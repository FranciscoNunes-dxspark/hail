// How a request reaches its server: straight, or through the proxy HTTPS_PROXY / HTTP_PROXY name
// (NO_PROXY leaving some out), and with or without checking the server's certificate (an
// environment's "SSLConfiguration": { "verifyHostCertificate": false }, as JetBrains has it).
//
// Without a dependency: Node's fetch is undici, which takes a `dispatcher`, and undici's Agent class is
// the global dispatcher's own (Symbol.for('undici.globalDispatcher.1'), set once fetch has been used).
// An Agent given its own `connect` reaches the proxy and asks it for a tunnel (CONNECT), for http and
// https alike. Bun's fetch takes `tls` and `proxy` instead, which the compiled builds use.
import net from 'node:net';
import tls from 'node:tls';

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|::1)$/i;

const ipv4 = (s) => (/^\d+\.\d+\.\d+\.\d+$/.test(s) ? s.split('.').reduce((n, p) => n * 256 + Number(p), 0) : null);

/** Whether NO_PROXY's `list` ("localhost,.example.com,10.0.0.0/8,*") leaves `host` (and `port`) out. */
export function bypassesProxy(host, port, list) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (const raw of String(list ?? '').split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const cidr = /^([\d.]+)\/(\d+)$/.exec(entry);
    if (cidr) {
      const [a, b] = [ipv4(h), ipv4(cidr[1])];
      const bits = Number(cidr[2]);
      if (a !== null && b !== null && bits <= 32 && (bits === 0 || a >>> (32 - bits) === b >>> (32 - bits))) return true;
      continue;
    }
    const withPort = /^(.*?):(\d+)$/.exec(entry);
    if (withPort && !entry.includes('::')) {
      if (String(port) !== withPort[2]) continue;
      entry = withPort[1];
    }
    entry = entry.replace(/^\*?\.?/, '');
    if (h === entry || h.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/** The proxy a request to `url` goes through, from the environment variables, or null. This machine never is proxied. */
export function proxyFor(url, env = process.env) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (LOOPBACK.test(host)) return null;
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  if (bypassesProxy(host, port, env.NO_PROXY ?? env.no_proxy)) return null;
  const proxy = u.protocol === 'https:' ? (env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy) : (env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy);
  if (!proxy) return null;
  return /^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

/** undici's Agent, from the dispatcher fetch made for itself. */
async function agentClass() {
  const key = Symbol.for('undici.globalDispatcher.1');
  if (!globalThis[key]) await fetch('data:,').catch(() => {});
  return globalThis[key]?.constructor ?? null;
}

/**
 * An undici `connect` that asks the proxy at `proxyUrl` for a tunnel to the server (CONNECT), then
 * speaks TLS through it to an https server, checking its certificate unless `insecure`.
 */
export function tunnel(proxyUrl, { insecure = false } = {}) {
  const p = new URL(proxyUrl);
  const auth = p.username ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}\r\n` : '';
  const proxyPort = Number(p.port) || (p.protocol === 'https:' ? 443 : 80);
  return (opts, callback) => {
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    const target = `${opts.hostname.includes(':') && !opts.hostname.startsWith('[') ? `[${opts.hostname}]` : opts.hostname}:${port}`;
    const socket = p.protocol === 'https:' ? tls.connect({ host: p.hostname, port: proxyPort, servername: p.hostname }) : net.connect({ host: p.hostname, port: proxyPort });
    let done = false;
    const finish = (error, s) => {
      if (done) return;
      done = true;
      if (error) {
        socket.destroy();
        callback(error);
      } else callback(null, s);
    };
    socket.once('error', (e) => finish(e));
    socket.once(p.protocol === 'https:' ? 'secureConnect' : 'connect', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`));
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      socket.pause();
      const status = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head.toString('latin1', 0, end))?.[1];
      if (status !== '200') return finish(Object.assign(new Error(`the proxy ${p.host} wouldn't connect to ${target} (${status ?? 'no answer'})`), { code: 'EPROXY' }));
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      if (opts.protocol !== 'https:') return finish(null, socket);
      const servername = opts.servername || (net.isIP(opts.hostname) ? undefined : opts.hostname);
      const secure = tls.connect({ socket, servername, rejectUnauthorized: !insecure, ALPNProtocols: ['http/1.1'] });
      secure.once('secureConnect', () => finish(null, secure));
      secure.once('error', (e) => finish(e));
    };
    socket.on('data', onData);
  };
}

const agents = new Map();

/**
 * What fetch needs for a request to `url`: { init, proxy, insecure }, `init` being the options to add
 * to fetch's (a dispatcher in Node, tls and proxy in Bun; none when it goes straight and checks
 * certificates), `proxy` the proxy's host when it goes through one, `insecure` whether the
 * certificate goes unchecked (https only). `env` holds the proxy variables.
 */
export async function transport(url, { insecure = false, env = process.env } = {}) {
  const proxy = proxyFor(url, env);
  const https = new URL(url).protocol === 'https:';
  const skip = insecure && https;
  const said = { proxy: proxy ? new URL(proxy).host : null, insecure: skip };
  if (!proxy && !skip) return { init: {}, ...said };
  if (process.versions.bun) return { init: { ...(skip ? { tls: { rejectUnauthorized: false } } : {}), ...(proxy ? { proxy } : {}) }, ...said };
  const key = `${proxy ?? ''}\n${skip}`;
  if (!agents.has(key)) {
    const Agent = await agentClass();
    if (!Agent) throw new Error(proxy ? "Going through a proxy isn't possible in this runtime." : "Skipping the certificate check isn't possible in this runtime.");
    agents.set(key, new Agent({ connect: proxy ? tunnel(proxy, { insecure: skip }) : { rejectUnauthorized: false } }));
  }
  return { init: { dispatcher: agents.get(key) }, ...said };
}

/** `# @timeout` in milliseconds: seconds by default, or with a unit (500 ms, 30 s, 2 m); null when it isn't one. */
export function parseTimeout(value) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|sec|min)?\s*$/i.exec(String(value ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 's').toLowerCase();
  const ms = unit === 'ms' ? n : unit.startsWith('m') ? n * 60_000 : n * 1000;
  return ms > 0 ? ms : null;
}
