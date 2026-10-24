// One request's whole exchange after it's filled in: sending it, then running its response handlers
// (checks.js) on what came back. And the report of a run of the whole file (/send all, `hail test`),
// which is pure.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { runChecks } from './checks.js';
import { send } from './send.js';
import { grpcSend } from './grpc.js';
import { parseTimeout } from './transport.js';
import { issueText } from './contract.js';

/**
 * Sends `req` (send.js's prepare), saves its body where `>> path` says, and runs its handlers. Resolves
 * with { response, checks, globals, saved }: `checks` is null without handlers, `globals` the global
 * variables afterwards (from `globals`), `saved` { path, shown } or { error } when `>>` said to save it.
 * `jar` keeps cookies (cookies.js) unless the request says `# @no-cookie-jar`; `# @no-redirect` and
 * `# @timeout 30` are the request's too, and `insecure` (the environment's SSLConfiguration) skips
 * checking certificates; `onStream` is told of an event stream as it comes (send's). Throws what send
 * throws (no answer, cancelled, out of time).
 */
export async function exchange(req, { signal, globals = {}, fetch, jar = null, insecure = false, env, onStream } = {}) {
  const options = req.options ?? {};
  const { raw, ...response } = req.method === 'GRPC' ? await grpcCall(req, { signal, insecure, timeout: parseTimeout(options.timeout) }) : await send(req, {
    signal,
    fetch,
    jar: options['no-cookie-jar'] ? null : jar,
    follow: !options['no-redirect'],
    timeout: parseTimeout(options.timeout),
    insecure,
    env,
    onStream,
  });
  let saved = null;
  if (req.output) {
    try {
      saved = saveBody(raw, req.output);
    } catch (e) {
      saved = { error: `Couldn't save it to ${req.output.shown}: ${e.message}` };
    }
  }
  let checks = null;
  let after = globals;
  if (req.handlers?.length) {
    const r = runChecks(req.handlers, response, { globals });
    checks = { tests: r.tests, log: r.log, error: r.error };
    after = r.globals;
  }
  return { response, checks, globals: after, saved };
}

/** A gRPC call (grpc.js), with its body's bytes as `raw`, as send gives them. */
async function grpcCall(req, opts) {
  const response = await grpcSend(req, opts);
  return { ...response, raw: Buffer.from(response.body) };
}

/** Whether `request` is sent in a run of the whole file (/send all, hail test): a WebSocket is opened on its own. */
export const inRun = (request) => request.method !== 'WEBSOCKET';

/** `path` with -1, -2… before its extension: out.json, out-1.json. */
export function numbered(path, n) {
  if (!n) return path;
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)}-${n}${ext}`;
}

/**
 * Writes a response's body (`bytes`) where `>> path` says (`output`: { path, shown, overwrite }), as
 * JetBrains does: a file that's there already is kept and the body goes to out-1.json, out-2.json…,
 * unless `>>!` says to write over it. Folders on the way are made. Returns { path, shown }.
 */
export function saveBody(bytes, output) {
  let n = 0;
  if (!output.overwrite) while (existsSync(numbered(output.path, n))) n++;
  const path = numbered(output.path, n);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return { path, shown: numbered(output.shown, n) };
}

/** How a run's results went: the requests sent, and the tests passed and failed. */
export function tally(results) {
  const t = { requests: results.length, sent: 0, tests: 0, passed: 0, failed: 0, errors: 0, skipped: 0, drift: 0 };
  for (const r of results) {
    if (r.response) t.sent++;
    if (r.contract?.issues.length) t.drift++;
    if (r.error) t.errors++;
    if (r.skipped) t.skipped++;
    for (const test of r.checks?.tests ?? []) {
      t.tests++;
      if (test.passed) t.passed++;
      else t.failed++;
    }
    if (r.checks?.error) t.errors++;
    if (r.saved?.error) t.errors++;
  }
  return t;
}

/**
 * Whether a run failed: a test failed, a handler broke, a request wasn't sent or got no answer; with
 * `strict`, also a response that drifted from the contract.
 */
export const runFailed = (results, { strict = false } = {}) => {
  const t = tally(results);
  return t.failed > 0 || t.errors > 0 || t.skipped > 0 || (strict && t.drift > 0);
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
  if (t.drift) parts.push(`${t.drift} drifted from the contract`);
  if (stopped) parts.push('stopped');
  return parts.join(' · ');
}

/**
 * The report of a run, as lines of segments ({ text, tone }), tone being 'add' (passed), 'del' (failed),
 * 'dim', 'warn' or a status ({ status }). Each request: a mark, its status, its name, how long, its
 * tests; under it the tests that failed, the handler's error, what it logged, and why it wasn't sent.
 * `results`: [{ request, response?, checks?, error?, skipped?, saved? }]; `stopped`: the run stopped
 * early (a request got no answer, or it was cancelled), naming the requests that didn't run. A result's
 * `contract` (contract.js's checkContract) lists how it drifted, a failure only when `strict`.
 */
export function reportLines(results, { left = [], stopped = false, strict = false } = {}) {
  const out = [];
  for (const r of results) {
    const tests = r.checks?.tests ?? [];
    const failed = tests.filter((x) => !x.passed);
    const drift = r.contract?.issues ?? [];
    const bad = r.error || r.skipped || failed.length || r.checks?.error || (strict && drift.length);
    const head = [{ text: bad ? '✗ ' : '✓ ', tone: bad ? 'del' : 'add' }];
    if (r.response) head.push({ text: `${r.response.status} `, status: r.response.status });
    head.push({ text: r.request.label, bold: true });
    if (r.response) head.push({ text: `  ${r.response.ms} ms`, tone: 'dim' });
    if (tests.length) head.push({ text: `  ${failed.length ? `${failed.length} of ${plural(tests.length, 'test')} failed` : `${plural(tests.length, 'test')} passed`}`, tone: failed.length ? 'del' : 'add' });
    if (r.saved?.shown) head.push({ text: `  → ${r.saved.shown}`, tone: 'dim' });
    if (drift.length) head.push({ text: `  ⚠ ${plural(drift.length, 'difference')} from the contract`, tone: 'warn' });
    out.push(head);
    for (const i of drift) out.push([{ text: `    ${issueText(i)}`, tone: 'warn' }]);
    for (const x of failed) out.push([{ text: '    ✗ ', tone: 'del' }, { text: x.name }, ...(x.message && x.message !== x.name ? [{ text: `: ${x.message}`, tone: 'dim' }] : [])]);
    if (r.checks?.error) out.push([{ text: '    ✗ ', tone: 'del' }, { text: r.checks.error, tone: 'del' }]);
    if (r.error) out.push([{ text: `    ${r.error}`, tone: 'del' }]);
    if (r.saved?.error) out.push([{ text: `    ${r.saved.error}`, tone: 'del' }]);
    if (r.skipped) out.push([{ text: `    Not sent: ${r.skipped}`, tone: 'warn' }]);
    for (const l of r.checks?.log ?? []) out.push([{ text: `    › ${l}`, tone: 'dim' }]);
  }
  for (const request of left) out.push([{ text: '  ', tone: 'dim' }, { text: request.label, tone: 'dim' }, { text: '  not run', tone: 'dim' }]);
  out.push([], [{ text: summaryLine(results, { stopped }), bold: true, tone: runFailed(results, { strict }) ? 'del' : 'add' }]);
  return out;
}

/** The report as plain text (for the terminal, `hail test`). */
export const reportText = (lines) => lines.map((segs) => segs.map((s) => s.text).join('')).join('\n');
