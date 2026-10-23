// Contract drift: a response checked against the API's OpenAPI (3) or Swagger (2) document. The
// operation is found by method and path (the servers' or basePath's prefix taken off, {templates}
// matched), the response by status (exact, 2XX, default), and its JSON body against the schema with
// a subset of JSON Schema: type, nullable, required, properties, additionalProperties, items, enum,
// oneOf / anyOf / allOf, and local $refs; formats are ignored. Pure, apart from loadContract reading it.
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { parseYaml } from './yaml.js';

/** The document in `text` (JSON or YAML), or a thrown reason it isn't an API description. */
export function parseContract(text) {
  const t = String(text ?? '').replace(/^﻿/, '');
  let spec;
  try {
    spec = /^\s*\{/.test(t) ? JSON.parse(t) : parseYaml(t);
  } catch (e) {
    throw new Error(`It can't be read: ${e.message}`);
  }
  if (!spec || typeof spec !== 'object' || !spec.paths || typeof spec.paths !== 'object') throw new Error("It isn't an OpenAPI or Swagger document (it has no paths).");
  return spec;
}

/** Reads a contract from a file (relative to `dir`) or an http(s) URL: { spec, source, operations }. */
export async function loadContract(source, { dir = process.cwd(), fetch = globalThis.fetch, signal } = {}) {
  let text;
  if (/^https?:\/\//i.test(source)) {
    let res;
    try {
      res = await fetch(source, { signal });
    } catch (e) {
      throw new Error(`Couldn't fetch ${source}: ${e.cause?.message ?? e.message}`);
    }
    if (!res.ok) throw new Error(`Couldn't fetch ${source}: ${res.status} ${res.statusText}`);
    text = await res.text();
  } else {
    const path = isAbsolute(source) ? source : resolve(dir, source);
    try {
      text = await readFile(path, 'utf8');
    } catch (e) {
      throw new Error(`Couldn't read ${source}: ${e.code === 'ENOENT' ? "there's no such file" : e.message}`);
    }
  }
  const spec = parseContract(text);
  return { spec, source, operations: operationCount(spec) };
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export const operationCount = (spec) => Object.values(spec.paths ?? {}).reduce((n, item) => n + METHODS.filter((m) => item?.[m]).length, 0);

/** The path prefixes the API lives under: the servers' (OpenAPI 3) or basePath (Swagger 2), longest first. */
export function basePaths(spec) {
  const out = new Set();
  for (const s of spec.servers ?? []) {
    let url = String(s?.url ?? '');
    for (const [k, v] of Object.entries(s?.variables ?? {})) url = url.split(`{${k}}`).join(v?.default ?? '');
    let path;
    try {
      path = new URL(url).pathname;
    } catch {
      path = url.replace(/^[a-z]+:\/\/[^/]*/i, '');
    }
    out.add(path.replace(/\/+$/, ''));
  }
  if (spec.basePath) out.add(String(spec.basePath).replace(/\/+$/, ''));
  out.add('');
  return [...out].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A path template as a regular expression, and how many parameters it has. */
function templateRe(template) {
  const params = (template.match(/\{[^}]+\}/g) ?? []).length;
  const body = template
    .replace(/\/+$/, '')
    .split(/(\{[^}]+\})/)
    .map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : escapeRe(part)))
    .join('');
  return { re: new RegExp(`^${body || ''}/?$`), params };
}

// The paths' templates as expressions, made once per spec (a big one has thousands, and every
// response is matched against them).
const TEMPLATES = new WeakMap();
const templatesOf = (paths) => {
  // `prefix`: the text before its first parameter, which a path it matches starts with.
  if (!TEMPLATES.has(paths)) TEMPLATES.set(paths, Object.keys(paths).map((template) => ({ template, prefix: template.replace(/\/+$/, '').split('{')[0], ...templateRe(template) })));
  return TEMPLATES.get(paths);
};

/** The path of `url` (a whole URL or one starting with /), decoded where it can be. */
function pathOf(url) {
  let p;
  try {
    p = new URL(url).pathname;
  } catch {
    p = String(url).replace(/^[a-z]+:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  }
  try {
    return decodeURI(p) || '/';
  } catch {
    return p || '/';
  }
}

/**
 * The operation `method` `url` is: { path, method, op }, or { path, method, op: null } when the path is
 * there without that method, or null when no path matches. A path without parameters wins over one with.
 */
export function findOperation(spec, method, url) {
  const path = pathOf(url);
  const m = String(method).toLowerCase();
  for (const base of basePaths(spec)) {
    if (base && !(path === base || path.startsWith(`${base}/`))) continue;
    const rest = path.slice(base.length) || '/';
    const hits = templatesOf(spec.paths)
      .filter((t) => (rest.startsWith(t.prefix) && t.re.test(rest)) || (rest === '/' && t.template === '/'))
      .sort((a, b) => a.params - b.params);
    if (!hits.length) continue;
    const withMethod = hits.find((h) => spec.paths[h.template]?.[m]);
    const hit = withMethod ?? hits[0];
    return { path: hit.template, method: m.toUpperCase(), op: spec.paths[hit.template]?.[m] ?? null };
  }
  return null;
}

/** `node` with its local $ref followed (through as many as there are), or null for one that can't be. */
export function deref(spec, node) {
  if (!node || typeof node !== 'object' || typeof node.$ref !== 'string') return node ?? null;
  if (!spec || typeof spec !== 'object') return follow(spec, node);
  // Where a $ref leads is the same each time, and a body of many items asks for it once an item.
  let refs = REFS.get(spec);
  if (!refs) REFS.set(spec, (refs = new Map()));
  if (!refs.has(node.$ref)) refs.set(node.$ref, follow(spec, node));
  return refs.get(node.$ref);
}

const REFS = new WeakMap();

function follow(spec, node) {
  let n = node;
  for (let hops = 0; n && typeof n === 'object' && typeof n.$ref === 'string'; hops++) {
    if (hops > 50 || !n.$ref.startsWith('#')) return null;
    n = n.$ref
      .slice(1)
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((at, key) => (at && typeof at === 'object' ? at[key] : undefined), spec);
  }
  return n ?? null;
}

/**
 * What the operation says about a response with `status`: { key, schema, media } (the responses entry
 * it is, the body's schema or null), or { undocumented: [keys documented] }.
 */
export function responseSpec(spec, op, status, contentType = '') {
  const responses = op?.responses ?? {};
  const keys = Object.keys(responses);
  const s = String(status);
  const key = keys.find((k) => k === s) ?? keys.find((k) => k.toUpperCase() === `${s[0]}XX`) ?? keys.find((k) => k === 'default');
  if (!key) return { undocumented: keys };
  const r = deref(spec, responses[key]) ?? {};
  if (r.content && typeof r.content === 'object') {
    const types = Object.keys(r.content);
    const want = String(contentType).split(';')[0].trim().toLowerCase();
    const media = types.find((t) => t.toLowerCase() === want) ?? types.find((t) => /json/i.test(t)) ?? types[0];
    return { key, media: media ?? null, schema: media ? (r.content[media]?.schema ?? null) : null };
  }
  return { key, media: r.schema ? 'application/json' : null, schema: r.schema ?? null };
}

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v);
const at = (path, key) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
const shown = (v) => {
  const s = JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** allOf's schemas made one: their properties and required lists together. */
function merged(spec, schema, depth) {
  const out = { ...schema };
  delete out.allOf;
  const parts = (schema.allOf ?? []).map((p) => deref(spec, p)).filter(Boolean).map((p) => (p.allOf && depth < 20 ? merged(spec, p, depth + 1) : p));
  for (const p of parts) {
    if (p.properties) out.properties = { ...(out.properties ?? {}), ...p.properties };
    if (p.required) out.required = [...new Set([...(out.required ?? []), ...p.required])];
    for (const k of ['type', 'items', 'enum', 'nullable', 'x-nullable', 'oneOf', 'anyOf']) if (p[k] !== undefined && out[k] === undefined) out[k] = p[k];
    if (p.additionalProperties !== undefined && out.additionalProperties === undefined) out.additionalProperties = p.additionalProperties;
  }
  return out;
}

/**
 * How `value` differs from `schema`: [{ kind, path, text }], kind being 'added' (a field the schema
 * doesn't have), 'missing' (a required one that isn't there), 'type' or 'enum'. `spec` resolves $refs.
 */
export function validate(spec, schema, value, path = '$', depth = 0) {
  let s = deref(spec, schema);
  if (!s || typeof s !== 'object' || depth > 60) return [];
  if (s.allOf) s = merged(spec, s, 0);
  const actual = typeOf(value);
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : s.properties ? ['object'] : s.items ? ['array'] : null;
  if (value === null) {
    if (s.nullable || s['x-nullable'] || !types || types.includes('null') || s.enum?.includes(null)) return [];
  }
  const branches = s.oneOf ?? s.anyOf;
  if (branches) {
    const tries = branches.map((b) => validate(spec, b, value, path, depth + 1));
    if (!tries.some((t) => t.length === 0)) return tries.reduce((best, t) => (t.length < best.length ? t : best));
  }
  if (types && !types.some((t) => t === actual || (t === 'number' && actual === 'integer'))) {
    return [{ kind: 'type', path, text: `${actual}, the contract says ${types.join(' or ')}` }];
  }
  if (s.enum && !s.enum.some((e) => same(e, value))) return [{ kind: 'enum', path, text: `${shown(value)} isn't one of ${s.enum.map(shown).join(', ')}` }];
  const out = [];
  if (actual === 'object') {
    const props = s.properties ?? {};
    for (const r of s.required ?? []) if (!(r in value)) out.push({ kind: 'missing', path: at(path, r), text: 'required, and missing' });
    const extra = s.additionalProperties;
    for (const [k, v] of Object.entries(value)) {
      if (props[k] !== undefined) out.push(...validate(spec, props[k], v, at(path, k), depth + 1));
      else if (extra && typeof extra === 'object') out.push(...validate(spec, extra, v, at(path, k), depth + 1));
      else if (extra !== true && (s.properties || extra === false)) out.push({ kind: 'added', path: at(path, k), text: "not in the contract" });
    }
  } else if (actual === 'array' && s.items) {
    value.forEach((v, n) => out.push(...validate(spec, s.items, v, `${path}[${n}]`, depth + 1)));
  }
  return out;
}

/** The same difference in many items said once: $.items[3].id and $.items[7].id are $.items[].id, "in 2 items". */
export function grouped(issues) {
  const by = new Map();
  for (const i of issues) {
    const path = i.path.replace(/\[\d+\]/g, '[]');
    const key = `${i.kind}\n${path}\n${i.kind === 'type' ? i.text : ''}`;
    if (by.has(key)) by.get(key).count++;
    else by.set(key, { ...i, path, count: 1 });
  }
  return [...by.values()];
}

/**
 * A response checked against the contract: { operation, status, issues }, `operation` "GET /users/{id}"
 * (null when no path matched) and `issues` [{ kind, path?, text, count? }] with kind also 'path'
 * (not in the contract), 'method' and 'status' (not documented) or 'body'. `request` is { method, url },
 * `response` { status, headers: [[name, value]], body }.
 */
export function checkContract(spec, request, response) {
  const found = findOperation(spec, request.method, request.url);
  if (!found) return { operation: null, issues: [{ kind: 'path', text: `${request.method} ${pathOf(request.url)} isn't in the contract` }] };
  const operation = `${found.method} ${found.path}`;
  if (!found.op) return { operation, issues: [{ kind: 'method', text: `${found.path} has no ${found.method} in the contract` }] };
  const type = response.headers?.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const r = responseSpec(spec, found.op, response.status, type);
  if (r.undocumented) return { operation, issues: [{ kind: 'status', text: `${response.status} isn't documented for ${operation}${r.undocumented.length ? ` (it has ${r.undocumented.join(', ')})` : ''}` }] };
  const issues = [];
  const body = String(response.body ?? '');
  if (r.schema && (!r.media || /json/i.test(r.media))) {
    if (!body.trim()) {
      if (found.method !== 'HEAD' && response.status !== 204 && response.status !== 304) issues.push({ kind: 'body', text: `No body came back; the contract says ${r.media ?? 'one'}` });
    } else {
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        issues.push({ kind: 'body', text: `The body isn't JSON; the contract says ${r.media}` });
      }
      if (value !== undefined) issues.push(...grouped(validate(spec, r.schema, value)));
    }
  }
  return { operation, status: r.key, issues };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "3 differences from the contract", or "matches the contract (GET /users/{id} 200)". */
export function driftSummary(result) {
  if (!result) return '';
  if (!result.issues.length) return `matches the contract (${result.operation} ${result.status})`;
  return `${plural(result.issues.length, 'difference')} from the contract`;
}

/** A difference's mark: + added, − missing, ≠ a wrong type or value, ? not documented. */
export const issueMark = (kind) => ({ added: '+', missing: '−', type: '≠', enum: '≠', body: '≠' })[kind] ?? '?';

/** A difference as one line of text. */
export const issueText = (i) => `${issueMark(i.kind)} ${i.path ? `${i.path}: ` : ''}${i.text}${i.count > 1 ? ` (in ${i.count} items)` : ''}`;
