// A cookie jar, as a browser keeps one: what Set-Cookie says, sent back on later requests to the
// same site, honouring Domain, Path, Expires/Max-Age and Secure (RFC 6265, without the public suffix
// list). Pure: the clock comes in as `now`. App keeps one per file and environment, in memory only.

/** The cookie in one Set-Cookie value, set by a response from `url`, or null when it's refused. */
export function parseSetCookie(value, url, now = Date.now()) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const [pair, ...attrs] = String(value).split(';');
  const eq = pair.indexOf('=');
  if (eq < 1) return null;
  const cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1'), domain: host, hostOnly: true, path: defaultPath(u.pathname), secure: false, httpOnly: false, expires: null };
  if (!cookie.name) return null;
  let maxAge = null;
  for (const a of attrs) {
    const i = a.indexOf('=');
    const key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? '' : a.slice(i + 1).trim();
    if (key === 'domain' && v) {
      const d = v.replace(/^\./, '').toLowerCase();
      // A cookie for another site, or for a whole top-level domain, is refused.
      if (!domainMatches(host, d) || (!d.includes('.') && d !== host)) return null;
      cookie.domain = d;
      cookie.hostOnly = false;
    } else if (key === 'path' && v.startsWith('/')) cookie.path = v;
    else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'max-age' && /^-?\d+$/.test(v)) maxAge = Number(v);
    else if (key === 'expires') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) cookie.expires = t;
    }
  }
  // Max-Age wins over Expires; zero or less means it's gone.
  if (maxAge !== null) cookie.expires = maxAge <= 0 ? 0 : now + maxAge * 1000;
  return cookie;
}

/** The path a cookie without one gets: the request's, up to its last slash. */
function defaultPath(path) {
  if (!path.startsWith('/')) return '/';
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

/** Whether `host` is `domain` or a name under it (never for an IP address but itself). */
export function domainMatches(host, domain) {
  if (host === domain) return true;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return host.endsWith(`.${domain}`);
}

/** Whether a request to `path` gets a cookie set for `cookiePath`. */
export function pathMatches(path, cookiePath) {
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

/** A jar: store(setCookies, url), header(url) for the Cookie header, list(), clear(), size(). */
export function createJar() {
  let cookies = [];
  const alive = (c, now) => c.expires === null || c.expires > now;
  return {
    /** Keeps what the Set-Cookie values in `setCookies` say, from a response to `url`. */
    store(setCookies, url, now = Date.now()) {
      for (const value of setCookies ?? []) {
        const c = parseSetCookie(value, url, now);
        if (!c) continue;
        if (c.secure && new URL(url).protocol !== 'https:') continue;
        cookies = cookies.filter((x) => !(x.name === c.name && x.domain === c.domain && x.path === c.path));
        if (alive(c, now)) cookies.push({ ...c, created: now });
      }
    },
    /** The Cookie header for a request to `url`, or '' when the jar has nothing for it. */
    header(url, now = Date.now()) {
      const u = new URL(url);
      const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      cookies = cookies.filter((c) => alive(c, now));
      return cookies
        .filter((c) => (c.hostOnly ? host === c.domain : domainMatches(host, c.domain)) && pathMatches(u.pathname || '/', c.path) && (!c.secure || u.protocol === 'https:'))
        .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    },
    /** Every cookie kept, by site. */
    list(now = Date.now()) {
      cookies = cookies.filter((c) => alive(c, now));
      return [...cookies].sort((a, b) => a.domain.localeCompare(b.domain) || a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    },
    clear() {
      const n = cookies.length;
      cookies = [];
      return n;
    },
    size: () => cookies.length,
  };
}
