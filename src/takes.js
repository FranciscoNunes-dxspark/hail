// What Hail does with what the sibling apps hand it (`/take <context>`, family.js): a request from
// Sonar's logs replayed, rows from Trawl as a body, a log line from Bosun found in the history. Pure.

/** The siblings each kind Hail doesn't take is for. */
export const OWNERS = { exception: 'Splice', commit: 'Splice', file: 'Splice', query: 'Trawl' };

/** The environment variables that say where the API is, in the order they're looked for. */
export const HOST_VARIABLES = ['host', 'baseUrl', 'baseURL'];

/** The first of HOST_VARIABLES `vars` (an environment's variables) gives a value, or null. */
export const hostVariable = (vars) => HOST_VARIABLES.find((n) => typeof vars?.[n] === 'string' && vars[n].trim()) ?? null;

// Headers that belong to the connection rather than the request, and ones that carry credentials:
// neither goes into the file.
const CONNECTION = /^(host|content-length|connection|transfer-encoding|keep-alive|upgrade|te|trailer)$/i;
const CREDENTIAL = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|ocp-apim-subscription-key)$/i;

/** A URL's path and query, and its scheme and host: { origin, path, pathname }. */
function split(url) {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: `${u.pathname}${u.search}`, pathname: u.pathname };
  } catch {
    const m = /^([a-z][\w+.-]*:\/\/[^/?#]*)?(.*)$/i.exec(String(url ?? ''));
    const path = m[2] || '/';
    return { origin: m[1] ?? '', path, pathname: path.replace(/[?#].*$/, '') };
  }
}

/** A body as text for the file: JSON indented, text as it is. */
function bodyText(body) {
  if (body == null || body === '') return '';
  if (typeof body === 'object') return JSON.stringify(body, null, 2);
  const s = String(body);
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object') return JSON.stringify(v, null, 2);
  } catch {}
  return s;
}

/**
 * A request context ({ method, url, headers: { name: value }, body }) as a block for the end of the
 * file, `### replay <METHOD> <path>`. With `hostVar`, the URL's scheme and host become {{hostVar}}, so
 * it goes to the environment picked. Returns { block, dropped } (the headers left out, by name).
 */
export function replayBlock(data, { hostVar = null } = {}) {
  const method = String(data.method ?? 'GET').toUpperCase();
  const { origin, path, pathname } = split(data.url);
  const url = hostVar ? `{{${hostVar}}}${path}` : `${origin}${path}`;
  const dropped = [];
  const headers = [];
  for (const [k, v] of Object.entries(data.headers ?? {})) {
    if (CONNECTION.test(k)) continue;
    if (CREDENTIAL.test(k)) {
      dropped.push(k);
      continue;
    }
    headers.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  const body = bodyText(data.body);
  const lines = [`### replay ${method} ${pathname}`, `${method} ${url}`, ...headers];
  if (body) lines.push('', ...body.split(/\r?\n/).map((l) => (/^###/.test(l) ? ` ${l}` : l)));
  return { block: `${lines.join('\n')}\n`, dropped };
}

/** Rows from Trawl ({ columns, rows }) as JSON: an array of objects, or one object for one row. */
export function rowsJson(data) {
  const columns = data.columns ?? [];
  const objects = (data.rows ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, row?.[i] ?? null])));
  return JSON.stringify(objects.length === 1 ? objects[0] : objects, null, 2);
}

/** A table's name for a URL: dbo.Orders and [dbo].[Orders] are Orders. */
export const tablePath = (table) => String(table ?? '').split('.').at(-1).replace(/^[[`"]|[\]`"]$/g, '');

/** A new POST request with the rows as its body, to {{hostVar}}/<table> when the table is known. */
export function rowsRequestBlock(data, { hostVar = 'host' } = {}) {
  const table = tablePath(data.table);
  const title = table ? `### POST ${table}` : '### POST rows';
  return `${title}\nPOST {{${hostVar}}}/${table}\nContent-Type: application/json\n\n${rowsJson(data)}\n`;
}

/**
 * The file's lines with the body of the request whose line is `requestLine` (from 1) replaced by
 * `body`, and a Content-Type header added when it has none: { lines, row } (`row` the body's first line).
 * Its response handlers and >> line stay where they are.
 */
export function replaceBody(lines, requestLine, body, { contentType = 'application/json' } = {}) {
  const out = [...lines];
  let i = requestLine;
  while (i < out.length && /^\s*[?&]/.test(out[i])) i++;
  let headerEnd = i;
  let typed = false;
  while (headerEnd < out.length && out[headerEnd].trim() && !/^###/.test(out[headerEnd])) {
    if (/^\s*content-type\s*:/i.test(out[headerEnd])) typed = true;
    headerEnd++;
  }
  let end = headerEnd;
  while (end < out.length && !/^###/.test(out[end])) end++;
  const bodyLines = body.split('\n');
  let row;
  if (headerEnd >= end) {
    // No blank line after the headers: the body goes in after one, with one before the next request.
    out.splice(headerEnd, 0, '', ...bodyLines, ...(end < out.length ? [''] : []));
    row = headerEnd + 1;
  } else {
    let start = headerEnd + 1;
    let stop = start;
    while (stop < end && !/^\s*(>|<>)/.test(out[stop])) stop++;
    while (stop > start && !out[stop - 1].trim()) stop--;
    while (start < stop && !out[start].trim()) start++;
    out.splice(start, stop - start, ...bodyLines);
    row = start;
  }
  if (!typed && contentType) {
    out.splice(headerEnd, 0, `Content-Type: ${contentType}`);
    row++;
  }
  return { lines: out, row };
}

// The headers a request's id travels in, either way: X-Request-Id, Request-Id, traceparent,
// correlation ids, and the clouds' own.
const ID_HEADER = /request-?id|correlation-?id|trace-?id|operation-?id|traceparent|x-b3-traceid|cloud-trace-context/i;

/** The values to match an id against in one header: the value, and a traceparent's or X-Amzn-Trace-Id's trace id. */
function idValues(name, value) {
  const v = String(value ?? '').trim();
  const out = [v];
  const tp = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/i.exec(v);
  if (tp) out.push(tp[1], tp[2]);
  const root = /Root=([\w-]+)/.exec(v);
  if (root) out.push(root[1]);
  return out.filter(Boolean);
}

/** The ids in a log line's text: GUIDs, 32-hex trace ids, and what follows "request id". */
export function idsIn(text) {
  const s = String(text ?? '');
  const out = [];
  for (const m of s.matchAll(/request[ _-]?id["']?\s*[=:]\s*["']?([\w.|:-]{6,})/gi)) out.push(m[1]);
  for (const m of s.matchAll(/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b/gi)) out.push(m[0]);
  for (const m of s.matchAll(/\b[\da-f]{32}\b/gi)) out.push(m[0]);
  return [...new Set(out)];
}

/**
 * The newest kept response (history.js entries, oldest first) whose request or response headers carry
 * one of `ids`: { entry, header } or null. A long id also matches inside a value (|abc.1. Request-Ids).
 */
export function findByRequestId(entries, ids) {
  const wanted = ids.map((id) => String(id).trim().toLowerCase()).filter(Boolean);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    for (const [k, v] of [...(e.request?.headers ?? []), ...(e.response?.headers ?? [])]) {
      if (!ID_HEADER.test(k)) continue;
      const values = idValues(k, v).map((x) => x.toLowerCase());
      if (wanted.some((id) => values.some((x) => x === id || (id.length >= 8 && x.includes(id))))) return { entry: e, header: k };
    }
  }
  return null;
}
