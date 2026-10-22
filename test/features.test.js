// Secrets, history across runs, searching a response and Claude's drafts, through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryCredentials } from '../src/credentials.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
let calls = 0;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-features-'));
  // Answers with how many times it's been asked, and the key it was given, so two responses differ.
  server = createServer((req, res) => {
    calls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ call: calls, key: req.headers['x-api-key'] ?? null, items: ['anchor', 'bowline', 'capstan', 'bowsprit'] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(dir, 'api.http'),
    `@host = http://127.0.0.1:${server.address().port}

### Items
# @name items
GET {{host}}/items
X-Api-Key: {{$secret api-key}}
`,
  );
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

const historyText = () => {
  const d = join(process.env.HAIL_HOME, 'history');
  return readdirSync(d).map((f) => readFileSync(join(d, f), 'utf8')).join('');
};

test('a secret asked for once and kept in the store, history across runs, and comparing responses', async () => {
  const credentials = memoryCredentials();
  let app = start({ initialFile: join(dir, 'api.http'), credentials });
  let frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /GET\s+(\d+ )?items/.test(frame()), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('The value of the secret api-key'), 'the secret asked for');
    await type(app.stdin, 's3cret-key');
    assert.doesNotMatch(frame(), /s3cret-key/, 'typed as stars');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"key": "s3cret-key"'), 'the response, the secret sent');
    assert.equal(credentials.saved.get('api-key'), 's3cret-key');
    const saved = JSON.parse(readFileSync(join(process.env.HAIL_HOME, 'config.json'), 'utf8'));
    assert.deepEqual(saved.secrets, ['api-key'], 'its name, never its value');
    assert.doesNotMatch(JSON.stringify(saved), /s3cret-key/);

    // Again: no question this time.
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"call": 2'), 'the second response');
    assert.doesNotMatch(historyText(), /s3cret-key/, 'history leaves the secret out, even where the server echoed it');
  } finally {
    app.unmount();
  }

  // A new run: the last response is there before anything is sent.
  app = start({ initialFile: join(dir, 'api.http'), credentials });
  frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('"call": 2') && /GET\s+200 items/.test(frame()), 'the response from last time');
    app.stdin.write('3');
    await until(() => frame().includes('2 kept'), 'History');
    assert.match(frame(), /❯ now\s+200 GET\s+items/);
    app.stdin.write('d');
    await until(() => frame().includes('- ') && frame().includes('"call": 1') && frame().includes('"call": 2'), 'the diff with the one before');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('2 kept'), 'History again');
    app.stdin.write('D');
    await until(() => frame().includes('Forget the 2 responses'), 'asked first');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('0 kept'), 'forgotten');
  } finally {
    app.unmount();
  }
});

test('searching a response: matches as you type, n to the next, esc clears it, and q still only types', async () => {
  const credentials = memoryCredentials({ 'api-key': 'k' });
  const app = start({ initialFile: join(dir, 'api.http'), credentials });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /GET\s+(\d+ )?items/.test(frame()), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"bowsprit"'), 'the response');
    app.stdin.write('2');
    await until(() => frame().includes('/ search'), 'the Response view');
    app.stdin.write('/');
    await type(app.stdin, 'bow');
    await until(() => frame().includes('/bow▏ 1/2'), 'two matches');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('/bow 1/2'), 'the search kept');
    app.stdin.write('n');
    await until(() => frame().includes('/bow 2/2'), 'the next match');
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('/bow'), 'the search cleared');
    // A q typed into a search is part of it, not quit.
    app.stdin.write('/');
    await type(app.stdin, 'q');
    await until(() => frame().includes('/q▏ no match'), 'q searched for');
  } finally {
    app.unmount();
  }
});

test('/draft: Claude writes requests from a description, shown first, added once you say so', async () => {
  writeFileSync(join(dir, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', paths: { '/users': { get: {} } } }));
  const asked = [];
  const askClaude = async (prompt, { input }) => {
    asked.push({ prompt, input });
    return '```http\n### List users\n# @name listUsers\nGET {{host}}/users\nAccept: application/json\n```';
  };
  const app = start({ initialFile: join(dir, 'api.http'), credentials: memoryCredentials(), askClaude });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => /GET\s+(\d+ )?items/.test(frame()), 'the request');
    app.stdin.write('/');
    await type(app.stdin, 'draft openapi.json the user endpoints');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("Claude's draft: 1 request") && frame().includes('Add it to api.http?'), 'the draft and the question');
    assert.match(asked[0].prompt, /Write requests for: the user endpoints/);
    assert.match(asked[0].prompt, /use them rather than declaring new ones: host/);
    assert.match(asked[0].input, /"\/users"/);
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('listUsers') && frame().includes('Added 1 request to api.http'), 'the request added');
    assert.match(readFileSync(join(dir, 'api.http'), 'utf8'), /\n\n### List users\n# @name listUsers\nGET \{\{host\}\}\/users\n/);
  } finally {
    app.unmount();
  }
});
