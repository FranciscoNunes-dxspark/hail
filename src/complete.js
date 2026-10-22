// What the Edit view suggests as you type, as Trawl's console does from the schema: inside {{ the
// variables there are (the environment's, the file's, the named requests' responses, the built-ins),
// a method where the request line goes, and header names and some of their values under it. Pure.
import { METHODS, roleAt } from './http-file.js';

const BUILTINS = [
  ['$uuid', 'a new UUID'],
  ['$guid', 'a new UUID'],
  ['$timestamp', 'seconds since 1970'],
  ['$isoTimestamp', 'now, as ISO 8601'],
  ['$randomInt ', 'min max', true],
  ['$processEnv ', 'NAME', true],
  ['$env.', 'NAME', false, true],
  ['$azToken', "the Azure CLI's sign-in"],
  ['$secret ', 'name', true],
];

const HEADERS = [
  'Accept',
  'Accept-Encoding',
  'Accept-Language',
  'Authorization',
  'Cache-Control',
  'Content-Type',
  'Cookie',
  'If-Match',
  'If-None-Match',
  'Origin',
  'User-Agent',
  'X-Api-Key',
  'X-Request-Id',
];

const MEDIA = ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain', 'application/xml', 'text/html', '*/*'];
const VALUES = { 'content-type': MEDIA, accept: MEDIA, authorization: ['Bearer ', 'Basic '] };

// Those starting with what's typed first, then those that have it, ignoring case.
function ranked(items, typed) {
  const q = typed.toLowerCase();
  const starts = items.filter((i) => i.label.toLowerCase().startsWith(q));
  const has = items.filter((i) => !i.label.toLowerCase().startsWith(q) && i.label.toLowerCase().includes(q));
  return [...starts, ...has].slice(0, 50);
}

/**
 * The suggestions at the cursor: { from, items: [{ label, insert, detail, kind, close, inside }] },
 * `from` the column the word being typed starts at, or null when there are none. `close` adds "}}"
 * after the insert (unless it's there), and `inside` leaves the cursor before it, for what takes
 * arguments. `sources`: { environment, file } (variables by name) and `requests` (the named ones).
 * `force` (ctrl+n) offers them before anything is typed.
 */
export function completeAt(ed, { environment = {}, file = {}, requests = [] } = {}, { force = false } = {}) {
  const line = ed.lines[ed.row];
  const before = line.slice(0, ed.col);
  const open = before.lastIndexOf('{{');
  if (open >= 0 && !before.slice(open).includes('}}')) {
    const typed = before.slice(open + 2).replace(/^\s+/, '');
    if (/\s/.test(typed)) return null;
    const items = [
      ...Object.entries(environment).map(([k, v]) => ({ label: k, insert: k, detail: String(v), kind: 'environment', close: true })),
      ...Object.entries(file)
        .filter(([k]) => !(k in environment))
        .map(([k, v]) => ({ label: k, insert: k, detail: String(v), kind: 'file', close: true })),
      ...requests.map((n) => ({ label: `${n}.response.body.`, insert: `${n}.response.body.`, detail: 'its response', kind: 'response' })),
      ...BUILTINS.map(([name, detail, inside, open]) => ({ label: name.trim(), insert: name, detail, kind: 'builtin', close: !open, inside })),
    ];
    const shown = ranked(items, typed);
    return shown.length ? { from: ed.col - typed.length, items: shown } : null;
  }
  const role = roleAt(ed.lines, ed.row);
  if (role === 'pre') {
    const m = /^(\s*)([A-Za-z]*)$/.exec(before);
    if (!m || (!m[2] && !force) || line.slice(ed.col).trim()) return null;
    const items = ranked(METHODS.map((name) => ({ label: name, insert: `${name} `, detail: '', kind: 'method' })), m[2]);
    return items.length ? { from: m[1].length, items } : null;
  }
  if (role !== 'headers') return null;
  const value = /^\s*([A-Za-z-]+)\s*:\s*(\S*)$/.exec(before);
  if (value) {
    const list = VALUES[value[1].toLowerCase()];
    if (!list || (!value[2] && !force)) return null;
    const items = ranked(list.map((v) => ({ label: v.trim(), insert: v, detail: '', kind: 'value' })), value[2]);
    return items.length ? { from: ed.col - value[2].length, items } : null;
  }
  const name = /^(\s*)([A-Za-z-]*)$/.exec(before);
  if (!name || (!name[2] && !force) || line.slice(ed.col).includes(':')) return null;
  const items = ranked(HEADERS.map((h) => ({ label: h, insert: `${h}: `, detail: '', kind: 'header' })), name[2]);
  return items.length ? { from: name[1].length, items } : null;
}

/** The editor with `item` taken in place of the word being typed. */
export function accept(ed, completion, item) {
  const line = ed.lines[ed.row];
  const rest = line.slice(ed.col);
  const close = item.close && !rest.startsWith('}}') ? '}}' : '';
  const lines = [...ed.lines];
  lines[ed.row] = line.slice(0, completion.from) + item.insert + close + rest;
  const col = completion.from + item.insert.length + (item.inside || !item.close ? 0 : 2);
  return { lines, row: ed.row, col };
}
