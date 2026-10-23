// Contract drift through the UI and hail test: /contract, the Contract section, ⚠ in Requests, the report.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFile } from '../src/config.js';
import { runTests } from '../src/headless.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
let server;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-drift-'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/users/1') return res.end(JSON.stringify({ id: '1', name: 'Ana', nickname: 'a' }));
    if (req.url === '/api/users/2') return res.end(JSON.stringify({ id: 2, name: 'Bo' }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(
    join(dir, 'openapi.yaml'),
    `openapi: 3.0.0
servers:
  - url: /api
paths:
  /users/{id}:
    get:
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                required: [id, name]
                properties:
                  id: { type: integer }
                  name: { type: string }
`,
  );
  writeFileSync(join(dir, 'api.http'), `@host = http://127.0.0.1:${server.address().port}\n\n### Drifts\nGET {{host}}/api/users/1\n\n### Fine\nGET {{host}}/api/users/2\n`);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('/contract checks each response, shows the drift with it and in Requests, and is remembered for the file', async () => {
  const app = start({ initialFile: join(dir, 'api.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Drifts'), 'the requests');
    app.stdin.write('/');
    await type(app.stdin, 'contract openapi.yaml');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('every response to api.http'), 'the contract read');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Contract: 2 differences from the contract'), 'the contract section');
    assert.match(frame(), /≠ \$\.id: string, the contract says integer/);
    assert.match(frame(), /\+ \$\.nickname: not in the contract/);
    assert.match(frame(), /200 ⚠ Drifts/);
    const saved = JSON.parse(readFileSync(configFile(), 'utf8'));
    assert.equal(saved.contracts[join(dir, 'api.http')], join(dir, 'openapi.yaml'));
    app.stdin.write('A');
    await until(() => frame().includes('1 drifted from the contract'), 'the report');
    assert.match(frame(), /⚠ 2 differences from the contract/);
  } finally {
    app.unmount();
  }
});

test('hail test reports drift, and fails on it only with --contract-strict', async () => {
  const out = [];
  const config = { contracts: { [join(dir, 'api.http')]: join(dir, 'openapi.yaml') } };
  const code = await runTests([join(dir, 'api.http')], { print: (l) => out.push(l), printError: (l) => out.push(l), config, cwd: dir });
  assert.equal(code, 0, out.join('\n'));
  assert.match(out.join('\n'), /≠ \$\.id: string, the contract says integer/);
  const strict = await runTests([join(dir, 'api.http'), '--contract', 'openapi.yaml', '--contract-strict'], { print: () => {}, printError: () => {}, config: {}, cwd: dir });
  assert.equal(strict, 1);
  assert.equal(await runTests([join(dir, 'api.http'), '--contract', 'nope.yaml'], { print: () => {}, printError: () => {}, config: {}, cwd: dir }), 2);
});
