// What the sibling apps hand Hail: /take request, rows and logline, the pure parts and through the UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeContext, takeLine } from '../src/family.js';
import { findByRequestId, hostVariable, idsIn, replaceBody, replayBlock, rowsJson, rowsRequestBlock } from '../src/takes.js';
import { KEYS, start, tempHome, until } from './helpers.js';

test('a replayed request: its path under {{host}} or as it came, connection and credential headers left out', () => {
  const data = { method: 'post', url: 'https://prod.example.com/api/orders?x=1', headers: { Host: 'prod', 'Content-Type': 'application/json', Authorization: 'Bearer z', 'X-Trace': 'a' }, body: '{"id":1}' };
  const r = replayBlock(data, { hostVar: 'baseUrl' });
  assert.equal(r.block, '### replay POST /api/orders\nPOST {{baseUrl}}/api/orders?x=1\nContent-Type: application/json\nX-Trace: a\n\n{\n  "id": 1\n}\n');
  assert.deepEqual(r.dropped, ['Authorization']);
  assert.match(replayBlock({ url: 'https://prod.example.com/a' }).block, /^### replay GET \/a\nGET https:\/\/prod\.example\.com\/a\n$/);
  assert.equal(hostVariable({ baseURL: 'x' }), 'baseURL');
  assert.equal(hostVariable({ other: 'x' }), null);
});

test('rows as JSON, a new request, or the body of one replaced', () => {
  const data = { table: 'dbo.Orders', columns: ['id', 'name'], rows: [[1, 'a'], [2, null]] };
  assert.deepEqual(JSON.parse(rowsJson(data)), [{ id: 1, name: 'a' }, { id: 2, name: null }]);
  assert.deepEqual(JSON.parse(rowsJson({ ...data, rows: [[1, 'a']] })), { id: 1, name: 'a' });
  assert.match(rowsRequestBlock(data), /^### POST Orders\nPOST \{\{host\}\}\/Orders\nContent-Type: application\/json\n\n\[/);
  const lines = ['### One', 'POST http://x/a', 'Accept: */*', '', 'old', 'body', '', '> {% client.log(1) %}', '', '### Two', 'GET http://x/b', '### Three', 'PUT http://x/c', 'Content-Type: text/plain'];
  const one = replaceBody(lines, 2, '{\n  "a": 1\n}');
  assert.deepEqual(one.lines.slice(0, 10), ['### One', 'POST http://x/a', 'Accept: */*', 'Content-Type: application/json', '', '{', '  "a": 1', '}', '', '> {% client.log(1) %}']);
  assert.equal(one.row, 5);
  const two = replaceBody(lines, 11, '[]');
  assert.deepEqual(two.lines.slice(9, 15), ['### Two', 'GET http://x/b', 'Content-Type: application/json', '', '[]', '']);
  const three = replaceBody(lines, 13, '{}');
  assert.deepEqual(three.lines.slice(11), ['### Three', 'PUT http://x/c', 'Content-Type: text/plain', '', '{}']);
});

test('a request found by its id, in either side\'s headers, traceparent included', () => {
  const entry = (at, req, res) => ({ at, label: `r${at}`, request: { headers: req }, response: { headers: res } });
  const entries = [
    entry(1, [['X-Request-Id', 'abc-123-def']], []),
    entry(2, [], [['traceparent', '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01']]),
    entry(3, [['Authorization', 'abc-123-def']], [['request-id', '|9f2c1b7e.1.']]),
  ];
  assert.equal(findByRequestId(entries, ['ABC-123-DEF']).entry.at, 1);
  assert.equal(findByRequestId(entries, ['0af7651916cd43dd8448eb211c80319c']).entry.at, 2);
  assert.equal(findByRequestId(entries, ['9f2c1b7e']).entry.at, 3);
  assert.equal(findByRequestId(entries, ['nope']), null);
  assert.deepEqual(idsIn('GET /x 500 requestId=r-77aa91 trace 0af7651916cd43dd8448eb211c80319c'), ['r-77aa91', '0af7651916cd43dd8448eb211c80319c']);
});

let cleanup;
let dir;
let server;
const seen = [];
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-take-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.setHeader('X-Request-Id', `rid-${seen.length}-0000`);
      res.end('{"ok":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ local: { host } }));
  writeFileSync(join(dir, 'api.http'), `### Orders\nPOST {{host}}/orders\n\n{ "old": true }\n`);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

/** Types a line into the prompt in one go, as a paste after / would, and runs it. */
async function run(app, line) {
  app.stdin.write('/');
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(line.replace(/^\//, ''));
  await new Promise((r) => setTimeout(r, 50));
  app.stdin.write(KEYS.enter);
}

test('/take request replays it against the environment, picked and ready to send', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Orders'), 'the requests');
    await run(app, takeLine('request', { method: 'GET', url: 'https://prod.example.com/orders/42?full=1', headers: { Accept: 'application/json', Cookie: 'x=1' } }));
    await until(() => frame().includes('To local'), 'the question');
    assert.match(frame(), /As it came {2}https:\/\/prod\.example\.com/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Added replay GET /orders/42'), 'the request added');
    assert.match(readFileSync(join(dir, 'api.http'), 'utf8'), /### replay GET \/orders\/42\nGET \{\{host\}\}\/orders\/42\?full=1\nAccept: application\/json\n$/);
    assert.match(frame(), /❯ GET +replay GET \/orders\/42/);
    app.stdin.write(KEYS.enter);
    await until(() => seen.some((s) => s.url === '/orders/42?full=1'), 'it sent to the local server');
    // Another app's kind says whose it is.
    await run(app, encodeContext('commit', { hash: 'abc' }));
    await until(() => frame().includes("That's for Splice"), 'whose it is');
  } finally {
    app.unmount();
  }
});
