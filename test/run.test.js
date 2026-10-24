// The shared run.js: programs started without a terminal, and signals of their own for calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { callSignal, run } from '../src/run.js';

test('callSignal ties a call to a long-lived signal only until it is done', () => {
  const task = new AbortController();
  const calls = Array.from({ length: 50 }, () => callSignal(task.signal));
  assert.equal(getEventListeners(task.signal, 'abort').length, 50);
  for (const c of calls.slice(1)) c.done();
  assert.equal(getEventListeners(task.signal, 'abort').length, 1, 'only the call still going listens');
  task.abort('stopped');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[0].signal.reason, 'stopped');
  assert.equal(calls[1].signal.aborted, false, 'a call already done is left alone');
  assert.equal(callSignal(task.signal).signal.aborted, true, 'already aborted: so is the call');
  assert.equal(callSignal(undefined).signal, undefined);
  callSignal(undefined).done();
});

test('run gives a program its output, and a cancelled one says so', async () => {
  const { stdout } = await run('node -e "process.stdout.write(\'hi\')"');
  assert.equal(stdout, 'hi');
  const c = new AbortController();
  const p = run('node -e "setTimeout(() => {}, 10000)"', { signal: c.signal });
  setTimeout(() => c.abort(), 100);
  await assert.rejects(p, (e) => e.cancelled === true);
  assert.equal(getEventListeners(c.signal, 'abort').length, 0);
});
