// The command palette, your own commands and your own keys, through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
before(() => (cleanup = tempHome()));
after(() => cleanup());

const CTRL_P = '\x10';

test('ctrl+p filters every command and runs the one picked; your commands and keys run theirs', async () => {
  const config = {
    history: [],
    commands: { both: { run: ['/settings'], desc: 'Open the settings' }, help: '/quit' },
    keys: { global: { 'ctrl+s': '/settings' } },
  };
  const app = start({ config });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('commands or keys in the config were left out') && frame().includes('help'), 'the command named like a built-in left out, and said');

    app.stdin.write(CTRL_P);
    await until(() => frame().includes('type to filter'), 'the palette');
    await type(app.stdin, 'settin');
    await until(() => /❯.*\/settings/.test(frame()), 'settings at the top');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Accent colour'), 'the settings, from the palette');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Accent colour'), 'closed');

    app.stdin.write('/');
    await type(app.stdin, 'both');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Accent colour'), 'the settings, from your command');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Accent colour'), 'closed again');

    app.stdin.write('\x13'); // ctrl+s
    await until(() => frame().includes('Accent colour'), 'the settings, from your key');
    assert.ok(true);
  } finally {
    app.unmount();
  }
});
