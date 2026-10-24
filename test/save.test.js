// >> ./out.json after a request: its body saved to a file, a new name each time unless >>! says so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHttpFile } from '../src/http-file.js';
import { exchange, numbered, reportLines, reportText } from '../src/runner.js';
import { prepare } from '../src/send.js';
import { KEYS, start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
let server;
let base;
let calls = 0;
const IMAGE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0d, 0x0a]);
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-save-'));
  server = createServer((req, res) => {
    calls++;
    if (req.url === '/image') {
      res.setHeader('Content-Type', 'image/png');
      return res.end(IMAGE);
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ call: calls }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('>> saves the body beside the .http file, out-1, out-2 when it is there; >>! writes over it', async () => {
  assert.equal(numbered('/a/out.json', 0), '/a/out.json');
  assert.equal(numbered('/a/out.json', 2), '/a/out-2.json');
  assert.equal(numbered('/a/README', 1), '/a/README-1');
  const { requests } = parseHttpFile(`### Image
GET ${base}/image

> {% client.test("png", () => client.assert(response.contentType.mimeType === "image/png")); %}
>> ./saved/{{name}}.png

### Over
GET ${base}/json

>>! ./over.json
`);
  assert.deepEqual(requests[0].output, { path: './saved/{{name}}.png', overwrite: false });
  assert.equal(requests[0].handlers.length, 1);
  assert.deepEqual(requests[1].output, { path: './over.json', overwrite: true });
  const image = await prepare(requests[0], { file: { name: 'dot' } }, { dir });
  assert.deepEqual(image.output, { path: join(dir, 'saved', 'dot.png'), shown: './saved/dot.png', overwrite: false });
  const first = await exchange(image, {});
  assert.deepEqual(first.saved, { path: join(dir, 'saved', 'dot.png'), shown: './saved/dot.png' });
  assert.ok(readFileSync(join(dir, 'saved', 'dot.png')).equals(IMAGE), 'byte for byte');
  assert.equal(first.checks.tests[0].passed, true);
  const second = await exchange(image, {});
  assert.equal(second.saved.shown, './saved/dot-1.png');
  assert.ok(existsSync(join(dir, 'saved', 'dot-1.png')));
  const over = await prepare(requests[1], {}, { dir });
  await exchange(over, {});
  const again = await exchange(over, {});
  assert.equal(again.saved.shown, './over.json');
  assert.equal(JSON.parse(readFileSync(join(dir, 'over.json'), 'utf8')).call, calls, 'the newest');
  assert.ok(!existsSync(join(dir, 'over-1.json')));
  assert.match(reportText(reportLines([{ request: { label: 'Over' }, ...again }])), /✓ 200 Over {2}\d+ ms {2}→ \.\/over\.json/);
  // A place it can't be written: the response still comes, and it says why.
  writeFileSync(join(dir, 'blocked'), 'a file, not a folder');
  const blocked = await exchange({ ...over, output: { path: join(dir, 'blocked', 'x.json'), shown: './blocked/x.json', overwrite: true } }, {});
  assert.match(blocked.saved.error, /^Couldn't save it to \.\/blocked\/x\.json/);
  assert.equal(blocked.response.status, 200);
});

test('in the UI: where it was saved shows with the response and in the activity lines', async () => {
  writeFileSync(join(dir, 'api.http'), `### Json\nGET ${base}/json\n\n>> ./ui.json\n`);
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Json'), 'the request');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Saved to ./ui.json'), 'saved');
    assert.ok(existsSync(join(dir, 'ui.json')));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Saved to ./ui-1.json'), 'saved under a new name');
  } finally {
    app.unmount();
  }
});
