// The mock: kept responses served at their method and path, the contract's examples where there are
// none, a 404 that says what's served; /mock in the app and `hail mock` from the shell.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory, entryFor, historyFile } from '../src/history.js';
import { mockArgs, runMock } from '../src/headless.js';
import { matchRoute, notServed, routeOf, routesFor, startMock } from '../src/mock.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let api;
let base;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-mock-'));
  api = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Set-Cookie', 'sid=secret-cookie');
    res.setHeader('X-Kept', 'yes');
    res.statusCode = req.url === '/api/users' ? 201 : 200;
    res.end(JSON.stringify({ from: 'the real api', path: req.url }));
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
});
after(() => {
  api.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

const req = (method, url, label = `${method} ${url}`) => ({ method, url, label, headers: [], body: '' });
const kept = (label, status, body, headers = [['Content-Type', 'application/json']]) =>
  entryFor({ label, at: Date.now(), request: { method: 'GET', url: 'x', headers: [], body: '', secrets: [] }, response: { status, statusText: 'OK', headers, body, ms: 1, size: body.length, url: 'x' } });

test('a request is served at its path, its {{variables}} as any segment, the host variable\'s own path kept', () => {
  assert.equal(routeOf(req('GET', '{{host}}/users/{{id}}?full=1'), { host: 'http://localhost:3000/api' }).template, '/api/users/{id}');
  assert.equal(routeOf(req('GET', '{{base}}/users'), {}).template, '/users');
  assert.equal(routeOf(req('POST', 'https://x.example.com/v1/orders')).template, '/v1/orders');
  assert.equal(routeOf(req('GRAPHQL', 'http://h/graphql')).method, 'POST');
  assert.equal(routeOf(req('WEBSOCKET', 'ws://h/x')), null);
  const requests = [req('GET', '{{host}}/users/{{id}}', 'One'), req('GET', '{{host}}/users/me', 'Me'), req('GET', '{{host}}/never', 'Never sent')];
  const spec = { openapi: '3.0.0', servers: [{ url: '/api' }], paths: { '/users/{id}': { get: {} }, '/health': { get: { summary: 'Health', responses: { 200: { content: { 'application/json': { example: { ok: true } } } } } } } } };
  const routes = routesFor({ requests, entries: [kept('One', 200, '{"id":1}'), kept('Me', 200, '{"me":true}')], vars: { host: 'http://h/api' }, spec });
  assert.deepEqual(routes.map((r) => `${r.method} ${r.template} ${r.source}`), ['GET /api/users/{id} history', 'GET /api/users/me history', 'GET /api/health contract']);
  assert.equal(matchRoute(routes, 'GET', '/api/users/me').label, 'Me', 'the fixed segment wins');
  assert.equal(matchRoute(routes, 'GET', '/api/users/7?x=1').label, 'One');
  assert.equal(matchRoute(routes, 'HEAD', '/api/health').response.body, '{\n  "ok": true\n}');
  assert.equal(matchRoute(routes, 'POST', '/api/users/7'), null);
  assert.match(notServed(routes, 'POST', '/x').serves.join('\n'), /GET \/api\/health {2}\(Health, from the contract\)/);
});

test('the server hands on the kept response without credentials, answers CORS, and says what it serves on a 404', async () => {
  const hits = [];
  const routes = routesFor({ requests: [req('GET', 'http://h/users/{{id}}', 'User')], entries: [kept('User', 200, '{"id":1}', [['Content-Type', 'application/json'], ['Set-Cookie', '••••••'], ['Authorization', '••••••'], ['Content-Length', '8'], ['X-Kept', 'yes']])] });
  const m = await startMock({ port: 0, routes: () => routes, onHit: (h) => hits.push(h) });
  try {
    const r = await fetch(`http://127.0.0.1:${m.port}/users/5`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{"id":1}');
    assert.equal(r.headers.get('x-kept'), 'yes');
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('x-hail-mock'), 'User');
    const pre = await fetch(`http://127.0.0.1:${m.port}/users/5`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const none = await fetch(`http://127.0.0.1:${m.port}/nope`);
    assert.equal(none.status, 404);
    assert.deepEqual((await none.json()).serves, ['GET /users/{id}  (User)']);
    assert.deepEqual(hits.map((h) => h.status), [200, 204, 404]);
  } finally {
    await m.close();
  }
  assert.deepEqual(mockArgs(['api.http', '--port', '5000', '--env', 'dev']), { file: 'api.http', env: 'dev', port: 5000, help: false });
  assert.match(mockArgs(['--port', 'x']).problem, /port number/);
});

test('hail mock serves the history of the file from the shell, read again as it grows', async () => {
  const file = join(dir, 'shell.http');
  writeFileSync(file, '@host = http://example.com/v2\n\n### Item\nGET {{host}}/items/{{id}}\n\n### List\nGET {{host}}/items\n');
  const hf = historyFile(file);
  appendHistory(hf, kept('Item', 200, '{"item":true}'));
  const out = [];
  const mock = await runMock([file, '--port', '0'], { print: (l) => out.push(l), printError: (l) => out.push(l), config: {}, cwd: dir });
  try {
    assert.equal(mock.code, null, out.join('\n'));
    assert.match(out.join('\n'), /Mock of shell\.http on http:\/\/127\.0\.0\.1:\d+ · 1 route\n {2}GET {4}\/v2\/items\/\{id\} {2}Item/);
    assert.equal(await (await fetch(`http://127.0.0.1:${mock.port}/v2/items/3`)).text(), '{"item":true}');
    assert.equal((await fetch(`http://127.0.0.1:${mock.port}/v2/items`)).status, 404);
    // Hail keeps another response: served from then on (the file's time stamp moves on).
    await new Promise((r) => setTimeout(r, 30));
    appendHistory(hf, kept('List', 200, '[1,2]'));
    let status = 404;
    for (let i = 0; i < 50 && status !== 200; i++) {
      status = (await fetch(`http://127.0.0.1:${mock.port}/v2/items`)).status;
      if (status !== 200) await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(status, 200);
    assert.match(out.join('\n'), /GET \/v2\/items\/3 → 200 {2}Item/);
  } finally {
    await mock.close?.();
  }
});

test('/mock in the app: in the header, the kept response served, each hit in the Log, /mock again stops it', async () => {
  writeFileSync(join(dir, 'app.http'), `@host = ${base}/api\n\n### Create\nPOST {{host}}/users\n`);
  const app = start({ initialFile: join(dir, 'app.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Create'), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => /POST\s+201 Create/.test(f()), 'its response');
    app.stdin.write('/');
    await type(app.stdin, 'mock 0');
    app.stdin.write(KEYS.enter);
    await until(() => /mock :\d+/.test(f()), 'the mock in the header');
    const port = /mock :(\d+)/.exec(f())[1];
    assert.match(f(), /Mock of app\.http on http:\/\/127\.0\.0\.1:\d+: 1 route/);
    const r = await fetch(`http://127.0.0.1:${port}/api/users`, { method: 'POST' });
    assert.equal(r.status, 201);
    assert.deepEqual(await r.json(), { from: 'the real api', path: '/api/users' });
    assert.equal(r.headers.get('set-cookie'), null);
    await until(() => f().includes('mock POST /api/users → 201'), 'the hit in the activity lines');
    app.stdin.write('/');
    await type(app.stdin, 'mock');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Stopped the mock') && !/mock :\d+/.test(f()), 'stopped');
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/users`));
  } finally {
    app.unmount();
  }
});
