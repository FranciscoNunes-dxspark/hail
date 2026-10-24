// The family's activity log in Hail: /timeline (all five apps, or this project's), what Hail adds to
// it, and /wiring, what the project points at with its secrets masked.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logActivity, readActivity } from '../src/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let api;
let base;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-timeline-'));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'api'));
  api = createServer((req, res) => {
    res.statusCode = req.url === '/bad' ? 500 : 200;
    res.end('{}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${api.address().port}`;
  writeFileSync(join(dir, 'api', 'api.http'), `### Fine\nGET ${base}/ok\n\n> {% client.test("ok", () => client.assert(response.status === 200)); %}\n\n### Broken\nGET ${base}/bad\n\n> {% client.test("ok", () => client.assert(response.status === 200)); %}\n`);
  writeFileSync(join(dir, 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Main: 'Server=db.local;Database=shop;User Id=sa;Password=Sup3rS3cret;' }, Api: { BaseUrl: 'https://api.example.com' } }));
  writeFileSync(join(dir, 'api', 'http-client.env.json'), JSON.stringify({ dev: { host: base, token: 'tok-plain-777' } }));
});
after(() => {
  api.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('/timeline shows the family newest first, p this project alone; Hail logs a failed run, the mock and /load', async () => {
  logActivity('splice', { text: 'Pushed main (3 commits) (shop)', project: dir }, { now: Date.now() - 60_000 });
  logActivity('trawl', { text: 'Ran an UPDATE on another database', project: join(tmpdir(), 'elsewhere') }, { now: Date.now() - 30_000 });
  const app = start({ initialFile: join(dir, 'api', 'api.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Broken'), 'the file');
    app.stdin.write('A');
    await until(() => f().includes('Sent all'), 'the run');
    app.stdin.write(KEYS.esc);
    await until(() => !f().includes('Sent all'), 'the report closed');
    app.stdin.write('/');
    await type(app.stdin, 'load Fine 4 2');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Load: Fine'), 'the load report');
    app.stdin.write(KEYS.esc);
    await until(() => !f().includes('Load: Fine'), 'its report closed');
    app.stdin.write('/');
    await type(app.stdin, 'mock 0');
    app.stdin.write(KEYS.enter);
    // The header's "mock :port" is cut off beside a long temp path (Windows'), so wait for the note.
    await until(() => /Mock of api\.http on http:\/\/127\.0\.0\.1:\d+/.test(f()), 'the mock');
    app.stdin.write('/');
    await type(app.stdin, 'mock off');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Stopped the mock'), 'stopped');

    const logged = readActivity().filter((e) => e.app === 'hail').map((e) => e.text);
    assert.match(logged.join('\n'), /Send all: 2 requests sent .*failed: Broken \(api\.http\)/);
    assert.match(logged.join('\n'), /Load Fine: .* \(api\.http\)/);
    assert.match(logged.join('\n'), /Started a mock of the API on http:\/\/127\.0\.0\.1:\d+ \(2 routes\) \(api\.http\)/);
    assert.match(logged.join('\n'), /Stopped the mock/);
    assert.ok(readActivity().filter((e) => e.app === 'hail').every((e) => e.project === dir), 'logged for the checkout');

    app.stdin.write('/');
    await type(app.stdin, 'timeline');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Timeline: the family'), 'the timeline');
    assert.match(f(), /Hail\s+Stopped the mock/);
    assert.match(f(), /Trawl\s+Ran an UPDATE/);
    assert.ok(f().indexOf('Stopped the mock') < f().indexOf('Pushed main'), 'newest first');
    app.stdin.write('p');
    await until(() => f().includes(`Timeline of`), 'this project only');
    assert.doesNotMatch(f(), /Ran an UPDATE/);
    assert.match(f(), /Splice\s+Pushed main/);
    app.stdin.write('G');
    await until(() => /❯.*Pushed main/.test(f()), 'the oldest');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('App: Splice'), 'the entry whole');
    assert.match(f(), new RegExp(`Project: ${dir.replace(/[\\.]/g, '\\$&')}`));
  } finally {
    app.unmount();
  }
});

test('/wiring shows what the folder and its checkout point at, secrets masked', async () => {
  const app = start({ initialFile: join(dir, 'api', 'api.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Broken'), 'the file');
    app.stdin.write('/');
    await type(app.stdin, 'wiring');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('points at'), 'the wiring');
    assert.match(f(), /http-client\.env\.json/);
    assert.match(f(), /env:dev\.host\s+http:\/\/127\.0\.0\.1/);
    assert.match(f(), /appsettings\.json {2}\(the checkout/);
    assert.match(f(), /ConnectionStrings:Main\s+Server=db\.local;Database=shop;User Id=sa;Password=••••/);
    assert.match(f(), /Api:BaseUrl\s+https:\/\/api\.example\.com/);
    assert.doesNotMatch(f(), /Sup3rS3cret|tok-plain-777/);
  } finally {
    app.unmount();
  }
});
