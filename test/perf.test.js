// The shortcuts taken for speed give what the long way gives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../src/history.js';
import { send } from '../src/send.js';
import { highlight, highlightLines } from '../src/http-file.js';
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
