// gRPC, as JetBrains writes a call: `GRPC host:port/package.Service/Method` and a JSON body. Unary calls,
// over HTTP/2 in plain text (or TLS with grpcs:// or https://), the types learnt from the server's own
// reflection service (grpc.reflection.v1, else v1alpha), so no .proto files are needed. The answer is a
// response like any other: its status (gRPC's code made the nearest HTTP one), the metadata as headers,
// and the message as JSON. Streaming calls aren't made.
import { connect, constants } from 'node:http2';
import { DESCRIPTORS, addFile, decodeFile, decodeMessage, encodeMessage, newRegistry } from './protobuf.js';

export const CODES = ['OK', 'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED', 'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED'];
// The HTTP status nearest each code (as grpc-gateway maps them), so a response reads as one.
const HTTP = [200, 499, 500, 400, 504, 404, 409, 403, 429, 400, 409, 400, 501, 500, 503, 500, 401];

/**
 * Where a GRPC request goes: { origin, service, method, path }. `grpc://` and `http://` (or none) are
 * plain text, `grpcs://` and `https://` TLS. Throws when it isn't host:port/package.Service/Method.
 */
export function grpcTarget(url) {
  const m = /^(?:(grpcs?|https?):\/\/)?([^/\s]+)\/([\w.]+)\/(\w+)\/?$/i.exec(String(url).trim());
  if (!m) throw new Error(`${url} isn't a gRPC call: GRPC host:port/package.Service/Method`);
  const tls = /^(grpcs|https)$/i.test(m[1] ?? '');
  const host = /:\d+$/.test(m[2]) ? m[2] : `${m[2]}:${tls ? 443 : 80}`;
  return { origin: `${tls ? 'https' : 'http'}://${host}`, service: m[3], method: m[4], path: `/${m[3]}/${m[4]}` };
}

/** A message framed as gRPC sends it: not compressed, its length, then it. */
export const frame = (bytes) => Buffer.concat([Buffer.from([0, ...[24, 16, 8, 0].map((s) => (bytes.length >>> s) & 255)]), bytes]);

/** The messages in a gRPC body (frames one after another). */
export function unframe(buf) {
  const out = [];
  for (let at = 0; at + 5 <= buf.length; ) {
    if (buf[at] !== 0) throw new Error("The answer is compressed, which Hail can't read.");
    const len = buf.readUInt32BE(at + 1);
    out.push(buf.subarray(at + 5, at + 5 + len));
    at += 5 + len;
  }
  return out;
}

const cancelled = () => Object.assign(new Error('Cancelled'), { cancelled: true });

/** An HTTP/2 connection to `origin`, once it's made; `insecure` skips checking the certificate. */
export function open(origin, { insecure = false, signal } = {}) {
  return new Promise((resolve, reject) => {
    const session = connect(origin, origin.startsWith('https') ? { rejectUnauthorized: !insecure, ALPNProtocols: ['h2'] } : {});
    const onAbort = () => {
      session.destroy();
      reject(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    session.once('connect', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(session);
    });
    session.once('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Couldn't reach ${origin}: ${e.code === 'ECONNREFUSED' ? 'nothing is listening there' : e.message}`));
    });
  });
}

/**
 * One call on `session`: `messages` (bytes each) sent to `path` with `metadata` ({ name: value }),
 * resolving with { headers, trailers, messages, code, message } once the server ends it. `timeout` (ms)
 * goes as grpc-timeout too.
 */
export function call(session, path, messages, { metadata = {}, signal, timeout = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const req = session.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: path,
      'content-type': 'application/grpc',
      te: 'trailers',
      ...(timeout ? { 'grpc-timeout': `${Math.max(1, Math.round(timeout))}m` } : {}),
      ...metadata,
    });
    let headers = {};
    let trailers = {};
    const chunks = [];
    let timer = null;
    const finish = (e) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (e) return reject(e);
      const status = trailers['grpc-status'] ?? headers['grpc-status'];
      let body;
      try {
        body = unframe(Buffer.concat(chunks));
      } catch (err) {
        return reject(err);
      }
      const raw = trailers['grpc-message'] ?? headers['grpc-message'] ?? '';
      let message = raw;
      try {
        message = decodeURIComponent(raw);
      } catch {}
      if (status == null && headers[':status'] && headers[':status'] !== 200) return resolve({ headers, trailers, messages: body, code: 14, message: `the server answered HTTP ${headers[':status']}${headers['content-type'] ? ` (${headers['content-type']})` : ''}, not gRPC` });
      resolve({ headers, trailers, messages: body, code: Number(status ?? 2), message: status == null ? 'the call ended without a grpc-status' : message });
    };
    const onAbort = () => {
      req.close(constants.NGHTTP2_CANCEL);
      finish(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeout) timer = setTimeout(() => (req.close(constants.NGHTTP2_CANCEL), finish(Object.assign(new Error(`No answer within ${timeout >= 1000 ? `${timeout / 1000} s` : `${timeout} ms`} (# @timeout)`), { timeout: true }))), timeout);
    req.on('response', (h) => (headers = h));
    req.on('trailers', (t) => (trailers = t));
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => finish());
    req.on('error', (e) => finish(new Error(`The call to ${path} broke off: ${e.message}`)));
    for (const m of messages) req.write(frame(m));
    req.end();
  });
}

const REFLECTION = ['grpc.reflection.v1.ServerReflection', 'grpc.reflection.v1alpha.ServerReflection'];

/** One reflection question ({ file_containing_symbol } or { file_by_filename }), on whichever version the server has. */
async function ask(session, question, state, { signal }) {
  for (const service of state.version ? [state.version] : REFLECTION) {
    const r = await call(session, `/${service}/ServerReflectionInfo`, [encodeMessage(DESCRIPTORS, '.ServerReflectionRequest', question)], { signal });
    if (r.code === 12 || (r.code !== 0 && /unimplemented|unknown service/i.test(r.message))) continue;
    if (r.code !== 0) throw new Error(`The server's reflection said ${CODES[r.code] ?? r.code}${r.message ? `: ${r.message}` : ''}`);
    state.version = service;
    const answer = decodeMessage(DESCRIPTORS, '.ServerReflectionResponse', r.messages[0] ?? Buffer.alloc(0), { raw: true });
    if (answer.error_response) throw new Error(`The server's reflection doesn't know ${Object.values(question)[0]}: ${answer.error_response.error_message ?? `error ${answer.error_response.error_code}`}`);
    return answer.file_descriptor_response?.file_descriptor_proto ?? [];
  }
  throw new Error("The server has no reflection service (grpc.reflection.v1 or v1alpha), so Hail can't learn its types: turn reflection on in the server.");
}

/** The types of `service` and everything they use, through the server's reflection: a registry (protobuf.js). */
export async function reflect(session, service, { signal } = {}) {
  const registry = newRegistry();
  const state = { version: null };
  const pending = [];
  const add = (files) => {
    for (const bytes of files) {
      const file = decodeFile(bytes);
      if (registry.files.has(file.name)) continue;
      addFile(registry, file);
      pending.push(...(file.dependency ?? []));
    }
  };
  add(await ask(session, { file_containing_symbol: service }, state, { signal }));
  // A server may hand over a file without the ones it imports.
  for (let n = 0; pending.length && n < 200; n++) {
    const name = pending.shift();
    if (registry.files.has(name)) continue;
    try {
      add(await ask(session, { file_by_filename: name }, state, { signal }));
    } catch (e) {
      if (e.cancelled) throw e;
      // The well-known ones are known without it; anything else shows up as a missing type.
    }
  }
  return registry;
}

// What reflection said, per server and service, for a few minutes: a call made again doesn't ask again.
const learnt = new Map();
const KEEP_FOR = 5 * 60_000;

/** Headers that are HTTP/2's or gRPC's own, not metadata to send. */
const OWN = /^(content-type|content-length|te|host|connection|user-agent|grpc-timeout|grpc-encoding|grpc-accept-encoding|accept|accept-encoding|transfer-encoding|upgrade|keep-alive)$/i;

/**
 * Sends a filled-in GRPC request (send.js's prepare): { url, headers, body (JSON) }. Resolves with a
 * response as send.js gives one ({ status, statusText, headers, body, ms, size, url, grpc: { code,
 * status, message } }), the status gRPC's code made HTTP's (OK 200, NOT_FOUND 404…). Throws when it
 * can't be called at all (no server, no such method, a body that doesn't fit the request's type).
 */
export async function grpcSend(req, { signal, insecure = false, timeout = null, now = () => performance.now() } = {}) {
  const target = grpcTarget(req.url);
  const started = now();
  let body;
  try {
    body = req.body?.trim() ? JSON.parse(req.body) : {};
  } catch (e) {
    throw new Error(`The body of a gRPC call is the request message as JSON: ${e.message}`);
  }
  const session = await open(target.origin, { insecure, signal });
  session.on('error', () => {});
  try {
    const key = `${target.origin} ${target.service}`;
    let known = learnt.get(key);
    if (!known || Date.now() - known.at > KEEP_FOR) {
      known = { registry: await reflect(session, target.service, { signal }), at: Date.now() };
      learnt.set(key, known);
    }
    const svc = known.registry.services.get(target.service);
    if (!svc) throw new Error(`The server has no service ${target.service}${known.registry.services.size ? ` (it has ${[...known.registry.services.keys()].join(', ')})` : ''}.`);
    const method = svc.methods.find((m) => m.name === target.method);
    if (!method) throw new Error(`${target.service} has no method ${target.method}: it has ${svc.methods.map((m) => m.name).join(', ')}.`);
    if (method.clientStreaming || method.serverStreaming) throw new Error(`${target.service}/${target.method} is a ${method.clientStreaming && method.serverStreaming ? 'bidirectional' : method.clientStreaming ? 'client' : 'server'}-streaming call: Hail makes unary gRPC calls only.`);
    const message = encodeMessage(known.registry, method.input, body);
    const metadata = {};
    for (const [k, v] of req.headers ?? []) if (!OWN.test(k) && !k.startsWith(':')) metadata[k.toLowerCase()] = v;
    const r = await call(session, target.path, [message], { metadata, signal, timeout });
    const out = r.code === 0 && r.messages[0] ? decodeMessage(known.registry, method.output, r.messages[0]) : r.code === 0 ? {} : { code: r.code, status: CODES[r.code] ?? 'UNKNOWN', message: r.message };
    const text = JSON.stringify(out, null, 2);
    const headers = [];
    for (const [k, v] of [...Object.entries(r.headers), ...Object.entries(r.trailers)]) if (!k.startsWith(':')) headers.push([k, Array.isArray(v) ? v.join(', ') : String(v)]);
    return {
      status: HTTP[r.code] ?? 500,
      statusText: r.code === 0 ? 'OK' : `${CODES[r.code] ?? r.code}${r.message ? `: ${r.message}` : ''}`,
      headers,
      body: text,
      ms: Math.round(now() - started),
      size: r.messages.reduce((n, m) => n + m.length, 0),
      url: req.url,
      grpc: { code: r.code, status: CODES[r.code] ?? 'UNKNOWN', message: r.message },
    };
  } finally {
    session.close();
  }
}

/** Forgets what reflection said (tests, and a server that changed). */
export const forgetReflection = () => learnt.clear();
