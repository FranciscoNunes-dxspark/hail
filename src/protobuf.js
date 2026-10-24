// Protocol Buffers, as much as a gRPC call from JSON needs, with no dependency: the wire format, a
// registry of message and enum types (read from FileDescriptorProtos, which gRPC's server reflection
// hands over), and JSON to bytes and back, as proto3's JSON mapping has it: scalars, strings, bytes
// (base64), enums (by name), nested and repeated messages, maps, 64-bit integers as strings, and the
// well-known Timestamp, Duration, wrappers, Struct, Value, ListValue and Empty. Pure.

// Field types, as descriptor.proto numbers them.
export const T = { double: 1, float: 2, int64: 3, uint64: 4, int32: 5, fixed64: 6, fixed32: 7, bool: 8, string: 9, group: 10, message: 11, bytes: 12, uint32: 13, enum: 14, sfixed32: 15, sfixed64: 16, sint32: 17, sint64: 18 };
const WIRE = { 1: 1, 2: 5, 3: 0, 4: 0, 5: 0, 6: 1, 7: 5, 8: 0, 9: 2, 11: 2, 12: 2, 13: 0, 14: 0, 15: 5, 16: 1, 17: 0, 18: 0 };
const LONG = new Set([T.int64, T.uint64, T.fixed64, T.sfixed64, T.sint64]);
const PACKABLE = (type) => WIRE[type] === 0 || WIRE[type] === 1 || WIRE[type] === 5;

const lowerCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// --- The wire ------------------------------------------------------------------------------------------

/** Bytes written one value at a time. */
class Writer {
  constructor() {
    this.parts = [];
  }
  bytes(b) {
    this.parts.push(Buffer.from(b));
  }
  varint(v) {
    let n = BigInt.asUintN(64, BigInt(v));
    const out = [];
    do {
      let byte = Number(n & 0x7fn);
      n >>= 7n;
      if (n) byte |= 0x80;
      out.push(byte);
    } while (n);
    this.parts.push(Buffer.from(out));
  }
  tag(number, wire) {
    this.varint((BigInt(number) << 3n) | BigInt(wire));
  }
  fixed32(v, kind) {
    const b = Buffer.alloc(4);
    if (kind === 'float') b.writeFloatLE(v);
    else if (kind === 'signed') b.writeInt32LE(v);
    else b.writeUInt32LE(v >>> 0);
    this.parts.push(b);
  }
  fixed64(v, kind) {
    const b = Buffer.alloc(8);
    if (kind === 'double') b.writeDoubleLE(v);
    else b.writeBigUInt64LE(BigInt.asUintN(64, BigInt(v)));
    this.parts.push(b);
  }
  delimited(b) {
    this.varint(b.length);
    this.parts.push(Buffer.from(b));
  }
  finish() {
    return Buffer.concat(this.parts);
  }
}

/** Reads values from `buf` in turn. */
class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  done() {
    return this.pos >= this.buf.length;
  }
  varint() {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('The message ended in the middle of a number.');
      const b = this.buf[this.pos++];
      n |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return n;
      shift += 7n;
      if (shift > 70n) throw new Error('A number in the message is too long.');
    }
  }
  take(n) {
    if (this.pos + n > this.buf.length) throw new Error('The message is cut short.');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.take(8);
    else if (wire === 2) this.take(Number(this.varint()));
    else if (wire === 5) this.take(4);
    else throw new Error(`Hail can't read wire type ${wire}.`);
  }
}

// --- Types -------------------------------------------------------------------------------------------

/** A registry of types by full name ('.pkg.Message'): { messages: Map, enums: Map, services: Map }. */
export const newRegistry = () => ({ messages: new Map(), enums: new Map(), services: new Map(), files: new Set() });

/** A message type for a registry: `fields` as [name, number, type, typeName?, repeated?]; names stay as written (no camelCase). */
export function plainMessage(name, fields) {
  return { name, mapEntry: false, fields: fields.map(([n, number, type, typeName = null, repeated = false]) => ({ name: n, jsonName: n, number, type, typeName, repeated })) };
}

/** Adds the types of `file` (a FileDescriptorProto, as decoded with DESCRIPTORS' names) to `registry`. */
export function addFile(registry, file) {
  registry.files.add(file.name);
  const pkg = file.package ? `.${file.package}` : '';
  const addEnum = (prefix, e) => registry.enums.set(`${prefix}.${e.name}`, { name: `${prefix}.${e.name}`, values: (e.value ?? []).map((v) => ({ name: v.name, number: Number(v.number ?? 0) })) });
  const addMessage = (prefix, m) => {
    const name = `${prefix}.${m.name}`;
    registry.messages.set(name, {
      name,
      mapEntry: Boolean(m.options?.map_entry),
      fields: (m.field ?? []).map((f) => ({
        name: f.name,
        jsonName: f.json_name || lowerCamel(f.name),
        number: Number(f.number),
        type: Number(f.type),
        typeName: f.type_name || null,
        repeated: Number(f.label) === 3,
      })),
    });
    for (const n of m.nested_type ?? []) addMessage(name, n);
    for (const e of m.enum_type ?? []) addEnum(name, e);
  };
  for (const m of file.message_type ?? []) addMessage(pkg, m);
  for (const e of file.enum_type ?? []) addEnum(pkg, e);
  for (const s of file.service ?? []) {
    const name = `${file.package ? `${file.package}.` : ''}${s.name}`;
    registry.services.set(name, {
      name,
      methods: (s.method ?? []).map((m) => ({ name: m.name, input: m.input_type, output: m.output_type, clientStreaming: Boolean(m.client_streaming), serverStreaming: Boolean(m.server_streaming) })),
    });
  }
}

// descriptor.proto, the parts a FileDescriptorProto needs read (and written, for tests' servers).
export const DESCRIPTORS = (() => {
  const r = newRegistry();
  const add = (name, fields) => r.messages.set(name, plainMessage(name, fields));
  add('.FileDescriptorProto', [['name', 1, T.string], ['package', 2, T.string], ['dependency', 3, T.string, null, true], ['message_type', 4, T.message, '.DescriptorProto', true], ['enum_type', 5, T.message, '.EnumDescriptorProto', true], ['service', 6, T.message, '.ServiceDescriptorProto', true], ['syntax', 12, T.string]]);
  add('.DescriptorProto', [['name', 1, T.string], ['field', 2, T.message, '.FieldDescriptorProto', true], ['nested_type', 3, T.message, '.DescriptorProto', true], ['enum_type', 4, T.message, '.EnumDescriptorProto', true], ['options', 7, T.message, '.MessageOptions'], ['oneof_decl', 8, T.message, '.OneofDescriptorProto', true]]);
  add('.MessageOptions', [['map_entry', 7, T.bool]]);
  add('.OneofDescriptorProto', [['name', 1, T.string]]);
  add('.FieldDescriptorProto', [['name', 1, T.string], ['number', 3, T.int32], ['label', 4, T.int32], ['type', 5, T.int32], ['type_name', 6, T.string], ['default_value', 7, T.string], ['oneof_index', 9, T.int32], ['json_name', 10, T.string], ['proto3_optional', 17, T.bool]]);
  add('.EnumDescriptorProto', [['name', 1, T.string], ['value', 2, T.message, '.EnumValueDescriptorProto', true]]);
  add('.EnumValueDescriptorProto', [['name', 1, T.string], ['number', 2, T.int32]]);
  add('.ServiceDescriptorProto', [['name', 1, T.string], ['method', 2, T.message, '.MethodDescriptorProto', true]]);
  add('.MethodDescriptorProto', [['name', 1, T.string], ['input_type', 2, T.string], ['output_type', 3, T.string], ['client_streaming', 5, T.bool], ['server_streaming', 6, T.bool]]);
  // grpc.reflection.v1 (and v1alpha, the same messages).
  add('.ServerReflectionRequest', [['host', 1, T.string], ['file_by_filename', 3, T.string], ['file_containing_symbol', 4, T.string], ['list_services', 7, T.string]]);
  add('.ServerReflectionResponse', [['valid_host', 1, T.string], ['original_request', 2, T.message, '.ServerReflectionRequest'], ['file_descriptor_response', 4, T.message, '.FileDescriptorResponse'], ['list_services_response', 6, T.message, '.ListServiceResponse'], ['error_response', 7, T.message, '.ErrorResponse']]);
  add('.FileDescriptorResponse', [['file_descriptor_proto', 1, T.bytes, null, true]]);
  add('.ListServiceResponse', [['service', 1, T.message, '.ServiceResponse', true]]);
  add('.ServiceResponse', [['name', 1, T.string]]);
  add('.ErrorResponse', [['error_code', 1, T.int32], ['error_message', 2, T.string]]);
  return r;
})();

// --- JSON to bytes -----------------------------------------------------------------------------------

const WRAPPERS = { DoubleValue: T.double, FloatValue: T.float, Int64Value: T.int64, UInt64Value: T.uint64, Int32Value: T.int32, UInt32Value: T.uint32, BoolValue: T.bool, StringValue: T.string, BytesValue: T.bytes };
const wkt = (typeName) => (typeName?.startsWith('.google.protobuf.') ? typeName.slice(17) : null);

const fail = (path, text) => {
  throw new Error(`${path}: ${text}`);
};

/** A JSON value as a number for a numeric field (a string is fine, as proto3 JSON writes 64-bit ones). */
function toNumber(type, v, path) {
  if (type === T.double || type === T.float) {
    if (v === 'NaN' || v === 'Infinity' || v === '-Infinity') return Number(v);
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
    if (Number.isNaN(n)) fail(path, `${JSON.stringify(v)} isn't a number`);
    return n;
  }
  if (typeof v === 'boolean' || v == null || (typeof v === 'string' && !/^-?\d+(\.0+)?$/.test(v.trim())) || (typeof v === 'number' && !Number.isInteger(v))) fail(path, `${JSON.stringify(v)} isn't a whole number`);
  const n = BigInt(String(v).trim().replace(/\.0+$/, ''));
  if ([T.uint32, T.uint64, T.fixed32, T.fixed64].includes(type) && n < 0n) fail(path, `${v} is negative, and the field isn't signed`);
  return n;
}

function writeScalar(w, type, v, path, registry, typeName) {
  switch (type) {
    case T.double:
      return w.fixed64(toNumber(type, v, path), 'double');
    case T.float:
      return w.fixed32(toNumber(type, v, path), 'float');
    case T.fixed32:
      return w.fixed32(Number(toNumber(type, v, path)), 'unsigned');
    case T.sfixed32:
      return w.fixed32(Number(toNumber(type, v, path)), 'signed');
    case T.fixed64:
    case T.sfixed64:
      return w.fixed64(toNumber(type, v, path));
    case T.sint32:
    case T.sint64: {
      const n = toNumber(type, v, path);
      return w.varint(n >= 0n ? n << 1n : (-n << 1n) - 1n);
    }
    case T.bool:
      if (typeof v !== 'boolean' && v !== 'true' && v !== 'false') fail(path, `${JSON.stringify(v)} isn't true or false`);
      return w.varint(v === true || v === 'true' ? 1 : 0);
    case T.string:
      if (typeof v !== 'string') fail(path, `${JSON.stringify(v)} isn't a string`);
      return w.delimited(Buffer.from(v, 'utf8'));
    case T.bytes:
      if (v instanceof Uint8Array) return w.delimited(v);
      if (typeof v !== 'string') fail(path, 'bytes are given as base64');
      return w.delimited(Buffer.from(v, 'base64'));
    case T.enum: {
      const e = registry.enums.get(typeName);
      if (typeof v === 'number') return w.varint(v);
      const found = e?.values.find((x) => x.name === v);
      if (!found) fail(path, `${JSON.stringify(v)} isn't one of ${e ? e.values.map((x) => x.name).join(', ') : 'its values'}`);
      return w.varint(found.number);
    }
    default:
      return w.varint(toNumber(type, v, path));
  }
}

/** A well-known type's JSON as the message it stands for, or undefined for one that's an ordinary message. */
function fromWellKnown(name, v, path) {
  if (name === 'Timestamp') {
    const ms = Date.parse(v);
    if (typeof v !== 'string' || Number.isNaN(ms)) fail(path, `${JSON.stringify(v)} isn't a time (RFC 3339, like 2024-05-01T12:00:00Z)`);
    const frac = /\.(\d+)/.exec(v)?.[1] ?? '';
    return { seconds: String(Math.floor(ms / 1000)), nanos: Number(frac.padEnd(9, '0').slice(0, 9)) || 0 };
  }
  if (name === 'Duration') {
    const m = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(String(v));
    if (!m) fail(path, `${JSON.stringify(v)} isn't a duration (like "1.5s")`);
    const sign = m[1] ? -1 : 1;
    return { seconds: String(sign * Number(m[2])), nanos: sign * Number((m[3] ?? '').padEnd(9, '0')) };
  }
  if (WRAPPERS[name]) return { value: v };
  if (name === 'Struct') return { fields: v };
  if (name === 'ListValue') return { values: v };
  if (name === 'Value') {
    if (v === null) return { null_value: 0 };
    if (typeof v === 'number') return { number_value: v };
    if (typeof v === 'string') return { string_value: v };
    if (typeof v === 'boolean') return { bool_value: v };
    if (Array.isArray(v)) return { list_value: v };
    return { struct_value: v };
  }
  return undefined;
}

// The well-known types' own fields, so they work without their descriptors.
const WELL_KNOWN = (() => {
  const r = newRegistry();
  const add = (name, fields) => r.messages.set(`.google.protobuf.${name}`, plainMessage(`.google.protobuf.${name}`, fields));
  add('Timestamp', [['seconds', 1, T.int64], ['nanos', 2, T.int32]]);
  add('Duration', [['seconds', 1, T.int64], ['nanos', 2, T.int32]]);
  add('Empty', []);
  for (const [name, type] of Object.entries(WRAPPERS)) add(name, [['value', 1, type]]);
  add('Struct', [['fields', 1, T.message, '.google.protobuf.Struct.FieldsEntry', true]]);
  r.messages.set('.google.protobuf.Struct.FieldsEntry', { ...plainMessage('.google.protobuf.Struct.FieldsEntry', [['key', 1, T.string], ['value', 2, T.message, '.google.protobuf.Value']]), mapEntry: true });
  add('Value', [['null_value', 1, T.enum, '.google.protobuf.NullValue'], ['number_value', 2, T.double], ['string_value', 3, T.string], ['bool_value', 4, T.bool], ['struct_value', 5, T.message, '.google.protobuf.Struct'], ['list_value', 6, T.message, '.google.protobuf.ListValue']]);
  add('ListValue', [['values', 1, T.message, '.google.protobuf.Value', true]]);
  r.enums.set('.google.protobuf.NullValue', { name: '.google.protobuf.NullValue', values: [{ name: 'NULL_VALUE', number: 0 }] });
  return r;
})();

const messageType = (registry, name) => (wkt(name) && WELL_KNOWN.messages.get(name)) || registry.messages.get(name) || WELL_KNOWN.messages.get(name);
const enumType = (registry, name) => registry.enums.get(name) ?? WELL_KNOWN.enums.get(name);
const both = (registry) => ({ messages: { get: (n) => messageType(registry, n) }, enums: { get: (n) => enumType(registry, n) } });

/**
 * `value` (JSON) as the bytes of message `typeName` from `registry`. A field is found by its JSON name
 * or its own; one the message doesn't have throws, naming it, as does a value of the wrong kind.
 */
export function encodeMessage(registry, typeName, value, path = '$') {
  const reg = both(registry);
  const type = reg.messages.get(typeName);
  if (!type) throw new Error(`${path}: there's no message type ${typeName.replace(/^\./, '')}`);
  const name = wkt(typeName);
  if (name) {
    const v = fromWellKnown(name, value, path);
    if (v !== undefined) value = v;
  }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(path, `a ${typeName.replace(/^\./, '')} is a JSON object`);
  const byName = new Map();
  for (const f of type.fields) {
    byName.set(f.jsonName, f);
    byName.set(f.name, f);
  }
  const w = new Writer();
  for (const [key, v] of Object.entries(value)) {
    const f = byName.get(key);
    if (!f) fail(path, `${typeName.replace(/^\./, '')} has no field ${key} (it has ${type.fields.map((x) => x.jsonName).join(', ') || 'none'})`);
    if (v == null && !(f.typeName === '.google.protobuf.Value')) continue;
    const at = `${path}.${key}`;
    const entry = f.type === T.message ? reg.messages.get(f.typeName) : null;
    if (f.repeated && entry?.mapEntry) {
      if (typeof v !== 'object' || Array.isArray(v)) fail(at, 'a map is a JSON object');
      for (const [k, x] of Object.entries(v)) {
        const keyField = entry.fields.find((e) => e.number === 1);
        const key = keyField.type === T.bool ? k === 'true' : keyField.type === T.string ? k : k;
        w.tag(f.number, 2);
        w.delimited(encodeMessage(registry, f.typeName, { [keyField.name]: key, [entry.fields.find((e) => e.number === 2).name]: x }, `${at}.${k}`));
      }
      continue;
    }
    const list = f.repeated ? v : [v];
    if (f.repeated && !Array.isArray(v)) fail(at, 'a repeated field is a JSON array');
    if (f.repeated && PACKABLE(f.type) && list.length) {
      const inner = new Writer();
      list.forEach((x, i) => writeScalar(inner, f.type, x, `${at}[${i}]`, reg, f.typeName));
      w.tag(f.number, 2);
      w.delimited(inner.finish());
      continue;
    }
    list.forEach((x, i) => {
      const where = f.repeated ? `${at}[${i}]` : at;
      if (f.type === T.message) {
        w.tag(f.number, 2);
        w.delimited(encodeMessage(registry, f.typeName, x, where));
      } else if (f.type === T.group) fail(where, "Hail can't write proto2 groups");
      else {
        w.tag(f.number, WIRE[f.type]);
        writeScalar(w, f.type, x, where, reg, f.typeName);
      }
    });
  }
  return w.finish();
}

// --- Bytes to JSON -----------------------------------------------------------------------------------

function readScalar(r, type, wire, { raw, registry, typeName }) {
  switch (type) {
    case T.double:
      return r.take(8).readDoubleLE(0);
    case T.float:
      return r.take(4).readFloatLE(0);
    case T.fixed32:
      return r.take(4).readUInt32LE(0);
    case T.sfixed32:
      return r.take(4).readInt32LE(0);
    case T.fixed64:
      return String(r.take(8).readBigUInt64LE(0));
    case T.sfixed64:
      return String(r.take(8).readBigInt64LE(0));
    case T.bool:
      return r.varint() !== 0n;
    case T.string:
      return r.take(Number(r.varint())).toString('utf8');
    case T.bytes: {
      const b = Buffer.from(r.take(Number(r.varint())));
      return raw ? b : b.toString('base64');
    }
    case T.sint32:
    case T.sint64: {
      const n = r.varint();
      const v = n & 1n ? -((n + 1n) >> 1n) : n >> 1n;
      return type === T.sint64 ? String(v) : Number(v);
    }
    case T.int32:
      return Number(BigInt.asIntN(32, r.varint()));
    case T.uint32:
      return Number(BigInt.asUintN(32, r.varint()));
    case T.int64:
      return String(BigInt.asIntN(64, r.varint()));
    case T.uint64:
      return String(BigInt.asUintN(64, r.varint()));
    case T.enum: {
      const n = Number(BigInt.asIntN(32, r.varint()));
      if (raw) return n;
      return registry.enums.get(typeName)?.values.find((v) => v.number === n)?.name ?? n;
    }
    default:
      r.skip(wire);
      return undefined;
  }
}

/** A well-known type's message as its JSON, or undefined for an ordinary one. */
function toWellKnown(name, m) {
  // 0, 3, 6 or 9 digits, as proto3's JSON writes them.
  const nanos = (n) => {
    const v = Math.abs(n ?? 0);
    const digits = String(v).padStart(9, '0');
    return !v ? '' : v % 1e6 === 0 ? digits.slice(0, 3) : v % 1e3 === 0 ? digits.slice(0, 6) : digits;
  };
  if (name === 'Timestamp') {
    const ms = Number(m.seconds ?? 0) * 1000;
    const base = new Date(ms).toISOString().replace(/\.\d+Z$/, '');
    const frac = nanos(m.nanos);
    return `${base}${frac ? `.${frac}` : ''}Z`;
  }
  if (name === 'Duration') {
    const s = BigInt(m.seconds ?? 0);
    const neg = s < 0n || (m.nanos ?? 0) < 0;
    const frac = nanos(m.nanos);
    return `${neg && s === 0n ? '-' : ''}${s}${frac ? `.${frac}` : ''}s`;
  }
  if (WRAPPERS[name]) return m.value ?? (WRAPPERS[name] === T.bool ? false : WRAPPERS[name] === T.string || WRAPPERS[name] === T.bytes ? '' : 0);
  if (name === 'Empty') return {};
  if (name === 'Struct') return m.fields ?? {};
  if (name === 'ListValue') return m.values ?? [];
  if (name === 'Value') {
    for (const k of ['number_value', 'string_value', 'bool_value', 'struct_value', 'list_value']) if (k in m) return m[k];
    return null;
  }
  return undefined;
}

/**
 * The bytes of message `typeName` as JSON (fields under their JSON names; those the bytes don't carry
 * are left out, as proto3 leaves defaults out). `raw`: names as written, bytes as Buffers and enums
 * as numbers, for reading descriptors.
 */
export function decodeMessage(registry, typeName, buf, { raw = false } = {}) {
  const reg = raw ? registry : both(registry);
  const type = reg.messages.get(typeName);
  if (!type) throw new Error(`There's no message type ${typeName.replace(/^\./, '')}`);
  const byNumber = new Map(type.fields.map((f) => [f.number, f]));
  const out = {};
  const r = new Reader(buf);
  while (!r.done()) {
    const tag = r.varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    const f = byNumber.get(number);
    if (!f) {
      r.skip(wire);
      continue;
    }
    const key = raw ? f.name : f.jsonName;
    const entry = f.type === T.message ? reg.messages.get(f.typeName) : null;
    if (f.type === T.message) {
      if (wire !== 2) {
        r.skip(wire);
        continue;
      }
      const v = decodeMessage(registry, f.typeName, r.take(Number(r.varint())), { raw });
      if (f.repeated && entry?.mapEntry) {
        const k = v[raw ? entry.fields.find((e) => e.number === 1).name : entry.fields.find((e) => e.number === 1).jsonName];
        const val = v[raw ? entry.fields.find((e) => e.number === 2).name : entry.fields.find((e) => e.number === 2).jsonName];
        out[key] = { ...out[key], [String(k ?? '')]: val ?? defaultFor(entry.fields.find((e) => e.number === 2), reg) };
      } else if (f.repeated) (out[key] ??= []).push(v);
      else out[key] = v;
      continue;
    }
    const opts = { raw, registry: reg, typeName: f.typeName };
    if (f.repeated && wire === 2 && PACKABLE(f.type)) {
      const inner = new Reader(r.take(Number(r.varint())));
      const list = (out[key] ??= []);
      while (!inner.done()) list.push(readScalar(inner, f.type, WIRE[f.type], opts));
      continue;
    }
    const v = readScalar(r, f.type, wire, opts);
    if (v === undefined) continue;
    if (f.repeated) (out[key] ??= []).push(v);
    else out[key] = v;
  }
  const name = !raw && wkt(typeName);
  if (name) {
    const v = toWellKnown(name, out);
    if (v !== undefined) return v;
  }
  return out;
}

/** The default of a field (a map's value the bytes left out). */
function defaultFor(f, reg) {
  if (f.type === T.message) return {};
  if (f.type === T.string || f.type === T.bytes) return '';
  if (f.type === T.bool) return false;
  if (LONG.has(f.type)) return '0';
  if (f.type === T.enum) return reg.enums.get(f.typeName)?.values.find((v) => v.number === 0)?.name ?? 0;
  return 0;
}

/** A FileDescriptorProto's bytes as an object with descriptor.proto's names (what addFile takes). */
export const decodeFile = (bytes) => decodeMessage(DESCRIPTORS, '.FileDescriptorProto', bytes, { raw: true });

/** A FileDescriptorProto (descriptor.proto's names) as its bytes, as a server's reflection hands it over. */
export const encodeFile = (file) => encodeMessage(DESCRIPTORS, '.FileDescriptorProto', file);
