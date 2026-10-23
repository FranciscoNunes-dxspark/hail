// The cookie jar (cookies.js), redirects followed with it, and /cookies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJar, domainMatches, parseSetCookie, pathMatches } from '../src/cookies.js';
import { send } from '../src/send.js';
import { exchange } from '../src/runner.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-cookies-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/login') {
        res.setHeader('Set-Cookie', ['session=s-42; Path=/; HttpOnly', 'theme=dark; Max-Age=3600', 'gone=x; Max-Age=0', 'safe=1; Secure']);
        res.statusCode = 302;
        res.setHeader('Location', '/home');
        return res.end();
      }
      if (req.url === '/see-other') {
        res.statusCode = 303;
        res.setHeader('Location', '/echo');
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/echo') res.setHeader('Set-Cookie', 'last=e-7');
      res.end(JSON.stringify({ path: req.url, method: req.method, cookie: req.headers.cookie ?? null, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('Set-Cookie: domain, path, expiry and secure, as a browser keeps them', () => {
  const now = 1_000_000;
  const c = parseSetCookie('id=a1; Domain=.example.com; Path=/api; Secure; HttpOnly; Max-Age=60; Expires=Wed, 21 Oct 2015 07:28:00 GMT', 'https://www.example.com/x', now);
  assert.deepEqual(c, { name: 'id', value: 'a1', domain: 'example.com', hostOnly: false, path: '/api', secure: true, httpOnly: true, expires: now + 60_000 });
  assert.equal(parseSetCookie('a=1; Domain=other.com', 'https://www.example.com/'), null, "another site's");
  assert.equal(parseSetCookie('a=1; Domain=com', 'https://example.com/'), null, 'a whole top-level domain');
  assert.equal(parseSetCookie('a=1', 'https://x.com/a/b/c').path, '/a/b', 'the default path');
  assert.ok(domainMatches('a.b.example.com', 'example.com') && !domainMatches('badexample.com', 'example.com') && !domainMatches('1.2.3.4', '2.3.4'));
  assert.ok(pathMatches('/api/users', '/api') && pathMatches('/api/', '/api/') && !pathMatches('/apix', '/api'));

  const jar = createJar();
  jar.store(['s=1; Path=/', 'deep=2; Path=/api', 'dom=3; Domain=example.com; Path=/', 'sec=4; Secure; Path=/', 'old=5; Expires=Thu, 01 Jan 1970 00:00:00 GMT'], 'https://example.com/api/login', now);
  assert.equal(jar.header('https://example.com/api/users', now), 'deep=2; s=1; dom=3; sec=4');
  assert.equal(jar.header('http://example.com/other', now), 's=1; dom=3', 'no secure cookie over http, no /api cookie elsewhere');
  assert.equal(jar.header('https://sub.example.com/', now), 'dom=3', 'only the Domain one on a subdomain');
  jar.store(['s=; Max-Age=0'], 'https://example.com/', now);
  assert.equal(jar.header('https://example.com/', now), 'dom=3; sec=4', 'deleted');
  jar.store(['short=1; Max-Age=1'], 'https://example.com/', now);
  assert.match(jar.header('https://example.com/', now), /short=1/);
  assert.doesNotMatch(jar.header('https://example.com/', now + 2000), /short=1/, 'expired');
  const insecure = createJar();
  insecure.store(['sec=1; Secure'], 'http://example.com/', now);
  assert.equal(insecure.size(), 0, 'a Secure cookie from http is refused');
  assert.equal(jar.list(now).length, 3);
  assert.equal(jar.clear(), 3);
  assert.equal(jar.size(), 0);
});

test('redirects are followed with the jar: cookies kept from the redirect itself and sent on', async () => {
  const jar = createJar();
  const res = await send({ method: 'POST', url: `${base}/login`, headers: [['Content-Type', 'text/plain']], body: 'hi' }, { jar });
  assert.equal(res.redirects, 1);
  assert.equal(res.url, `${base}/home`);
  const got = JSON.parse(res.body);
  assert.deepEqual([got.method, got.path, got.cookie, got.body], ['GET', '/home', 'session=s-42; theme=dark', ''], 'a 302 after a POST goes on as a GET, with the cookies');
  assert.deepEqual(jar.list().map((c) => c.name), ['session', 'theme'], 'Secure over http and Max-Age=0 left out');
  // The request's own Cookie wins; without the jar nothing is added.
  assert.equal(JSON.parse((await send({ method: 'GET', url: `${base}/x`, headers: [['Cookie', 'mine=1']], body: '' }, { jar })).body).cookie, 'mine=1');
  assert.equal(JSON.parse((await send({ method: 'GET', url: `${base}/x`, headers: [], body: '' })).body).cookie, null);
  // # @no-cookie-jar: neither sent nor kept.
  const fresh = createJar();
  fresh.store(['a=1'], `${base}/`);
  const out = await exchange({ method: 'GET', url: `${base}/login`, headers: [], body: '', options: { 'no-cookie-jar': true } }, { jar: fresh });
  assert.equal(JSON.parse(out.response.body).cookie, null);
  assert.deepEqual(fresh.list().map((c) => c.name), ['a']);
  // 303: a GET, whatever it was.
  const seeOther = JSON.parse((await send({ method: 'PUT', url: `${base}/see-other`, headers: [], body: 'x' })).body);
  assert.deepEqual([seeOther.method, seeOther.path], ['GET', '/echo']);
});

test('/cookies shows what the jar holds for the file and environment, /cookies clear forgets it, and history hides them', async () => {
  writeFileSync(join(dir, 'api.http'), `### Log in\nPOST ${base}/login\n\n### Echo\nGET ${base}/echo\n`);
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Log in'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"cookie": "session=s-42; theme=dark"'), 'the cookies sent on the redirect');
    app.stdin.write('/');
    await type(app.stdin, 'cookies');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Cookies: api.http · 2'), 'the jar');
    assert.match(frame(), /session=s-42\s+\/ · until Hail closes · HttpOnly/);
    assert.match(frame(), /theme=dark\s+\/ · until /);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Cookies: api.http'), 'closed');
    app.stdin.write('/');
    await type(app.stdin, 'cookies clear');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Forgot the 2 cookies kept for api.http'), 'cleared');
    app.stdin.write('j');
    await until(() => /❯ GET\s+Echo/.test(frame()), 'the second');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"cookie": null'), 'nothing sent after clearing');
    const history = readdirSync(join(process.env.HAIL_HOME, 'history')).map((f) => readFileSync(join(process.env.HAIL_HOME, 'history', f), 'utf8')).join('');
    assert.doesNotMatch(history, /e-7/, 'Set-Cookie is hidden');
    assert.match(history, /\["set-cookie","••••••"\]/);
  } finally {
    app.unmount();
  }
});
