// Response handlers and sending the whole file, through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-runall-'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/login') return res.end(JSON.stringify({ token: 'tok-1' }));
    res.end(JSON.stringify({ auth: req.headers.authorization ?? null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(dir, 'api.http'),
    `@host = http://127.0.0.1:${server.address().port}

### Log in
POST {{host}}/login

> {%
  client.test("got a token", () => client.assert(response.body.token, "no token"));
  client.global.set("token", response.body.token);
%}

### Me
GET {{host}}/me
Authorization: Bearer {{token}}

> {%
  client.test("token sent", () => client.assert(response.body.auth === "Bearer tok-1"));
  client.test("is an admin", () => client.assert(response.body.admin, "not an admin"));
%}

### Needs more
GET {{host}}/{{nothing}}
`,
  );
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('a response handler\'s tests show with the response, its globals feed later requests, and A sends them all', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Log in') && frame().includes('Needs more'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('✓ got a token'), 'the test beside the response');
    assert.match(frame(), /1 test passed/, 'said in the activity lines');

    app.stdin.write('j');
    await until(() => /❯ GET\s+Me/.test(frame()), 'the second');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('✗ is an admin: not an admin'), 'the failed test');
    assert.match(frame(), /✓ token sent/, 'the global set by the first was sent');
    assert.match(frame(), /1 of 2 tests failed/);
    assert.match(frame(), /GET\s+200 ✗ Me/, 'the list marks it');

    app.stdin.write('A');
    await until(() => frame().includes('Sent all: api.http'), 'the report');
    assert.match(frame(), /✓ 200 Log in\s+\d+ ms\s+1 test passed/);
    assert.match(frame(), /✗ 200 Me\s+\d+ ms\s+1 of 2 tests failed/);
    assert.match(frame(), /Not sent: nothing gives \{\{nothing\}\} a value/);
    assert.match(frame(), /2 requests sent · 1 not sent · 3 tests: 2 passed, 1 failed/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Sent all: api.http'), 'the report closed');

    app.stdin.write('4');
    await until(() => frame().includes('4 kept'), 'History');
    assert.match(frame(), /Me\s+\d+ ms · \d+ B\s+✗ 1\/2/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('✗ is an admin'), 'the tests in the kept response');
    const kept = readdirSync(join(process.env.HAIL_HOME, 'history')).map((f) => readFileSync(join(process.env.HAIL_HOME, 'history', f), 'utf8')).join('');
    assert.match(kept, /"checks":\{"tests":\[\{"name":"got a token","passed":true\}\]/);

    // /send all from the prompt too.
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('4 kept') && !frame().includes('✗ is an admin'), 'History again');
    app.stdin.write('/');
    await type(app.stdin, 'send all');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Sent all: api.http'), 'the report again');
  } finally {
    app.unmount();
  }
});
