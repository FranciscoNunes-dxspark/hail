// /import: Postman collections and environments, HAR recordings and OpenAPI documents as .http blocks,
// never with a credential written out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHttpFile } from '../src/http-file.js';
import { detectImport, exampleFor, importHar, importOpenApi, importPostman, importPostmanEnvironment, importText } from '../src/importers.js';
import { basicAuth } from '../src/send.js';
import { readActivity } from '../src/family.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

let cleanup;
let dir;
before(() => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-import-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

const COLLECTION = {
  info: { name: 'Shop API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  variable: [
    { key: 'baseUrl', value: 'https://shop.example.com' },
    { key: 'apiKey', value: 'live-key-123' },
  ],
  auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-bearer-999', type: 'string' }] },
  item: [
    {
      name: 'Orders',
      item: [
        {
          name: 'Get order',
          event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
          request: { method: 'GET', header: [{ key: 'Accept', value: 'application/json' }, { key: 'X-Old', value: '1', disabled: true }], url: { raw: '{{baseUrl}}/orders/:id', variable: [{ key: 'id', value: '42' }] } },
        },
        {
          name: 'Create order',
          request: { method: 'POST', header: [], body: { mode: 'raw', raw: '{"sku":"a1","qty":2}', options: { raw: { language: 'json' } } }, url: '{{baseUrl}}/orders' },
        },
      ],
    },
    { name: 'Login', request: { method: 'POST', auth: { type: 'basic', basic: [{ key: 'username', value: 'ana' }, { key: 'password', value: 'hunter2' }] }, body: { mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }] }, url: '{{baseUrl}}/login' } },
    { name: 'Search', request: { method: 'GET', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'k' }, { key: 'value', value: '{{apiKey}}' }, { key: 'in', value: 'query' }] }, url: '{{baseUrl}}/search?q=x' } },
    {
      name: 'Upload',
      request: { method: 'POST', auth: { type: 'noauth' }, body: { mode: 'formdata', formdata: [{ key: 'title', value: 'hi', type: 'text' }, { key: 'photo', src: './beach.png', type: 'file' }] }, url: '{{baseUrl}}/upload' },
    },
    { name: 'Hero', request: { method: 'POST', auth: { type: 'oauth1' }, body: { mode: 'graphql', graphql: { query: 'query { hero { name } }', variables: '{"id":1}' } }, url: '{{baseUrl}}/graphql' } },
  ],
};

test('a Postman collection: folders as names, variables, auth as headers, bodies of every kind, and no secret written out', () => {
  const r = importPostman(COLLECTION);
  assert.equal(r.requests, 6);
  assert.doesNotMatch(r.text, /live-key-123|literal-bearer-999|hunter2/);
  assert.match(r.text, /^@baseUrl = https:\/\/shop\.example\.com\n@apiKey = \{\{\$secret shop-api-apikey\}\}\n@id = 42\n/);
  assert.match(r.text, /### Orders \/ Get order\nGET \{\{baseUrl\}\}\/orders\/\{\{id\}\}\nAccept: application\/json\nAuthorization: Bearer \{\{\$secret shop-api-token\}\}\n/);
  assert.doesNotMatch(r.text, /X-Old/);
  assert.match(r.text, /### Orders \/ Create order\nPOST \{\{baseUrl\}\}\/orders\nAuthorization: Bearer [^\n]+\nContent-Type: application\/json\n\n\{\n {2}"sku": "a1",/);
  assert.match(r.text, /### Login\nPOST \{\{baseUrl\}\}\/login\nAuthorization: Basic ana:\{\{\$secret shop-api-password\}\}\nContent-Type: application\/x-www-form-urlencoded\n\na=1&b=2/);
  assert.match(r.text, /GET \{\{baseUrl\}\}\/search\?q=x&k=\{\{apiKey\}\}/);
  assert.match(r.text, /Content-Type: multipart\/form-data; boundary=WebAppBoundary\n\n--WebAppBoundary\nContent-Disposition: form-data; name="title"\n\nhi\n--WebAppBoundary\nContent-Disposition: form-data; name="photo"; filename="beach.png"\n\n< \.\/beach\.png\n--WebAppBoundary--/);
  assert.match(r.text, /GRAPHQL \{\{baseUrl\}\}\/graphql\n\nquery \{ hero \{ name \} \}\n\n\{\n {2}"id": 1\n\}/);
  assert.deepEqual(r.secrets.sort(), ['shop-api-apikey', 'shop-api-password', 'shop-api-token']);
  assert.match(r.notes.join('\n'), /Left out 1 pre-request and test script/);
  assert.match(r.notes.join('\n'), /Left out oauth1 auth/);
  // What it writes reads back as the requests it is.
  const { requests, variables } = parseHttpFile(r.text);
  assert.deepEqual(requests.map((q) => q.method), ['GET', 'POST', 'POST', 'GET', 'POST', 'GRAPHQL']);
  assert.equal(variables.id, '42');
  // v2.0's auth objects, and a variable the file has already.
  const v20 = importPostman({ info: { name: 'Old' }, item: [{ name: 'x', request: { method: 'GET', url: 'http://h/x', auth: { type: 'bearer', bearer: { token: '{{tok}}' } } } }], variable: [{ key: 'host', value: 'h' }] }, { taken: new Set(['host']) });
  assert.match(v20.text, /Authorization: Bearer \{\{tok\}\}/);
  assert.doesNotMatch(v20.text, /@host/);
  assert.match(v20.notes.join('\n'), /Kept the file's own \{\{host\}\}/);
});

test('a Postman environment becomes one of http-client.env.json, its secrets as placeholders', () => {
  const r = importPostmanEnvironment({ name: 'Staging', values: [{ key: 'baseUrl', value: 'https://stg', enabled: true }, { key: 'pass', value: 'p@ss', type: 'secret', enabled: true }, { key: 'off', value: 'x', enabled: false }], _postman_variable_scope: 'environment' });
  assert.deepEqual(r.environment, { name: 'Staging', vars: { baseUrl: 'https://stg', pass: '{{$secret staging-pass}}' } });
  assert.equal(detectImport(JSON.stringify({ name: 'E', values: [] })).kind, 'postman-env');
});

test('a HAR recording: a request per entry, without cookies, credentials or connection headers', () => {
  const r = importHar({
    log: {
      entries: [
        { request: { method: 'POST', url: 'https://api.example.com/v1/users?x=1', headers: [{ name: ':authority', value: 'api' }, { name: 'Host', value: 'api' }, { name: 'Cookie', value: 'sid=1' }, { name: 'Authorization', value: 'Bearer abc' }, { name: 'X-Trace', value: 't' }], postData: { mimeType: 'application/json', text: '{"a":1}' } } },
        { request: { method: 'GET', url: 'data:image/png;base64,xx', headers: [] } },
      ],
    },
  });
  assert.equal(r.requests, 1);
  assert.equal(r.text, '### POST /v1/users\nPOST https://api.example.com/v1/users?x=1\nX-Trace: t\nContent-Type: application/json\n\n{\n  "a": 1\n}\n');
  assert.match(r.notes.join('\n'), /Left out the cookie, authorization headers/);
  assert.match(r.notes.join('\n'), /Passed over 1 entry/);
});

const OPENAPI = `openapi: 3.0.0
info:
  title: Pets
servers:
  - url: https://pets.example.com/v1
security:
  - bearer: []
components:
  securitySchemes:
    bearer: { type: http, scheme: bearer }
    sso: { type: oauth2, flows: {} }
  schemas:
    Pet:
      type: object
      required: [name]
      properties:
        name: { type: string, example: Rex }
        age: { type: integer }
        tags: { type: array, items: { type: string } }
paths:
  /pets/{petId}:
    parameters:
      - { name: petId, in: path, required: true, schema: { type: integer, example: 7 } }
    get:
      operationId: getPet
      summary: One pet
      parameters:
        - { name: verbose, in: query, required: true, schema: { type: boolean } }
        - { name: page, in: query, schema: { type: integer } }
      responses:
        '200':
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Pet' }
  /pets:
    post:
      operationId: addPet
      security:
        - sso: []
      requestBody:
        content:
          application/json:
            schema: { $ref: '#/components/schemas/Pet' }
      responses:
        '201': { description: made }
`;

test('an OpenAPI document: a request per operation, path parameters as variables, example bodies, security as placeholders', () => {
  const r = importText(OPENAPI, 'pets.yaml');
  assert.equal(r.kind, 'openapi');
  assert.equal(r.requests, 2);
  assert.match(r.text, /^@host = https:\/\/pets\.example\.com\/v1\n@petId = 7\n@verbose = true\n/);
  assert.match(r.text, /### One pet\n# @name getPet\nGET \{\{host\}\}\/pets\/\{\{petId\}\}\?verbose=\{\{verbose\}\}\nAccept: application\/json\nAuthorization: Bearer \{\{\$secret pets-token\}\}\n/);
  assert.match(r.text, /### addPet\n# @name addPet\nPOST \{\{host\}\}\/pets\nAuthorization: Bearer \{\{\$auth\.token\("sso"\)\}\}\nContent-Type: application\/json\n\n\{\n {2}"name": "Rex",\n {2}"age": 0,\n {2}"tags": \[\n {4}"string"\n {2}\]\n\}/);
  assert.match(r.notes.join('\n'), /\{\{\$auth\.token\("sso"\)\}\}/);
  assert.equal(parseHttpFile(r.text).requests.length, 2);
  // Swagger 2, JSON.
  const swagger = importOpenApi({ swagger: '2.0', info: { title: 'Old' }, host: 'old.example.com', basePath: '/api', schemes: ['http'], securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } }, security: [{ key: [] }], paths: { '/things': { post: { parameters: [{ in: 'body', name: 'b', schema: { type: 'object', properties: { n: { type: 'number', default: 3 } } } }], responses: {} } } } });
  assert.match(swagger.text, /@host = http:\/\/old\.example\.com\/api\n\n### POST \/things\nPOST \{\{host\}\}\/things\nX-Api-Key: \{\{\$secret old-x-api-key\}\}\nContent-Type: application\/json\n\n\{\n {2}"n": 3\n\}/);
  assert.deepEqual(exampleFor({}, { oneOf: [{ type: 'string', format: 'uuid' }] }), '00000000-0000-0000-0000-000000000000');
  assert.throws(() => importText('{"hello":1}', 'x.json'), /isn't a Postman collection/);
});

test('Basic user:password is encoded as it goes, as VS Code reads it', () => {
  assert.equal(basicAuth('Basic ana:pw 1'), `Basic ${Buffer.from('ana:pw 1').toString('base64')}`);
  assert.equal(basicAuth('Basic ana pw'), `Basic ${Buffer.from('ana:pw').toString('base64')}`);
  assert.equal(basicAuth('Basic YW5hOnB3'), 'Basic YW5hOnB3');
  assert.equal(basicAuth('Bearer x'), 'Bearer x');
});

test('through the UI: appended to the open file (and undone), a new file with --new, and an environment', async () => {
  writeFileSync(join(dir, 'api.http'), '@baseUrl = http://127.0.0.1:1\n\n### Ping\nGET {{baseUrl}}/ping\n');
  writeFileSync(join(dir, 'shop.postman_collection.json'), JSON.stringify(COLLECTION));
  writeFileSync(join(dir, 'pets.yaml'), OPENAPI);
  writeFileSync(join(dir, 'staging.json'), JSON.stringify({ name: 'staging', values: [{ key: 'baseUrl', value: 'https://stg', enabled: true }], _postman_variable_scope: 'environment' }));
  const app = start({ initialFile: join(dir, 'api.http') });
  const f = () => app.lastFrame() ?? '';
  try {
    await until(() => f().includes('Ping'), 'the file');
    app.stdin.write('/');
    await type(app.stdin, 'import shop.postman_collection.json');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Imported 6 requests from shop.postman_collection.json'), 'imported');
    assert.match(f(), /Orders \/ Get order/);
    await until(() => readFileSync(join(dir, 'api.http'), 'utf8').includes('### Orders / Get order'), 'saved to the file');
    const text = readFileSync(join(dir, 'api.http'), 'utf8');
    assert.doesNotMatch(text, /@baseUrl = https:\/\/shop/, "the file's own baseUrl kept");
    assert.doesNotMatch(text, /hunter2|literal-bearer-999|live-key-123/);
    // ctrl+z in Edit takes it back out.
    app.stdin.write('2');
    await until(() => f().includes('2 Edit') && /Orders \/ Get order/.test(f()), 'the Edit view');
    app.stdin.write('\x1a');
    await until(() => !readFileSync(join(dir, 'api.http'), 'utf8').includes('Orders'), 'undone');

    app.stdin.write('/');
    await type(app.stdin, 'import pets.yaml --new');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Imported 2 requests from pets.yaml (an OpenAPI document) into pets.http'), 'a new file');
    assert.ok(existsSync(join(dir, 'pets.http')));
    assert.match(readActivity().map((e) => e.text).join('\n'), /Imported 2 requests from pets\.yaml \(an OpenAPI document\) into pets\.http/);
    assert.match(f(), /pets\.http/);

    app.stdin.write('/');
    await type(app.stdin, 'import staging.json');
    app.stdin.write(KEYS.enter);
    await until(() => f().includes('Added the environment staging'), 'the environment');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'http-client.env.json'), 'utf8')), { staging: { baseUrl: 'https://stg' } });
  } finally {
    app.unmount();
  }
});
