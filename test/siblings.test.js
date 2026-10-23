// The family rules in Hail: pasting a command into a view, /family's lines, and the moods.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeContext, familyDir, writeMood } from '../src/family.js';
import { familyOffers, trawlLine } from '../src/actions.js';
import { familyMood, reactionLine } from '../src/pet.js';
import { KEYS, start, tempHome, until } from './helpers.js';

let cleanup;
let dir;
let server;
before(async () => {
  cleanup = tempHome();
  dir = mkdtempSync(join(tmpdir(), 'hail-siblings-'));
  server = createServer((req, res) => res.end('{"ok":true}'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  mkdirSync(join(dir, '.git'));
  mkdirSync(join(dir, 'api'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' } }));
  writeFileSync(join(dir, 'api', 'appsettings.json'), JSON.stringify({ ConnectionStrings: { Shop: 'Server=tcp:shop.database.windows.net,1433;Database=Shop;Authentication=Active Directory Default', Local: 'Server=localhost,1444;Database=Dev;User ID=sa;Password=hunter2' } }));
  writeFileSync(join(dir, '.env'), 'DATABASE_URL=postgres://me:pw@db.local:5433/orders\n');
  writeFileSync(join(dir, 'api', 'api.http'), `### Ping\nGET http://127.0.0.1:${server.address().port}/ping\n`);
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
  cleanup();
});

test('/family offers Splice the checkout, Bosun the project and Trawl each database, never a password', () => {
  const offers = familyOffers(join(dir, 'api'));
  assert.deepEqual(offers.map((o) => [o.app, o.line]), [
    ['Splice', `/open ${dir}`],
    ['Bosun', `/move ${dir}`],
    ['Trawl', '/azure-sql shop.database.windows.net Shop'],
    ['Trawl', '/add Local localhost,1444 Dev --user sa'],
    ['Trawl', '/add DATABASE_URL db.local:5433 orders --kind postgres --user me'],
  ]);
  assert.ok(offers.every((o) => !/hunter2|pw@/.test(o.line)));
  assert.equal(trawlLine({ name: 'X', kind: 'sqlserver', server: 'x.database.windows.net', user: 'app', database: 'D', entra: false }), '/add X x.database.windows.net D --user app');
});

test('Hoot\'s moods for the family, and his line about theirs', () => {
  assert.deepEqual(familyMood('worried', { lastEntry: { status: 'ok', worried: '2 checks failed', title: 'GET x' } }), { mood: 'worried', reason: '2 checks failed' });
  assert.deepEqual(familyMood('look', { busy: { label: 'Sending' } }), { mood: 'busy', reason: 'Sending' });
  assert.deepEqual(familyMood('wave'), { mood: 'neutral', reason: '' });
  assert.equal(reactionLine({ app: 'sonar', mood: 'worried', reason: '12 new exceptions' }), '{O,O} Sonar looks worried: 12 new exceptions');
  assert.equal(reactionLine({ app: 'bosun', mood: 'busy' }), null);
});

test('a pasted command or context opens the prompt with it, unrun, from the views (Response\'s search too); /family copies a line', async () => {
  const copied = [];
  const app = start({ initialFile: join(dir, 'api', 'api.http'), copy: (t) => copied.push(t) });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Ping'), 'the requests');
    app.stdin.write('/send Ping\r');
    await until(() => frame().includes('> /send Ping'), 'the prompt with the paste');
    assert.doesNotMatch(frame(), /⏺ GET|200 OK/, 'not sent');
    app.stdin.write(KEYS.esc);
    await until(() => frame().includes('↵ send · A send all'), 'back in the view');
    app.stdin.write('3');
    await until(() => frame().includes('Not sent yet'), 'the Response view');
    app.stdin.write('1');
    await until(() => frame().includes('↵ send · A send all'), 'Requests');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('200 OK'), 'a response');
    app.stdin.write('3');
    await until(() => frame().includes('/ search'), 'the response, full width');
    app.stdin.write('/');
    await until(() => frame().includes('/▏'), 'its search');
    const ctx = encodeContext('commit', { hash: 'abc123' });
    app.stdin.write(`${ctx}\n`);
    await until(() => frame().includes(`> ${ctx.slice(0, 40)}`), 'the context in the prompt, not the search');
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes("That's for Splice"), 'it taken');
    app.stdin.write('1');
    await until(() => frame().includes('↵ send · A send all'), 'Requests again');
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('family');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => frame().includes('For the sibling apps'), 'the picker');
    assert.match(frame(), /Trawl +Shop \(appsettings\.json\) +\/azure-sql shop\.database\.windows\.net Shop/);
    app.stdin.write(KEYS.down);
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => copied.length === 1, 'the line copied');
    assert.equal(copied[0], `/move ${dir}`);
    await until(() => frame().includes("Copied for Bosun: paste it into Bosun's prompt"), 'what to do with it');
  } finally {
    app.unmount();
  }
});

test('Hoot writes his mood when it changes, remarks once on a sibling\'s, and the setting turns both off', async () => {
  const home = familyDir();
  writeMood('sonar', { mood: 'worried', reason: 'production has 12 new exceptions' });
  writeMood('bosun', { mood: 'busy', reason: 'starting' });
  const app = start({ initialFile: join(dir, 'api', 'api.http'), familyEvery: 100 });
  const frame = () => app.lastFrame() ?? '';
  try {
    await until(() => frame().includes('Sonar looks worried: production has 12 new exceptions'), 'the reaction');
    assert.doesNotMatch(frame(), /Bosun/);
    app.stdin.write(KEYS.esc);
    await until(() => !frame().includes('Sonar looks worried'), 'it dismissed');
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(frame(), /Sonar looks worried/, 'once only');
    app.stdin.write('/');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write('nope');
    await new Promise((r) => setTimeout(r, 50));
    app.stdin.write(KEYS.enter);
    await until(() => existsSync(join(home, 'hail.mood.json')) && JSON.parse(readFileSync(join(home, 'hail.mood.json'), 'utf8')).mood === 'worried', 'the mood written');
    assert.match(JSON.parse(readFileSync(join(home, 'hail.mood.json'), 'utf8')).reason, /Unknown command/);
  } finally {
    app.unmount();
  }
  rmSync(home, { recursive: true, force: true });
  writeMood('splice', { mood: 'happy', reason: 'PR merged' });
  const off = start({ initialFile: join(dir, 'api', 'api.http'), familyEvery: 100, config: { history: [], familyMoods: false } });
  try {
    await until(() => (off.lastFrame() ?? '').includes('Ping'), 'the requests');
    await new Promise((r) => setTimeout(r, 300));
    assert.doesNotMatch(off.lastFrame(), /Splice is happy/);
    assert.equal(existsSync(join(home, 'hail.mood.json')), false);
  } finally {
    off.unmount();
  }
});
