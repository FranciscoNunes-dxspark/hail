// Drives the real UI against the placeholder source: keys in, frames out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

test('the items, the viewer, tabs, help and the prompt', async () => {
  const copied = [];
  const app = start({ copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('bowline'), 'the items');
    assert.match(frame(), /❯ anchor/);
    assert.match(frame(), /Holds the boat in place/, 'the one under the cursor shows beside the list');

    app.stdin.write('j');
    await until(() => /❯ bowline/.test(frame()), 'the cursor on the second item');
    app.stdin.write('y');
    await until(() => frame().includes('Copied bowline'), 'the copy said in the bottom line');
    assert.deepEqual(copied, ['bowline']);

    app.stdin.write(KEYS.enter);
    await until(() => /bowline.*esc close/.test(frame()), 'the item in the viewer');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('esc close'), 'the viewer closed');

    app.stdin.write('?');
    await until(() => frame().includes('Show the item'), 'help, on the Items section');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Show the item'), 'help closed');

    app.stdin.write('/');
    await type(app.stdin, 'sho');
    await until(() => frame().includes('/show <item>'), 'the command suggested');
    await type(app.stdin, 'w cl');
    await until(() => frame().includes('clove hitch'), 'the item suggested');
    app.stdin.write(KEYS.enter);
    await until(() => /clove hitch.*esc close/.test(frame()), '/show from its suggestion');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('esc close'), 'the viewer closed again');

    app.stdin.write('/');
    await type(app.stdin, 'nope');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Unknown command: /nope'), 'an unknown command said so');

    app.stdin.write('2');
    await until(() => frame().includes('╭─ Log '), 'the Log view');
    assert.match(frame(), /❯ \S Unknown command: \/nope/, 'on the newest entry');
  } finally {
    app.unmount();
  }
});

test('! runs a shell command, with its output in the activity lines, and esc cancels a slow one', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('bowline'), 'the items');
    app.stdin.write('!');
    await type(app.stdin, 'node -e "console.log(6*7)"');
    app.stdin.write(KEYS.enter);
    await until(() => /⎿\s+42/.test(frame()), 'the output');

    app.stdin.write('!');
    await type(app.stdin, 'node -e "setTimeout(() => {}, 20000)"');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('esc to cancel'), 'the spinner');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('Cancelled'), 'the command cancelled');

    // Both are in the prompt's history, newest first.
    const saved = JSON.parse(readFileSync(join(process.env.HAIL_HOME, 'config.json'), 'utf8'));
    assert.equal(saved.history.length, 2);
    assert.match(saved.history[0], /setTimeout/);
  } finally {
    app.unmount();
  }
});

test('settings: a toggle saves, the accent changes through its command', async () => {
  const app = start();
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('bowline'), 'the items');
    app.stdin.write(',');
    await until(() => frame().includes('Accent colour'), 'the settings');
    app.stdin.write('j');
    await until(() => /❯ Mouse\s+on/.test(frame()), 'the cursor on Mouse');
    app.stdin.write(KEYS.enter);
    await until(() => /❯ Mouse\s+off/.test(frame()), 'the mouse off');
    const saved = () => JSON.parse(readFileSync(join(process.env.HAIL_HOME, 'config.json'), 'utf8'));
    assert.equal(saved().mouse, false);

    app.stdin.write('k');
    await until(() => /❯ Accent colour/.test(frame()), 'the cursor on the accent');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/accent #ff875f'), 'the prompt filled in');
    for (let i = 0; i < 7; i++) app.stdin.write(KEYS.backspace);
    await type(app.stdin, '#ff8800');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('#ff8800'), 'the new accent in the list');
    assert.equal(saved().accent, '#ff8800');
  } finally {
    app.unmount();
  }
});

test('a source that fails says so, and r tries again', async () => {
  let calls = 0;
  const load = async () => {
    if (++calls === 1) throw new Error('the server is asleep');
    return [{ name: 'only one', kind: 'test', detail: 'here' }];
  };
  const app = start({ load });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes("Couldn't load: the server is asleep"), 'the error');
    app.stdin.write('r');
    await until(() => frame().includes('only one'), 'the second load');
  } finally {
    app.unmount();
  }
});
