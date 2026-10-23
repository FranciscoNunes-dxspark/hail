// The shortcuts taken for speed give what the long way gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { basePaths, deref, findOperation } from '../src/contract.js';
import { readHistory } from '../src/history.js';
import { parseYaml } from '../src/yaml.js';
import { send } from '../src/send.js';
import { highlight, highlightLines, parseHttpFile } from '../src/http-file.js';
import { wrap } from '../src/text.js';
import { bodyLines, responseLines, wrapIndented } from '../src/ui/response.js';

// wrapIndented as it was, through wrap for every line.
const slowWrap = (line, width) => {
  if (!line) return [''];
  const indent = /^\s*/.exec(line)[0];
  return wrap(line.slice(indent.length), Math.max(10, width - indent.length)).map((part) => indent + part);
};

test('a line that fits skips wrap and comes back as wrap would give it', () => {
  const lines = ['', 'short', '    "id": 1,', '  a  b   c ', ' '.repeat(12), 'x'.repeat(40), '  tab\there', 'wide 漢字 text', 'émigré', `  ${'word '.repeat(30)}`, '    "k": "a long value that goes on past the width of the pane"'];
  for (const width of [5, 10, 20, 40, 80]) for (const l of lines) assert.deepEqual(wrapIndented(l, width), slowWrap(l, width), `${JSON.stringify(l)} at ${width}`);
});

test("a response's body lines are worked out once per width, and responseLines ends with them", () => {
  const response = { status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], body: JSON.stringify({ items: [1, 2], text: 'word '.repeat(40) }), ms: 5, size: 10, url: 'http://x/' };
  const sent = { request: { method: 'GET', url: 'http://x/' }, response, at: Date.now() };
  const a = bodyLines(response, 40);
  assert.equal(bodyLines(response, 40), a, 'the same array the second time');
  assert.notEqual(bodyLines(response, 60), a, 'another width, other lines');
  assert.equal(bodyLines(response, 40), a, 'and the first width is still kept');
  const lines = responseLines(sent, 40);
  assert.deepEqual(lines.slice(-a.length), a);
  assert.deepEqual(a.map((l) => l[0].text), JSON.stringify(JSON.parse(response.body), null, 2).split('\n').flatMap((l) => slowWrap(l, 40)));
  // Another response with the same body is its own.
  assert.notEqual(bodyLines({ ...response }, 40), a);
});

const FILE = `@host = https://example.com
# a comment

### Upload
# @no-redirect
# @name up
POST {{host}}/upload
Content-Type: multipart/form-data; boundary=B

--B
Content-Disposition: form-data; name="f"

< ./f.png
--B
### Q
GRAPHQL /graphql

query Hero {
  hero { name }
}
###
GET {{host}}/items
  ?a=1
  &b=2
Accept: application/json

{ "x": "{{y}}" }

> {%
  client.test("ok", () => {});
%}
>> ./out.json
### Last
POST /x
X-Request-Type: GraphQL

mutation M { m }`;

test('the rows on screen are coloured as the whole file colours them', () => {
  const lines = FILE.split('\n');
  const whole = highlight(FILE);
  for (let from = 0; from < lines.length; from++) for (let to = from; to <= lines.length; to++) assert.deepEqual(highlightLines(lines, from, to), whole.slice(from, to), `rows ${from} to ${to}`);
});

test("a request's body after a multipart part left open is still a body, not a part's headers", () => {
  const kinds = highlight(FILE).map((runs) => runs.map((r) => r.kind ?? '-').join(' '));
  // "--B" then ### Q: the next request starts afresh.
  assert.equal(kinds[17], 'keyword -');
});

test('history read from its bytes: characters of every width, CRLF, blank lines and a line cut short', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hail-perf-'));
  try {
    const file = join(dir, 'h.jsonl');
    const bodies = ['plain', 'café ☕ 漢字 🦉', 'a\nb', '"quoted"\\'];
    writeFileSync(file, `${bodies.map((body, i) => JSON.stringify({ label: `r${i}`, at: i, response: { body } })).join('\r\n')}\n\n  \n{"label":"cut","at":`);
    assert.deepEqual(readHistory(file).map((e) => e.response.body), bodies);
    writeFileSync(file, '');
    assert.deepEqual(readHistory(file), []);
    assert.deepEqual(readHistory(join(dir, 'none.jsonl')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('requests sharing one signal leave no listeners on it, and it still cancels them', async () => {
  const server = createServer((req, res) => (req.url === '/slow' ? setTimeout(() => res.end('late'), 5000) : res.end('{"ok":true}')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const controller = new AbortController();
    await Promise.all(Array.from({ length: 50 }, () => send({ method: 'GET', url: `${url}/`, headers: [] }, { signal: controller.signal })));
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const slow = send({ method: 'GET', url: `${url}/slow`, headers: [] }, { signal: controller.signal, timeout: 10_000 });
    setTimeout(() => controller.abort(), 50);
    await assert.rejects(slow, (e) => e.cancelled === true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    await assert.rejects(send({ method: 'GET', url: `${url}/`, headers: [] }, { signal: controller.signal }), (e) => e.cancelled === true, 'already cancelled');
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test('a file parsed again after an edit reads as it does parsed afresh, and changing what it gave changes nothing kept', () => {
  let text = FILE;
  const edits = [(t) => t.replace('/items', '/things'), (t) => `### New\nGET /new\n\n${t}`, (t) => t.replace('### Q\n', ''), (t) => t.replace('@host = https://example.com', '@host = http://localhost'), (t) => `${t}\n###\nGET /x\n> ./check.js`];
  for (const edit of edits) {
    const before = parseHttpFile(text);
    text = edit(text);
    const warm = JSON.stringify(parseHttpFile(text));
    parseHttpFile('GET /nothing-in-common');
    assert.equal(warm, JSON.stringify(parseHttpFile(text)), 'the same as a parse that kept nothing');
    assert.ok(before.requests.length);
  }
  const a = parseHttpFile(text);
  const handlers = a.requests[2].handlers.length;
  a.requests[1].headers.push(['X-Added', '1']);
  a.requests[1].options.timeout = '5';
  a.requests[2].handlers.push({ file: 'x.js', line: 1 });
  const b = parseHttpFile(text);
  assert.deepEqual(b.requests[1].headers.map(([k]) => k), ['Content-Type']);
  assert.deepEqual(b.requests[1].options, { 'no-redirect': true });
  assert.equal(b.requests[2].handlers.length, handlers);
  // The same block twice in a file: each request its own, with its own line.
  const twice = parseHttpFile('###\nGET /a\n###\nGET /a\n');
  assert.deepEqual(twice.requests.map((r) => [r.index, r.line]), [[0, 2], [1, 4]]);
});

test("a pane's first rows of a body are the whole body's first rows, worked out alone or taken from it", () => {
  const bodies = ['', 'one line', 'ends in a newline\n', 'a\n\nb\n\n', JSON.stringify({ text: 'word '.repeat(50), list: [1, 2, 3] }), 'x'.repeat(300)];
  for (const body of bodies) {
    for (const width of [10, 40]) {
      const fresh = () => ({ status: 200, statusText: 'OK', headers: [['Content-Type', /^\{/.test(body) ? 'application/json' : 'text/plain']], body, ms: 1, size: body.length, url: 'u' });
      const whole = bodyLines(fresh(), width);
      for (const rows of [0, 1, 2, 3, 5, 100]) {
        assert.deepEqual(bodyLines(fresh(), width, rows), whole.slice(0, rows), `${JSON.stringify(body.slice(0, 20))} ${width}×${rows} alone`);
        const r = fresh();
        bodyLines(r, width);
        assert.deepEqual(bodyLines(r, width, rows), whole.slice(0, rows), 'from the whole');
      }
      const sent = { request: { method: 'GET', url: 'u' }, response: fresh(), at: Date.now() };
      const all = responseLines(sent, width);
      assert.deepEqual(responseLines(sent, width, { rows: 3 }), all.slice(0, all.length - whole.length + 3).slice(0, all.length));
    }
  }
});

test("an operation is found as matching every path's expression in turn finds it", () => {
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const templateRe = (template) => ({
    re: new RegExp(`^${template.replace(/\/+$/, '').split(/(\{[^}]+\})/).map((part) => (/^\{[^}]+\}$/.test(part) ? '[^/]+' : escapeRe(part))).join('')}/?$`),
    params: (template.match(/\{[^}]+\}/g) ?? []).length,
  });
  // findOperation as it was, every template made into an expression on every call.
  const slow = (spec, method, url) => {
    let path;
    try {
      path = decodeURI(new URL(url).pathname) || '/';
    } catch {
      path = '/';
    }
    const m = method.toLowerCase();
    for (const base of basePaths(spec)) {
      if (base && !(path === base || path.startsWith(`${base}/`))) continue;
      const rest = path.slice(base.length) || '/';
      const hits = Object.keys(spec.paths).map((template) => ({ template, ...templateRe(template) })).filter((t) => t.re.test(rest) || (rest === '/' && t.template === '/')).sort((a, b) => a.params - b.params);
      if (!hits.length) continue;
      const hit = hits.find((h) => spec.paths[h.template]?.[m]) ?? hits[0];
      return { path: hit.template, method: m.toUpperCase(), op: spec.paths[hit.template]?.[m] ?? null };
    }
    return null;
  };
  const ok = { responses: {} };
  const spec = {
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: { '/': { get: ok }, '/users': { get: ok }, '/users/': { post: ok }, '/users/{id}': { get: ok }, '/users/me': { get: ok }, '/users/{id}/posts/{post}': { get: ok }, '/files/{name}.{ext}': { get: ok }, '/a+b/(c)': { get: ok }, '/v1': { get: ok }, '{all}': { get: ok } },
  };
  const urls = ['/', '/v1', '/v1/', '/users', '/users/', '/users/7', '/users/me', '/users/7/posts/3', '/v1/users/7', '/files/a.txt', '/files/a', '/a+b/(c)', '/ab/c', '/nothing/here', '/users/7/', '/x%20y'];
  for (const url of urls) for (const method of ['GET', 'POST', 'DELETE']) assert.deepEqual(findOperation(spec, method, `http://h${url}`), slow(spec, method, `http://h${url}`), `${method} ${url}`);
});

test('a $ref leads where it led the first time, through chains, escapes and dead ends', () => {
  const spec = { components: { schemas: { A: { $ref: '#/components/schemas/B' }, B: { type: 'string' }, 'a/b~c': { type: 'integer' }, Loop: { $ref: '#/components/schemas/Loop' } } } };
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(deref(spec, { $ref: '#/components/schemas/A' }), { type: 'string' });
    assert.deepEqual(deref(spec, { $ref: '#/components/schemas/a~1b~0c' }), { type: 'integer' });
    assert.equal(deref(spec, { $ref: '#/components/schemas/Nope' }), null);
    assert.equal(deref(spec, { $ref: '#/components/schemas/Loop' }), null);
    assert.equal(deref(spec, { $ref: 'other.json#/x' }), null);
    assert.deepEqual(deref(spec, { type: 'object' }), { type: 'object' });
    assert.equal(deref(spec, null), null);
    assert.equal(deref(spec, false), false);
  }
  assert.equal(deref(null, { $ref: '#/x' }), null);
  // Another spec has its own answers.
  assert.deepEqual(deref({ components: { schemas: { A: { type: 'number' } } } }, { $ref: '#/components/schemas/A' }), { type: 'number' });
});

test('double-quoted YAML without a backslash reads as it always did, and with one is still unescaped', () => {
  assert.deepEqual(parseYaml('"a b": "c: d # e"\n"x": ""\ny: "tab\there"\nz: "say \\"hi\\"\\n"\nw: "\\u00e9t\\x41"\n'), { 'a b': 'c: d # e', x: '', y: 'tab  here', z: 'say "hi"\n', w: 'étA' });
  assert.deepEqual(parseYaml('k: "one\n  two"\n'), { k: 'one two' });
  assert.deepEqual(parseYaml('list: ["a", "b, c", \'d\']\n'), { list: ['a', 'b, c', 'd'] });
});
