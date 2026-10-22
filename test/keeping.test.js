// Secrets, the history of responses, comparing them, and Claude's drafts: the pure parts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftPrompt, parseDraft } from '../src/claude.js';
import { memoryCredentials } from '../src/credentials.js';
import { changedOnly, lineDiff } from '../src/diff.js';
import { appendHistory, entryFor, historyFile, latestByLabel, previousOf, readHistory } from '../src/history.js';
import { parseHttpFile } from '../src/http-file.js';
import { prepare } from '../src/send.js';

test('{{$secret}} reads the store, and what was filled in is noted so it can be left out later', async () => {
  const store = memoryCredentials({ 'api-key': 'k-12345' });
  const [request] = parseHttpFile('GET https://x/items?key={{$secret api-key}}\nAuthorization: Bearer {{$secret api-key}}\n').requests;
  const req = await prepare(request, { env: { secret: (n) => store.get(n) } });
  assert.equal(req.url, 'https://x/items?key=k-12345');
  assert.deepEqual(req.secrets, ['k-12345']);
  const none = await prepare(parseHttpFile('GET https://x/{{$secret other}}\n').requests[0], { env: { secret: (n) => store.get(n) } });
  assert.deepEqual(none.missing, ['$secret other'], 'an unsaved one is missing, by its whole expression, for the app to ask');
});

test('what history keeps: secrets blanked everywhere, credential headers hidden, big bodies cut', () => {
  const e = entryFor({
    label: 'items',
    name: 'items',
    at: 1,
    request: { method: 'GET', url: 'https://x/items?key=k-12345', headers: [['Authorization', 'Bearer abc'], ['X-Trace', 'k-12345'], ['Accept', 'json']], body: 'k-12345', secrets: ['k-12345'] },
    response: { status: 200, statusText: 'OK', headers: [['Set-Cookie', 'sid=1'], ['Content-Type', 'text/plain']], body: 'echo k-12345 ' + 'x'.repeat(600 * 1024), ms: 5, size: 10, url: 'https://x/items?key=k-12345' },
  });
  assert.equal(e.request.url, 'https://x/items?key=••••••');
  assert.deepEqual(e.request.headers, [['Authorization', '••••••'], ['X-Trace', '••••••'], ['Accept', 'json']]);
  assert.equal(e.request.body, '••••••');
  assert.deepEqual(e.response.headers[0], ['Set-Cookie', '••••••']);
  assert.ok(e.response.body.startsWith('echo •••••• '));
  assert.equal(e.response.body.length, 512 * 1024);
  assert.equal(e.response.truncated, true);
  assert.ok(!JSON.stringify(e).includes('k-12345'));
});

test('the history file: appended, read back past a broken line, trimmed to the newest, the latest per request', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hail-history-'));
  try {
    const file = historyFile('/work/api.http', dir);
    assert.notEqual(file, historyFile('/work/other.http', dir));
    const entry = (label, at) => ({ label, at, request: {}, response: { body: String(at) } });
    let held = [];
    for (let i = 1; i <= 30; i++) held = appendHistory(file, entry(i % 2 ? 'a' : 'b', i), { entries: held, keep: 10 });
    const all = readHistory(file);
    assert.ok(all.length >= 10 && all.length <= 12, `${all.length} kept`);
    assert.deepEqual(held.map((e) => e.at), all.map((e) => e.at), 'what the app holds is what the file has');
    // Without the entries, the file is read first.
    assert.equal(appendHistory(file, entry('b', 32)).length, all.length + 1);
    assert.equal(all.at(-1).at, 30);
    assert.deepEqual(Object.fromEntries(Object.entries(latestByLabel(all)).map(([k, v]) => [k, v.at])), { a: 29, b: 30 });
    assert.equal(previousOf(all, all.at(-1)).at, 28);
    assert.equal(previousOf(all, all[0]), null);
    // A line cut short (the app closed mid-write) costs only itself.
    appendHistory(file, entry('a', 31));
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"label":"a","at":`);
    assert.equal(readHistory(file).at(-1).at, 31);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('diff: the lines that changed, with some round them', () => {
  const d = lineDiff('a\nb\nc\nd\ne\nf\ng\nh\ni', 'a\nb\nc\nd\nE\nf\ng\nh\ni');
  assert.deepEqual(d.filter(([m]) => m !== ' '), [['-', 'e'], ['+', 'E']]);
  assert.deepEqual(changedOnly(d, 1), [['…', ''], [' ', 'd'], ['-', 'e'], ['+', 'E'], [' ', 'f'], ['…', '']]);
});

test("Claude's drafts: the prompt says what the file has, the answer is read past fences and talk", () => {
  const p = draftPrompt({ want: 'the user endpoints', variables: ['host'], environment: ['token', 'host'], labels: ['login'] });
  assert.match(p, /Write requests for: the user endpoints/);
  assert.match(p, /use them rather than declaring new ones: host, token/);
  assert.match(p, /leave them out: login/);
  const d = parseDraft('Here you go:\n```http\n### List users\n# @name listUsers\nGET {{host}}/users HTTP/1.1\n```\nEnjoy!');
  assert.equal(d.text, '### List users\n# @name listUsers\nGET {{host}}/users HTTP/1.1\n');
  assert.deepEqual(d.requests.map((r) => r.name), ['listUsers']);
  assert.throws(() => parseDraft('Sorry, I need more detail.'), /no requests/);
});
