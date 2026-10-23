// Turning a parsed request into what goes over the wire, sending it, and showing what came back.
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fill } from './variables.js';

/**
 * The request with every placeholder filled in: { method, url, headers, body, missing, secrets,
 * handlers }, `missing` being the variables nothing answered and `secrets` the secret values and
 * tokens filled in. A body from a file is read relative to the .http file's `dir`, and so is a response
 * handler's script file; `handlers` are the scripts to run on the response ([{ script, name }]).
 */
export async function prepare(request, scope, { dir = process.cwd(), read = (p) => readFile(p, 'utf8') } = {}) {
  const missing = [];
  const used = new Set();
  const inner = { ...scope, env: { ...scope?.env, used } };
  const f = async (text) => {
    const r = await fill(text, inner);
    missing.push(...r.missing);
    return r.text;
  };
  const url = await f(request.url);
  const headers = [];
  for (const [k, v] of request.headers) headers.push([await f(k), await f(v)]);
  let body = await f(request.body);
  if (request.bodyFile) {
    const path = await f(request.bodyFile.path);
    const text = await read(isAbsolute(path) ? path : join(dir, path));
    body = request.bodyFile.fill ? await f(text) : text;
  }
  const at = (path) => (isAbsolute(path) ? path : join(dir, path));
  const handlers = [];
  for (const h of request.handlers ?? []) {
    if (h.script != null) handlers.push({ script: h.script, name: `the script on line ${h.line}` });
    else {
      const path = await f(h.file);
      handlers.push({ script: await read(at(path)), name: basename(path) });
    }
  }
  return { method: request.method, url, headers, body, missing: [...new Set(missing)], secrets: [...used], handlers, options: request.options ?? {} };
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;
const has = (headers, name) => headers.some(([k]) => k.toLowerCase() === name);

/**
 * Sends a prepared request with `fetch`, resolving with { status, statusText, headers: [[name, value]],
 * body, raw, ms, size, url, redirects }; `url` is where it ended up after redirects, `raw` the body's
 * bytes. Redirects are followed here rather than by fetch, so that a cookie `jar` (cookies.js) sees
 * the Set-Cookie of every response on the way and sends its cookies to each hop, unless the request
 * sets Cookie itself. `follow: false` gives back the redirect itself. `signal` cancels it.
 */
export async function send(req, { signal, fetch = globalThis.fetch, now = () => performance.now(), jar = null, follow = true } = {}) {
  let url;
  try {
    url = new URL(req.url).href;
  } catch {
    throw new Error(`${req.url} isn't a URL${/\{\{/.test(req.url) ? ' (a variable in it has no value)' : ''}`);
  }
  const started = now();
  let method = req.method;
  let headers = req.headers;
  let body = req.payload ?? req.body;
  let res;
  let bytes;
  let redirects = 0;
  try {
    for (;;) {
      const cookie = jar && !has(headers, 'cookie') ? jar.header(url) : '';
      res = await fetch(url, {
        method,
        headers: cookie ? [...headers, ['Cookie', cookie]] : headers,
        body: body && body.length && !['GET', 'HEAD'].includes(method) ? body : undefined,
        redirect: 'manual',
        signal,
      });
      jar?.store(res.headers.getSetCookie?.() ?? [], url);
      const location = res.headers.get('location');
      if (!follow || !REDIRECTS.has(res.status) || !location || redirects >= MAX_REDIRECTS) break;
      await res.arrayBuffer().catch(() => {});
      const next = new URL(location, url);
      // As browsers do: 303, and 301 or 302 after a POST, go on as a GET without the body.
      if ((res.status === 303 && method !== 'HEAD') || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = headers.filter(([k]) => !/^content-(type|length|encoding|language|location)$/i.test(k));
      }
      // Credentials don't follow a redirect to another site.
      if (next.origin !== new URL(url).origin) headers = headers.filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k));
      url = next.href;
      redirects++;
    }
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    throw new Error(networkError(e, url));
  }
  return {
    status: res.status,
    statusText: res.statusText,
    headers: [...res.headers.entries()],
    body: bytes.toString('utf8'),
    raw: bytes,
    ms: Math.round(now() - started),
    size: bytes.length,
    url,
    redirects,
  };
}

/** What went wrong reaching `url`, in words: fetch only says "fetch failed" and keeps the reason in `cause`. */
export function networkError(e, url) {
  const c = e.cause ?? e;
  const host = new URL(url).host;
  const why = {
    ECONNREFUSED: `nothing is listening at ${host}`,
    ENOTFOUND: `there's no such host as ${new URL(url).hostname}`,
    ECONNRESET: `${host} closed the connection`,
    ETIMEDOUT: `${host} didn't answer in time`,
    EAI_AGAIN: `${new URL(url).hostname} couldn't be looked up (offline?)`,
  }[c.code];
  if (why) return `Couldn't reach ${url}: ${why}`;
  // fetch refuses the ports browsers block (SMTP's, IRC's and the like), before trying them.
  if (c.message === 'bad port') return `Couldn't reach ${url}: port ${new URL(url).port} is one that browsers and fetch refuse to use`;
  if (/certificate|CERT_|SSL/i.test(`${c.code} ${c.message}`)) return `Couldn't reach ${url}: its certificate isn't trusted (${c.code ?? c.message})`;
  return `Couldn't reach ${url}: ${c.message ?? e.message}`;
}

/** The response's body for reading: JSON indented, anything else as it came. */
export function prettyBody(response) {
  const type = response.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const text = response.body;
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON after all.
    }
  }
  return text;
}

/** "1.2 KB", "830 B". */
export function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** The prepared request as a curl command line (POSIX shell quoting), for pasting elsewhere. */
export function toCurl(req) {
  const parts = ['curl'];
  if (req.method !== 'GET') parts.push('-X', req.method);
  parts.push(quote(req.url));
  for (const [k, v] of req.headers) parts.push('-H', quote(`${k}: ${v}`));
  if (req.body && !['GET', 'HEAD'].includes(req.method)) parts.push('--data-raw', quote(req.body));
  return parts.join(' ');
}
