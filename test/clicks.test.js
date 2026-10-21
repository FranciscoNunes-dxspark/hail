// Clicks and the wheel, driven through the real UI with a stand-in for the terminal's mouse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
before(() => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-clicks-'));
  writeFileSync(join(dir, 'api.http'), Array.from({ length: 30 }, (_, i) => `### Request ${i + 1}\nGET https://example.com/${i + 1}\n`).join('\n'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

/** mouse.js's terminalMouse() without a terminal: records `enable` and sends made-up events. */
function fakeMouse() {
  const listeners = new Set();
  const send = (e) => listeners.forEach((fn) => fn({ button: 'left', release: false, drag: false, ...e }));
  return {
    enabled: [],
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    enable(on) {
      this.enabled.push(on);
    },
    click: (x, y) => send({ x, y }),
    wheel: (x, y, wheel) => send({ x, y, button: 'wheel', wheel }),
    copy: (text) => listeners.forEach((fn) => fn({ type: 'copy', text })),
  };
}

// Where the frame shows `text`: { x, y } of its first character, so clicks land where things were drawn.
const at = (frame, text) => {
  const lines = frame.split('\n');
  const y = lines.findIndex((l) => l.includes(text));
  assert.ok(y >= 0, `"${text}" isn't on screen:\n${frame}`);
  return { x: lines[y].indexOf(text), y };
};

test('clicks pick rows and tabs, the wheel scrolls the list, and a copy is said', async () => {
  const mouse = fakeMouse();
  const app = start({ mouse, initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Request 2 '), 'the requests');
    assert.deepEqual(mouse.enabled, [true]);

    let p = at(frame(), 'Request 4 ');
    mouse.click(p.x, p.y);
    await until(() => /❯ GET\s+Request 4 /.test(frame()), 'the cursor on the clicked row');
    assert.match(frame(), /example\.com\/4/, 'and the request beside it');

    p = at(frame(), 'Request 1 ');
    mouse.wheel(p.x, p.y, 3);
    await until(() => !frame().includes('Request 1 '), 'the list scrolled by the wheel');

    p = at(frame(), '3 Log');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('Nothing has run yet'), 'the Log tab');

    mouse.copy('two\nlines');
    await until(() => frame().includes('Copied 2 lines'), 'the copy said');
  } finally {
    app.unmount();
  }
});
