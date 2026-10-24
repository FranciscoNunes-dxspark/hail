// Multipart bodies with files in them, and GraphQL, as JetBrains writes them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphqlBody, multipartBoundary, multipartParts } from '../src/bodies.js';
import { highlight, parseHttpFile } from '../src/http-file.js';
import { prepare, send, toCurl } from '../src/send.js';

let dir;
let server;
let base;
let last;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hail-bodies-'));
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      last = { method: req.method, type: req.headers['content-type'], body: Buffer.concat(chunks) };
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const MULTIPART = (host) => `POST ${host}/upload
Content-Type: multipart/form-data; boundary=WebAppBoundary

--WebAppBoundary
Content-Disposition: form-data; name="title"

{{title}}
--WebAppBoundary
Content-Disposition: form-data; name="photo"; filename="dot.png"
Content-Type: image/png

< ./dot.png
--WebAppBoundary
Content-Disposition: form-data; name="meta"; filename="meta.json"
Content-Type: application/json

<@ ./meta.json
--WebAppBoundary--
`;

test('a multipart body goes as CRLF lines with its files in it, byte for byte', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x80, 0x0a]);
  writeFileSync(join(dir, 'dot.png'), png);
  writeFileSync(join(dir, 'meta.json'), '{"by":"{{title}}"}');
  const [request] = parseHttpFile(MULTIPART(base)).requests;
  const req = await prepare(request, { file: { title: 'Holidays' } }, { dir });
  assert.deepEqual(req.missing, []);
  assert.match(req.body, /< \.\/dot\.png/, 'the text kept shows the file, not its bytes');
  await send(req);
  const expected = Buffer.concat([
    Buffer.from('--WebAppBoundary\r\nContent-Disposition: form-data; name="title"\r\n\r\nHolidays\r\n--WebAppBoundary\r\nContent-Disposition: form-data; name="photo"; filename="dot.png"\r\nContent-Type: image/png\r\n\r\n'),
    png,
    Buffer.from('\r\n--WebAppBoundary\r\nContent-Disposition: form-data; name="meta"; filename="meta.json"\r\nContent-Type: application/json\r\n\r\n{"by":"Holidays"}\r\n--WebAppBoundary--\r\n'),
  ]);
  assert.equal(last.type, 'multipart/form-data; boundary=WebAppBoundary');
  assert.ok(last.body.equals(expected), `sent:\n${last.body.toString('latin1')}`);
  assert.deepEqual(
    multipartParts(req.body, 'WebAppBoundary').map((p) => [p.name, p.filename, p.type, p.file, p.value]),
    [
      ['title', null, null, null, 'Holidays'],
      ['photo', 'dot.png', 'image/png', './dot.png', ''],
      ['meta', 'meta.json', 'application/json', './meta.json', ''],
    ],
  );
  // The files from the folder given, as this system writes paths.
  assert.equal(toCurl(req, { dir: '/d' }), `curl -X POST '${base}/upload' -F 'title=Holidays' -F 'photo=@${join('/d', 'dot.png')};type=image/png' -F 'meta=@${join('/d', 'meta.json')};type=application/json'`);
  assert.equal(multipartBoundary([['Content-Type', 'multipart/form-data; boundary="b 1"']]), 'b 1');
  assert.equal(multipartBoundary([['Content-Type', 'application/json']]), null);
  await assert.rejects(prepare(parseHttpFile(MULTIPART(base).replace('dot.png\n--', 'gone.png\n--').replace('< ./dot.png', '< ./gone.png')).requests[0], { file: { title: 't' } }, { dir }), /Couldn't read the file \.\/gone\.png: there's no such file/);
});

test('a body file goes as its bytes', async () => {
  const bytes = Buffer.from([0, 1, 2, 0xfe, 0xff]);
  writeFileSync(join(dir, 'blob.bin'), bytes);
  const [request] = parseHttpFile(`POST ${base}/blob\nContent-Type: application/octet-stream\n\n< ./blob.bin\n`).requests;
  await send(await prepare(request, {}, { dir }));
  assert.ok(last.body.equals(bytes));
});

test('GraphQL: the GRAPHQL method or X-REQUEST-TYPE, the query and its variables POSTed as JSON', async () => {
  const [one, two] = parseHttpFile(`GRAPHQL ${base}/graphql

query Hero($id: ID!) {
  hero(id: $id) { name }

  droid { name }
}

{
  "id": "{{id}}"
}

###
POST ${base}/graphql
X-REQUEST-TYPE: GraphQL

{ hero { name } }
`).requests;
  assert.equal(one.method, 'GRAPHQL');
  const req = await prepare(one, { file: { id: '1000' } });
  assert.equal(req.method, 'POST');
  assert.deepEqual(req.headers, [['Content-Type', 'application/json']]);
  assert.deepEqual(JSON.parse(req.body), { query: 'query Hero($id: ID!) {\n  hero(id: $id) { name }\n\n  droid { name }\n}', variables: { id: '1000' } });
  await send(req);
  assert.deepEqual([last.method, last.type, JSON.parse(last.body).variables], ['POST', 'application/json', { id: '1000' }]);
  const plain = await prepare(two, {});
  assert.deepEqual(plain.headers, [['Content-Type', 'application/json']], 'X-REQUEST-TYPE is not sent');
  assert.deepEqual(JSON.parse(plain.body), { query: '{ hero { name } }' });
  assert.deepEqual(graphqlBody('{ a }\n\n[1]'), { query: '{ a }\n\n[1]' }, 'variables are an object');
});

test('colours in Edit: directives, boundaries, the parts\' headers and files, GraphQL keywords, handlers', () => {
  const kinds = (text) => highlight(text).map((runs) => runs.map((r) => `${r.kind ?? '-'}:${r.text}`).join(' '));
  const out = kinds(`### Upload
# @no-redirect
# @name up
POST /upload
Content-Type: multipart/form-data; boundary=B

--B
Content-Disposition: form-data; name="f"

< ./f.png
--B--

> {% client.test("ok", () => {}); %}
>> ./out.json

### Q
GRAPHQL /graphql

query Hero {
  hero { name }
}`);
  assert.equal(out[1], 'directive:# @no-redirect');
  assert.equal(out[2], 'comment:# @name up');
  assert.equal(out[6], 'boundary:--B');
  assert.equal(out[7], 'header:Content-Disposition -::  value:form-data; name="f"');
  assert.equal(out[9], 'file:< ./f.png');
  assert.equal(out[10], 'boundary:--B--');
  assert.equal(out[12], 'handler:> {% client.test("ok", () => {}); %}');
  assert.equal(out[13], 'file:>> ./out.json');
  assert.equal(out[16], 'method:GRAPHQL -:  url:/graphql');
  assert.equal(out[18], 'keyword:query -: Hero {');
  assert.equal(out[19], '-:  hero { name }');
});
