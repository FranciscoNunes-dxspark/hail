// OAuth 2 sign-ins, as JetBrains' HTTP Client has them: an environment's "Security": { "Auth": { "<id>":
// { "Type": "OAuth2", "Grant Type": …, … } } }, used in a request as {{$auth.token("<id>")}} (and
// {{$auth.idToken("<id>")}}). Four grants: Client Credentials, Password, Authorization Code (with PKCE,
// caught by a listener on this machine at the redirect URL's port) and Device Authorization (a code to
// enter on another page, then polling). Tokens are kept in memory per file, environment and id; a
// refresh token is kept in the system's credential store (credentials.js), so the next run of Hail
// (or `hail test`) refreshes rather than signs in again. Nothing here ever logs or returns a token
// anywhere but to the request that asked for it.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { callSignal } from './run.js';
import { fill } from './variables.js';

export const GRANTS = {
  'client credentials': 'client',
  password: 'password',
  'authorization code': 'code',
  'device authorization': 'device',
};
export const GRANT_NAMES = { client: 'Client Credentials', password: 'Password', code: 'Authorization Code', device: 'Device Authorization' };

// A token is taken as expired this long before it says it is, so it doesn't run out on its way.
const EARLY = 30_000;
// How long an Authorization Code sign-in waits for the browser.
export const SIGN_IN_WAIT = 5 * 60_000;

/** A field of a JetBrains auth config, by its name in any case and spacing ("Client ID", "clientId"). */
function field(raw, ...names) {
  const want = names.map((n) => n.toLowerCase().replace(/[\s_-]/g, ''));
  for (const [k, v] of Object.entries(raw ?? {})) if (want.includes(k.toLowerCase().replace(/[\s_-]/g, ''))) return v;
  return undefined;
}

/** The grant `raw` says it uses, by its name ('Client Credentials'), or '?' for one Hail doesn't know. */
export const grantName = (raw) => GRANT_NAMES[GRANTS[String(field(raw, 'Grant Type') ?? '').toLowerCase().trim()]] ?? '?';

/**
 * Custom Request Parameters: { name: "value" } or { name: { "Value": …, "Use": "Everywhere" | "In Auth
 * Request" | "In Token Request" } }, as { auth: {}, token: {} }; Audience and Resource go everywhere.
 */
function customParams(raw) {
  const out = { auth: {}, token: {} };
  for (const [k, v] of Object.entries(field(raw, 'Custom Request Parameters') ?? {})) {
    const value = v && typeof v === 'object' ? field(v, 'Value') : v;
    if (value == null) continue;
    const use = String((v && typeof v === 'object' ? field(v, 'Use') : null) ?? 'Everywhere').toLowerCase();
    if (!use.includes('token')) out.auth[k] = String(value);
    if (!use.includes('auth request')) out.token[k] = String(value);
  }
  for (const name of ['audience', 'resource']) {
    const v = field(raw, name);
    if (v != null && v !== '') out.auth[name] = out.token[name] = String(v);
  }
  return out;
}

/**
 * The auth config `raw` (its variables filled in already) for `id`, read: { id, grant, tokenUrl, authUrl,
 * deviceUrl, clientId, clientSecret, clientAuth, scope, redirectUrl, pkce, username, password, params,
 * useIdToken }. Throws, saying what's missing, when it can't be used.
 */
export function readAuthConfig(id, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`The auth ${id} isn't an object of settings.`);
  const type = String(field(raw, 'Type') ?? 'OAuth2');
  if (!/^oauth\s*2(\.0)?$/i.test(type)) throw new Error(`The auth ${id} is of Type ${type}: Hail signs in with OAuth2 only.`);
  const grantName = String(field(raw, 'Grant Type') ?? '');
  const grant = GRANTS[grantName.toLowerCase().trim()];
  if (!grant) throw new Error(`The auth ${id} has ${grantName ? `the Grant Type ${grantName}` : 'no Grant Type'}: Hail knows ${Object.values(GRANT_NAMES).join(', ')}.`);
  const str = (...names) => {
    const v = field(raw, ...names);
    return v == null || v === '' ? null : String(v);
  };
  const pkceRaw = field(raw, 'PKCE');
  const pkce =
    pkceRaw === false
      ? null
      : { method: /plain/i.test(String((pkceRaw && typeof pkceRaw === 'object' ? field(pkceRaw, 'Code Challenge Method') : null) ?? '')) ? 'plain' : 'S256', verifier: pkceRaw && typeof pkceRaw === 'object' ? (field(pkceRaw, 'Code Verifier') ?? null) : null };
  const cfg = {
    id,
    grant,
    tokenUrl: str('Token URL'),
    authUrl: str('Auth URL', 'Authorization URL'),
    deviceUrl: str('Device Auth URL', 'Device Authorization URL'),
    clientId: str('Client ID'),
    clientSecret: str('Client Secret'),
    clientAuth: /basic/i.test(str('Client Credentials') ?? '') ? 'basic' : /none/i.test(str('Client Credentials') ?? '') ? 'none' : 'in body',
    scope: str('Scope'),
    redirectUrl: str('Redirect URL'),
    pkce: grant === 'code' ? pkce : null,
    username: str('Username'),
    password: str('Password'),
    params: customParams(raw),
    useIdToken: field(raw, 'Use ID Token') === true,
  };
  const need = [['tokenUrl', 'Token URL'], ['clientId', 'Client ID']];
  if (grant === 'code') need.push(['authUrl', 'Auth URL']);
  if (grant === 'device') need.push(['deviceUrl', 'Device Auth URL']);
  if (grant === 'password') need.push(['username', 'Username'], ['password', 'Password']);
  const missing = need.filter(([k]) => !cfg[k]).map(([, n]) => `"${n}"`);
  if (missing.length) throw new Error(`The auth ${id} (${GRANT_NAMES[grant]}) needs ${missing.join(', ')}.`);
  return cfg;
}

/**
 * The auth config `raw` with the {{variables}} in its values filled in from `scope` (variables.js's,
 * {{$secret}}s too, but no {{$auth}} of its own): { raw, missing }, `missing` being what nothing answered.
 */
export async function fillAuthConfig(raw, scope) {
  const inner = { ...scope, env: { ...scope?.env, auth: undefined } };
  const missing = [];
  const walk = async (v) => {
    if (typeof v === 'string') {
      const r = await fill(v, inner);
      missing.push(...r.missing);
      return r.text;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x);
      return out;
    }
    return v;
  };
  return { raw: await walk(raw), missing: [...new Set(missing)] };
}

/** An error from the token endpoint, with OAuth's own code (invalid_grant, authorization_pending…). */
export class OAuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier and its challenge (S256 unless `method` is plain). */
export function pkcePair(method = 'S256', verifier = null) {
  const v = verifier ?? b64url(randomBytes(48));
  return { verifier: v, challenge: method === 'plain' ? v : b64url(createHash('sha256').update(v).digest()), method };
}

/** The token response `json` as { accessToken, idToken, refreshToken, expiresAt, tokenType, scope }. */
export function tokenFrom(json, now = Date.now()) {
  if (!json?.access_token && !json?.id_token) throw new OAuthError('The token endpoint answered without a token.', 'no_token');
  const secs = Number(json.expires_in);
  return {
    accessToken: json.access_token ?? null,
    idToken: json.id_token ?? null,
    refreshToken: json.refresh_token ?? null,
    expiresAt: Number.isFinite(secs) && secs > 0 ? now + secs * 1000 : null,
    tokenType: json.token_type ?? 'Bearer',
    scope: json.scope ?? null,
  };
}

/** POSTs `params` as a form to `url`, resolving with the JSON answer; a refusal throws OAuthError. */
async function postForm(url, params, { headers = {}, fetch = globalThis.fetch, signal }) {
  const own = callSignal(signal);
  let res;
  let text;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers }, body: new URLSearchParams(params).toString(), signal: own.signal });
    text = await res.text();
  } catch (e) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
    throw new Error(`Couldn't reach ${url}: ${e.cause?.message ?? e.message}`);
  } finally {
    own.done();
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // A form-encoded answer (GitHub's, without Accept honoured).
    if (/=/.test(text) && !/[<{]/.test(text)) json = Object.fromEntries(new URLSearchParams(text));
  }
  if (json?.error) throw new OAuthError(`${json.error}${json.error_description ? `: ${json.error_description}` : ''}`, json.error);
  if (!res.ok) throw new OAuthError(`${url} answered ${res.status} ${res.statusText}`.trim(), `http_${res.status}`);
  if (!json) throw new OAuthError(`${url} didn't answer with JSON.`, 'not_json');
  return json;
}

/** A call to the token endpoint with the client's credentials added as the config says. */
async function tokenCall(cfg, params, { fetch, signal, now = Date.now } = {}) {
  const body = { ...params, ...cfg.params.token };
  const headers = {};
  if (cfg.clientAuth === 'basic' && cfg.clientSecret) {
    const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
    headers.Authorization = `Basic ${Buffer.from(`${enc(cfg.clientId)}:${enc(cfg.clientSecret)}`).toString('base64')}`;
  } else {
    body.client_id = cfg.clientId;
    if (cfg.clientSecret && cfg.clientAuth !== 'none') body.client_secret = cfg.clientSecret;
  }
  return tokenFrom(await postForm(cfg.tokenUrl, body, { headers, fetch, signal }), now());
}

const withScope = (cfg, p) => (cfg.scope ? { ...p, scope: cfg.scope } : p);

/** Client Credentials: the client signs in as itself. */
export const clientCredentials = (cfg, opts = {}) => tokenCall(cfg, withScope(cfg, { grant_type: 'client_credentials' }), opts);

/** Password: the user's name and password straight to the token endpoint. */
export const passwordGrant = (cfg, opts = {}) => tokenCall(cfg, withScope(cfg, { grant_type: 'password', username: cfg.username, password: cfg.password }), opts);

/** A new access token for a refresh token; the answer may carry a new refresh token, else the old one stays. */
export async function refreshGrant(cfg, refreshToken, opts = {}) {
  const t = await tokenCall(cfg, withScope(cfg, { grant_type: 'refresh_token', refresh_token: refreshToken }), opts);
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Authorization Code: listens on this machine at the Redirect URL's port (any free one when it names
 * none: http://127.0.0.1/callback), opens the sign-in page through `openUrl`, catches the code the
 * browser is sent back with, checks its state, and exchanges it (with the PKCE verifier). `onUrl(url)`
 * is told the page's address first, for when no browser opens. `signal` cancels; it gives up after `wait`.
 */
export async function authorizationCode(cfg, { openUrl, onUrl, signal, fetch, now = Date.now, wait = SIGN_IN_WAIT } = {}) {
  const redirect = new URL(cfg.redirectUrl ?? 'http://127.0.0.1/callback');
  if (redirect.protocol !== 'http:' || !LOOPBACK.has(redirect.hostname))
    throw new Error(`Hail catches the sign-in at a redirect to this machine (http://127.0.0.1:<port>/…, or localhost); the auth ${cfg.id}'s Redirect URL is ${redirect.href}`);
  const state = b64url(randomBytes(16));
  const pkce = cfg.pkce ? pkcePair(cfg.pkce.method, cfg.pkce.verifier) : null;
  let settle;
  const got = new Promise((resolve, reject) => (settle = { resolve, reject }));
  const handler = (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== redirect.pathname) {
      res.statusCode = 404;
      return res.end();
    }
    const q = u.searchParams;
    const page = (text) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>Hail</title><body style="font-family:sans-serif;margin:3em"><h2>${text}</h2><p>You can close this tab and go back to Hail.</p></body>`);
    };
    if (q.get('error')) {
      page('The sign-in was refused.');
      return settle.reject(new OAuthError(`${q.get('error')}${q.get('error_description') ? `: ${q.get('error_description')}` : ''}`, q.get('error')));
    }
    if (q.get('state') !== state || !q.get('code')) {
      res.statusCode = 400;
      return page("That isn't the sign-in Hail is waiting for.");
    }
    page('Signed in.');
    settle.resolve(q.get('code'));
  };
  const servers = [createServer(handler)];
  const listen = (server, host, port) =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => resolve(server.address().port));
    });
  let port;
  try {
    port = await listen(servers[0], '127.0.0.1', Number(redirect.port) || 0);
  } catch (e) {
    throw new Error(`Couldn't listen for the sign-in at 127.0.0.1:${redirect.port || 'any port'}: ${e.code === 'EADDRINUSE' ? 'something else is using that port' : e.message}`);
  }
  // A browser may take localhost to ::1 first.
  if (redirect.hostname === 'localhost') {
    const v6 = createServer(handler);
    await listen(v6, '::1', port).then(() => servers.push(v6), () => {});
  }
  if (!redirect.port) redirect.port = String(port);
  const timer = setTimeout(() => settle.reject(new Error(`No sign-in came back within ${Math.round(wait / 60_000)} minutes.`)), wait);
  const onAbort = () => settle.reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const url = new URL(cfg.authUrl);
    const p = url.searchParams;
    p.set('response_type', 'code');
    p.set('client_id', cfg.clientId);
    p.set('redirect_uri', redirect.href);
    if (cfg.scope) p.set('scope', cfg.scope);
    p.set('state', state);
    if (pkce) {
      p.set('code_challenge', pkce.challenge);
      p.set('code_challenge_method', pkce.method);
    }
    for (const [k, v] of Object.entries(cfg.params.auth)) p.set(k, v);
    onUrl?.(url.href);
    await Promise.resolve(openUrl?.(url.href)).catch(() => {});
    const code = await got;
    return await tokenCall(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirect.href, ...(pkce ? { code_verifier: pkce.verifier } : {}) }, { fetch, signal, now });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    for (const s of servers) {
      s.close();
      s.closeAllConnections?.();
    }
  }
}

const sleepFor = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(t);
      reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    }
    signal?.addEventListener('abort', stop, { once: true });
  });

/**
 * Device Authorization: asks the Device Auth URL for a code, hands `onCode({ userCode, verificationUri,
 * verificationUriComplete, expiresAt })` it to show, then polls the token endpoint at the interval the
 * server asks for (slower when it says slow_down) until the sign-in is done, refused or expired.
 */
export async function deviceAuthorization(cfg, { onCode, signal, fetch, now = Date.now, sleep = sleepFor } = {}) {
  const start = await postForm(cfg.deviceUrl, withScope(cfg, { client_id: cfg.clientId, ...cfg.params.auth }), { fetch, signal });
  if (!start.device_code || !start.user_code) throw new OAuthError(`${cfg.deviceUrl} didn't answer with a device code.`, 'no_code');
  const expiresAt = now() + (Number(start.expires_in) > 0 ? Number(start.expires_in) * 1000 : 10 * 60_000);
  onCode?.({ userCode: start.user_code, verificationUri: start.verification_uri ?? start.verification_url, verificationUriComplete: start.verification_uri_complete ?? null, expiresAt });
  let interval = Number.isFinite(Number(start.interval)) ? Number(start.interval) * 1000 : 5000;
  for (;;) {
    await sleep(Math.max(20, interval), signal);
    if (now() > expiresAt) throw new OAuthError('The code ran out before the sign-in was done.', 'expired_token');
    try {
      return await tokenCall(cfg, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: start.device_code }, { fetch, signal, now });
    } catch (e) {
      if (e.code === 'authorization_pending') continue;
      if (e.code === 'slow_down') {
        interval += 5000;
        continue;
      }
      if (e.code === 'access_denied') throw new OAuthError('The sign-in was turned down.', e.code);
      throw e;
    }
  }
}

/** The credential store's name for a refresh token: oauth:<the file's hash>:<environment>:<id>. */
export const refreshName = (file, env, id) => `oauth:${createHash('sha1').update(String(file)).digest('hex').slice(0, 16)}:${env ?? '-'}:${id}`;

/**
 * The tokens Hail holds while it runs: { get, status, forget }. `credentials` keeps refresh tokens
 * (credentials.js). `onSignIn({ id, grant, how })` is told of each new token ('signed in' or
 * 'refreshed'); `onNote(text)` of what's worth saying (a refresh token that couldn't be kept).
 */
export function createTokens({ credentials, fetch = globalThis.fetch, now = Date.now, onSignIn = () => {}, onNote = () => {} } = {}) {
  const cache = new Map();
  const pending = new Map();
  const fresh = (t) => t && (!t.expiresAt || t.expiresAt - EARLY > now());
  const pick = (t, kind, cfg) => {
    const want = kind === 'idToken' || (cfg.useIdToken && t.idToken) ? 'idToken' : 'accessToken';
    const v = t[want];
    if (!v) throw new Error(want === 'idToken' ? `The sign-in for ${cfg.id} gave no ID token (asking for the openid scope usually brings one).` : `The sign-in for ${cfg.id} gave no access token.`);
    return v;
  };
  const stored = async (name) => {
    try {
      return (await credentials?.get(name)) ?? null;
    } catch {
      return null;
    }
  };
  const keep = async (name, t) => {
    if (!t.refreshToken || !credentials) return;
    try {
      await credentials.set(name, { user: name, password: t.refreshToken });
    } catch (e) {
      onNote(`Couldn't keep the refresh token in ${credentials.name}: ${e.message.split('\n')[0]}`);
    }
  };

  /**
   * A token for `cfg` (readAuthConfig's): `key` names it in memory (file, environment, id), `store` in
   * the credential store. `interactive(cfg)` runs a grant that needs a person (code, device) and
   * resolves with its token; without it, those grants can't sign in afresh. `kind`: 'token' or 'idToken'.
   */
  async function get({ key, store, cfg, kind = 'token', interactive = null, signal }) {
    const have = cache.get(key);
    if (fresh(have)) return pick(have, kind, cfg);
    if (!pending.has(key)) {
      const p = (async () => {
        const refresh = have?.refreshToken ?? (await stored(store));
        if (refresh) {
          try {
            const t = await refreshGrant(cfg, refresh, { fetch, signal, now });
            cache.set(key, t);
            if (t.refreshToken !== refresh) await keep(store, t);
            onSignIn({ id: cfg.id, grant: cfg.grant, how: 'refreshed' });
            return t;
          } catch (e) {
            if (e.cancelled) throw e;
            // Refused (expired, revoked): sign in afresh, and forget it.
            if (e instanceof OAuthError) await credentials?.remove(store).catch(() => {});
            else throw e;
          }
        }
        let t;
        if (cfg.grant === 'client') t = await clientCredentials(cfg, { fetch, signal, now });
        else if (cfg.grant === 'password') t = await passwordGrant(cfg, { fetch, signal, now });
        else if (!interactive) throw new Error(`The auth ${cfg.id} signs in with ${GRANT_NAMES[cfg.grant]}, which needs a person: sign in once in Hail (its refresh token is kept), or use Client Credentials here.`);
        else t = await interactive(cfg);
        cache.set(key, t);
        await keep(store, t);
        onSignIn({ id: cfg.id, grant: cfg.grant, how: 'signed in' });
        return t;
      })();
      pending.set(key, p);
      p.finally(() => pending.delete(key)).catch(() => {});
    }
    return pick(await pending.get(key), kind, cfg);
  }

  /** What's known of `key` without signing in: { signedIn, expiresAt, refresh } (refresh: one is kept). */
  async function status(key, store) {
    const t = cache.get(key);
    return { signedIn: fresh(t), expiresAt: t?.expiresAt ?? null, refresh: Boolean(t?.refreshToken || (await stored(store))) };
  }

  /** Forgets `key`'s token, and its refresh token in the store. */
  async function forget(key, store) {
    cache.delete(key);
    await credentials?.remove(store).catch(() => {});
  }

  return { get, status, forget };
}
