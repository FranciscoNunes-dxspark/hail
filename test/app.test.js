// Drives the real UI over a .http file in a temporary folder, against a server on this machine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-files-'));
  // Echoes what it was sent; /login hands out a token.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-Served-By', 'test');
      if (req.url === '/login') return res.end(JSON.stringify({ token: 'tok-123' }));
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization ?? null, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // A port with nothing on it: one that was free a moment ago.
  const spare = createServer();
  await new Promise((r) => spare.listen(0, '127.0.0.1', r));
  const closed = spare.address().port;
  await new Promise((r) => spare.close(r));
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ dev: { host: base }, broken: { host: `http://127.0.0.1:${closed}` } }));
  writeFileSync(
    join(dir, 'api.http'),
    `### Log in
# @name login
POST {{host}}/login
Content-Type: application/json

{ "user": "ana" }

### Who am I
GET {{host}}/me
Authorization: Bearer {{login.response.body.token}}

### Not there
GET {{host}}/missing
`,
  );
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('sending requests, a response used by the next, the full view, curl, environments and reloading', async () => {
  const copied = [];
  const app = start({ initialFile: join(dir, 'api.http'), copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Who am I') && frame().includes('api.http'), 'the requests');
    assert.match(frame(), /env dev/, 'dev, picked by itself');
    assert.match(frame(), /❯ POST\s+login/);
    assert.match(frame(), /POST \{\{host\}\}\/login/, 'the request as written, beside the list');

    // The second needs the first's token: nothing gives it one yet.
    app.stdin.write('j');
    await until(() => /❯ GET\s+Who am I/.test(frame()), 'the cursor on the second');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Nothing gives {{login.response.body.token}} a value'), 'the missing variable');

    app.stdin.write('k');
    await until(() => /❯ POST\s+login/.test(frame()), 'back on login');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ POST\s+200 login/.test(frame()) && frame().includes('"token": "tok-123"'), 'its response beside it');

    app.stdin.write('j');
    await until(() => /❯ GET\s+Who am I/.test(frame()), 'the second again');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"auth": "Bearer tok-123"'), 'the token sent on');

    app.stdin.write('c');
    await until(() => frame().includes('Copied it as curl'), 'curl copied');
    assert.equal(copied.at(-1), `curl '${base}/me' -H 'Authorization: Bearer tok-123'`);

    app.stdin.write('v');
    await until(() => frame().includes('GET Who am I') && frame().includes('h headers'), 'the Response view');
    assert.doesNotMatch(frame(), /x-served-by/);
    app.stdin.write('h');
    await until(() => frame().includes('x-served-by: test'), 'the headers');
    app.stdin.write('y');
    await until(() => frame().includes('Copied the body'), 'the body copied');
    assert.equal(JSON.parse(copied.at(-1)).path, '/me');

    // Another environment: a host with nothing on it.
    app.stdin.write('1');
    await until(() => frame().includes('╭─ api.http'), 'Requests again');
    app.stdin.write('e');
    await until(() => frame().includes('Environment') && frame().includes('broken'), 'the environments');
    app.stdin.write('j');
    await until(() => /❯\s+broken/.test(frame()), 'the cursor on broken');
    app.stdin.write(KEYS.enter);
    await until(() => /env broken/.test(frame()), 'broken picked');
    assert.match(frame(), /❯ GET\s+200 Who am I/, 'the cursor where it was before the Response view');
    app.stdin.write('G');
    await until(() => /❯ GET\s+Not there/.test(frame()), 'the last request');
    app.stdin.write(KEYS.enter);
    await until(() => /nothing is listening at 127\.0\.0\.1:\d+/.test(frame()), 'the network error in words');
    const saved = JSON.parse(readFileSync(join(process.env.HAIL_HOME, 'config.json'), 'utf8'));
    assert.equal(saved.environments[join(dir, 'api.http')], 'broken', 'kept for the file');

    // Saved in an editor: Hail reads it again.
    appendFileSync(join(dir, 'api.http'), '\n### Added later\nGET {{host}}/later\n');
    await until(() => frame().includes('Added later'), 'the new request after the file changed');
  } finally {
    app.unmount();
  }
});

test('with no file: it says how to start, and /new writes an example and opens it', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  const file = join(dir, 'example.http');
  try {
    await until(() => frame().includes('No .http file open'), 'the empty state');
    app.stdin.write('/');
    await type(app.stdin, `new ${file}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('example.http') && frame().includes('Ask for some JSON'), 'the example open');
    assert.ok(existsSync(file));
    app.stdin.write('/');
    await type(app.stdin, `new ${file}`);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('is there already'), "it doesn't write over a file");
  } finally {
    app.unmount();
  }
});

test('! runs a shell command, with its output in the activity lines, and esc cancels a slow one', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Who am I'), 'the requests');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "console.log(6*7)"');
    app.stdin.write(KEYS.enter);
    await until(() => /⎿\s+42/.test(frame()), 'the output');

    app.stdin.write('!');
    await type(app.stdin, 'node -e "setTimeout(() => {}, 20000)"');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('esc to cancel'), 'the spinner');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Cancelled'), 'the command cancelled');

    app.stdin.write('?');
    await until(() => frame().includes('Copy it as a curl command'), 'help, on the Requests section');
  } finally {
    app.unmount();
  }
});

test('settings: a toggle saves, the accent changes through its command', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Who am I'), 'the requests');
    app.stdin.write(',');
    await until(() => frame().includes('Accent colour'), 'the settings');
    app.stdin.write('j');
    await until(() => /❯ Mouse\s+on/.test(frame()), 'the cursor on Mouse');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Mouse\s+off/.test(frame()), 'the mouse off');
    const saved = () => JSON.parse(readFileSync(join(process.env.HAIL_HOME, 'config.json'), 'utf8'));
    assert.equal(saved().mouse, false);

    app.stdin.write('k');
    await until(() => /❯ Accent colour/.test(frame()), 'the cursor on the accent');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/accent #e8445a'), 'the prompt filled in');
    for (let i = 0; i < 7; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, '#5fafff');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('#5fafff'), 'the new accent in the list');
    assert.equal(saved().accent, '#5fafff');
  } finally {
    app.unmount();
  }
});
