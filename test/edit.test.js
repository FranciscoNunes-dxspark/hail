// The Edit view: colouring the file, what it suggests, the line commands, and editing, sending and
// saving through the real UI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accept, completeAt } from '../src/complete.js';
import * as ed from '../src/editor.js';
import { blockAt, highlight, roleAt } from '../src/http-file.js';
import { KEYS, start, tempHome, type, until } from './helpers.js';

const kinds = (line) => line.map((r) => `${r.kind ?? '-'}:${r.text}`);

test('highlight reads the file as the parser does', () => {
  const lines = highlight(`@host = http://x
### Log in
# @name login
POST {{host}}/login HTTP/1.1
Content-Type: application/json

{ "user": "{{name}}" }
> {% client.global.set("a", 1) %}
###
GET /next`);
  assert.deepEqual(kinds(lines[0]), ['variable:@host', 'comment: = ', '-:http://x']);
  assert.deepEqual(kinds(lines[1]), ['separator:### Log in']);
  assert.deepEqual(kinds(lines[2]), ['comment:# @name login']);
  assert.deepEqual(kinds(lines[3]), ['method:POST', '-: ', 'placeholder:{{host}}', 'url:/login', 'version: HTTP/1.1']);
  assert.deepEqual(kinds(lines[4]), ['header:Content-Type', '-:: ', 'value:application/json']);
  assert.deepEqual(kinds(lines[6]), ['-:{ "user": "', 'placeholder:{{name}}', '-:" }']);
  assert.deepEqual(kinds(lines[7]), ['handler:> {% client.global.set("a", 1) %}']);
  assert.deepEqual(kinds(lines[9]), ['method:GET', '-: ', 'url:/next'], 'a new request after ###');
});

test('blocks and what a line is to its request', () => {
  const lines = ['@a = 1', '### one', 'GET /a', 'Accept: x', '', 'body', '### two', ''];
  assert.deepEqual(blockAt(lines, 3), { start: 1, end: 5 });
  assert.deepEqual(blockAt(lines, 0), { start: 0, end: 0 });
  assert.equal(roleAt(lines, 2), 'pre', 'the request line itself');
  assert.equal(roleAt(lines, 3), 'headers');
  assert.equal(roleAt(lines, 5), 'body');
  assert.equal(roleAt(lines, 7), 'pre');
});

test('suggestions: variables in {{, methods, header names and values', () => {
  const at = (lines, row, col, opts) => completeAt({ lines, row, col }, { environment: { host: 'http://x' }, file: { token: 't' }, requests: ['login'] }, opts);
  const vars = at(['GET {{ho'], 0, 8);
  assert.equal(vars.items[0].label, 'host');
  assert.deepEqual(accept({ lines: ['GET {{ho'], row: 0, col: 8 }, vars, vars.items[0]), { lines: ['GET {{host}}'], row: 0, col: 12 });
  // Already closed: the }} isn't written twice.
  assert.deepEqual(accept({ lines: ['GET {{ho}}/x'], row: 0, col: 8 }, vars, vars.items[0]).lines, ['GET {{host}}/x']);
  const resp = at(['{{log'], 0, 5);
  assert.equal(resp.items[0].insert, 'login.response.body.');
  assert.deepEqual(accept({ lines: ['{{log'], row: 0, col: 5 }, resp, resp.items[0]), { lines: ['{{login.response.body.'], row: 0, col: 22 });
  const rand = at(['{{$rand'], 0, 7);
  assert.deepEqual(accept({ lines: ['{{$rand'], row: 0, col: 7 }, rand, rand.items[0]), { lines: ['{{$randomInt }}'], row: 0, col: 13 }, 'the cursor waits for the arguments');
  assert.equal(at(['### a', 'po'], 1, 2).items[0].insert, 'POST ');
  assert.equal(at(['### a', ''], 1, 0), null, 'nothing before a letter is typed');
  assert.equal(at(['### a', ''], 1, 0, { force: true }).items[0].label, 'GET', 'unless asked');
  assert.equal(at(['### a', 'GET /x', 'auth'], 2, 4).items[0].insert, 'Authorization: ');
  assert.equal(at(['### a', 'GET /x', 'Content-Type: app'], 2, 17).items[0].label, 'application/json');
  assert.equal(at(['### a', 'GET /x', '', '{ "a'], 3, 4), null, 'nothing in a body');
});

test('commenting lines uses #, and leaves ### alone', () => {
  const out = ed.toggleComment({ lines: ['GET /a', 'Accept: x'], row: 1, col: 9, anchor: { row: 0, col: 0 } });
  assert.deepEqual(out.lines, ['# GET /a', '# Accept: x']);
  assert.deepEqual(ed.toggleComment(out).lines, ['GET /a', 'Accept: x']);
  assert.deepEqual(ed.toggleComment({ lines: ['### one'], row: 0, col: 0 }).lines, ['# ### one'], 'a separator is commented out, not taken as a comment');
});

let cleanup;
let dir;
let server;
let base;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-edit-'));
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, path: req.url, body }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('editing the file: typing, suggestions, ctrl+r sends what is on screen, saved as you type, undo', async () => {
  const file = join(dir, 'api.http');
  // CRLF, as a file written on Windows: it stays CRLF.
  writeFileSync(file, `@host = ${base}\r\n\r\n### First\r\nGET {{host}}/first\r\n\r\n### Second\r\nGET {{host}}/second\r\n`);
  const app = start({ initialFile: file });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('First') && frame().includes('Second'), 'the requests');
    // i on the second request: the Edit view, typing, the cursor on it.
    app.stdin.write('j');
    await until(() => /❯ GET\s+Second/.test(frame()), 'the cursor on the second');
    app.stdin.write('i');
    await until(() => frame().includes('typing: every key is text'), 'typing in the Edit view');
    assert.match(frame(), /2 Edit/);
    // Digits and q are text while typing; the cursor is at the start of GET {{host}}/second.
    app.stdin.write('\x05'); // ctrl+e: to the end of the line
    await type(app.stdin, '/q1');
    await until(() => frame().includes('GET {{host}}/second/q1'), 'the text typed');
    assert.match(frame(), /typing: every key is text/, 'q didn\'t quit and 1 didn\'t switch views');
    // A new header, from the suggestions.
    app.stdin.write(KEYS.enter);
    await type(app.stdin, 'X-Api');
    await until(() => frame().includes('X-Api-Key'), 'the header suggested');
    app.stdin.write(KEYS.tab);
    await type(app.stdin, '{{ho');
    await until(() => frame().includes(' host '), 'the variable suggested');
    app.stdin.write(KEYS.tab);
    await until(() => frame().includes('X-Api-Key: {{host}}'), 'both taken');
    // ctrl+r sends the request the cursor is in, as it is now, and the response shows beside it.
    app.stdin.write('\x12');
    await until(() => frame().includes('"path": "/second/q1"'), 'the edited request sent');
    // Saved a moment after typing stops, still with CRLF.
    await until(() => readFileSync(file, 'utf8').includes('/second/q1'), 'the file saved');
    assert.equal(readFileSync(file, 'utf8'), `@host = ${base}\r\n\r\n### First\r\nGET {{host}}/first\r\n\r\n### Second\r\nGET {{host}}/second/q1\r\nX-Api-Key: {{host}}\r\n`);
    // esc stops typing; ctrl+z undoes the header, a word at a time.
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('↵ or i type · ctrl+r send'), 'typing stopped');
    app.stdin.write('\x1a');
    await until(() => !frame().includes('X-Api-Key: {{host}}'), 'the variable undone');
    // Changed elsewhere: the file comes in again.
    await until(() => readFileSync(file, 'utf8').includes('X-Api-Key: {{ho\r\n'), 'the undo saved');
    writeFileSync(file, `### Only\r\nGET ${base}/only\r\n`);
    await until(() => frame().includes(`GET ${base}/only`), 'the change made elsewhere');
    // /find selects text, and 1 goes back to Requests now that typing has stopped.
    app.stdin.write('/');
    await type(app.stdin, 'find only');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('selected · ctrl+c copy'), 'the text found');
    app.stdin.write('1');
    await until(() => /❯ GET\s+Only/.test(frame()), 'back in Requests');
  } finally {
    app.unmount();
  }
});
