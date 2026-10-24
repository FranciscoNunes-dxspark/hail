// /import: requests from what other tools keep them in, as blocks of a .http file. A Postman collection
// (v2.0 or v2.1; and a Postman environment, as one of http-client.env.json's), a HAR file (a browser's
// recording), and an OpenAPI 3 or Swagger 2 document (JSON or YAML), read here rather than by Claude.
// Nothing secret is written out: a credential becomes a {{$secret …}} placeholder (or the variable it
// already was), and credential headers in a recording are dropped, each said in `notes`. Pure.
import { deref } from './contract.js';
import { requestTitle } from './curl.js';
import { parseYaml } from './yaml.js';

const SECRET_NAME = /pass(word)?|pwd|secret|token|api[-_]?key|apikey|credential|private|auth/i;
const CREDENTIAL = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|ocp-apim-subscription-key)$/i;
const CONNECTION = /^(host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer)$/i;

/** A name made of letters, digits and dashes, for a {{$secret}}: "My API" → my-api. */
export const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'import';

/** Whether `text` is a whole {{variable}} already (so it's kept, not made a secret). */
const isVariable = (text) => /^\{\{[^{}]+\}\}$/.test(String(text ?? '').trim());

/** What's being written: the variables (in order), the request blocks, the notes and the secrets named. */
function output(taken = new Set()) {
  const vars = new Map();
  const o = {
    blocks: [],
    notes: [],
    secrets: new Set(),
    skipped: new Set(),
    /** A file variable, unless the file (or its environment) has one of that name already. */
    variable(name, value) {
      if (taken.has(name)) return o.skipped.add(name);
      if (!vars.has(name)) vars.set(name, String(value ?? ''));
    },
    /** `value` kept when it's a {{variable}}, else a {{$secret name}} placeholder for it. */
    secret(name, value) {
      if (isVariable(value)) return String(value).trim();
      o.secrets.add(name);
      return `{{$secret ${name}}}`;
    },
    text() {
      const head = [...vars].map(([k, v]) => `@${k} = ${v}`);
      return [...(head.length ? [head.join('\n')] : []), ...o.blocks].join('\n\n').replace(/\n*$/, '\n');
    },
    result(kind, extra = {}) {
      const notes = [...o.notes];
      if (o.secrets.size) notes.unshift(`Credentials became {{$secret}} placeholders, asked for the first time they're used (or /secret <name> saves one now): ${[...o.secrets].join(', ')}`);
      if (o.skipped.size) notes.push(`Kept the file's own ${[...o.skipped].map((n) => `{{${n}}}`).join(', ')} rather than declaring ${o.skipped.size === 1 ? 'it' : 'them'} again`);
      return { kind, text: o.text(), requests: o.blocks.length, notes, secrets: [...o.secrets], ...extra };
    },
  };
  return o;
}

/** A request block: ### title, directives, the request line, headers and the body. */
function block({ title, name, method, url, headers = [], body = '' }) {
  const lines = [`### ${title}`];
  if (name) lines.push(`# @name ${name}`);
  lines.push(`${method} ${url}`, ...headers.map(([k, v]) => `${k}: ${v}`));
  if (body) lines.push('', body);
  return lines.join('\n');
}

const pretty = (text, type = '') => {
  if (/json/i.test(type) || /^\s*[[{]/.test(text ?? '')) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return String(text ?? '');
};
const hasHeader = (headers, name) => headers.some(([k]) => k.toLowerCase() === name.toLowerCase());

/**
 * What kind of document `text` (from a file called `name`) is, read: { kind: 'postman' | 'postman-env'
 * | 'har' | 'openapi', doc }. Throws saying what it isn't.
 */
export function detectImport(text, name = '') {
  const t = String(text ?? '').replace(/^﻿/, '');
  let doc;
  try {
    doc = /^\s*[[{]/.test(t) ? JSON.parse(t) : parseYaml(t);
  } catch (e) {
    throw new Error(`${name || 'It'} can't be read as JSON or YAML: ${e.message}`);
  }
  if (doc?.info && Array.isArray(doc.item)) return { kind: 'postman', doc };
  if (Array.isArray(doc?.values) && (doc._postman_variable_scope || doc.name)) return { kind: 'postman-env', doc };
  if (Array.isArray(doc?.log?.entries)) return { kind: 'har', doc };
  if ((doc?.openapi || doc?.swagger) && doc.paths) return { kind: 'openapi', doc };
  throw new Error(`${name || 'It'} isn't a Postman collection or environment, a HAR file, or an OpenAPI or Swagger document.`);
}

/**
 * The requests in `text`: { kind, text (the .http blocks, variables first), requests, notes, secrets,
 * environment? ({ name, vars } for a Postman environment) }. `taken`: names the file or its environment
 * define already, which aren't declared again.
 */
export function importText(text, name = '', { taken = new Set() } = {}) {
  const { kind, doc } = detectImport(text, name);
  if (kind === 'postman') return importPostman(doc, { taken });
  if (kind === 'postman-env') return importPostmanEnvironment(doc);
  if (kind === 'har') return importHar(doc, { taken });
  return importOpenApi(doc, { taken });
}

export const KIND_NAMES = { postman: 'a Postman collection', 'postman-env': 'a Postman environment', har: 'a HAR recording', openapi: 'an OpenAPI document' };

// --- Postman -----------------------------------------------------------------------------------------

/** Postman's auth settings ({ type, bearer: [{ key, value }] } in v2.1, { type, bearer: { token } } in v2.0) as { key: value }. */
function authParams(auth) {
  const p = auth?.[auth?.type];
  if (Array.isArray(p)) return Object.fromEntries(p.map((x) => [x.key, x.value]));
  return p && typeof p === 'object' ? p : {};
}

/** A Postman URL (a string, or { raw, host, path, query, variable }) as text, `:id` path variables as {{id}}. */
function postmanUrl(url, o) {
  let raw = typeof url === 'string' ? url : (url?.raw ?? '');
  if (!raw && url && typeof url === 'object') {
    const host = Array.isArray(url.host) ? url.host.join('.') : (url.host ?? '');
    const path = Array.isArray(url.path) ? url.path.join('/') : (url.path ?? '');
    const query = (url.query ?? []).filter((q) => !q.disabled).map((q) => `${q.key}=${q.value ?? ''}`).join('&');
    raw = `${url.protocol ? `${url.protocol}://` : ''}${host}${path ? `/${path}` : ''}${query ? `?${query}` : ''}`;
  }
  for (const v of (typeof url === 'object' && url?.variable) || []) if (v.key && v.value != null && v.value !== '') o.variable(v.key, v.value);
  return raw.replace(/(^|\/):([A-Za-z_][\w-]*)(?=\/|\?|#|$)/g, '$1{{$2}}');
}

/** A Postman collection, folders as "Folder / Request" titles, auth as headers. */
export function importPostman(doc, { taken = new Set() } = {}) {
  const o = output(taken);
  const name = doc.info?.name ?? 'postman';
  const s = slug(name);
  let scripts = 0;
  const unsupportedAuth = new Set();
  for (const v of doc.variable ?? []) {
    if (!v?.key || v.disabled) continue;
    o.variable(v.key, v.type === 'secret' || SECRET_NAME.test(v.key) ? o.secret(`${s}-${slug(v.key)}`, v.value) : (v.value ?? ''));
  }
  const walk = (items, path, inherited) => {
    for (const item of items ?? []) {
      scripts += (item.event ?? []).filter((e) => e.script?.exec?.length).length;
      const auth = item.auth && item.auth.type !== 'inherit' ? item.auth : inherited;
      if (Array.isArray(item.item)) {
        walk(item.item, [...path, item.name], auth);
        continue;
      }
      const r = item.request;
      if (!r) continue;
      const req = typeof r === 'string' ? { url: r, method: 'GET' } : r;
      const title = [...path, item.name ?? 'request'].join(' / ');
      let url = postmanUrl(req.url, o);
      const headers = (Array.isArray(req.header) ? req.header : []).filter((h) => !h.disabled && h.key).map((h) => [h.key, CREDENTIAL.test(h.key) && !isVariable(h.value) ? o.secret(`${s}-${slug(h.key)}`, h.value) : String(h.value ?? '')]);
      const a = req.auth && req.auth.type !== 'inherit' ? req.auth : auth;
      const p = authParams(a);
      if (a?.type === 'bearer' && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Bearer ${o.secret(`${s}-token`, p.token)}`]);
      else if (a?.type === 'basic' && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Basic ${p.username ?? ''}:${o.secret(`${s}-password`, p.password)}`]);
      else if (a?.type === 'apikey') {
        const key = p.key || 'X-Api-Key';
        const value = o.secret(`${s}-${slug(key)}`, p.value);
        if (p.in === 'query') url += `${url.includes('?') ? '&' : '?'}${key}=${value}`;
        else if (!hasHeader(headers, key)) headers.push([key, value]);
      } else if (a && !['noauth', 'bearer', 'basic', 'apikey'].includes(a.type)) unsupportedAuth.add(a.type);
      let body = '';
      let method = String(req.method ?? 'GET').toUpperCase();
      const b = req.body;
      if (b?.mode === 'raw' && b.raw) {
        const lang = b.options?.raw?.language;
        if (lang === 'json' && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
        body = pretty(b.raw, lang === 'json' ? 'json' : '');
      } else if (b?.mode === 'urlencoded') {
        if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
        body = (b.urlencoded ?? []).filter((x) => !x.disabled).map((x) => `${x.key}=${x.value ?? ''}`).join('&');
      } else if (b?.mode === 'formdata') {
        const boundary = 'WebAppBoundary';
        for (let i = headers.length - 1; i >= 0; i--) if (headers[i][0].toLowerCase() === 'content-type') headers.splice(i, 1);
        headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
        const parts = [];
        for (const f of (b.formdata ?? []).filter((x) => !x.disabled)) {
          const files = f.type === 'file' ? [f.src].flat().filter(Boolean) : [];
          if (f.type === 'file') for (const src of files.length ? files : ['./file']) parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.key}"; filename="${String(src).split(/[\\/]/).pop()}"`, '', `< ${src}`);
          else parts.push(`--${boundary}`, `Content-Disposition: form-data; name="${f.key}"`, ...(f.contentType ? [`Content-Type: ${f.contentType}`] : []), '', String(f.value ?? ''));
        }
        body = parts.length ? [...parts, `--${boundary}--`].join('\n') : '';
      } else if (b?.mode === 'graphql' && b.graphql) {
        method = 'GRAPHQL';
        const vars = typeof b.graphql.variables === 'string' ? b.graphql.variables.trim() : b.graphql.variables ? JSON.stringify(b.graphql.variables) : '';
        body = [String(b.graphql.query ?? '').trim(), ...(vars && vars !== '{}' ? ['', pretty(vars, 'json')] : [])].join('\n');
      } else if (b?.mode === 'file' && b.file?.src) body = `< ${b.file.src}`;
      o.blocks.push(block({ title, method, url, headers, body }));
    }
  };
  walk(doc.item, [], doc.auth && doc.auth.type !== 'inherit' ? doc.auth : null);
  if (scripts) o.notes.push(`Left out ${scripts} pre-request and test script${scripts === 1 ? '' : 's'}: Hail's checks are JetBrains' > {% … %} handlers`);
  if (unsupportedAuth.size) o.notes.push(`Left out ${[...unsupportedAuth].join(', ')} auth: an environment's "Security" (OAuth 2) or a header of your own does it in Hail`);
  return o.result('postman', { title: name });
}

/** A Postman environment, as { name, vars } for http-client.env.json; secret ones as {{$secret}} placeholders. */
export function importPostmanEnvironment(doc) {
  const o = output();
  const name = String(doc.name ?? 'imported').trim() || 'imported';
  const vars = {};
  for (const v of doc.values ?? []) {
    if (!v?.key || v.enabled === false) continue;
    vars[v.key] = v.type === 'secret' || SECRET_NAME.test(v.key) ? o.secret(`${slug(name)}-${slug(v.key)}`, v.value) : String(v.value ?? '');
  }
  return { ...o.result('postman-env'), environment: { name, vars }, text: '', requests: 0 };
}

// --- HAR ---------------------------------------------------------------------------------------------

/** A HAR recording: a request per entry, without its cookies, credentials or connection headers. */
export function importHar(doc, { taken = new Set() } = {}) {
  const o = output(taken);
  const dropped = new Set();
  let skipped = 0;
  for (const e of doc.log.entries) {
    const r = e?.request;
    if (!r?.url || !/^https?:/i.test(r.url)) {
      skipped++;
      continue;
    }
    const method = String(r.method ?? 'GET').toUpperCase();
    const headers = [];
    for (const h of r.headers ?? []) {
      if (!h?.name || h.name.startsWith(':') || CONNECTION.test(h.name)) continue;
      if (CREDENTIAL.test(h.name)) {
        dropped.add(h.name.toLowerCase());
        continue;
      }
      if (!hasHeader(headers, h.name)) headers.push([h.name, String(h.value ?? '')]);
    }
    let body = '';
    const pd = r.postData;
    if (pd?.text) body = pretty(pd.text, pd.mimeType);
    else if (pd?.params?.length) body = pd.params.map((p) => `${p.name}=${p.value ?? ''}`).join('&');
    if (body && pd?.mimeType && !hasHeader(headers, 'content-type')) headers.push(['Content-Type', pd.mimeType]);
    o.blocks.push(block({ title: requestTitle({ method, url: r.url }), method, url: r.url, headers, body }));
  }
  if (dropped.size) o.notes.push(`Left out the ${[...dropped].join(', ')} header${dropped.size === 1 ? '' : 's'}: credentials and cookies stay in the browser`);
  if (skipped) o.notes.push(`Passed over ${skipped} entr${skipped === 1 ? 'y' : 'ies'} that weren't http(s) (data:, blob:, extensions)`);
  return o.result('har');
}

// --- OpenAPI -----------------------------------------------------------------------------------------

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

/** An example value for `schema` (an example, default, enum, or one made from its type), `depth` deep at most. */
export function exampleFor(spec, schema, depth = 0) {
  const s = deref(spec, schema);
  if (!s || typeof s !== 'object' || depth > 6) return null;
  if (s.example !== undefined) return s.example;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (s.default !== undefined) return s.default;
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (Array.isArray(s.allOf)) return Object.assign({}, ...s.allOf.map((x) => exampleFor(spec, x, depth + 1)).filter((x) => x && typeof x === 'object'));
  for (const k of ['oneOf', 'anyOf']) if (Array.isArray(s[k]) && s[k].length) return exampleFor(spec, s[k][0], depth + 1);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;
  if (type === 'object' || (!type && s.properties)) {
    const out = {};
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      const ex = exampleFor(spec, v, depth + 1);
      if (ex !== null || deref(spec, v)?.nullable) out[k] = ex;
    }
    return out;
  }
  if (type === 'array') {
    const item = exampleFor(spec, s.items, depth + 1);
    return item === null ? [] : [item];
  }
  if (type === 'integer' || type === 'number') return s.minimum ?? 0;
  if (type === 'boolean') return true;
  if (type === 'string') return { 'date-time': '2024-01-01T00:00:00Z', date: '2024-01-01', uuid: '00000000-0000-0000-0000-000000000000', email: 'name@example.com', uri: 'https://example.com' }[s.format] ?? 'string';
  return null;
}

/** An example of a parameter's value, as text for a variable. */
function paramExample(spec, p) {
  const v = p.example ?? Object.values(p.examples ?? {})[0]?.value ?? exampleFor(spec, p.schema ?? (p.type ? p : null));
  if (v == null) return p.schema?.type === 'integer' || p.type === 'integer' ? '1' : p.name;
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** The API's base URL: OpenAPI 3's first server (its variables at their defaults) or Swagger 2's host and basePath. */
function baseUrl(spec) {
  if (spec.swagger) return spec.host ? `${spec.schemes?.[0] ?? 'https'}://${spec.host}${spec.basePath ?? ''}`.replace(/\/$/, '') : `http://localhost${spec.basePath ?? ''}`.replace(/\/$/, '');
  const s = spec.servers?.[0];
  let url = String(s?.url ?? '');
  for (const [k, v] of Object.entries(s?.variables ?? {})) url = url.split(`{${k}}`).join(v?.default ?? '');
  if (!/^https?:\/\//i.test(url)) url = `http://localhost${url.startsWith('/') ? url : url ? `/${url}` : ''}`;
  return url.replace(/\/$/, '');
}

/** An OpenAPI 3 or Swagger 2 document: a request per operation, path and required parameters as variables. */
export function importOpenApi(spec, { taken = new Set() } = {}) {
  const o = output(taken);
  const title = spec.info?.title ?? 'api';
  const s = slug(title);
  o.variable('host', baseUrl(spec));
  const schemes = spec.components?.securitySchemes ?? spec.securityDefinitions ?? {};
  const oauth = new Set();
  const names = new Set();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const m of METHODS) {
      const op = item?.[m];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) => deref(spec, p)).filter(Boolean);
      const byKey = new Map(params.map((p) => [`${p.in}:${p.name}`, p]));
      let url = `{{host}}${path.replace(/\{([^}]+)\}/g, '{{$1}}')}`;
      const headers = [];
      const query = [];
      for (const p of byKey.values()) {
        if (p.in === 'path') o.variable(p.name, paramExample(spec, p));
        else if (p.in === 'query' && p.required) {
          query.push(`${p.name}={{${p.name}}}`);
          o.variable(p.name, paramExample(spec, p));
        } else if (p.in === 'header' && p.required && !CREDENTIAL.test(p.name)) {
          headers.push([p.name, `{{${p.name}}}`]);
          o.variable(p.name, paramExample(spec, p));
        }
      }
      if (query.length) url += `?${query.join('&')}`;
      const ok = Object.entries(op.responses ?? {}).find(([k]) => /^2/.test(k))?.[1];
      const produces = ok?.content ? Object.keys(deref(spec, ok).content ?? {}) : (op.produces ?? spec.produces ?? []);
      if (produces.some((t) => /json/i.test(t))) headers.push(['Accept', 'application/json']);
      // Security: the first requirement the operation (or the document) has.
      const req = (op.security ?? spec.security ?? [])[0] ?? {};
      for (const name of Object.keys(req)) {
        const sc = deref(spec, schemes[name]);
        if (!sc) continue;
        if ((sc.type === 'http' && /^bearer$/i.test(sc.scheme)) || sc.type === 'oauth2' || sc.type === 'openIdConnect') {
          if (sc.type === 'http') headers.push(['Authorization', `Bearer ${o.secret(`${s}-token`)}`]);
          else {
            headers.push(['Authorization', `Bearer {{$auth.token("${slug(name)}")}}`]);
            oauth.add(slug(name));
          }
        } else if ((sc.type === 'http' && /^basic$/i.test(sc.scheme)) || sc.type === 'basic') headers.push(['Authorization', `Basic {{username}}:${o.secret(`${s}-password`)}`]);
        else if (sc.type === 'apiKey' && sc.in === 'header') headers.push([sc.name, o.secret(`${s}-${slug(sc.name)}`)]);
        else if (sc.type === 'apiKey' && sc.in === 'query') url += `${url.includes('?') ? '&' : '?'}${sc.name}=${o.secret(`${s}-${slug(sc.name)}`)}`;
      }
      // The body: OpenAPI 3's requestBody, or Swagger 2's body (or formData) parameter.
      let body = '';
      const rb = deref(spec, op.requestBody);
      if (rb?.content) {
        const [type, media] = Object.entries(rb.content).find(([t]) => /json/i.test(t)) ?? Object.entries(rb.content)[0];
        const ex = media?.example ?? Object.values(media?.examples ?? {}).map((e) => deref(spec, e)?.value)[0] ?? exampleFor(spec, media?.schema);
        headers.push(['Content-Type', type]);
        if (ex != null) body = /json/i.test(type) ? JSON.stringify(ex, null, 2) : /x-www-form-urlencoded/i.test(type) && typeof ex === 'object' ? Object.entries(ex).map(([k, v]) => `${k}=${v}`).join('&') : typeof ex === 'object' ? JSON.stringify(ex, null, 2) : String(ex);
      } else {
        const bp = [...byKey.values()].find((p) => p.in === 'body');
        const form = [...byKey.values()].filter((p) => p.in === 'formData');
        if (bp) {
          headers.push(['Content-Type', (op.consumes ?? spec.consumes ?? ['application/json'])[0]]);
          const ex = exampleFor(spec, bp.schema);
          if (ex != null) body = JSON.stringify(ex, null, 2);
        } else if (form.length) {
          headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
          body = form.map((p) => `${p.name}=${paramExample(spec, p)}`).join('&');
        }
      }
      let name = op.operationId ? String(op.operationId).replace(/[^\w-]/g, '_') : null;
      if (name && names.has(name)) name = null;
      if (name) names.add(name);
      o.blocks.push(block({ title: op.summary ? String(op.summary).split('\n')[0] : (op.operationId ?? `${m.toUpperCase()} ${path}`), name, method: m.toUpperCase(), url, headers, body }));
    }
  }
  if (oauth.size) o.notes.push(`Signs in with {{$auth.token("${[...oauth].join('")}}, {{$auth.token("')}")}}: add ${oauth.size === 1 ? 'it' : 'them'} to an environment's "Security": { "Auth": { … } } (see /help)`);
  if (o.blocks.some((b) => b.includes('{{username}}'))) o.notes.push('Basic auth uses {{username}}: set it in the environment');
  return o.result('openapi', { title });
}
