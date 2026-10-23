// Reading .http files: the format VS Code's REST Client and JetBrains' HTTP Client share. Pure.
//
//   @host = https://example.com              a file variable
//   ### Log in                               starts a request; the rest of the line names it
//   # @name login                            names it too (VS Code), so others can use its response
//   POST {{host}}/login HTTP/1.1             the request line: a method (GET if none) and a URL
//   Content-Type: application/json           headers, up to the first blank line
//
//   { "user": "{{user}}" }                   the body, up to the next ###
//
// A body can come from a file instead: `< ./body.json` as it is, `<@ ./body.json` with its variables
// filled in. After the body, JetBrains' response handlers: `> {% ... %}` (a script, which may run over
// several lines) or `> ./checks.js`, run on what comes back (checks.js). `<> ...` (an earlier response
// file) is left out. `>> ./out.json` saves the response's body to a file (a new name if it's there
// already), `>>! ./out.json` over it. Comments like `# @no-redirect` before the request line or among the headers are
// directives, kept in `options`.

// GRAPHQL is JetBrains': a GraphQL query, POSTed as JSON (bodies.js).
export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'GRAPHQL'];

const SEPARATOR = /^###/;
const COMMENT = /^\s*(#|\/\/)/;
const NAME = /^\s*(?:#|\/\/)\s*@name(?:\s*=\s*|\s+)(\S+)/;
// `# @no-redirect`, `# @timeout 30`: what JetBrains calls directives, with or without a value.
const DIRECTIVE = /^\s*(?:#|\/\/)\s*@([a-z][\w-]*)(?:\s*=?\s*(.*?))?\s*$/i;
// A response handler after the body: a script between {% and %}, or a file of one.
const HANDLER = /^\s*>\s*(\{%|\S)/;
const FILE_VARIABLE = /^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/;
// The URL may hold spaces inside {{...}} ({{$randomInt 1 10}}). Without a method, a line only counts
// as a request when it starts like a URL, so stray text above a request isn't taken for one.
const REQUEST_LINE = new RegExp(`^\\s*(?:(?:(${METHODS.join('|')})\\s+(.+?))|((?:https?:\\/\\/|\\{\\{|\\/).*?))(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');
const HEADER = /^\s*([^:\s][^:]*?)\s*:\s*(.*?)\s*$/;

/** The directives in comment line `l` into `options` (lower-case names; a bare one is true). */
function directive(l, options) {
  const d = DIRECTIVE.exec(l);
  if (d && d[1].toLowerCase() !== 'name') options[d[1].toLowerCase()] = d[2] ? d[2] : true;
}

/**
 * The file's variables and requests: { variables: { name: value }, requests: [{ index, name, label,
 * method, url, headers: [[name, value]], body, bodyFile: { path, fill }, handlers: [{ script | file,
 * line }], output: { path, overwrite }, options, line }] }. `line` is where the request line is (from 1); `label` is what a list
 * shows: the name, else the method and URL. `options` holds the directives (`{ 'no-redirect': true }`).
 */
export function parseHttpFile(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const variables = {};
  const requests = [];
  // Blocks between ### lines, each with the line it starts on.
  const blocks = [{ start: 0, title: '' }];
  lines.forEach((l, i) => {
    if (SEPARATOR.test(l)) blocks.push({ start: i + 1, title: l.replace(/^#+/, '').trim() });
  });
  blocks.forEach((block, b) => {
    const end = b + 1 < blocks.length ? blocks[b + 1].start - 1 : lines.length;
    let name = block.title || null;
    let i = block.start;
    const options = {};
    // Before the request line: comments (one may name it), blank lines and file variables.
    let request = null;
    for (; i < end; i++) {
      const l = lines[i];
      const named = NAME.exec(l);
      if (named) name = named[1];
      else if (COMMENT.test(l)) directive(l, options);
      if (!l.trim() || COMMENT.test(l)) continue;
      const variable = FILE_VARIABLE.exec(l);
      if (variable) {
        variables[variable[1]] = variable[2];
        continue;
      }
      const m = REQUEST_LINE.exec(l);
      if (!m) continue;
      request = { method: (m[1] ?? 'GET').toUpperCase(), url: m[2] ?? m[3], line: i + 1 };
      i++;
      break;
    }
    if (!request) return;
    // Query lines under the URL (VS Code): "?a=1" and "&b=2".
    for (; i < end && /^\s*[?&]/.test(lines[i]); i++) request.url += lines[i].trim();
    const headers = [];
    for (; i < end && lines[i].trim(); i++) {
      if (COMMENT.test(lines[i])) {
        directive(lines[i], options);
        continue;
      }
      const h = HEADER.exec(lines[i]);
      if (h) headers.push([h[1], h[2]]);
    }
    // The body: what's left, without a response handler or response file and the blank lines round it.
    const rest = [];
    for (i++; i < end; i++) {
      if (HANDLER.test(lines[i]) || /^\s*<>/.test(lines[i])) break;
      rest.push(lines[i]);
    }
    // After it: the handlers, and where to save the response.
    const handlers = [];
    let output = null;
    for (; i < end; i++) {
      const l = lines[i];
      const save = /^\s*>>(!?)\s*(\S.*?)\s*$/.exec(l);
      if (save) {
        output = { path: save[2], overwrite: save[1] === '!' };
        continue;
      }
      const script = /^\s*>\s*\{%(.*)$/.exec(l);
      if (script) {
        const line = i + 1;
        let text = script[1];
        while (!text.includes('%}') && i + 1 < end) text += `\n${lines[++i]}`;
        handlers.push({ script: text.replace(/%\}[\s\S]*$/, '').replace(/^\n/, ''), line });
        continue;
      }
      const file = /^\s*>\s+(?!>)(\S.*?)\s*$/.exec(l) ?? /^\s*>(?![>{])(\S.*?)\s*$/.exec(l);
      if (file) handlers.push({ file: file[1], line: i + 1 });
    }
    while (rest.length && !rest.at(-1).trim()) rest.pop();
    while (rest.length && !rest[0].trim()) rest.shift();
    let body = rest.join('\n');
    let bodyFile = null;
    const file = /^<(@?)\s+(.+?)\s*$/.exec(body);
    if (file && rest.length === 1) {
      bodyFile = { path: file[2], fill: file[1] === '@' };
      body = '';
    }
    const index = requests.length;
    requests.push({ index, name, label: name ?? `${request.method} ${request.url}`, ...request, headers, body, bodyFile, handlers, output, options });
  });
  return { variables, requests };
}

// {{placeholders}} inside a run of text, as runs of their own.
function withPlaceholders(text, kind) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(/\{\{.*?\}\}/g)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), kind });
    out.push({ text: m[0], kind: 'placeholder' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), kind });
  return out;
}

/**
 * The text as lines of runs ({ text, kind }) for the editor to colour, read as parseHttpFile reads
 * it: separator, comment, directive (# @no-redirect and the like), variable (an @name), method, url,
 * version, header, value, body, file (a body from a file, or one in a multipart part), boundary (a
 * multipart body's --boundary lines), keyword (a GraphQL query's operation), handler (a response
 * handler) and placeholder ({{...}}). Plain text has no kind.
 */
export function highlight(text) {
  return highlightLines(String(text).replace(/\r\n?/g, '\n').split('\n'));
}

/**
 * highlight's runs for `lines[from]` up to (not including) `lines[to]`, read from the ### line at or
 * above `from`, where each request starts afresh: so the editor colours the rows on screen without
 * reading the whole file on every key.
 */
export function highlightLines(lines, from = 0, to = lines.length) {
  let start = Math.max(0, Math.min(from, lines.length - 1));
  while (start > 0 && !SEPARATOR.test(lines[start])) start--;
  // Where in its request each line is: before the request line, the query lines, headers, body. In
  // the body, a multipart boundary and whether the line is among a part's headers; a GraphQL query.
  let state = 'pre';
  let boundary = null;
  let partHeaders = false;
  let graphql = false;
  const comment = (l) => [{ text: l, kind: /^\s*(#|\/\/)\s*@[a-z]/i.test(l) && !NAME.test(l) ? 'directive' : 'comment' }];
  const headerRuns = (l) => {
    const h = /^(\s*[^:\s][^:]*?)(\s*:\s*)(.*)$/.exec(l);
    return h ? [...withPlaceholders(h[1], 'header'), { text: h[2] }, ...withPlaceholders(h[3], 'value')] : withPlaceholders(l, undefined);
  };
  const runs = lines.slice(start, to).map((l) => {
    if (SEPARATOR.test(l)) {
      state = 'pre';
      boundary = null;
      partHeaders = false;
      graphql = false;
      return [{ text: l, kind: 'separator' }];
    }
    if (state === 'handler') return [{ text: l, kind: /^\s*>>!?\s/.test(l) || /^\s*>\s*[^\s{>]/.test(l) ? 'file' : 'handler' }];
    if (state === 'body' && (HANDLER.test(l) || /^\s*<>/.test(l))) {
      state = 'handler';
      return [{ text: l, kind: /^\s*>>!?\s/.test(l) || /^\s*>\s*[^\s{>]/.test(l) ? 'file' : 'handler' }];
    }
    if (state === 'body') {
      if (boundary && (l.trim() === `--${boundary}` || l.trim() === `--${boundary}--`)) {
        partHeaders = l.trim() === `--${boundary}`;
        return [{ text: l, kind: 'boundary' }];
      }
      if (partHeaders) {
        if (!l.trim()) partHeaders = false;
        else return headerRuns(l);
      }
      if (/^\s*<@?\s+\S/.test(l)) return [{ text: l, kind: 'file' }];
      const op = graphql ? /^(\s*)(query|mutation|subscription|fragment)\b(.*)$/.exec(l) : null;
      if (op) return [{ text: op[1] }, { text: op[2], kind: 'keyword' }, ...withPlaceholders(op[3], undefined)];
      return withPlaceholders(l, undefined);
    }
    if (state === 'query' && !/^\s*[?&]/.test(l)) state = 'headers';
    if (COMMENT.test(l)) return comment(l);
    if (state === 'pre') {
      const variable = /^(\s*@)([A-Za-z_][\w.-]*)(\s*=\s*)(.*)$/.exec(l);
      if (variable) return [{ text: variable[1] + variable[2], kind: 'variable' }, { text: variable[3], kind: 'comment' }, ...withPlaceholders(variable[4], undefined)];
      const m = l.trim() ? REQUEST_LINE.exec(l) : null;
      if (!m) return withPlaceholders(l, undefined);
      state = 'query';
      graphql = (m[1] ?? '').toUpperCase() === 'GRAPHQL';
      const runs = [];
      const method = /^(\s*)([A-Za-z]+)(\s+)/.exec(l);
      let rest = l;
      if (m[1] && method) {
        runs.push({ text: method[1] }, { text: method[2], kind: 'method' }, { text: method[3] });
        rest = l.slice(method[0].length);
      }
      const version = /(\s+HTTP\/[\d.]+\s*)$/i.exec(rest);
      if (version) rest = rest.slice(0, version.index);
      runs.push(...withPlaceholders(rest, 'url'));
      if (version) runs.push({ text: version[1], kind: 'version' });
      return runs;
    }
    if (state === 'query') return withPlaceholders(l, 'url');
    if (!l.trim()) {
      state = 'body';
      return [{ text: l }];
    }
    const h = HEADER.exec(l);
    if (h && /^content-type$/i.test(h[1])) boundary = /^\s*multipart\//i.test(h[2]) ? (/boundary\s*=\s*"?([^";]+)"?/i.exec(h[2])?.[1]?.trim() ?? null) : null;
    if (h && /^x-request-type$/i.test(h[1]) && /^graphql$/i.test(h[2])) graphql = true;
    return headerRuns(l);
  });
  return runs.slice(from - start).map((line) => line.filter((r) => r.text));
}

/** The lines (from 0) of the request block row `row` is in: from its ### line, or the top, to the line before the next. */
export function blockAt(lines, row) {
  let start = row;
  while (start > 0 && !SEPARATOR.test(lines[start])) start--;
  let end = row + 1;
  while (end < lines.length && !SEPARATOR.test(lines[end])) end++;
  return { start, end: end - 1 };
}

/**
 * What line `row` (from 0) is to its request, from the lines above it: 'pre' before the request
 * line (so it may be the request line), 'headers' after it up to the first blank line, then 'body'.
 */
export function roleAt(lines, row) {
  const { start } = blockAt(lines, row);
  let state = 'pre';
  for (let i = SEPARATOR.test(lines[start]) ? start + 1 : start; i < row; i++) {
    const l = lines[i];
    if (state === 'pre' && l.trim() && !COMMENT.test(l) && !FILE_VARIABLE.test(l) && REQUEST_LINE.test(l)) state = 'headers';
    else if (state === 'headers' && !l.trim()) state = 'body';
  }
  return state;
}

/** The request under line `line` (from 1) of the file: the last one starting at or above it. */
export function requestAtLine(requests, line) {
  return requests.filter((r) => r.line <= line).at(-1) ?? requests[0] ?? null;
}
