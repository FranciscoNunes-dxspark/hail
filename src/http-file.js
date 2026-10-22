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
// filled in. JetBrains' response handlers (`> {% ... %}`) and response files (`<> ...`) are left out.

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

const SEPARATOR = /^###/;
const COMMENT = /^\s*(#|\/\/)/;
const NAME = /^\s*(?:#|\/\/)\s*@name\s+(\S+)/;
const FILE_VARIABLE = /^\s*@([A-Za-z_][\w.-]*)\s*=\s*(.*?)\s*$/;
// The URL may hold spaces inside {{...}} ({{$randomInt 1 10}}). Without a method, a line only counts
// as a request when it starts like a URL, so stray text above a request isn't taken for one.
const REQUEST_LINE = new RegExp(`^\\s*(?:(?:(${METHODS.join('|')})\\s+(.+?))|((?:https?:\\/\\/|\\{\\{|\\/).*?))(?:\\s+HTTP\\/[\\d.]+)?\\s*$`, 'i');
const HEADER = /^\s*([^:\s][^:]*?)\s*:\s*(.*?)\s*$/;

/**
 * The file's variables and requests: { variables: { name: value }, requests: [{ index, name, label,
 * method, url, headers: [[name, value]], body, bodyFile: { path, fill }, line }] }. `line` is where the
 * request line is (from 1); `label` is what a list shows: the name, else the method and URL.
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
    // Before the request line: comments (one may name it), blank lines and file variables.
    let request = null;
    for (; i < end; i++) {
      const l = lines[i];
      const named = NAME.exec(l);
      if (named) name = named[1];
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
      if (COMMENT.test(lines[i])) continue;
      const h = HEADER.exec(lines[i]);
      if (h) headers.push([h[1], h[2]]);
    }
    // The body: what's left, without a response handler or response file and the blank lines round it.
    const rest = [];
    for (i++; i < end; i++) {
      if (/^\s*>\s*(\{%|\S)/.test(lines[i]) || /^\s*<>/.test(lines[i])) break;
      rest.push(lines[i]);
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
    requests.push({ index, name, label: name ?? `${request.method} ${request.url}`, ...request, headers, body, bodyFile });
  });
  return { variables, requests };
}

/** The request under line `line` (from 1) of the file: the last one starting at or above it. */
export function requestAtLine(requests, line) {
  return requests.filter((r) => r.line <= line).at(-1) ?? requests[0] ?? null;
}
