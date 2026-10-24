// WebSockets: the messages between === lines, waiting for the server where the file says, a live view
// to type into, and the conversation kept (secrets left out) once it closes. The server is a small one
// written here over http's upgrade: the handshake and the framing, nothing more.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCredentials } from '../src/credentials.js';
import { parseHttpFile, highlight } from '../src/http-file.js';
import { openSocket, socketMessages, socketUrl, transcript } from '../src/websocket.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
const upgrades = [];
const sockets = new Set();

/** One frame from the server: unmasked, FIN set. */
const frame = (opcode, payload) => {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  return Buffer.concat([head, payload]);
};

/** The frames a client sent (masked, as clients must), as { opcode, payload }; what's left over is kept for the next chunk. */
function reader(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 15;
      let len = buf[1] & 127;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const payload = Buffer.from(buf.subarray(at + 4, at + 4 + len)).map((b, i) => b ^ mask[i % 4]);
      buf = buf.subarray(at + 4 + len);
      onFrame({ opcode, payload: Buffer.from(payload) });
    }
  };
}

before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-ws-'));
  server = createServer((req, res) => res.end('not a socket'));
  // Answers "hello" with two messages, echoes anything else as JSON, and says goodbye to "bye".
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    upgrades.push({ url: req.url, token: req.headers['x-token'] ?? null, protocol: req.headers['sec-websocket-protocol'] ?? null });
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    const proto = req.headers['sec-websocket-protocol'] ? `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol'].split(',')[0].trim()}\r\n` : '';
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${proto}\r\n`);
    const text = (s) => socket.write(frame(1, Buffer.from(s)));
    socket.on('data', reader(({ opcode, payload }) => {
      if (opcode === 8) {
        socket.write(frame(8, payload.subarray(0, 2)));
        return socket.end();
      }
      if (opcode !== 1) return;
      const msg = payload.toString();
      if (msg === 'hello') {
        text('{"greeting":"hi","n":1}');
        text('second');
      } else if (msg === 'bye') {
        socket.write(frame(8, Buffer.from([0x03, 0xe8])));
        socket.end();
      } else text(JSON.stringify({ echo: msg }));
    }));
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const s of sockets) s.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('the messages between === lines, and how many answers each waits for', () => {
  assert.deepEqual(socketMessages('===\n{\n  "a": 1\n}\n=== wait-for-server\n=== wait-for-server\nthird\n===\nfourth\n'), [
    { text: '{\n  "a": 1\n}', wait: 0 },
    { text: 'third', wait: 2 },
    { text: 'fourth', wait: 0 },
  ]);
  assert.deepEqual(socketMessages('just one'), [{ text: 'just one', wait: 0 }]);
  assert.deepEqual(socketMessages(''), []);
  assert.equal(socketUrl('https://x/y'), 'wss://x/y');
  const { requests } = parseHttpFile('### Live\nWEBSOCKET ws://localhost/ws\nX-Token: t\n\n===\nhello\n=== wait-for-server\nnext\n');
  assert.equal(requests[0].method, 'WEBSOCKET');
  assert.equal(requests[0].body, '===\nhello\n=== wait-for-server\nnext');
  const kinds = highlight('WEBSOCKET ws://x\n\n===\nhi\n=== wait-for-server\n').map((l) => l.map((r) => r.kind).join(','));
  assert.equal(kinds[0], ',method,,url'.replace(/^,/, ''));
  assert.equal(kinds[2], 'boundary');
  assert.equal(kinds[4], 'boundary');
});

test('a session sends the file\'s messages as the server answers, then what is typed', async () => {
  const s = await openSocket({ url: `ws://${base}/chat`, headers: [['X-Token', 'abc'], ['Sec-WebSocket-Protocol', 'chat.v1'], ['Content-Type', 'application/json']], messages: socketMessages('hello\n=== wait-for-server\n=== wait-for-server\nafter both') });
  const seen = (n) => new Promise((r) => {
    const check = () => s.received >= n && r();
    s.subscribe(check);
    check();
  });
  await seen(3);
  assert.deepEqual(s.log.filter((m) => m.dir !== 'info').map((m) => [m.dir, m.text]), [
    ['sent', 'hello'],
    ['received', '{"greeting":"hi","n":1}'],
    ['received', 'second'],
    ['sent', 'after both'],
    ['received', '{"echo":"after both"}'],
  ]);
  assert.deepEqual(upgrades.at(-1), { url: '/chat', token: 'abc', protocol: 'chat.v1' });
  assert.ok(s.send('more'));
  await seen(4);
  s.close();
  await s.ended;
  assert.equal(s.state, 'closed');
  assert.equal(s.send('late'), false);
  assert.match(transcript(s.log), /^· Connected to ws:\/\/.*\n→ hello\n← \{"greeting"/);
  // Nothing there.
  const spare = createServer();
  await new Promise((r) => spare.listen(0, '127.0.0.1', r));
  const closed = spare.address().port;
  await new Promise((r) => spare.close(r));
  const none = await openSocket({ url: `ws://127.0.0.1:${closed}/nothing` });
  await none.ended;
  assert.match(none.log.find((m) => m.dir === 'error').text, /Couldn't connect/);
});

test('through the UI: the live view, typing a message, esc closing it, the conversation kept without its secrets', async () => {
  writeFileSync(join(dir, 'live.http'), `### Chat\nWEBSOCKET ws://${base}/live\nX-Token: {{$secret ws-token}}\n\n===\nhello\n=== wait-for-server\n{ "token": "{{$secret ws-token}}" }\n\n### Plain\nGET http://${base}/\n`);
  const app = start({ initialFile: join(dir, 'live.http'), credentials: memoryCredentials({ 'ws-token': 'tok-secret-9' }) });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Chat'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('3 received') && f().includes('"echo"'), 'the conversation');
    assert.match(f(), /WEBSOCKET ws:\/\/127\.0\.0\.1:\d+\/live/);
    assert.match(f(), /→ sent/);
    assert.match(f(), /← received/);
    assert.equal(upgrades.at(-1).token, 'tok-secret-9');
    await type(app.stdin, 'typed 1q');
    await until(() => f().includes('> typed 1q'), 'the message typed (1 and q are text here)');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('"echo": "typed 1q"'), 'its echo');
    app.stdin.write(KEYS.esc);
    await until(() => f().includes('closed') && /101 Chat/.test(f()), 'closed, its conversation as the response');
    assert.match(f(), /2 sent · \d received|3 sent · \d received/);
    const history = readdirSync(join(process.env.HAIL_HOME, 'history')).map((x) => readFileSync(join(process.env.HAIL_HOME, 'history', x), 'utf8')).join('');
    assert.match(history, /typed 1q/);
    assert.doesNotMatch(history, /tok-secret-9/, 'the secret it carried is left out');
  } finally {
    app.unmount();
  }
});
