// /load: the arguments, the numbers, and a run through the UI against a server on 127.0.0.1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadReport, loadStats, parseLoadArgs, percentile, runLoad, sparkline } from '../src/load.js';
import { readHistory, historyFile } from '../src/history.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

test('the arguments: the request, then count and concurrency, with limits', () => {
  assert.deepEqual(parseLoadArgs(''), { name: '', count: 200, concurrency: 10 });
  assert.deepEqual(parseLoadArgs('login 500 20'), { name: 'login', count: 500, concurrency: 20 });
  assert.deepEqual(parseLoadArgs('Page 2 50 5'), { name: 'Page 2', count: 50, concurrency: 5 });
  assert.deepEqual(parseLoadArgs('GET /x c=4 n=8'), { name: 'GET /x', count: 8, concurrency: 4 });
  assert.deepEqual(parseLoadArgs('me 5'), { name: 'me', count: 5, concurrency: 5 });
  assert.match(parseLoadArgs('me 5001').problem, /5,000/);
  assert.match(parseLoadArgs('me 10 101').problem, /up to 100/);
  assert.match(parseLoadArgs('me 0').problem, /at least once/);
});

test('the numbers: percentiles, statuses, errors, a sparkline', async () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(sparkline([1, 1, 9, 9], 4), '▁▁██');
  let clock = 0;
  let i = 0;
  const run = await runLoad({
    count: 10,
    concurrency: 3,
    now: () => clock,
    sendOne: async () => {
      const n = i++;
      clock += 100;
      if (n === 4) throw new Error('Couldn\'t reach x: nothing is listening');
      return { status: n === 7 ? 500 : 200, ms: (n + 1) * 10 };
    },
  });
  const stats = loadStats(run);
  assert.equal(stats.finished, 10);
  assert.deepEqual(stats.statuses, { 200: 8, 500: 1 });
  assert.deepEqual(stats.errors, { "Couldn't reach x: nothing is listening": 1 });
  assert.equal(stats.max, 100);
  assert.equal(stats.rps, 10);
  const text = loadReport(stats, { label: 'GET me', count: 10, concurrency: 3 }).map((l) => l.map((s) => s.text).join('')).join('\n');
  assert.match(text, /p50 \d+ ms · p90/);
  assert.match(text, /✗ 1× Couldn't reach x/);
  assert.match(text, /2 failures/);
});

test('a cancelled run stops starting new requests and counts only what finished', async () => {
  const c = new AbortController();
  let sent = 0;
  const run = await runLoad({
    count: 100,
    concurrency: 2,
    signal: c.signal,
    sendOne: async (signal) => {
      if (++sent === 5) c.abort();
      await new Promise((r) => setTimeout(r, 1));
      if (signal.aborted) throw new Error('Cancelled');
      return { status: 200, ms: 1 };
    },
  });
  assert.equal(run.cancelled, true);
  assert.ok(run.results.length < 10 && run.results.every((r) => r.status === 200));
});

let cleanup;
let dir;
let server;
let hits = 0;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-load-'));
  server = createServer((req, res) => {
    hits++;
    res.setHeader('Set-Cookie', 'n=1');
    res.statusCode = hits % 10 === 0 ? 503 : 200;
    res.end(req.headers.cookie ? 'cookie came back' : 'ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(dir, 'api.http'), `### Ping\nGET http://127.0.0.1:${server.address().port}/ping\n`);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('L starts /load for the request; it sends them, reports, and keeps nothing in the history', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Ping'), 'the requests');
    app.stdin.write('L');
    await until(() => frame().includes('/load Ping 200 10'), 'the prefilled command');
    for (let i = 0; i < 6; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, '40 4');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Load: Ping'), 'the report');
    assert.match(frame(), /40 requests, 4 at a time/);
    assert.match(frame(), /200 {2}36 responses/);
    assert.match(frame(), /503 {2}4 responses/);
    assert.match(frame(), /p50 \d+ ms · p90 \d+ ms · p95 \d+ ms · p99 \d+ ms · max/);
    assert.equal(hits, 40);
    assert.deepEqual(readHistory(historyFile(join(dir, 'api.http'))), []);
  } finally {
    app.unmount();
  }
});
