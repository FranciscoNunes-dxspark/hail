// WebSockets, as JetBrains writes them: `WEBSOCKET ws://host/path`, headers, then the messages to send,
// separated by `===` lines; `=== wait-for-server` waits for a message from the server before the next
// one goes. The connection is a session that lives until it's closed: a log of what went each way,
// a send for what's typed, and a close. Through the runtime's own WebSocket (Node 22's and Bun's take
// headers), so there's no dependency.
import { transport } from './transport.js';

const SEPARATOR = /^===(\s+wait-for-server)?\s*$/;

/**
 * The messages in a WEBSOCKET request's body: [{ text, wait }], `wait` being how many messages from the
 * server to wait for before sending it (one per `=== wait-for-server` line above it). Pure.
 */
export function socketMessages(body) {
  const out = [];
  let lines = [];
  let wait = 0;
  const flush = () => {
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    if (lines.length) {
      out.push({ text: lines.join('\n'), wait });
      wait = 0;
    }
    lines = [];
  };
  for (const l of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const m = SEPARATOR.exec(l);
    if (!m) {
      lines.push(l);
      continue;
    }
    flush();
    if (m[1]) wait++;
  }
  flush();
  return out;
}

/** `url` as a WebSocket's: http(s):// becomes ws(s)://. */
export const socketUrl = (url) => String(url).replace(/^http(s?):\/\//i, 'ws$1://');

// Headers the upgrade makes itself, or that only say what the messages are (JetBrains' Content-Type).
const OWN = /^(content-type|content-length|host|connection|upgrade|sec-websocket-key|sec-websocket-version|sec-websocket-extensions)$/i;

/**
 * Opens a WebSocket to `url` with `headers` ([[name, value]]; Sec-WebSocket-Protocol becomes the
 * protocols asked for) and sends `messages` (socketMessages') in turn as the server answers. Returns the
 * session: { url, log: [{ dir: 'sent' | 'received' | 'info' | 'error', text, at }], state ('connecting',
 * 'open', 'closing', 'closed'), sent, received, started, closed: { code, reason }, send(text), close(),
 * subscribe(fn), ended (a promise, when it's closed) }. `insecure` skips checking a wss certificate, and a
 * proxy comes from `env` (transport.js).
 */
export async function openSocket({ url, headers = [], messages = [], insecure = false, env = process.env, WebSocketImpl = globalThis.WebSocket, now = Date.now, keep = 2000, connectTimeout = 15_000 }) {
  const listeners = new Set();
  let done;
  const s = { url, log: [], state: 'connecting', sent: 0, received: 0, started: now(), closed: null, ended: new Promise((r) => (done = r)) };
  const emit = () => {
    for (const f of listeners) f(s);
  };
  const add = (dir, text) => {
    s.log.push({ dir, text, at: now() });
    if (s.log.length > keep) s.log.splice(0, s.log.length - keep);
    emit();
  };
  s.subscribe = (f) => {
    listeners.add(f);
    return () => listeners.delete(f);
  };
  const finish = (closed) => {
    if (s.state === 'closed') return;
    s.state = 'closed';
    s.closed = closed;
    add('info', `Closed${closed.code ? ` (${closed.code}${closed.reason ? `: ${closed.reason}` : ''})` : ''}`);
    done(s);
  };
  if (!WebSocketImpl) {
    add('error', "This runtime has no WebSocket (Node 22 or later has one).");
    finish({ code: 0, reason: '' });
    return s;
  }
  const protocols = headers.filter(([k]) => /^sec-websocket-protocol$/i.test(k)).flatMap(([, v]) => v.split(',').map((x) => x.trim()).filter(Boolean));
  const own = Object.fromEntries(headers.filter(([k]) => !OWN.test(k) && !/^sec-websocket-protocol$/i.test(k)));
  let ws;
  try {
    const way = await transport(url.replace(/^ws/i, 'http'), { insecure, env });
    ws = new WebSocketImpl(url, { headers: own, ...(protocols.length ? { protocols } : {}), ...way.init });
  } catch (e) {
    add('error', `Couldn't open ${url}: ${e.message}`);
    finish({ code: 0, reason: '' });
    return s;
  }
  ws.binaryType = 'arraybuffer';
  let next = 0;
  let heard = 0;
  // The file's messages, each once the server has said as much as its `=== wait-for-server` lines ask.
  const pump = () => {
    while (s.state === 'open' && next < messages.length && heard >= messages[next].wait) {
      heard = 0;
      s.send(messages[next++].text);
    }
  };
  s.send = (text) => {
    if (s.state !== 'open') return false;
    ws.send(text);
    s.sent++;
    add('sent', text);
    return true;
  };
  s.close = () => {
    if (s.state === 'closed' || s.state === 'closing') return;
    const was = s.state;
    s.state = 'closing';
    try {
      ws.close(1000);
    } catch {}
    // One that never opened, or a server that doesn't answer the close, is let go of anyway.
    setTimeout(() => finish({ code: 1000, reason: '' }), was === 'open' ? 2000 : 0).unref?.();
  };
  s.waiting = () => messages.length - next;
  ws.onopen = () => {
    clearTimeout(timer);
    if (s.state !== 'connecting') return;
    s.state = 'open';
    add('info', `Connected to ${url}${ws.protocol ? ` (${ws.protocol})` : ''}`);
    pump();
  };
  ws.onmessage = (e) => {
    const text = typeof e.data === 'string' ? e.data : `(${e.data.byteLength} bytes, base64) ${Buffer.from(e.data).toString('base64')}`;
    s.received++;
    heard++;
    add('received', text);
    pump();
  };
  // A connection that never opens says so, and ends (the runtime doesn't always say it closed).
  const fail = (why) => {
    add('error', `Couldn't connect to ${url}: ${why}`);
    finish({ code: 1006, reason: '' });
    try {
      ws.close();
    } catch {}
  };
  const timer = setTimeout(() => s.state === 'connecting' && fail(`no answer within ${connectTimeout / 1000} s`), connectTimeout);
  timer.unref?.();
  ws.onerror = (e) => {
    if (s.state === 'connecting') fail(e?.message && !/network error/i.test(e.message) ? e.message : 'nothing answered, or it refused the upgrade');
    else if (e?.message) add('error', e.message);
  };
  ws.onclose = (e) => {
    clearTimeout(timer);
    finish({ code: e.code, reason: e.reason });
  };
  return s;
}

/** A session's log as text: a line (or an indented JSON block) per message, → sent and ← received. */
export function transcript(log) {
  const mark = { sent: '→', received: '←', info: '·', error: '✗' };
  return log.map((m) => `${mark[m.dir]} ${m.text}`).join('\n');
}

/** `text` indented when it's JSON, else as it is. */
export function prettyMessage(text) {
  if (/^\s*[[{]/.test(text)) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return text;
}
