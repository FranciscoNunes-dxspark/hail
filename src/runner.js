// One request's whole exchange after it's filled in: sending it, then running its response handlers
// (checks.js) on what came back. And the report of a run of the whole file (/send all, `hail test`),
// which is pure.
import { runChecks } from './checks.js';
import { send } from './send.js';

/**
 * Sends `req` (send.js's prepare) and runs its handlers. Resolves with { response, checks, globals }:
 * `checks` is null without handlers, `globals` the global variables afterwards (from `globals`).
 * `jar` keeps cookies (cookies.js) unless the request says `# @no-cookie-jar`. Throws what send throws
 * (no answer, cancelled).
 */
export async function exchange(req, { signal, globals = {}, fetch, jar = null } = {}) {
  const options = req.options ?? {};
  const { raw: _, ...response } = await send(req, { signal, fetch, jar: options['no-cookie-jar'] ? null : jar });
  let checks = null;
  let after = globals;
  if (req.handlers?.length) {
    const r = runChecks(req.handlers, response, { globals });
    checks = { tests: r.tests, log: r.log, error: r.error };
    after = r.globals;
  }
  return { response, checks, globals: after };
}

/** How a run's results went: the requests sent, and the tests passed and failed. */
export function tally(results) {
  const t = { requests: results.length, sent: 0, tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0 };
  for (const r of results) {
    if (r.response) t.sent++;
    if (r.error) t.errors++;
    if (r.skipped) t.skipped++;
    for (const test of r.checks?.tests ?? []) {
      t.tests++;
      if (test.passed) t.passed++;
      else t.failed++;
    }
    if (r.checks?.error) t.errors++;
  }
  return t;
}

/** Whether a run failed: a test failed, a handler broke, a request wasn't sent or got no answer. */
export const runFailed = (results) => {
  const t = tally(results);
  return t.failed > 0 || t.errors > 0 || t.skipped > 0;
};

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The run in one line: "4 requests sent · 6 tests: 5 passed, 1 failed". */
export function summaryLine(results, { stopped = false } = {}) {
  const t = tally(results);
  const parts = [`${plural(t.sent, 'request')} sent`];
  if (t.skipped) parts.push(`${t.skipped} not sent`);
  if (t.tests) parts.push(`${plural(t.tests, 'test')}: ${t.passed} passed${t.failed ? `, ${t.failed} failed` : ''}`);
  else parts.push('no tests');
  if (t.errors) parts.push(plural(t.errors, 'error'));
  if (stopped) parts.push('stopped');
  return parts.join(' · ');
}

/**
 * The report of a run, as lines of segments ({ text, tone }), tone being 'add' (passed), 'del' (failed),
 * 'dim', 'warn' or a status ({ status }). Each request: a mark, its status, its name, how long, its
 * tests; under it the tests that failed, the handler's error, what it logged, and why it wasn't sent.
 * `results`: [{ request, response?, checks?, error?, skipped?, saved? }]; `stopped`: the run stopped
 * early (a request got no answer, or it was cancelled), naming the requests that didn't run.
 */
export function reportLines(results, { left = [], stopped = false } = {}) {
  const out = [];
  for (const r of results) {
    const tests = r.checks?.tests ?? [];
    const failed = tests.filter((x) => !x.passed);
    const bad = r.error || r.skipped || failed.length || r.checks?.error;
    const head = [{ text: bad ? '✗ ' : '✓ ', tone: bad ? 'del' : 'add' }];
    if (r.response) head.push({ text: `${r.response.status} `, status: r.response.status });
    head.push({ text: r.request.label, bold: true });
    if (r.response) head.push({ text: `  ${r.response.ms} ms`, tone: 'dim' });
    if (tests.length) head.push({ text: `  ${failed.length ? `${failed.length} of ${plural(tests.length, 'test')} failed` : `${plural(tests.length, 'test')} passed`}`, tone: failed.length ? 'del' : 'add' });
    if (r.saved) head.push({ text: `  → ${r.saved}`, tone: 'dim' });
    out.push(head);
    for (const x of failed) out.push([{ text: '    ✗ ', tone: 'del' }, { text: x.name }, ...(x.message && x.message !== x.name ? [{ text: `: ${x.message}`, tone: 'dim' }] : [])]);
    if (r.checks?.error) out.push([{ text: '    ✗ ', tone: 'del' }, { text: r.checks.error, tone: 'del' }]);
    if (r.error) out.push([{ text: `    ${r.error}`, tone: 'del' }]);
    if (r.skipped) out.push([{ text: `    Not sent: ${r.skipped}`, tone: 'warn' }]);
    for (const l of r.checks?.log ?? []) out.push([{ text: `    › ${l}`, tone: 'dim' }]);
  }
  for (const request of left) out.push([{ text: '  ', tone: 'dim' }, { text: request.label, tone: 'dim' }, { text: '  not run', tone: 'dim' }]);
  out.push([], [{ text: summaryLine(results, { stopped }), bold: true, tone: runFailed(results) ? 'del' : 'add' }]);
  return out;
}

/** The report as plain text (for the terminal, `hail test`). */
export const reportText = (lines) => lines.map((segs) => segs.map((s) => s.text).join('')).join('\n');
