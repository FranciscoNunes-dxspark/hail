// Contract drift, the pure parts: reading YAML, finding the operation, the schema subset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/yaml.js';
import { basePaths, checkContract, findOperation, parseContract, validate, issueText } from '../src/contract.js';

const YAML = `openapi: 3.0.1
info:
  title: Shop   # a comment
  description: >
    Folded
    text
servers:
  - url: https://api.example.com/v1
paths:
  /users/{id}:
    get:
      responses:
        "200":
          description: A user
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/User'
        '404':
          description: Not there
  /users/me:
    get:
      responses:
        2XX:
          content:
            application/json:
              schema: { type: object, properties: { id: { type: integer } } }
components:
  schemas:
    User:
      type: object
      required: [id, name]
      properties:
        id:
          type: integer
        name:
          type: string
        role:
          type: string
          enum:
            - admin
            - user
        manager:
          nullable: true
          allOf:
            - $ref: '#/components/schemas/Ref'
        tags:
          type: array
          items:
            type: string
    Ref:
      type: object
      properties:
        id: { type: integer }
`;

test('YAML: mappings, sequences, flow collections, quoted keys, block scalars and comments', () => {
  const y = parseYaml(YAML);
  assert.equal(y.openapi, '3.0.1');
  assert.equal(y.info.title, 'Shop');
  assert.equal(y.info.description, 'Folded text\n');
  assert.equal(y.servers[0].url, 'https://api.example.com/v1');
  assert.deepEqual(Object.keys(y.paths['/users/{id}'].get.responses), ['200', '404']);
  assert.deepEqual(y.components.schemas.User.required, ['id', 'name']);
  assert.deepEqual(y.components.schemas.User.properties.role.enum, ['admin', 'user']);
  assert.deepEqual(y.paths['/users/me'].get.responses['2XX'].content['application/json'].schema, { type: 'object', properties: { id: { type: 'integer' } } });
  assert.deepEqual(parseYaml('a:\n- 1\n- x: "q # not a comment"\n  y: |\n    one\n    two\nb: ~'), { a: [1, { x: 'q # not a comment', y: 'one\ntwo\n' }], b: null });
});

test('the operation: base path taken off, templates matched, a literal path first', () => {
  const spec = parseContract(YAML);
  assert.deepEqual(basePaths(spec), ['/v1', '']);
  assert.equal(findOperation(spec, 'GET', 'https://localhost:3000/v1/users/42?x=1').path, '/users/{id}');
  assert.equal(findOperation(spec, 'get', 'http://x/v1/users/me').path, '/users/me');
  assert.equal(findOperation(spec, 'GET', 'http://x/users/7').path, '/users/{id}', 'without the base path too');
  assert.equal(findOperation(spec, 'DELETE', 'http://x/v1/users/7').op, null);
  assert.equal(findOperation(spec, 'GET', 'http://x/v1/orders'), null);
});

test('drift: added fields, missing required ones, wrong types, enums, nullable, undocumented statuses', () => {
  const spec = parseContract(YAML);
  const res = (status, body) => ({ status, headers: [['Content-Type', 'application/json']], body: JSON.stringify(body) });
  const req = { method: 'GET', url: 'http://x/v1/users/1' };
  assert.deepEqual(checkContract(spec, req, res(200, { id: 1, name: 'Ana', manager: null, tags: ['a'] })).issues, []);
  const drift = checkContract(spec, req, res(200, { id: '1', role: 'boss', extra: true, tags: [1, 2], manager: { id: 'x' } }));
  assert.equal(drift.operation, 'GET /users/{id}');
  assert.deepEqual(drift.issues.map(issueText), [
    '− $.name: required, and missing',
    '≠ $.id: string, the contract says integer',
    '≠ $.role: "boss" isn\'t one of "admin", "user"',
    '+ $.extra: not in the contract',
    '≠ $.tags[]: integer, the contract says string (in 2 items)',
    '≠ $.manager.id: string, the contract says integer',
  ]);
  assert.deepEqual(checkContract(spec, req, res(418, {})).issues.map((i) => i.kind), ['status']);
  assert.deepEqual(checkContract(spec, req, res(404, {})).issues, [], 'a documented status without a body');
  assert.deepEqual(checkContract(spec, { method: 'GET', url: 'http://x/v1/users/me' }, res(201, { id: 1 })).issues, [], '2XX');
  assert.deepEqual(checkContract(spec, { method: 'GET', url: 'http://x/v1/nope' }, res(200, {})).issues.map((i) => i.kind), ['path']);
  assert.deepEqual(checkContract(spec, req, { status: 200, headers: [], body: 'oops' }).issues.map((i) => i.kind), ['body']);
});

test('Swagger 2: basePath, definitions, x-nullable, default, oneOf and additionalProperties', () => {
  const spec = parseContract(JSON.stringify({
    swagger: '2.0',
    basePath: '/api',
    paths: { '/pets': { get: { responses: { default: { schema: { type: 'array', items: { $ref: '#/definitions/Pet' } } } } } } },
    definitions: {
      Pet: { type: 'object', properties: { id: { type: 'integer' }, tag: { type: 'string', 'x-nullable': true }, kind: { oneOf: [{ type: 'string' }, { type: 'integer' }] } }, additionalProperties: { type: 'number' } },
    },
  }));
  const res = (body) => ({ status: 200, headers: [], body: JSON.stringify(body) });
  assert.deepEqual(checkContract(spec, { method: 'GET', url: 'http://h/api/pets' }, res([{ id: 1, tag: null, kind: 3, weight: 2.5 }])).issues, []);
  assert.deepEqual(checkContract(spec, { method: 'GET', url: 'http://h/api/pets' }, res([{ kind: true, weight: 'x' }])).issues.map((i) => i.path), ['$[].kind', '$[].weight']);
  assert.throws(() => parseContract('{"hello": 1}'), /no paths/);
  assert.deepEqual(validate({}, { type: ['string', 'null'] }, null), []);
});
