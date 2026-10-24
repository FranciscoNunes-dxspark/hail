// /import-curl: reading curl command lines from every shell, and adding one to the file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { curlToHttp, parseCurl, requestTitle, shellOf, tokenize } from '../src/curl.js';
import { parseHttpFile } from '../src/http-file.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
before(() => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-curl-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('bash: quotes, $\'…\', backslashes at line ends, and the lines run together', () => {
  const bash = `curl 'https://api.example.com/v1/users?page=2' \\
  -H 'accept: application/json' \\
  -H 'content-type: application/json' \\
  --data-raw '{"name":"Ana","note":"it'\\''s"}' \\
  --compressed`;
  assert.equal(shellOf(bash), 'posix');
  const r = parseCurl(bash);
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://api.example.com/v1/users?page=2');
  assert.deepEqual(r.headers, [['accept', 'application/json'], ['content-type', 'application/json']]);
  assert.equal(r.body, '{"name":"Ana","note":"it\'s"}');
  assert.deepEqual(parseCurl(bash.replace(/\n/g, ' ')), r, 'as the prompt has it, on one line');
  assert.deepEqual(tokenize(`curl $'a\\nb' "x \\"y\\" \\$z" plain\\ word`), ['curl', 'a\nb', 'x "y" $z', 'plain word']);
});

test("Windows: cmd's ^ escapes (Chrome's Copy as cURL (cmd)) and PowerShell's backticks", () => {
  const cmd = `curl "https://api.example.com/v1/users" ^
  -H "accept: */*" ^
  -H "content-type: application/json" ^
  --data-raw ^"^{^\\^"name^\\^":^\\^"Ana^\\^"^}^"`;
  assert.equal(shellOf(cmd), 'cmd');
  const c = parseCurl(cmd);
  assert.equal(c.body, '{"name":"Ana"}');
  assert.deepEqual(c.headers[0], ['accept', '*/*']);
  assert.deepEqual(parseCurl(cmd.replace(/\n/g, ' ')), c);
  const ps = 'curl.exe -X PATCH `\n  -H "Content-Type: application/json" `\n  -d \'{"a":1}\' `\n  "https://x.test/items/1?q=""x"""';
  assert.equal(shellOf(ps), 'powershell');
  const p = parseCurl(ps);
  assert.deepEqual([p.method, p.url, p.body], ['PATCH', 'https://x.test/items/1?q="x"', '{"a":1}']);
});

test('the options: data, json, users, forms, -G, joined short options, and what is left out', () => {
  const basic = parseCurl('curl -sSLk -u ana:pw -XPUT https://x.test/a -d a=1 -d b=2 --max-time 30 -o out.txt');
  assert.deepEqual(basic.headers, [['Authorization', `Basic ${Buffer.from('ana:pw').toString('base64')}`], ['Content-Type', 'application/x-www-form-urlencoded']]);
  assert.deepEqual([basic.method, basic.body, basic.timeout], ['PUT', 'a=1&b=2', 30]);
  assert.deepEqual(basic.ignored.sort(), ['-k', '-o']);
  const json = parseCurl(`curl --json '{"q":1}' x.test/j`);
  assert.deepEqual([json.method, json.url], ['POST', 'http://x.test/j']);
  assert.deepEqual(json.headers, [['Content-Type', 'application/json'], ['Accept', 'application/json']]);
  const get = parseCurl("curl -G https://x.test/s -d q=1 --data-urlencode 'w=a b'");
  assert.deepEqual([get.method, get.url, get.body], ['GET', 'https://x.test/s?q=1&w=a%20b', '']);
  assert.deepEqual(parseCurl('curl -I https://x.test/').method, 'HEAD');
  assert.deepEqual(parseCurl('curl https://x.test/ --data-binary @body.json').bodyFile, 'body.json');
  assert.deepEqual(parseCurl('curl -A agent -e https://ref -b "a=1; b=2" https://x.test/').headers, [['User-Agent', 'agent'], ['Referer', 'https://ref'], ['Cookie', 'a=1; b=2']]);
  const form = parseCurl("curl https://x.test/upload -F name=Ana -F 'file=@./pic.png;type=image/png'");
  assert.equal(form.method, 'POST');
  assert.deepEqual(form.headers, [['Content-Type', 'multipart/form-data; boundary=WebAppBoundary']]);
  assert.equal(
    form.body,
    '--WebAppBoundary\nContent-Disposition: form-data; name="name"\n\nAna\n--WebAppBoundary\nContent-Disposition: form-data; name="file"; filename="pic.png"\nContent-Type: image/png\n\n< ./pic.png\n--WebAppBoundary--',
  );
  assert.throws(() => parseCurl('wget https://x'), /isn't a curl command/);
  assert.throws(() => parseCurl('curl -H "a: b"'), /has no URL/);
});

test('as a block of the file: named after the method and path, JSON indented, and read back the same', () => {
  const r = parseCurl(`curl -m 5 -H 'Content-Type: application/json' -d '{"a":[1,2]}' 'https://x.test/v1/items?x=1'`);
  assert.equal(requestTitle(r), 'POST /v1/items');
  const block = curlToHttp(r);
  assert.equal(block, '### POST /v1/items\n# @timeout 5\nPOST https://x.test/v1/items?x=1\nContent-Type: application/json\n\n{\n  "a": [\n    1,\n    2\n  ]\n}\n');
  const [back] = parseHttpFile(block).requests;
  assert.deepEqual([back.name, back.method, back.url, back.options.timeout], ['POST /v1/items', 'POST', 'https://x.test/v1/items?x=1', '5']);
});

test('/import-curl adds the request to the end of the file and picks it; I starts the command', async () => {
  const file = join(dir, 'api.http');
  writeFileSync(file, '### First\nGET https://x.test/first\n');
  const app = start({ initialFile: file });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First'), 'the request');
    app.stdin.write('I');
    await until(() => frame().includes('> /import-curl '), 'the prompt, started');
    // Pasted: the lines come in together.
    app.stdin.write("curl 'https://x.test/v1/users' \\\n  -H 'accept: application/json' \\\n  --data-raw 'name=Ana' -k");
    await until(() => frame().includes('--data-raw'), 'the paste');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('Added POST /v1/users to api.http'), 'it said so');
    assert.match(frame(), /Left out: -k/);
    await until(() => /❯ POST\s+POST \/v1\/users/.test(frame()), 'the new request picked');
    assert.equal(
      readFileSync(file, 'utf8'),
      '### First\nGET https://x.test/first\n\n### POST /v1/users\nPOST https://x.test/v1/users\naccept: application/json\nContent-Type: application/x-www-form-urlencoded\n\nname=Ana\n',
    );
    app.stdin.write('/');
    await type(app.stdin, 'import-curl wget x');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("That isn't a curl command"), 'not curl');
  } finally {
    app.unmount();
  }
});
