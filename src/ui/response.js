// What a response looks like on screen, as lines of segments: the status, how long it took and how
// big it was, the headers when they're asked for, then the body (JSON indented). Shared by the pane
// beside the request list and the Response view.
import { driftSummary, issueText } from '../contract.js';
import { formatSize, prettyBody } from '../send.js';
import { theme } from '../theme.js';
import { relTime, wrap } from '../text.js';

const PRINTABLE = /^[\x20-\x7e]*$/;

/** A line wrapped to `width`, its indent kept on every part (wrap would drop it, and JSON needs it). */
export function wrapIndented(line, width) {
  if (!line) return [''];
  // Most lines fit as they are (wrap would give them back whole), so they skip it.
  if (line.length <= width && PRINTABLE.test(line)) return [line];
  const indent = /^\s*/.exec(line)[0];
  const room = Math.max(10, width - indent.length);
  return wrap(line.slice(indent.length), room).map((part) => indent + part);
}

export const statusColour = (status) => (status < 300 ? theme.add : status < 400 ? theme.info : status < 500 ? theme.warn : theme.del);

// Read from the theme as it draws, so a change of theme repaints them.
export const methodColour = (method) => theme.methods[method] ?? theme.dim;

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

/** How a response compares with the contract (contract.js's checkContract): a line, then each difference. */
export function contractLines(result) {
  if (!result) return [];
  if (!result.issues.length) return [[{ text: '✓ ', color: theme.add, bold: true }, { text: `Contract: ${driftSummary(result)}`, color: theme.dim }]];
  const colour = { added: theme.info, missing: theme.del };
  return [
    [{ text: '⚠ ', color: theme.warn, bold: true }, { text: `Contract: ${driftSummary(result)}`, color: theme.warn, bold: true }, { text: result.operation ? `  ${result.operation}${result.status ? ` ${result.status}` : ''}` : '', color: theme.dim }],
    ...result.issues.map((i) => [{ text: `  ${issueText(i)}`, color: colour[i.kind] ?? theme.warn }]),
  ];
}

/**
 * `sent` ({ response, request, at, checks }) as lines `width` wide: the status, how its tests went,
 * how it compares with the contract (`contract`, when there is one), then the body. `headers` shows
 * the response's headers too; `rows` says only that many of the body's lines are needed (at least).
 */
export function responseLines(sent, width, { headers = false, contract = null, rows = Infinity } = {}) {
  const r = sent.response;
  const out = [
    [
      { text: `${r.status} ${r.statusText}`, color: statusColour(r.status), bold: true },
      { text: `  ${r.ms} ms · ${formatSize(r.size)} · ${relTime(sent.at)}`, color: theme.dim },
    ],
  ];
  if (r.streaming) out[0].push({ text: ` · ${r.events} event${r.events === 1 ? '' : 's'} · streaming… (esc stops it)`, color: theme.warn });
  else if (r.stream) out[0].push({ text: ` · ${r.stream.events} event${r.stream.events === 1 ? '' : 's'}${r.stream.stopped ? ' · stopped' : ''}`, color: theme.dim });
  if (r.url !== sent.request.url) out.push([{ text: `→ ${r.url}`, color: theme.dim }]);
  const location = r.status >= 300 && r.status < 400 ? r.headers.find(([k]) => k.toLowerCase() === 'location')?.[1] : null;
  if (location) out.push([{ text: `Redirects to ${location} (not followed: # @no-redirect)`, color: theme.dim }]);
  if (r.insecure) out.push([{ text: '⚠ The certificate wasn\'t checked (the environment\'s SSLConfiguration)', color: theme.warn }]);
  if (r.proxy) out.push([{ text: `Through the proxy ${r.proxy}`, color: theme.dim }]);
  if (sent.saved?.error) out.push([{ text: sent.saved.error, color: theme.del }]);
  else if (sent.saved) out.push([{ text: `Saved to ${sent.saved.shown}`, color: theme.dim }]);
  out.push(...checkLines(sent.checks));
  out.push(...contractLines(contract));
  if (headers) for (const [k, v] of r.headers) out.push([{ text: `${k}: `, color: theme.dim }, { text: v }]);
  out.push([]);
  return out.concat(bodyLines(r, width, rows));
}

// A big body takes a while to indent and wrap, and the views draw on every key, so for each response
// (until it's gone) its pretty-printed body is kept, and its lines at the last few widths drawn whole.
const KEPT = new WeakMap();
const WIDTHS = 4;

const keptFor = (r) => {
  let k = KEPT.get(r);
  if (!k) KEPT.set(r, (k = { pretty: null, widths: new Map() }));
  return k;
};

/**
 * The body of response `r` as lines `width` wide (JSON indented), the same array each time. With
 * `rows`, only the first `rows` of them, which a pane showing the top of it needs: worked out without
 * wrapping the rest, unless the whole is kept already.
 */
export function bodyLines(r, width, rows = Infinity) {
  const k = keptFor(r);
  const whole = k.widths.get(width);
  if (whole) return rows < whole.length ? whole.slice(0, rows) : whole;
  k.pretty ??= prettyBody(r);
  const text = k.pretty;
  if (rows !== Infinity) {
    const out = [];
    for (let at = 0; at <= text.length && out.length < rows; ) {
      let end = text.indexOf('\n', at);
      if (end < 0) end = text.length;
      for (const part of wrapIndented(text.slice(at, end), width)) out.push([{ text: part }]);
      at = end + 1;
    }
    return out.slice(0, rows);
  }
  const lines = [];
  for (const l of text.split('\n')) for (const part of wrapIndented(l, width)) lines.push([{ text: part }]);
  if (k.widths.size >= WIDTHS) k.widths.delete(k.widths.keys().next().value);
  k.widths.set(width, lines);
  return lines;
}
