// Response handlers (checks.js), running the whole file (runner.js) and `hail test` (headless.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentType, runChecks } from '../src/checks.js';
import { parseHttpFile } from '../src/http-file.js';
import { reportLines, reportText, runFailed, summaryLine } from '../src/runner.js';
import { prepare } from '../src/send.js';
import { fill } from '../src/variables.js';
import { plainReport, runTests, testArgs } from '../src/headless.js';
import { entryFor } from '../src/history.js';

let dir;
let server;
let base;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hail-checks-'));
  server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Trace', 't-1');
    if (req.url === '/login') return res.end(JSON.stringify({ token: 'abc' }));
    res.end(JSON.stringify({ path: req.url, auth: req.headers.authorization ?? null }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const JSON_RESPONSE = { status: 200, headers: [['Content-Type', 'application/json; charset=utf-8'], ['Set-Cookie', 'a=1'], ['Set-Cookie', 'b=2']], body: '{"token":"t-9","items":[1,2]}' };

test('the parser keeps response handlers, scripts over several lines and files, and the directives', () => {
  const { requests } = parseHttpFile(`### One
# @no-redirect
# @timeout 30
GET https://x/one
# @no-cookie-jar
Accept: application/json

{"a":1}

> {%
  client.test("ok", () => client.assert(response.status === 200));
%}

### Two
GET https://x/two

> {% client.global.set("t", response.body.token); %}
> ./checks.js
`);
  const [one, two] = requests;
  assert.equal(one.body, '{"a":1}');
  assert.deepEqual(one.handlers, [{ script: '  client.test("ok", () => client.assert(response.status === 200));\n', line: 10 }]);
  assert.deepEqual(one.options, { 'no-redirect': true, timeout: '30', 'no-cookie-jar': true });
  assert.deepEqual(one.headers, [['Accept', 'application/json']]);
  assert.deepEqual(two.handlers, [{ script: ' client.global.set("t", response.body.token); ', line: 17 }, { file: './checks.js', line: 18 }]);
  assert.equal(two.body, '');
});

test('handlers: tests pass and fail, asserts outside a test, globals, the log and the response API', () => {
  const r = runChecks(
    [
      {
        script: `
client.test('status is 200', () => client.assert(response.status === 200, 'want 200'));
client.test('has items', () => { client.assert(response.body.items.length === 3, 'want 3 items'); });
client.test('headers', () => client.assert(response.headers.valueOf('content-type').startsWith('application/json') && response.headers.valuesOf('set-cookie').length === 2));
client.test('content type', () => client.assert(response.contentType.mimeType === 'application/json' && response.contentType.charset === 'utf-8'));
client.global.set('token', response.body.token);
client.global.set('n', 5);
client.log('token is', response.body.token, { n: client.global.get('n') }, client.global.get('was'));
console.log('console too');
client.assert(false, 'outside a test');
client.log('not reached');
`,
      },
      { script: 'client.global.clear("was"); client.exit(); client.log("not this")' },
    ],
    JSON_RESPONSE,
    { globals: { was: 'here' } },
  );
  assert.deepEqual(
    r.tests.map((t) => [t.name, t.passed, t.message]),
    [
      ['status is 200', true, undefined],
      ['has items', false, 'want 3 items'],
      ['headers', true, undefined],
      ['content type', true, undefined],
      ['outside a test', false, 'outside a test'],
    ],
  );
  assert.deepEqual(r.globals, { token: 't-9', n: '5' });
  assert.deepEqual(r.log, ['token is t-9 {"n":"5"} here', 'console too']);
  assert.equal(r.error, null);
  assert.deepEqual(contentType([['content-type', 'text/plain']]), { mimeType: 'text/plain', charset: 'utf-8' });
});

test('handlers run in a sandbox: no process, no require, no way out, and a time limit', () => {
  const r = runChecks(
    [
      { script: "client.log(typeof process, typeof require, typeof setTimeout, this.constructor.constructor('return typeof process')())", name: 'peek' },
      { script: 'while (true) {}', name: 'loop' },
      { script: 'client.log("after the loop")' },
      { script: 'nope(', name: 'broken' },
    ],
    { status: 500, headers: [], body: 'plain' },
    { timeout: 200 },
  );
  assert.deepEqual(r.log, ['undefined undefined undefined undefined', 'after the loop']);
  assert.match(r.error, /^loop: it ran for over 0\.2 s/);
  const broken = runChecks([{ script: 'nope(', name: 'broken' }], { status: 200, headers: [], body: '' });
  assert.match(broken.error, /^broken: /);
  const thrown = runChecks([{ script: 'undefinedThing.x', name: 'x' }], { status: 200, headers: [], body: '' });
  assert.match(thrown.error, /undefinedThing is not defined/);
  assert.equal(runChecks([{ script: 'client.log(typeof response.body)' }], { status: 200, headers: [], body: 'not json' }).log[0], 'string');
});

test('globals win over the environment and the file', async () => {
  const r = await fill('{{a}} {{b}} {{c}}', { globals: { a: 'global' }, environment: { a: 'env', b: 'env' }, file: { a: 'file', b: 'file', c: 'file' } });
  assert.equal(r.text, 'global env file');
});

test('prepare reads a handler file next to the .http file; history keeps the checks with secrets left out', async () => {
  writeFileSync(join(dir, 'checks.js'), 'client.test("from a file", () => {});');
  const [request] = parseHttpFile('GET https://x/\n\n> ./checks.js\n> {% client.log(1) %}\n').requests;
  const req = await prepare(request, {}, { dir });
  assert.deepEqual(req.handlers, [
    { script: 'client.test("from a file", () => {});', name: 'checks.js' },
    { script: ' client.log(1) ', name: 'the script on line 4' },
  ]);
  const entry = entryFor({
    label: 'x',
    at: 1,
    request: { method: 'GET', url: 'https://x/', headers: [], body: '', secrets: ['hunter22'] },
    response: { status: 200, statusText: 'OK', headers: [], body: '', ms: 1, size: 0, url: 'https://x/' },
    checks: { tests: [{ name: 'token is hunter22', passed: false, message: 'got hunter22' }], log: ['hunter22!'], error: null },
  });
  assert.doesNotMatch(JSON.stringify(entry), /hunter22/);
  assert.equal(entry.checks.tests[0].passed, false);
});

test('the report: a line per request, the failures under it, and the summary', () => {
  const request = (label) => ({ label });
  const results = [
    { request: request('Log in'), response: { status: 200, ms: 12 }, checks: { tests: [{ name: 'ok', passed: true }], log: [], error: null } },
    { request: request('Me'), response: { status: 404, ms: 3 }, checks: { tests: [{ name: 'found', passed: false, message: 'want 200' }], log: ['note'], error: null } },
    { request: request('Later'), skipped: 'nothing gives {{x}} a value' },
    { request: request('Down'), error: "Couldn't reach it" },
  ];
  const text = reportText(reportLines(results, { left: [request('Never')], stopped: true }));
  assert.match(text, /^✓ 200 Log in {2}12 ms {2}1 test passed$/m);
  assert.match(text, /^✗ 404 Me {2}3 ms {2}1 of 1 test failed\n {4}✗ found: want 200\n {4}› note$/m);
  assert.match(text, /^✗ Later\n {4}Not sent: nothing gives \{\{x\}\} a value$/m);
  assert.match(text, /^✗ Down\n {4}Couldn't reach it$/m);
  assert.match(text, /^ {2}Never {2}not run$/m);
  assert.equal(summaryLine(results, { stopped: true }), '2 requests sent · 1 not sent · 2 tests: 1 passed, 1 failed · 1 error · stopped');
  assert.ok(runFailed(results));
  assert.ok(!runFailed(results.slice(0, 1)));
  assert.equal(plainReport([[{ text: 'x', tone: 'add' }]], { color: true }), '\x1b[32mx\x1b[0m');
});

test('hail test: every request in order, globals and named responses passed on, the exit code', async () => {
  writeFileSync(join(dir, 'http-client.env.json'), JSON.stringify({ dev: { host: base }, other: { host: base } }));
  writeFileSync(
    join(dir, 'api.http'),
    `### Log in
# @name login
POST {{host}}/login

> {%
  client.test("a token", () => client.assert(response.body.token === "abc"));
  client.global.set("token", response.body.token);
%}

### Me
GET {{host}}/me
Authorization: Bearer {{token}}
X-From: {{login.response.body.token}}

> {% client.test("sent the token", () => client.assert(response.body.auth === "Bearer abc")); %}
`,
  );
  const lines = [];
  const code = await runTests(['api.http', '--env', 'other'], { print: (l) => lines.push(l), printError: (l) => lines.push(`! ${l}`), cwd: dir, config: {} });
  const out = lines.join('\n');
  assert.equal(code, 0, out);
  assert.match(out, /^api\.http · other · 2 requests/);
  assert.match(out, /✓ 200 login .* 1 test passed/);
  assert.match(out, /✓ 200 Me .* 1 test passed/);
  assert.match(out, /2 requests sent · 2 tests: 2 passed/);

  writeFileSync(join(dir, 'fail.http'), `GET ${base}/x\n\n> {% client.test("never", () => client.assert(false, "no")); %}\n\n###\nGET {{nothing}}/y\n`);
  const failed = [];
  assert.equal(await runTests(['fail.http'], { print: (l) => failed.push(l), cwd: dir, config: {} }), 1);
  assert.match(failed.join('\n'), /✗ never: no[\s\S]*Not sent: nothing gives \{\{nothing\}\} a value/);
  const errs = [];
  assert.equal(await runTests(['api.http', '--env', 'prod'], { print: () => {}, printError: (l) => errs.push(l), cwd: dir, config: {} }), 2);
  assert.match(errs[0], /no environment called prod. There are: dev, other/);
  assert.deepEqual(testArgs(['--env=dev', 'a.http']), { file: 'a.http', env: 'dev', help: false });
  assert.match(testArgs(['--bogus']).problem, /--bogus isn't an option/);
});

test('hail test from the command line exits with 1 on a failure', async () => {
  writeFileSync(join(dir, 'cli.http'), `GET ${base}/x\n\n> {% client.test("wants 201", () => client.assert(response.status === 201, "got " + response.status)); %}\n`);
  const bin = new URL('../bin/hail.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const r = await new Promise((done) => execFile(process.execPath, [bin, 'test', 'cli.http'], { cwd: dir, env: { ...process.env, HAIL_HOME: dir } }, (error, stdout, stderr) => done({ code: error?.code ?? 0, stdout, stderr })));
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /✗ 200 GET .*\/x .*1 of 1 test failed\n {4}✗ wants 201: got 200/);
});
