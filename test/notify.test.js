// A long request (or /send all) that ends rings the bell and asks for a desktop notification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NOTIFY_AFTER, notification, notifySeconds, worthNotifying } from '../src/notify.js';
import { settingRows } from '../src/settings.js';
import { KEYS, start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
let server;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-notify-'));
  server = createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('late'), 3000);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(dir, 'api.http'), `### Quick\nGET ${host}/quick\n\n### Slow\nGET ${host}/slow\n`);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('the bytes: a bell, then OSC 9, or OSC 777 in VTE terminals, with nothing that could end them early', () => {
  assert.equal(notification('Hail: GET x', '200 OK', {}), '\x07\x1b]9;Hail: GET x: 200 OK\x07');
  assert.equal(notification('A;b', 'c\x07d', { VTE_VERSION: '7000' }), '\x07\x1b]777;notify;A,b;c d\x1b\\');
  assert.equal(notifySeconds({}), NOTIFY_AFTER);
  assert.equal(notifySeconds({ notifyAfter: 30 }), 30);
  assert.ok(worthNotifying(10_000, {}) && !worthNotifying(9_999, {}));
  assert.ok(!worthNotifying(60_000, { notify: false }));
  const row = settingRows({ notifyAfter: 30 }).find((r) => r.id === 'notify');
  assert.deepEqual([row.label, row.value, row.action], ['Notify when done', 'on', 'toggle']);
  assert.match(row.note, /over 30 s/);
  assert.equal(settingRows({ notify: false }).find((r) => r.id === 'notify').value, 'off');
});

test('a request over notifyAfter notifies when it ends, a cancelled one never does, and the setting turns it off', async () => {
  const told = [];
  const app = start({ initialFile: join(dir, 'api.http'), config: { history: [], notifyAfter: 0 }, notify: (title, body) => told.push([title, body]) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Quick') && frame().includes('Slow'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => told.length === 1, 'a notification');
    assert.match(told[0][0], /^Hail: GET http:\/\/127\.0\.0\.1:\d+\/quick$/);
    assert.match(told[0][1], /^200 OK · \d+ ms · 2 B$/);

    // Cancelled with esc: nothing.
    app.stdin.write('j');
    await until(() => /❯ GET\s+Slow/.test(frame()), 'the slow one');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Sending'), 'on its way');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Cancelled'), 'cancelled');
    assert.equal(told.length, 1);

    // Off in Settings.
    app.stdin.write(',');
    await until(() => frame().includes('Notify when done'), 'the settings');
    for (let i = 0; i < 5; i++) app.stdin.write('j');
    await until(() => /❯ Notify when done\s+on/.test(frame()), 'the cursor on it');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Notify when done\s+off/.test(frame()), 'off');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Notify when done'), 'closed');
    app.stdin.write('k');
    await until(() => /❯ GET\s+(\d+ )?Quick/.test(frame()), 'the quick one');
    app.stdin.write(KEYS.enter);
    await until(() => /5 Log 3/.test(frame()) && !frame().includes('Sending'), 'sent again');
    assert.equal(told.length, 1, 'nothing while it is off');
  } finally {
    app.unmount();
  }
});
