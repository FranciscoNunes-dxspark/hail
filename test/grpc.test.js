// gRPC: protobuf's wire format both ways, the types learnt through server reflection, and unary calls
// through the UI and hail test. The server is written here over node:http2, with the same encoder,
// serving reflection (v1 or only v1alpha) and a small shop service.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createSecureServer, createServer } from 'node:http2';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESCRIPTORS, T, addFile, decodeFile, decodeMessage, encodeFile, encodeMessage, newRegistry } from '../src/protobuf.js';
import { forgetReflection, frame, grpcSend, grpcTarget, unframe } from '../src/grpc.js';
import { runTests } from '../src/headless.js';
import { parseHttpFile } from '../src/http-file.js';
import { KEYS, start, tempHome, until } from './helpers.js';

const f = (name, number, type, extra = {}) => ({ name, number, type, label: extra.repeated ? 3 : 1, ...(extra.typeName ? { type_name: extra.typeName } : {}), ...(extra.json ? { json_name: extra.json } : {}) });

// money.proto, which shop.proto imports, and is only handed over when asked for by name.
const MONEY = { name: 'money.proto', package: 'common', syntax: 'proto3', message_type: [{ name: 'Money', field: [f('currency', 1, T.string), f('units', 2, T.int64)] }] };
const SHOP = {
  name: 'shop.proto',
  package: 'shop',
  syntax: 'proto3',
  dependency: ['money.proto', 'google/protobuf/timestamp.proto'],
  enum_type: [{ name: 'State', value: [{ name: 'STATE_UNKNOWN', number: 0 }, { name: 'OPEN', number: 1 }, { name: 'SHIPPED', number: 2 }] }],
  message_type: [
    { name: 'GetOrder', field: [f('order_id', 1, T.int64, { json: 'orderId' }), f('verbose', 2, T.bool)] },
    {
      name: 'Order',
      field: [
        f('order_id', 1, T.int64, { json: 'orderId' }),
        f('state', 2, T.enum, { typeName: '.shop.State' }),
        f('lines', 3, T.message, { typeName: '.shop.Order.Line', repeated: true }),
        f('counts', 4, T.message, { typeName: '.shop.Order.CountsEntry', repeated: true }),
        f('total', 5, T.message, { typeName: '.common.Money' }),
        f('blob', 6, T.bytes),
        f('weight', 7, T.double),
        f('tags', 8, T.string, { repeated: true }),
        f('scores', 9, T.sint32, { repeated: true }),
        f('created', 10, T.message, { typeName: '.google.protobuf.Timestamp' }),
        f('note', 11, T.message, { typeName: '.google.protobuf.StringValue' }),
      ],
      nested_type: [
        { name: 'Line', field: [f('sku', 1, T.string), f('qty', 2, T.uint32)] },
        { name: 'CountsEntry', field: [f('key', 1, T.string), f('value', 2, T.int32)], options: { map_entry: true } },
      ],
    },
  ],
  service: [
    {
      name: 'Orders',
      method: [
        { name: 'Get', input_type: '.shop.GetOrder', output_type: '.shop.Order' },
        { name: 'Watch', input_type: '.shop.GetOrder', output_type: '.shop.Order', server_streaming: true },
      ],
    },
  ],
};

let cleanup;
let dir;
const servers = [];
const calls = [];

/** A gRPC server with the shop service and reflection under `versions`. */
async function grpcServer(versions, { secure = false } = {}) {
  const registry = newRegistry();
  addFile(registry, MONEY);
  addFile(registry, SHOP);
  const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  const server = secure ? createSecureServer({ key: fixture('localhost.key'), cert: fixture('localhost.crt') }) : createServer();
  server.on('stream', (stream, headers) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => {
      const path = headers[':path'];
      const respond = (messages, status = 0, message = '') => {
        stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'x-served-by': 'test' }, { waitForTrailers: true });
        stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': String(status), ...(message ? { 'grpc-message': encodeURIComponent(message) } : {}) }));
        for (const m of messages) stream.write(frame(m));
        stream.end();
      };
      const [service, method] = path.slice(1).split('/');
      if (service.startsWith('grpc.reflection.')) {
        if (!versions.includes(service.split('.')[2])) return respond([], 12, 'unknown service');
        const q = decodeMessage(DESCRIPTORS, '.ServerReflectionRequest', unframe(Buffer.concat(chunks))[0], { raw: true });
        const files = q.file_containing_symbol?.startsWith('shop.') ? [SHOP] : q.file_by_filename === 'money.proto' ? [MONEY] : [];
        const answer = files.length ? { file_descriptor_response: { file_descriptor_proto: files.map(encodeFile) } } : { error_response: { error_code: 5, error_message: 'not found' } };
        return respond([encodeMessage(DESCRIPTORS, '.ServerReflectionResponse', answer)]);
      }
      if (path !== '/shop.Orders/Get') return respond([], 12, `unknown method ${path}`);
      const req = decodeMessage(registry, '.shop.GetOrder', unframe(Buffer.concat(chunks))[0]);
      calls.push({ req, auth: headers.authorization ?? null });
      if (req.orderId === '404') return respond([], 5, 'no order 404 here');
      respond([
        encodeMessage(registry, '.shop.Order', {
          orderId: req.orderId,
          state: 'SHIPPED',
          lines: [{ sku: 'a1', qty: 2 }, { sku: 'b2', qty: 1 }],
          counts: { a1: 2, b2: 1 },
          total: { currency: 'EUR', units: '9007199254740993' },
          blob: Buffer.from('hi').toString('base64'),
          weight: 1.5,
          tags: ['x', 'y'],
          scores: [-3, 4],
          created: '2024-05-01T12:00:00.250Z',
          note: 'fragile',
        }),
      ]);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `127.0.0.1:${server.address().port}`;
}

let v1;
let alpha;
let tls;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-grpc-'));
  v1 = await grpcServer(['v1', 'v1alpha']);
  alpha = await grpcServer(['v1alpha']);
  tls = await grpcServer(['v1'], { secure: true });
});
after(() => {
  for (const s of servers) s.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('protobuf: every kind of field there and back, maps, packed repeats, 64-bit integers and the well-known types', () => {
  const registry = newRegistry();
  addFile(registry, decodeFile(encodeFile(MONEY)));
  addFile(registry, decodeFile(encodeFile(SHOP)));
  assert.deepEqual([...registry.services.keys()], ['shop.Orders']);
  assert.equal(registry.services.get('shop.Orders').methods[1].serverStreaming, true);
  const value = {
    orderId: '-12',
    state: 'OPEN',
    lines: [{ sku: 'z', qty: 3 }],
    counts: { z: 3 },
    total: { currency: 'USD', units: '18446744073709551' },
    blob: 'AAEC',
    weight: -0.25,
    tags: ['t'],
    scores: [-1, 0, 1],
    created: '1999-12-31T23:59:59Z',
    note: 'n',
  };
  assert.deepEqual(decodeMessage(registry, '.shop.Order', encodeMessage(registry, '.shop.Order', value)), value);
  // The original names work too, and numbers can come as strings.
  assert.deepEqual(decodeMessage(registry, '.shop.GetOrder', encodeMessage(registry, '.shop.GetOrder', { order_id: 7, verbose: true })), { orderId: '7', verbose: true });
  assert.throws(() => encodeMessage(registry, '.shop.GetOrder', { order: 1 }), /\$: shop\.GetOrder has no field order \(it has orderId, verbose\)/);
  assert.throws(() => encodeMessage(registry, '.shop.Order', { state: 'LOST' }), /\$\.state: "LOST" isn't one of STATE_UNKNOWN, OPEN, SHIPPED/);
  assert.throws(() => encodeMessage(registry, '.shop.Order', { lines: [{ qty: -1 }] }), /\$\.lines\[0\]\.qty: -1 is negative/);
  // A varint: 300 is AC 02.
  assert.deepEqual([...encodeMessage(registry, '.common.Money', { units: 300 })], [0x10, 0xac, 0x02]);
});

test('the target, framing, and a parsed GRPC request', () => {
  assert.deepEqual(grpcTarget('localhost:50051/shop.Orders/Get'), { origin: 'http://localhost:50051', service: 'shop.Orders', method: 'Get', path: '/shop.Orders/Get' });
  assert.equal(grpcTarget('grpcs://api.example.com/a.B/C').origin, 'https://api.example.com:443');
  assert.throws(() => grpcTarget('localhost:1/nomethod'), /isn't a gRPC call/);
  assert.deepEqual(unframe(Buffer.concat([frame(Buffer.from('ab')), frame(Buffer.alloc(0))])).map(String), ['ab', '']);
  const { requests } = parseHttpFile('### Get\nGRPC localhost:50051/shop.Orders/Get\nAuthorization: Bearer x\n\n{ "orderId": 1 }\n');
  assert.equal(requests[0].method, 'GRPC');
  assert.equal(requests[0].url, 'localhost:50051/shop.Orders/Get');
});

test('a unary call learns its types through reflection (v1, or v1alpha), and says what went wrong', async () => {
  forgetReflection();
  const ok = await grpcSend({ url: `${v1}/shop.Orders/Get`, headers: [['Authorization', 'Bearer t-1'], ['Content-Type', 'application/json']], body: '{ "orderId": "42" }' });
  assert.equal(ok.status, 200);
  assert.equal(ok.statusText, 'OK');
  const body = JSON.parse(ok.body);
  assert.equal(body.orderId, '42');
  assert.equal(body.state, 'SHIPPED');
  assert.deepEqual(body.counts, { a1: 2, b2: 1 });
  assert.deepEqual(body.total, { currency: 'EUR', units: '9007199254740993' });
  assert.equal(body.created, '2024-05-01T12:00:00.250Z');
  assert.equal(body.note, 'fragile');
  assert.deepEqual(body.scores, [-3, 4]);
  assert.equal(calls.at(-1).auth, 'Bearer t-1');
  assert.ok(ok.headers.some(([k, v]) => k === 'x-served-by' && v === 'test'));
  assert.ok(ok.headers.some(([k, v]) => k === 'grpc-status' && v === '0'));
  const old = await grpcSend({ url: `grpc://${alpha}/shop.Orders/Get`, headers: [], body: '{"orderId":1}' });
  assert.equal(JSON.parse(old.body).orderId, '1');
  // TLS, its certificate one of its own making, so checked only when the environment says not to.
  await assert.rejects(grpcSend({ url: `grpcs://${tls}/shop.Orders/Get`, headers: [], body: '{}' }), /Couldn't reach https:\/\/127\.0\.0\.1/);
  assert.equal((await grpcSend({ url: `grpcs://${tls}/shop.Orders/Get`, headers: [], body: '{"orderId":5}' }, { insecure: true })).status, 200);
  const missing = await grpcSend({ url: `${v1}/shop.Orders/Get`, headers: [], body: '{"orderId":404}' });
  assert.equal(missing.status, 404);
  assert.equal(missing.statusText, 'NOT_FOUND: no order 404 here');
  assert.deepEqual(JSON.parse(missing.body), { code: 5, status: 'NOT_FOUND', message: 'no order 404 here' });
  await assert.rejects(grpcSend({ url: `${v1}/shop.Orders/Watch`, headers: [], body: '{}' }), /server-streaming call: Hail makes unary gRPC calls only/);
  await assert.rejects(grpcSend({ url: `${v1}/shop.Orders/Nope`, headers: [], body: '{}' }), /shop\.Orders has no method Nope: it has Get, Watch/);
  await assert.rejects(grpcSend({ url: `${v1}/shop.Orders/Get`, headers: [], body: '{"wrong":1}' }), /has no field wrong/);
  await assert.rejects(grpcSend({ url: `${v1}/shop.Orders/Get`, headers: [], body: 'nope' }), /request message as JSON/);
});

test('through the UI and hail test: the call sent with ↵, its answer as JSON, its checks run', async () => {
  writeFileSync(join(dir, 'shop.http'), `@grpc = ${v1}\n\n### Get an order\nGRPC {{grpc}}/shop.Orders/Get\nAuthorization: Bearer ui-token\n\n{ "orderId": 7 }\n\n> {% client.test("shipped", () => client.assert(response.body.state === "SHIPPED")); %}\n\n### Missing\nGRPC {{grpc}}/shop.Orders/Get\n\n{ "orderId": 404 }\n`);
  const app = start({ initialFile: join(dir, 'shop.http') });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Get an order'), 'the requests');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('"state": "SHIPPED"'), 'the answer');
    assert.match(frame(), /GRPC\s+200 Get an order/);
    assert.match(frame(), /✓ shipped/);
    assert.equal(calls.at(-1).auth, 'Bearer ui-token');
    app.stdin.write(KEYS.down);
    await until(() => /❯ GRPC\s+Missing/.test(frame()), 'the second');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('404 NOT_FOUND: no order 404 here'), 'the error as a status');
  } finally {
    app.unmount();
  }
  const out = [];
  const code = await runTests([join(dir, 'shop.http')], { print: (l) => out.push(l), printError: (l) => out.push(l), config: {}, cwd: dir });
  assert.equal(code, 0, out.join('\n'));
  assert.match(out.join('\n'), /✓ 200 Get an order .*1 test passed/);
  assert.match(out.join('\n'), /404 Missing/);
});
