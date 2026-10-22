// Claude through the Claude Code CLI (`claude -p`), signed in as you already are, so Hail never sees a
// key; Splice asks it the same way. The prompts and the reading of answers are pure, for tests; `ask`
// runs the CLI, and App takes it as the `askClaude` prop so tests stub it.
import { execFile } from 'node:child_process';
import { parseHttpFile } from './http-file.js';

// Each flag takes seconds off a call: no MCP servers to start, no settings files (whose hooks and
// plugins load on every run), no skills, and nothing saved to your session history.
const FLAGS = ['--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'];

/** Asks Claude `prompt` about `input` (sent on stdin), in `cwd`, with no tools. */
export function ask(prompt, { input = '', cwd, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('claude', ['-p', prompt, '--tools', '', ...FLAGS], { cwd, signal, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout.trim());
      if (err.name === 'AbortError') return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      if (err.code === 'ENOENT') return reject(new Error('Claude Code (claude) is not installed or not on the PATH. Get it from https://claude.com/claude-code'));
      reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join('\n')));
    });
    child.stdin.end(input);
  });
}

const MAX_INPUT = 200_000;

/** Keeps what's sent to Claude to a sensible size, saying where it was cut. */
export function clip(text, max = MAX_INPUT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Cut here: the rest (${(text.length - max).toLocaleString('en')} more characters) was left out.]`;
}

/**
 * What to ask for requests drafted from an API description (OpenAPI, Swagger, or any text that
 * describes the routes, which goes on stdin). `want` is what to write ("the user endpoints"); `known`
 * says what the open file has already, so the draft uses its variables and doesn't repeat it.
 */
export function draftPrompt({ want, variables = [], environment = [], labels = [] }) {
  return [
    'Write HTTP requests in the .http file format that VS Code\'s REST Client and JetBrains\' HTTP Client read, for the API described on standard input (an OpenAPI or Swagger document, or code or notes describing its routes).',
    want ? `Write requests for: ${want}.` : 'Write one request for each operation, or for the most useful ones if there are more than about 25.',
    'The format: "### <a short title>" starts each request; the next line is "# @name <camelCaseName>"; then "METHOD {{host}}/path HTTP/1.1"; then headers, one per line; then a blank line and the body, if there is one.',
    'Use {{host}} for the base URL. Write path parameters as {{variables}} (like {{userId}}), query parameters in the URL, and a realistic example body (JSON indented) with a Content-Type header for each request that takes one.',
    'For authentication, use a header with a variable, like "Authorization: Bearer {{token}}", never a made-up secret. Where a request needs an id another request returns, use {{otherName.response.body.path}}.',
    variables.length || environment.length
      ? `The file already has these variables, so use them rather than declaring new ones: ${[...new Set([...variables, ...environment])].join(', ')}.`
      : 'If the description names a server, start with one line "@host = <its URL>"; otherwise leave {{host}} undeclared.',
    labels.length ? `The file already has these requests, so leave them out: ${labels.join('; ')}.` : '',
    'Reply with the .http text only: no explanation, no code fences.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Claude's answer as .http text and the requests in it: fences and talk round it taken off. Throws if there are none. */
export function parseDraft(answer) {
  let text = String(answer).replace(/\r\n?/g, '\n').trim();
  const fenced = /```[a-z]*\n([\s\S]*?)\n```/.exec(text);
  if (fenced) text = fenced[1].trim();
  // Anything said before the first request or variable isn't part of the file.
  const start = text.search(/^(###|@[\w.-]+\s*=)/m);
  if (start > 0) text = text.slice(start);
  const { requests } = parseHttpFile(text);
  if (!requests.length) throw new Error("Claude's answer had no requests in it");
  return { text: `${text}\n`, requests };
}
