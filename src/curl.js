// Reading a curl command line into a request, for /import-curl. Pure. Takes what browsers' "Copy as
// cURL" gives in each of its shells: bash and zsh ('single', "double", $'ansi' quoting and \ at line
// ends), Windows cmd (^ escapes and ^ at line ends, Chrome's "Copy as cURL (cmd)") and PowerShell
// (` escapes and ` at line ends), and the lines run together as the prompt has them.

// Options whose value is skipped: they change how curl itself runs, not the request.
const SKIP_WITH_VALUE = new Set([
  '-o', '--output', '-w', '--write-out', '--connect-timeout', '--retry', '--retry-delay', '--retry-max-time', '-x', '--proxy', '-U', '--proxy-user',
  '-c', '--cookie-jar', '--cacert', '--capath', '-E', '--cert', '--key', '--cert-type', '--key-type', '--resolve', '--connect-to', '--limit-rate',
  '-r', '--range', '-z', '--time-cond', '--interface', '--dns-servers', '-K', '--config', '--trace', '--trace-ascii', '--stderr', '-T', '--upload-file',
  '--max-redirs', '-y', '--speed-time', '-Y', '--speed-limit', '--tls-max', '--ciphers', '--pinnedpubkey', '--proto', '--proto-redir', '--unix-socket',
]);
// Short options that take a value, for -XPOST and the like.
const SHORT_WITH_VALUE = new Set(['X', 'H', 'd', 'u', 'F', 'A', 'e', 'b', 'm', 'o', 'w', 'x', 'U', 'c', 'E', 'r', 'z', 'K', 'T', 'y', 'Y']);

/** Which shell the command was written for: 'cmd' (^ escapes), 'powershell' (` escapes) or 'posix'. */
export function shellOf(text) {
  // Also when the prompt has run the lines together: a ^ or ` standing alone between words.
  if (/\^\s*(\r?\n|$)|\^"|\s\^\s/m.test(text)) return 'cmd';
  if (/`\s*(\r?\n|$)|`"|\s`\s/m.test(text)) return 'powershell';
  return 'posix';
}

const ANSI_C = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v', 0: '\0' };

/** The command's words, as its shell would split and unquote them. */
export function tokenize(text, shell = shellOf(text)) {
  let s = String(text);
  if (shell === 'cmd') {
    // ^ at a line's end joins the next line on, and ^x stands for x.
    s = s.replace(/\^\r?\n/g, ' ').replace(/\^(.)/g, '$1');
  }
  const words = [];
  let word = null;
  const push = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (/\s/.test(c)) {
      push();
      continue;
    }
    // A line continuation the prompt ran into one line: \ (or `) on its own, then spaces.
    if (shell === 'posix' && c === '\\' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      if (s[i + 1] === '\n' || s[i + 1] === '\r' || word === null) {
        push();
        continue;
      }
    }
    if (shell === 'powershell' && c === '`' && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
      push();
      continue;
    }
    word ??= '';
    if (c === "'" && shell === 'posix' && s[i - 1] === '$' && word.endsWith('$')) {
      // $'...': ANSI-C quoting, as Chrome's bash copy uses for bodies with odd characters.
      word = word.slice(0, -1);
      for (i++; i < s.length && s[i] !== "'"; i++) {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[++i];
          if (n === 'x' && /^[0-9a-f]{2}$/i.test(s.slice(i + 1, i + 3))) {
            word += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16));
            i += 2;
          } else if (n === 'u' && /^[0-9a-f]{4}$/i.test(s.slice(i + 1, i + 5))) {
            word += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16));
            i += 4;
          } else word += ANSI_C[n] ?? `\\${n}`;
        } else word += s[i];
      }
    } else if (c === "'") {
      // Single quotes: as they are; PowerShell writes a ' inside as ''.
      for (i++; i < s.length; i++) {
        if (s[i] === "'" && shell === 'powershell' && s[i + 1] === "'") {
          word += "'";
          i++;
        } else if (s[i] === "'") break;
        else word += s[i];
      }
    } else if (c === '"') {
      for (i++; i < s.length; i++) {
        if (s[i] === '"') {
          // PowerShell writes a " inside as "".
          if (shell !== 'powershell' || s[i + 1] !== '"') break;
          word += '"';
          i++;
        } else if (shell === 'powershell' && s[i] === '`' && i + 1 < s.length) {
          const n = s[++i];
          word += { n: '\n', t: '\t', r: '\r', 0: '\0' }[n] ?? n;
        } else if (shell !== 'powershell' && s[i] === '\\' && i + 1 < s.length && (shell === 'cmd' ? s[i + 1] === '"' || s[i + 1] === '\\' : '"\\$`\n'.includes(s[i + 1]))) {
          const n = s[++i];
          if (n !== '\n') word += n;
        } else word += s[i];
      }
    } else if (c === '\\' && shell === 'posix' && i + 1 < s.length) {
      const n = s[++i];
      if (n !== '\n') word += n;
    } else if (c === '`' && shell === 'powershell' && i + 1 < s.length) word += s[++i];
    else word += c;
  }
  push();
  return words;
}

const header = (headers, name) => headers.find(([k]) => k.toLowerCase() === name.toLowerCase());

/**
 * The command as a request: { method, url, headers: [[name, value]], body, bodyFile, timeout, ignored }.
 * `ignored` names the options that don't carry over (-k, which an environment's SSLConfiguration does,
 * and the like). Throws when it isn't a curl command or has no URL.
 */
export function parseCurl(text) {
  const words = tokenize(String(text).trim());
  if (!words.length || !/^curl(\.exe)?$/i.test(words[0].replace(/^.*[\\/]/, ''))) throw new Error("That isn't a curl command: it should start with curl.");
  let method = null;
  let url = null;
  const headers = [];
  const data = [];
  let get = false;
  let head = false;
  let json = false;
  let user = null;
  const form = [];
  let timeout = null;
  const ignored = new Set();
  let bodyFile = null;
  const addHeader = (line) => {
    const m = /^([^:]+):\s*(.*)$/.exec(line);
    if (m) headers.push([m[1].trim(), m[2]]);
  };
  for (let i = 1; i < words.length; i++) {
    let w = words[i];
    let value = () => words[++i] ?? '';
    // -XPOST, -H'X: y', -dfoo: a short option with its value joined on.
    const joined = /^-([A-Za-z])(.+)$/.exec(w);
    if (joined && SHORT_WITH_VALUE.has(joined[1])) {
      w = `-${joined[1]}`;
      const v = joined[2];
      value = () => v;
    } else if (joined && /^-[A-Za-z]+$/.test(w)) {
      // Flags run together (-sSL): none of them changes the request but -G and -I.
      if (w.includes('G')) get = true;
      if (w.includes('I')) head = true;
      if (w.includes('k')) ignored.add('-k');
      continue;
    }
    if (w === '-X' || w === '--request') method = value().toUpperCase();
    else if (w === '-H' || w === '--header') addHeader(value());
    else if (['-d', '--data', '--data-ascii', '--data-raw', '--data-binary', '--data-urlencode'].includes(w)) {
      const v = value();
      if (v.startsWith('@') && w !== '--data-raw' && w !== '--data-urlencode') bodyFile = v.slice(1);
      else data.push(w === '--data-urlencode' ? urlencoded(v) : w === '-d' || w === '--data' || w === '--data-ascii' ? v.replace(/\r?\n/g, '') : v);
    } else if (w === '--json') {
      json = true;
      const v = value();
      if (v.startsWith('@')) bodyFile = v.slice(1);
      else data.push(v);
    } else if (w === '-u' || w === '--user') user = value();
    else if (w === '-F' || w === '--form' || w === '--form-string') form.push({ raw: value(), literal: w === '--form-string' });
    else if (w === '-A' || w === '--user-agent') headers.push(['User-Agent', value()]);
    else if (w === '-e' || w === '--referer') headers.push(['Referer', value()]);
    else if (w === '-b' || w === '--cookie') {
      const v = value();
      if (v.includes('=')) headers.push(['Cookie', v]);
      else ignored.add('-b <file>');
    } else if (w === '-m' || w === '--max-time') timeout = Number(value()) || null;
    else if (w === '--url') url = value();
    else if (w === '-G' || w === '--get') get = true;
    else if (w === '-I' || w === '--head') head = true;
    else if (w === '-k' || w === '--insecure') ignored.add('-k');
    else if (SKIP_WITH_VALUE.has(w)) {
      value();
      ignored.add(w);
    } else if (w.startsWith('-')) {
      // --compressed, -L, -s, -v, -i, --http2 and the rest: how curl runs, which Hail decides itself.
    } else url ??= w;
  }
  if (!url) throw new Error('The curl command has no URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  if (user) {
    const basic = Buffer.from(user.includes(':') ? user : `${user}:`).toString('base64');
    if (!header(headers, 'Authorization')) headers.push(['Authorization', `Basic ${basic}`]);
  }
  if (json) {
    if (!header(headers, 'Content-Type')) headers.push(['Content-Type', 'application/json']);
    if (!header(headers, 'Accept')) headers.push(['Accept', 'application/json']);
  }
  let body = data.join(json ? '' : '&');
  if (get && body) {
    url += (url.includes('?') ? '&' : '?') + body;
    body = '';
  }
  if (form.length) {
    const boundary = 'WebAppBoundary';
    const ct = header(headers, 'Content-Type');
    if (ct && /^multipart\//i.test(ct[1]) && /boundary=/i.test(ct[1])) ct[1] = `multipart/form-data; boundary=${boundary}`;
    else if (!ct) headers.push(['Content-Type', `multipart/form-data; boundary=${boundary}`]);
    body = multipartText(form, boundary);
  } else if (body && !json && !bodyFile && !header(headers, 'Content-Type') && !get) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
  method ??= head ? 'HEAD' : get ? 'GET' : body || bodyFile || form.length ? 'POST' : 'GET';
  return { method, url, headers, body, bodyFile, timeout, ignored: [...ignored] };
}

// --data-urlencode's forms: "content", "=content", "name=content", "@file", "name@file".
function urlencoded(v) {
  const eq = v.indexOf('=');
  if (eq < 0) return encodeURIComponent(v);
  const name = v.slice(0, eq);
  return name ? `${name}=${encodeURIComponent(v.slice(eq + 1))}` : encodeURIComponent(v.slice(eq + 1));
}

/** -F fields as a multipart body in JetBrains' format, files as `< path` lines. */
function multipartText(form, boundary) {
  const out = [];
  for (const { raw, literal } of form) {
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw : raw.slice(0, eq);
    let value = eq < 0 ? '' : raw.slice(eq + 1);
    // ;type=… and ;filename=… after a file.
    let type = null;
    let filename = null;
    const file = !literal && (value.startsWith('@') || value.startsWith('<'));
    if (file) {
      const parts = value.slice(1).split(';');
      value = parts[0];
      for (const p of parts.slice(1)) {
        const m = /^\s*(type|filename)=(.*)$/.exec(p);
        if (m?.[1] === 'type') type = m[2];
        if (m?.[1] === 'filename') filename = m[2];
      }
    }
    out.push(`--${boundary}`);
    const upload = file && raw.slice(eq + 1).startsWith('@');
    const shownName = filename ?? value.replace(/^.*[\\/]/, '');
    out.push(`Content-Disposition: form-data; name="${name}"${upload ? `; filename="${shownName}"` : ''}`);
    if (type) out.push(`Content-Type: ${type}`);
    out.push('', file ? `< ${value}` : value);
  }
  out.push(`--${boundary}--`);
  return out.join('\n');
}

/** "POST /users", for the request's ### line: the method and the URL's path. */
export function requestTitle({ method, url }) {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // Not a URL after all: the whole of it.
  }
  return `${method} ${path || '/'}`;
}

/** The request as a block of a .http file, from ### to its body. */
export function curlToHttp(parsed, title = requestTitle(parsed)) {
  const lines = [`### ${title}`];
  if (parsed.timeout) lines.push(`# @timeout ${parsed.timeout}`);
  lines.push(`${parsed.method} ${parsed.url}`);
  for (const [k, v] of parsed.headers) lines.push(`${k}: ${v}`);
  if (parsed.bodyFile) lines.push('', `< ${parsed.bodyFile}`);
  else if (parsed.body) {
    let body = parsed.body;
    // JSON reads better indented, as it would be written by hand.
    if (/json/i.test(parsed.headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '')) {
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Not JSON after all: as it came.
      }
    }
    lines.push('', body);
  }
  return `${lines.join('\n')}\n`;
}
