// Server-sent events: read as they come, shown live in the Response view until esc or the end, and
// kept whole.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventReader, eventsText, parseEvents } from '../src/sse.js';
import { prettyBody, send } from '../src/send.js';
import { KEYS, start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
const open = new Set();

before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-sse-'));
  server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    if (req.url === '/three') {
      let n = 0;
      const t = setInterval(() => {
        n++;
        res.write(`id: ${n}\nevent: tick\ndata: {"n":${n}}\n\n`);
        if (n === 3) {
          clearInterval(t);
          res.end();
        }
      }, 20);
      return;
    }
    // Never ends: an event every 40 ms until the client goes.
    open.add(res);
    let n = 0;
    res.write(': hello\n\n');
    const t = setInterval(() => res.write(`data: {"count":${++n}}\n\n`), 40);
    res.on('close', () => {
      clearInterval(t);
      open.delete(res);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  for (const r of open) r.destroy();
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('events are read as the standard has them, across pieces however they are cut', () => {
  const r = eventReader();
  assert.deepEqual(r.push('data: one\r'), []);
  assert.deepEqual(r.push('\n\r\n: a comment\nid: 7\nevent: up'), [{ id: null, event: 'message', data: 'one' }]);
  assert.deepEqual(r.push('date\ndata: a\ndata:b\nretry: 300\n\n'), [{ id: '7', event: 'update', data: 'a\nb', retry: 300 }]);
  assert.deepEqual(r.push('data: two\n\n'), [{ id: '7', event: 'message', data: 'two' }]);
  assert.deepEqual(parseEvents('data: unfinished'), []);
  assert.equal(eventsText(parseEvents('id: 1\nevent: tick\ndata: {"n":1}\n\ndata: plain\n\n')), '#1  event: tick  id: 1\n{\n  "n": 1\n}\n\n#2  id: 1\nplain');
  assert.equal(prettyBody({ headers: [['Content-Type', 'text/event-stream']], body: 'data: {"a":1}\n\n' }), '#1\n{\n  "a": 1\n}');
});

test('send reads a stream as it comes, and esc keeps what came', async () => {
  const seen = [];
  const r = await send({ method: 'GET', url: `${base}/three`, headers: [] }, { onStream: (p) => seen.push(p.events) });
  assert.equal(r.stream.events, 3);
  assert.equal(r.stream.stopped, false);
  assert.deepEqual(seen.at(-1), 3);
  assert.equal(parseEvents(r.body).at(-1).data, '{"n":3}');
  const c = new AbortController();
  const endless = await send({ method: 'GET', url: `${base}/forever`, headers: [] }, { signal: c.signal, onStream: (p) => p.events >= 2 && c.abort() });
  assert.equal(endless.stream.stopped, true);
  assert.ok(endless.stream.events >= 2);
  // A run bounds an endless one with # @timeout.
  const timed = await send({ method: 'GET', url: `${base}/forever`, headers: [] }, { timeout: 150 });
  assert.equal(timed.stream.stopped, true);
});

test('through the UI: the events stream into the Response view until esc, and are kept', async () => {
  writeFileSync(join(dir, 'live.http'), `### Ticks\nGET ${base}/forever\nAccept: text/event-stream\n`);
  const app = start({ initialFile: join(dir, 'live.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Ticks'), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('streaming… (esc stops it)') && /Streaming: \d+ events/.test(f()), 'the stream, live in the Response view');
    assert.match(f(), /─ GET Ticks/);
    await until(() => /"count": [4-9]/.test(f()), 'later events on screen');
    app.stdin.write(KEYS.esc);
    await until(() => /events · stopped/.test(f()), 'stopped');
    assert.match(f(), /200 OK .*\d+ events, stopped/s);
    app.stdin.write('4');
    await until(() => f().includes('1 kept'), 'kept in the history');
  } finally {
    app.unmount();
  }
});
