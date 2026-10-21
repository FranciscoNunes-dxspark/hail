// Clicks and the wheel, driven through the real UI with a stand-in for the terminal's mouse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, tempHome, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

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

test('clicks pick rows and tabs, a double-click does what ↵ does, and a copy is said', async () => {
  const mouse = fakeMouse();
  const app = start({ mouse });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('bowline'), 'the items');
    assert.deepEqual(mouse.enabled, [true]);

    let p = at(frame(), 'halyard');
    mouse.click(p.x, p.y);
    await until(() => /❯ halyard/.test(frame()), 'the cursor on the clicked row');
    assert.doesNotMatch(frame(), /esc close/);

    mouse.click(p.x, p.y);
    mouse.click(p.x, p.y);
    await until(() => /halyard.*esc close/.test(frame()), 'the item from a double-click');

    p = at(frame(), '2 Log');
    mouse.click(p.x, p.y);
    await until(() => frame().includes('Nothing has run yet') && !frame().includes('esc close'), 'the Log tab, with the viewer closed');

    mouse.copy('two\nlines');
    await until(() => frame().includes('Copied 2 lines'), 'the copy said');
  } finally {
    app.unmount();
  }
});
