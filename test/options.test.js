// A request's directives (# @no-redirect, # @timeout), an environment's SSLConfiguration, and proxies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { environmentsFrom } from '../src/environments.js';
import { parseHttpFile } from '../src/http-file.js';
import { exchange } from '../src/runner.js';
import { prepare } from '../src/send.js';
import { bypassesProxy, parseTimeout, proxyFor } from '../src/transport.js';
import { responseLines } from '../src/ui/response.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

let plain;
let secure;
let proxy;
let tunnels = [];
let refuse = false;
before(async () => {
  plain = createServer((req, res) => {
    if (req.url === '/moved') {
      res.statusCode = 302;
      res.setHeader('Location', '/there');
      return res.end();
    }
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 1500);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, host: req.headers.host }));
  });
  secure = createHttpsServer({ key: fixture('localhost.key'), cert: fixture('localhost.crt') }, (req, res) => res.end(`secure ${req.url}`));
  // A proxy that tunnels whatever it's asked for to this machine, at the port asked for.
  proxy = createServer((req, res) => {
    res.statusCode = 405;
    res.end();
  });
  proxy.on('connect', (req, client, head) => {
    tunnels.push({ target: req.url, auth: req.headers['proxy-authorization'] ?? null });
    if (refuse) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }
    const port = Number(req.url.split(':').at(-1));
    const upstream = connect(port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  await Promise.all([plain, secure, proxy].map((s) => new Promise((r) => s.listen(0, '127.0.0.1', r))));
});
after(() => {
  for (const s of [plain, secure, proxy]) s.close();
});

const port = (s) => s.address().port;
const requestFrom = async (text, scope = {}) => prepare(parseHttpFile(text).requests[0], scope);
const NO_PROXY_ENV = {};

test('# @no-redirect gives back the redirect itself; without it, it is followed', async () => {
  const followed = await exchange(await requestFrom(`GET http://127.0.0.1:${port(plain)}/moved`), { env: NO_PROXY_ENV });
  assert.equal(JSON.parse(followed.response.body).path, '/there');
  const req = await requestFrom(`# @no-redirect\nGET http://127.0.0.1:${port(plain)}/moved`);
  const kept = await exchange(req, { env: NO_PROXY_ENV });
  assert.equal(kept.response.status, 302);
  assert.equal(kept.response.redirects, 0);
  const lines = responseLines({ request: req, response: kept.response, at: Date.now() }, 80).map((l) => l.map((s) => s.text).join(''));
  assert.ok(lines.includes('Redirects to /there (not followed: # @no-redirect)'), lines.join('\n'));
});

test('# @timeout gives up waiting, in seconds or with a unit', async () => {
  assert.equal(parseTimeout('30'), 30_000);
  assert.equal(parseTimeout('500 ms'), 500);
  assert.equal(parseTimeout('2 m'), 120_000);
  assert.equal(parseTimeout('1.5s'), 1500);
  assert.equal(parseTimeout('soon'), null);
  const req = await requestFrom(`GET http://127.0.0.1:${port(plain)}/slow\n# @timeout 300 ms\n`);
  assert.equal(req.options.timeout, '300 ms', 'a directive among the headers counts too');
  await assert.rejects(exchange(req, { env: NO_PROXY_ENV }), /127\.0\.0\.1:\d+ didn't answer within 300 ms \(# @timeout\)/);
  const enough = await requestFrom(`# @timeout 5\nGET http://127.0.0.1:${port(plain)}/slow`);
  assert.equal((await exchange(enough, { env: NO_PROXY_ENV })).response.body, 'late');
});

test("an environment's SSLConfiguration skips checking the certificate, and the response says so", async () => {
  const envs = environmentsFrom([{ dev: { host: 'h', SSLConfiguration: { verifyHostCertificate: false } }, prod: { host: 'p' } }, { $shared: { SSLConfiguration: { clientCertificate: 'x' } } }]);
  assert.deepEqual(envs.vars('dev'), { host: 'h' }, 'not a variable');
  assert.deepEqual(envs.options('dev'), { insecure: true });
  assert.deepEqual(envs.options('prod'), { insecure: false });
  const req = await requestFrom(`GET https://127.0.0.1:${port(secure)}/x`);
  await assert.rejects(exchange(req, { env: NO_PROXY_ENV }), /certificate isn't trusted .*verifyHostCertificate/);
  const out = await exchange(req, { insecure: true, env: NO_PROXY_ENV });
  assert.equal(out.response.body, 'secure /x');
  assert.equal(out.response.insecure, true);
  const lines = responseLines({ request: req, response: out.response, at: Date.now() }, 80).map((l) => l.map((s) => s.text).join(''));
  assert.match(lines.join('\n'), /The certificate wasn't checked/);
  // Over plain http there's nothing to skip, so nothing is said.
  const http = await exchange(await requestFrom(`GET http://127.0.0.1:${port(plain)}/`), { insecure: true, env: NO_PROXY_ENV });
  assert.equal(http.response.insecure, undefined);
});

test('proxies: HTTPS_PROXY and HTTP_PROXY tunnel, NO_PROXY and this machine go straight', async () => {
  assert.ok(bypassesProxy('api.example.com', 443, 'localhost,.example.com'));
  assert.ok(bypassesProxy('example.com', 443, '*.example.com'));
  assert.ok(bypassesProxy('10.1.2.3', 80, '10.0.0.0/8'));
  assert.ok(bypassesProxy('a.test', 8080, 'a.test:8080') && !bypassesProxy('a.test', 80, 'a.test:8080'));
  assert.ok(!bypassesProxy('notexample.com', 443, 'example.com'));
  assert.ok(bypassesProxy('anything', 1, '*'));
  assert.equal(proxyFor('https://127.0.0.1/', { HTTPS_PROXY: 'http://p:1' }), null, 'this machine never is');
  assert.equal(proxyFor('https://x.test/', { https_proxy: 'p:1' }), 'http://p:1');
  assert.equal(proxyFor('http://x.test/', { HTTPS_PROXY: 'http://p:1' }), null, 'http has its own');
  assert.equal(proxyFor('http://x.test/', { HTTPS_PROXY: 'http://p:1', NO_PROXY: 'x.test' }), null);

  const env = { HTTPS_PROXY: `http://ana:pw@127.0.0.1:${port(proxy)}`, HTTP_PROXY: `http://127.0.0.1:${port(proxy)}` };
  tunnels = [];
  const viaHttps = await exchange(await requestFrom(`GET https://hail.test:${port(secure)}/through`), { insecure: true, env });
  assert.equal(viaHttps.response.body, 'secure /through');
  assert.equal(viaHttps.response.proxy, `127.0.0.1:${port(proxy)}`);
  assert.deepEqual(tunnels, [{ target: `hail.test:${port(secure)}`, auth: `Basic ${Buffer.from('ana:pw').toString('base64')}` }]);
  const viaHttp = await exchange(await requestFrom(`GET http://hail.test:${port(plain)}/plain`), { env });
  assert.deepEqual(JSON.parse(viaHttp.response.body), { path: '/plain', host: `hail.test:${port(plain)}` });
  assert.equal(tunnels.length, 2);
  const lines = responseLines({ request: { url: 'x' }, response: viaHttp.response, at: Date.now() }, 80).map((l) => l.map((s) => s.text).join(''));
  assert.match(lines.join('\n'), /Through the proxy 127\.0\.0\.1:\d+/);
  // The certificate is still checked through the tunnel unless it's skipped.
  await assert.rejects(exchange(await requestFrom(`GET https://hail.test:${port(secure)}/`), { env }), /certificate isn't trusted/);
  refuse = true;
  try {
    await assert.rejects(exchange(await requestFrom(`GET http://refused.test:${port(plain)}/`), { env }), /the proxy 127\.0\.0\.1:\d+ wouldn't connect to refused\.test:\d+ \(407\)/);
  } finally {
    refuse = false;
  }
});
