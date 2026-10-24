// A mock of the API the open file talks to: each request's latest response kept in the history, served
// again to whoever asks for its method and path (a {{variable}} in the path matches any segment), and
// where the file has no answer, the contract's examples. Something else (a frontend, a test, a process
// Bosun runs) points at it instead of the real API. `routesFor` and `matchRoute` are pure; `startMock`
// is the server, on this machine only.
import { createServer } from 'node:http';
import { basePaths, deref } from './contract.js';
import { latestByLabel } from './history.js';
import { exampleFor } from './importers.js';

export const DEFAULT_PORT = 4010;

// Headers a kept response doesn't hand on: credentials (hidden in the history anyway), and what belongs
// to the connection or to how the body travelled the first time.
const DROP = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|ocp-apim-subscription-key|content-length|transfer-encoding|connection|keep-alive|content-encoding|date|server|via|alt-svc|strict-transport-security)$|token|secret|password/i;
const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** `text` with the {{variables}} `vars` knows filled in (several times over, for ones made of others). */
function withVars(text, vars) {
  let t = String(text);
  for (let i = 0; i < 5 && /\{\{/.test(t); i++) t = t.replace(/\{\{\s*([^{}\s]+)\s*\}\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
  return t;
}

/** A path template's segments as a pattern: `{x}` or `{{x}}` (or one with either in it) matches any one segment. */
function pattern(path) {
  const segs = path.split('/').filter(Boolean);
  const wild = (s) => /\{\{.*\}\}|\{[^}]+\}/.test(s);
  const re = new RegExp(`^/${segs.map((s) => (wild(s) ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')}/?$`);
  return { re, literal: segs.filter((s) => !wild(s)).length, template: `/${segs.map((s) => s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '{$1}')).join('/')}` };
}

/**
 * Where a request of the file is served: { method, template, re, literal } from its URL, its variables
 * that `vars` (the environment's and the file's) know filled in, so {{host}}'s own path counts, then
 * its scheme and host (or the variable it starts with) taken off. Null for a WebSocket or gRPC call.
 */
export function routeOf(request, vars = {}) {
  if (['WEBSOCKET', 'GRPC'].includes(request.method)) return null;
  let url = withVars(request.url, vars).replace(/[?#].*$/, '');
  if (/^[a-z][\w+.-]*:\/\//i.test(url)) url = url.replace(/^[a-z][\w+.-]*:\/\/[^/]*/i, '');
  else if (/^\{\{[^}]*\}\}/.test(url)) url = url.replace(/^\{\{[^}]*\}\}/, '');
  if (!url.startsWith('/')) url = `/${url}`;
  return { method: request.method === 'GRAPHQL' ? 'POST' : request.method, ...pattern(url) };
}

/** An example response for an operation of the contract: { status, headers, body } from its first 2xx (or default) response. */
function contractResponse(spec, op) {
  const entries = Object.entries(op.responses ?? {});
  const [key, raw] = entries.find(([k]) => /^2/.test(k)) ?? entries.find(([k]) => k === 'default') ?? [];
  if (!key) return { status: 204, headers: [], body: '' };
  const status = /^\d{3}$/.test(key) ? Number(key) : 200;
  const res = deref(spec, raw);
  const content = res?.content ?? (res?.schema ? { 'application/json': { schema: res.schema, example: res.examples?.['application/json'] } } : null);
  if (!content) return { status, headers: [], body: '' };
  const [type, media] = Object.entries(content).find(([t]) => /json/i.test(t)) ?? Object.entries(content)[0];
  const ex = media?.example ?? Object.values(media?.examples ?? {})[0]?.value ?? exampleFor(spec, media?.schema);
  return { status, headers: [['Content-Type', type]], body: ex == null ? '' : typeof ex === 'string' && !/json/i.test(type) ? ex : JSON.stringify(ex, null, 2) };
}

/**
 * The routes the mock serves: the file's requests with a response kept (`entries`, the history; the
 * latest per request), then the contract's operations (`spec`) none of them covers, from its examples.
 * Each: { method, template, re, literal, label, source: 'history' | 'contract', response: { status,
 * statusText?, headers, body } }.
 */
export function routesFor({ requests = [], entries = [], vars = {}, spec = null } = {}) {
  const latest = latestByLabel(entries);
  const out = [];
  for (const r of requests) {
    const e = latest[r.label];
    const route = e && routeOf(r, vars);
    if (route) out.push({ ...route, label: r.label, source: 'history', response: e.response });
  }
  if (spec?.paths) {
    const base = basePaths(spec)[0] ?? '';
    const have = new Set(out.map((r) => `${r.method} ${r.re.source}`));
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const m of METHODS) {
        const op = item?.[m];
        if (!op) continue;
        const p = pattern(`${base}${path}`);
        const method = m.toUpperCase();
        if (have.has(`${method} ${p.re.source}`)) continue;
        out.push({ method, ...p, label: op.summary ?? op.operationId ?? `${method} ${path}`, source: 'contract', response: contractResponse(spec, op) });
      }
    }
  }
  return out;
}

/** The route for `method` and `path`: the one matching with the most fixed segments, the history's before the contract's. */
export function matchRoute(routes, method, path) {
  const m = method === 'HEAD' ? 'GET' : method;
  const p = path.replace(/[?#].*$/, '') || '/';
  let best = null;
  for (const r of routes) {
    if (r.method !== m || !r.re.test(p)) continue;
    if (!best || r.literal > best.literal || (r.literal === best.literal && best.source === 'contract' && r.source === 'history')) best = r;
  }
  return best;
}

/** What the mock says to a request nothing matches: JSON listing what it does serve. */
export function notServed(routes, method, path) {
  return {
    error: `Hail's mock has nothing for ${method} ${path}`,
    serves: routes.map((r) => `${r.method} ${r.template}  (${r.label}${r.source === 'contract' ? ', from the contract' : ''})`),
    hint: routes.length ? 'A request is served once a response to it is kept: send it in Hail first.' : "Nothing is served yet: send the file's requests in Hail (their responses are kept), or set a contract with /contract.",
  };
}

/**
 * Starts the mock on `host`:`port` (0: any free one): `routes()` is asked on every request, so what it
 * serves follows the history as it grows. `onHit({ method, path, status, label })` hears each request.
 * Resolves with { port, close() }; rejects when the port can't be had.
 */
export function startMock({ port = DEFAULT_PORT, host = '127.0.0.1', routes, onHit = () => {} }) {
  const server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const path = new URL(req.url ?? '/', 'http://mock').pathname;
    req.resume();
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Expose-Headers', '*');
    if (method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*', 'Access-Control-Max-Age': '600' });
      res.end();
      return onHit({ method, path, status: 204, label: 'CORS preflight' });
    }
    let list = [];
    try {
      list = routes();
    } catch {}
    const r = matchRoute(list, method, path);
    if (!r) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(notServed(list, method, path), null, 2));
      return onHit({ method, path, status: 404, label: null });
    }
    const headers = {};
    for (const [k, v] of r.response.headers ?? []) if (!DROP.test(k) && v !== '••••••') headers[k] = v;
    headers['X-Hail-Mock'] = encodeURIComponent(r.label).slice(0, 200);
    res.writeHead(r.response.status, r.response.statusText ?? undefined, headers);
    res.end(method === 'HEAD' ? undefined : (r.response.body ?? ''));
    onHit({ method, path, status: r.response.status, label: r.label });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(new Error(e.code === 'EADDRINUSE' ? `port ${port} is in use already` : e.message)));
    server.listen(port, host, () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      }),
    );
  });
}
