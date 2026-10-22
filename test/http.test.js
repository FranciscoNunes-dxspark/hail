// The .http format, variables, environments, and what goes over the wire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { environmentsFrom } from '../src/environments.js';
import { parseHttpFile, requestAtLine } from '../src/http-file.js';
import { formatSize, prepare, prettyBody, send, toCurl } from '../src/send.js';
import { fill, pathIn } from '../src/variables.js';

const FILE = `@host = https://api.example.com
@token = {{$processEnv API_TOKEN}}

### List the users
GET {{host}}/users
  ?page=2
  &size=10
Accept: application/json

### Log in
# @name login
POST {{host}}/login HTTP/1.1
Content-Type: application/json
# a comment among the headers

{
  "user": "{{user}}"
}

> {% client.global.set("t", response.body.token); %}

###
// @name upload
PUT {{host}}/files
Content-Type: application/json

<@ ./body.json

###
https://example.com/plain
`;

test('the file: its variables, and each request with its name, headers and body', () => {
  const { variables, requests } = parseHttpFile(FILE.replace(/\n/g, '\r\n'));
  assert.deepEqual(variables, { host: 'https://api.example.com', token: '{{$processEnv API_TOKEN}}' });
  assert.equal(requests.length, 4);
  const [list, login, upload, plain] = requests;
  assert.deepEqual([list.name, list.method, list.url, list.line], ['List the users', 'GET', '{{host}}/users?page=2&size=10', 5]);
  assert.deepEqual(list.headers, [['Accept', 'application/json']]);
  assert.equal(list.body, '');
  assert.equal(login.name, 'login', '# @name wins over the ### title, so responses can be used by it');
  assert.deepEqual(login.headers, [['Content-Type', 'application/json']]);
  assert.equal(login.body, '{\n  "user": "{{user}}"\n}', "the response handler isn't part of it");
  assert.deepEqual(upload.bodyFile, { path: './body.json', fill: true });
  assert.deepEqual([plain.method, plain.url, plain.label], ['GET', 'https://example.com/plain', 'GET https://example.com/plain']);
  assert.equal(requestAtLine(requests, 16).name, 'login');
  // A URL with spaces inside a placeholder; text that isn't a URL isn't a request.
  const odd = parseHttpFile('just some words\n\n###\nGET {{host}}/{{$randomInt 1 10}} HTTP/1.1\n\n###\n{{host}}/plain\n').requests;
  assert.deepEqual(odd.map((r) => [r.method, r.url]), [['GET', '{{host}}/{{$randomInt 1 10}}'], ['GET', '{{host}}/plain']]);
  assert.equal(requestAtLine(requests, 1).name, 'List the users', 'above the first, the first');
});

test('variables: the environment over the file, variables made of variables, built-ins, responses', async () => {
  const scope = {
    environment: { host: 'https://dev.example.com', base: '{{host}}/v2' },
    file: { host: 'https://api.example.com', user: 'ana' },
    responses: { login: { headers: [['X-Request-Id', 'r1']], body: '{"token":"abc","items":[{"id":7}]}' } },
    env: { now: () => 1_700_000_000_000, random: () => 0.5, uuid: () => 'u-u-i-d', processEnv: { API_TOKEN: 's3cret' } },
  };
  const r = await fill('{{base}}/{{user}}?t={{login.response.body.token}}&id={{login.response.body.$.items[0].id}}', scope);
  assert.equal(r.text, 'https://dev.example.com/v2/ana?t=abc&id=7');
  assert.deepEqual(r.missing, []);
  assert.equal((await fill('{{$timestamp}} {{$uuid}} {{$randomInt 10 20}} {{$processEnv API_TOKEN}} {{$env.API_TOKEN}}', scope)).text, '1700000000 u-u-i-d 15 s3cret s3cret');
  assert.equal((await fill('{{login.response.headers.x-request-id}}', scope)).text, 'r1');
  const gaps = await fill('{{nope}} and {{other.response.body.x}}', scope);
  assert.equal(gaps.text, '{{nope}} and {{other.response.body.x}}', 'left in place');
  assert.deepEqual(gaps.missing, ['nope', 'other.response.body.x']);
  // A variable made of itself stops rather than looping.
  assert.ok((await fill('{{a}}', { file: { a: '{{a}}' } })).text.includes('{{a}}'));
  assert.equal(pathIn({ a: [{ b: 1 }] }, '$.a[0].b'), 1);
});

test('environments: $shared in each, the private file over the shared one', () => {
  const envs = environmentsFrom([
    { $shared: { version: 'v1' }, dev: { host: 'dev' }, prod: { host: 'prod', limits: { n: 1 } } },
    { dev: { password: 'p' } },
    null,
  ]);
  assert.deepEqual(envs.names, ['dev', 'prod']);
  assert.deepEqual(envs.vars('dev'), { version: 'v1', host: 'dev', password: 'p' });
  assert.deepEqual(envs.vars('prod'), { version: 'v1', host: 'prod', limits: '{"n":1}' });
  assert.deepEqual(envs.vars(null), { version: 'v1' });
});

test('prepare fills everything in and reads a body file; send, the body, and curl', async () => {
  const { requests } = parseHttpFile(FILE);
  const upload = await prepare(requests[2], { file: { host: 'http://h' } }, { dir: '/x', read: async (p) => `{"at":"${p.replaceAll('\\', '/')}","host":"{{host}}"}` });
  assert.equal(upload.url, 'http://h/files');
  assert.equal(upload.body, '{"at":"/x/body.json","host":"http://h"}');
  const login = await prepare(requests[1], { file: { host: 'http://h' } });
  assert.deepEqual(login.missing, ['user']);
  assert.equal(toCurl({ ...login, body: `it's` }), `curl -X POST 'http://h/login' -H 'Content-Type: application/json' --data-raw 'it'\\''s'`);
  assert.equal(toCurl({ method: 'GET', url: 'http://h/', headers: [], body: 'ignored' }), `curl 'http://h/'`);

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, path: req.url, auth: req.headers.authorization, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}/echo?x=1`;
    const res = await send({ method: 'POST', url, headers: [['Authorization', 'Bearer t']], body: 'hi' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { method: 'POST', path: '/echo?x=1', auth: 'Bearer t', body: 'hi' });
    assert.equal(prettyBody(res), JSON.stringify(JSON.parse(res.body), null, 2));
    assert.ok(res.size > 0 && res.ms >= 0);
    await assert.rejects(send({ method: 'GET', url: '{{host}}/x', headers: [], body: '' }), /a variable in it has no value/);
  } finally {
    server.close();
  }
  await assert.rejects(send({ method: 'GET', url: 'http://127.0.0.1:9/', headers: [], body: '' }), /port 9 is one that browsers and fetch refuse/);
  await assert.rejects(send({ method: 'GET', url: 'http://nope.invalid/', headers: [], body: '' }), /no such host as nope\.invalid|nope\.invalid couldn't be looked up/);
  assert.equal(formatSize(830), '830 B');
  assert.equal(formatSize(2048), '2.0 KB');
});
