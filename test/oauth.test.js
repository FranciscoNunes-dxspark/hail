// OAuth 2: the four grants against an authorization server on this machine, the token cache and the
// refresh tokens kept in the store, {{$auth.token("id")}} through the UI (and hail test), and that no
// token reaches the history.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCredentials } from '../src/credentials.js';
import { environmentsFrom } from '../src/environments.js';
import { fill } from '../src/variables.js';
import { authorizationCode, clientCredentials, createTokens, deviceAuthorization, passwordGrant, pkcePair, readAuthConfig, refreshName } from '../src/oauth.js';
import { runTests } from '../src/headless.js';
import { readActivity } from '../src/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
let n = 0;
const codes = new Map();
const refreshTokens = new Set();
const devices = new Map();
const seen = [];

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const issue = () => {
  n++;
  const t = { access_token: `access-${n}-token`, token_type: 'Bearer', expires_in: 3600, refresh_token: `refresh-${n}-token`, id_token: `idtok-${n}-token` };
  refreshTokens.add(t.refresh_token);
  return t;
};

before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-oauth-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = new URLSearchParams(body);
      const json = (status, obj) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (u.pathname === '/authorize') {
        const q = u.searchParams;
        const code = `code-${++n}`;
        codes.set(code, { challenge: q.get('code_challenge'), method: q.get('code_challenge_method'), redirect: q.get('redirect_uri'), audience: q.get('audience') });
        res.writeHead(302, { Location: `${q.get('redirect_uri')}?code=${code}&state=${encodeURIComponent(q.get('state'))}` });
        return res.end();
      }
      if (u.pathname === '/device') {
        const dc = `device-${++n}`;
        devices.set(dc, { approved: false });
        return json(200, { device_code: dc, user_code: 'WDJB-MJHT', verification_uri: `${base}/activate`, interval: 0, expires_in: 60 });
      }
      if (u.pathname === '/approve') {
        for (const d of devices.values()) d.approved = true;
        return json(200, {});
      }
      if (u.pathname === '/token') {
        seen.push({ params: Object.fromEntries(p), auth: req.headers.authorization ?? null });
        const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':') : null;
        const id = basic?.[0] ?? p.get('client_id');
        const secret = basic?.[1] ?? p.get('client_secret');
        if (id !== 'hail-client') return json(401, { error: 'invalid_client' });
        const grant = p.get('grant_type');
        if (grant === 'client_credentials') return secret === 's3cret-value' ? json(200, { ...issue(), refresh_token: undefined }) : json(401, { error: 'invalid_client', error_description: 'wrong secret' });
        if (grant === 'password') return p.get('username') === 'ana' && p.get('password') === 'pw-1234' ? json(200, issue()) : json(400, { error: 'invalid_grant' });
        if (grant === 'refresh_token') return refreshTokens.has(p.get('refresh_token')) ? json(200, issue()) : json(400, { error: 'invalid_grant', error_description: 'revoked' });
        if (grant === 'authorization_code') {
          const c = codes.get(p.get('code'));
          if (!c || c.redirect !== p.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          const want = c.method === 'S256' ? b64url(createHash('sha256').update(p.get('code_verifier') ?? '').digest()) : p.get('code_verifier');
          if (c.challenge && want !== c.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
          codes.delete(p.get('code'));
          return json(200, issue());
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          const d = devices.get(p.get('device_code'));
          if (!d) return json(400, { error: 'expired_token' });
          return d.approved ? json(200, issue()) : json(400, { error: 'authorization_pending' });
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      // The API: says what it was given.
      json(200, { auth: req.headers.authorization ?? null });
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

const config = (grant, extra = {}) =>
  readAuthConfig('api', { Type: 'OAuth2', 'Grant Type': grant, 'Token URL': `${base}/token`, 'Auth URL': `${base}/authorize`, 'Device Auth URL': `${base}/device`, 'Client ID': 'hail-client', 'Client Secret': 's3cret-value', ...extra });

// What a browser does with the sign-in page: follows the redirects, here straight back to Hail.
const browser = async (url) => {
  await fetch(url);
};

test('the config is read as JetBrains writes it, and what it lacks is said', () => {
  const cfg = config('Authorization Code', { Scope: 'openid api', 'Redirect URL': 'http://127.0.0.1:0/cb', 'Custom Request Parameters': { audience: 'https://api', prompt: { Value: 'login', Use: 'In Auth Request' } } });
  assert.equal(cfg.grant, 'code');
  assert.equal(cfg.pkce.method, 'S256');
  assert.deepEqual(cfg.params, { auth: { audience: 'https://api', prompt: 'login' }, token: { audience: 'https://api' } });
  assert.equal(config('Client Credentials', { 'Client Credentials': 'basic' }).clientAuth, 'basic');
  assert.equal(config('Authorization Code', { PKCE: false }).pkce, null);
  assert.throws(() => readAuthConfig('x', { Type: 'OAuth2', 'Grant Type': 'Password', 'Token URL': 'u', 'Client ID': 'c' }), /needs "Username", "Password"/);
  assert.throws(() => readAuthConfig('x', { Type: 'OAuth2', 'Grant Type': 'Implicit' }), /Hail knows Client Credentials/);
  assert.throws(() => readAuthConfig('x', { Type: 'Basic' }), /OAuth2 only/);
  assert.equal(pkcePair('S256', 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk').challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('environments carry their auth configs, merged across the files, and leave them out of the variables', () => {
  const envs = environmentsFrom([
    { $shared: { Security: { Auth: { api: { Type: 'OAuth2', 'Client ID': 'shared' } } } }, dev: { host: 'h', Security: { Auth: { api: { 'Grant Type': 'Client Credentials' } } } } },
    { dev: { Security: { Auth: { api: { 'Client Secret': '{{$secret cs}}' } } } } },
  ]);
  assert.deepEqual(envs.auth('dev'), { api: { Type: 'OAuth2', 'Client ID': 'shared', 'Grant Type': 'Client Credentials', 'Client Secret': '{{$secret cs}}' } });
  assert.deepEqual(envs.vars('dev'), { host: 'h' });
});

test('{{$auth.token("id")}} and {{$auth.idToken("id")}} fill in, and count as secrets', async () => {
  const used = new Set();
  const r = await fill('Bearer {{$auth.token("api")}} / {{$auth.idToken( \'api\' )}}', { env: { used, auth: async (kind, id) => `${kind}-of-${id}` } });
  assert.equal(r.text, 'Bearer token-of-api / idToken-of-api');
  assert.deepEqual([...used].sort(), ['idToken-of-api', 'token-of-api']);
  assert.deepEqual((await fill('{{$auth.token("api")}}', {})).missing, ['$auth.token("api")']);
});

test('client credentials, in the body or as basic, and the password grant', async () => {
  const t = await clientCredentials(config('Client Credentials', { Scope: 'read' }));
  assert.match(t.accessToken, /^access-/);
  assert.equal(seen.at(-1).params.client_secret, 's3cret-value');
  assert.equal(seen.at(-1).params.scope, 'read');
  await clientCredentials(config('Client Credentials', { 'Client Credentials': 'basic' }));
  assert.match(seen.at(-1).auth, /^Basic /);
  assert.equal(seen.at(-1).params.client_secret, undefined);
  await assert.rejects(clientCredentials(config('Client Credentials', { 'Client Secret': 'nope' })), /invalid_client: wrong secret/);
  const p = await passwordGrant(config('Password', { Username: 'ana', Password: 'pw-1234' }));
  assert.match(p.refreshToken, /^refresh-/);
});

test('authorization code: the page opened, the code caught on this machine, exchanged with the PKCE verifier', async () => {
  let opened = null;
  const t = await authorizationCode(config('Authorization Code', { Audience: 'https://api' }), {
    openUrl: async (url) => {
      opened = new URL(url);
      await browser(url);
    },
  });
  assert.match(t.accessToken, /^access-/);
  assert.equal(opened.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(opened.searchParams.get('audience'), 'https://api');
  assert.match(opened.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.ok(seen.at(-1).params.code_verifier);
  // A redirect elsewhere can't be caught.
  await assert.rejects(authorizationCode(config('Authorization Code', { 'Redirect URL': 'https://example.com/cb' }), { openUrl: browser }), /redirect to this machine/);
  // Cancelled while waiting for the browser.
  const c = new AbortController();
  const waiting = authorizationCode(config('Authorization Code'), { openUrl: () => c.abort(), signal: c.signal });
  await assert.rejects(waiting, /Cancelled/);
});

test('device authorization: the code handed over, polled until it is approved', async () => {
  let shown = null;
  const t = await deviceAuthorization(config('Device Authorization', { Scope: 'offline_access' }), {
    onCode: (c) => {
      shown = c;
      setTimeout(() => fetch(`${base}/approve`), 100);
    },
  });
  assert.equal(shown.userCode, 'WDJB-MJHT');
  assert.equal(shown.verificationUri, `${base}/activate`);
  assert.match(t.accessToken, /^access-/);
});

test('tokens are kept until they run out, then refreshed from the store; a refused refresh signs in afresh', async () => {
  let clock = 1_000_000;
  const credentials = memoryCredentials();
  const signedIn = [];
  const tokens = createTokens({ credentials, now: () => clock, onSignIn: (s) => signedIn.push(s.how) });
  const cfg = config('Password', { Username: 'ana', Password: 'pw-1234' });
  const at = { key: 'k', store: refreshName('/x/api.http', 'dev', 'api'), cfg };
  const first = await tokens.get(at);
  assert.equal(await tokens.get(at), first, 'the same token while it lasts');
  assert.match(credentials.saved.get(at.store), /^refresh-/);
  assert.equal(at.store, `oauth:${createHash('sha1').update('/x/api.http').digest('hex').slice(0, 16)}:dev:api`);
  clock += 3600_000;
  const second = await tokens.get(at);
  assert.notEqual(second, first);
  assert.deepEqual(signedIn, ['signed in', 'refreshed']);
  // A new run: nothing in memory, the refresh token in the store.
  const again = createTokens({ credentials, now: () => clock });
  assert.match(await again.get(at), /^access-/);
  assert.deepEqual(await again.status('k', at.store), { signedIn: true, expiresAt: clock + 3600_000, refresh: true });
  // Revoked: forgotten, and signed in afresh.
  refreshTokens.clear();
  const third = createTokens({ credentials, now: () => clock });
  assert.match(await third.get(at), /^access-/);
  assert.equal(await third.get({ ...at, kind: 'idToken' }), (await third.get(at)).replace('access', 'idtok'));
  await third.forget('k', at.store);
  assert.equal(credentials.saved.has(at.store), false);
  // A grant that needs a person, with no one to ask.
  await assert.rejects(createTokens({}).get({ key: 'c', store: 's', cfg: config('Authorization Code') }), /needs a person/);
});

const envFile = () =>
  writeFileSync(
    join(dir, 'http-client.env.json'),
    JSON.stringify({
      dev: {
        host: base,
        Security: {
          Auth: {
            machine: { Type: 'OAuth2', 'Grant Type': 'Client Credentials', 'Token URL': '{{host}}/token', 'Client ID': 'hail-client', 'Client Secret': '{{$secret oauth-secret}}' },
            browser: { Type: 'OAuth2', 'Grant Type': 'Authorization Code', 'Token URL': `${base}/token`, 'Auth URL': `${base}/authorize`, 'Client ID': 'hail-client' },
            tv: { Type: 'OAuth2', 'Grant Type': 'Device Authorization', 'Token URL': `${base}/token`, 'Device Auth URL': `${base}/device`, 'Client ID': 'hail-client' },
          },
        },
      },
    }),
  );

const historyText = () => {
  const d = join(process.env.HAIL_HOME, 'history');
  return existsSync(d) ? readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('') : '';
};

test('through the UI: a client secret asked for, the token sent and kept out of the history, /auth, the browser and a device code', async () => {
  envFile();
  writeFileSync(
    join(dir, 'api.http'),
    `### Machine\nGET {{host}}/api\nAuthorization: Bearer {{$auth.token("machine")}}\n\n### Browser\nGET {{host}}/api\nAuthorization: Bearer {{$auth.token("browser")}}\n\n### TV\nGET {{host}}/api\nAuthorization: Bearer {{$auth.idToken("tv")}}\n`,
  );
  const credentials = memoryCredentials();
  const opened = [];
  const app = start({ initialFile: join(dir, 'api.http'), credentials, openUrl: async (url) => (opened.push(url), browser(url)) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Machine'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('The value of the secret oauth-secret'), 'the client secret asked for');
    await type(app.stdin, 's3cret-value');
    app.stdin.write(KEYS.enter);
    await until(() => /"auth": "Bearer access-\d+-token"/.test(frame()), 'the request sent with the token');
    assert.doesNotMatch(historyText(), /access-\d+-token/, 'the token is left out of the history');
    assert.match(historyText(), /Bearer ••••••/);

    app.stdin.write('/');
    await type(app.stdin, 'auth');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Sign-ins: api.http in dev'), 'the sign-ins');
    await until(() => /machine\s+Client Credentials\s+signed in, the token runs out in 60 min/.test(frame()), 'its status');
    assert.match(frame(), /browser\s+Authorization Code\s+not signed in/);
    assert.doesNotMatch(frame(), /access-/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Sign-ins:'), 'the sign-ins closed');

    // Authorization Code: the browser opened (here, fetched) and the code caught.
    app.stdin.write(KEYS.down);
    await until(() => /❯ GET\s+(\d+ )?Browser/.test(frame()), 'the second request');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Signed in with browser') && /"auth": "Bearer access-\d+-token"/.test(frame()), 'signed in in the browser and sent');
    assert.match(opened[0], /\/authorize\?response_type=code/);
    assert.ok([...credentials.saved.keys()].some((k) => /^oauth:[0-9a-f]{16}:dev:browser$/.test(k)), 'its refresh token kept');
    const logged = readActivity().map((e) => e.text).join('\n');
    assert.match(logged, /Signed in with browser \(OAuth 2, Authorization Code, dev\) \(api\.http\)/);
    assert.doesNotMatch(logged, /access-|refresh-/, 'never a token');

    // Device Authorization: the code shown in the confirm area until it's approved.
    app.stdin.write(KEYS.down);
    await until(() => /❯ GET\s+(\d+ )?TV/.test(frame()), 'the third request');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes(`Enter WDJB-MJHT at ${base}/activate`), 'the device code');
    await fetch(`${base}/approve`);
    await until(() => /"auth": "Bearer idtok-\d+-token"/.test(frame()), 'signed in on the device and sent with the ID token');
    assert.doesNotMatch(frame(), /Enter WDJB-MJHT/);

    app.stdin.write('/');
    await type(app.stdin, 'auth clear');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Forgot the tokens for api.http in dev'), 'forgotten');
    assert.ok(![...credentials.saved.keys()].some((k) => k.startsWith('oauth:')));
  } finally {
    app.unmount();
  }
});

test('hail test signs in with client credentials, and says a browser sign-in needs Hail', async () => {
  envFile();
  writeFileSync(join(dir, 'ci.http'), `### Machine\nGET {{host}}/api\nAuthorization: Bearer {{$auth.token("machine")}}\n\n> {% client.test("token sent", () => client.assert(/^Bearer access-/.test(response.body.auth))); %}\n\n### Browser\nGET {{host}}/api\nAuthorization: Bearer {{$auth.token("browser")}}\n`);
  const out = [];
  const code = await runTests([join(dir, 'ci.http')], { print: (l) => out.push(l), printError: (l) => out.push(l), credentials: memoryCredentials({ 'oauth-secret': 's3cret-value' }), config: {}, cwd: dir });
  const text = out.join('\n');
  assert.equal(code, 1, text);
  assert.match(text, /1 test passed/);
  assert.match(text, /Not sent: The auth browser signs in with Authorization Code, which needs a person/);
});
