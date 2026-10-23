// What a response looks like on screen, as lines of segments: the status, how long it took and how
// big it was, the headers when they're asked for, then the body (JSON indented). Shared by the pane
// beside the request list and the Response view.
import { formatSize, prettyBody } from '../send.js';
import { theme } from '../theme.js';
import { relTime, wrap } from '../text.js';

/** A line wrapped to `width`, its indent kept on every part (wrap would drop it, and JSON needs it). */
export function wrapIndented(line, width) {
  if (!line) return [''];
  const indent = /^\s*/.exec(line)[0];
  const room = Math.max(10, width - indent.length);
  return wrap(line.slice(indent.length), room).map((part) => indent + part);
}

export const statusColour = (status) => (status < 300 ? theme.add : status < 400 ? theme.info : status < 500 ? theme.warn : theme.del);

export const METHOD_COLOURS = { GET: '#5fafff', POST: '#5fd75f', PUT: '#ffaf5f', PATCH: '#d7af5f', DELETE: '#ff5f5f', GRAPHQL: '#d787ff' };
export const methodColour = (method) => METHOD_COLOURS[method] ?? theme.dim;

/** The request as written in the file: its line, headers and body, variables unfilled. */
export function requestLines(request, width) {
  const out = [[{ text: `${request.method} `, color: methodColour(request.method), bold: true }, { text: request.url }]];
  for (const [k, v] of request.headers) out.push([{ text: `${k}: `, color: theme.dim }, { text: v }]);
  if (request.bodyFile) out.push([], [{ text: `< ${request.bodyFile.path}`, color: theme.dim }]);
  else if (request.body) out.push([], ...request.body.split('\n').flatMap((l) => wrapIndented(l, width)).map((l) => [{ text: l }]));
  return out;
}

/** How a response's handlers went (runner.js's `checks`): a line per test, the script's error, what it logged. */
export function checkLines(checks) {
  if (!checks) return [];
  const out = [];
  for (const t of checks.tests ?? []) {
    const why = !t.passed && t.message && t.message !== t.name ? [{ text: `: ${t.message}`, color: theme.dim }] : [];
    out.push([{ text: t.passed ? '✓ ' : '✗ ', color: t.passed ? theme.add : theme.del, bold: true }, { text: t.name }, ...why]);
  }
  if (checks.error) out.push([{ text: '✗ ', color: theme.del, bold: true }, { text: checks.error, color: theme.del }]);
  for (const l of checks.log ?? []) out.push([{ text: `› ${l}`, color: theme.dim }]);
  return out;
}

/**
 * `sent` ({ response, request, at, checks }) as lines `width` wide: the status, how its tests went,
 * then the body. `headers` shows the response's headers too.
 */
export function responseLines(sent, width, { headers = false } = {}) {
  const r = sent.response;
  const out = [
    [
      { text: `${r.status} ${r.statusText}`, color: statusColour(r.status), bold: true },
      { text: `  ${r.ms} ms · ${formatSize(r.size)} · ${relTime(sent.at)}`, color: theme.dim },
    ],
  ];
  if (r.url !== sent.request.url) out.push([{ text: `→ ${r.url}`, color: theme.dim }]);
  const location = r.status >= 300 && r.status < 400 ? r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] : null;
  if (location) out.push([{ text: `Redirects to ${location} (not followed: # @no-redirect)`, color: theme.dim }]);
  if (r.insecure) out.push([{ text: '⚠ The certificate wasn\'t checked (the environment\'s SSLConfiguration)', color: theme.warn }]);
  if (r.proxy) out.push([{ text: `Through the proxy ${r.proxy}`, color: theme.dim }]);
  out.push(...checkLines(sent.checks));
  if (headers) for (const [k, v] of r.headers) out.push([{ text: `${k}: `, color: theme.dim }, { text: v }]);
  out.push([]);
  for (const l of prettyBody(r).split('\n')) for (const part of wrapIndented(l, width)) out.push([{ text: part }]);
  return out;
}
