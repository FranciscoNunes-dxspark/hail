// /load: one request sent many times, so many at once, and how it held up: percentiles, requests per
// second, statuses and errors, and a sparkline of the latency over the run. The run itself takes its
// `sendOne` from actions.js (send.js's send, the request filled in once); the rest is pure.

export const LIMITS = { count: 5000, concurrency: 100 };
export const DEFAULTS = { count: 200, concurrency: 10 };

/**
 * `/load [request] [count] [concurrency]`'s arguments: { name, count, concurrency } or { problem }. The
 * numbers are the last words (count=500 and concurrency=20, or n= and c=, also say which is which);
 * what's before them names the request.
 */
export function parseLoadArgs(rest) {
  const words = String(rest ?? '').trim().split(/\s+/).filter(Boolean);
  const out = { count: null, concurrency: null };
  const plain = [];
  while (words.length) {
    const w = words.at(-1);
    const named = /^(count|n|concurrency|c)=(\S*)$/i.exec(w);
    if (named) {
      const key = /^c(oncurrency)?$/i.test(named[1]) ? 'concurrency' : 'count';
      if (!/^\d+$/.test(named[2])) return { problem: `${named[1]} is a whole number, not "${named[2]}"` };
      out[key] = Number(named[2]);
    } else if (/^\d+$/.test(w) && plain.length < 2) plain.unshift(Number(w));
    else break;
    words.pop();
  }
  // Plain numbers fill count, then concurrency, in the order written, around any given by name.
  for (const n of plain) {
    if (out.count == null) out.count = n;
    else if (out.concurrency == null) out.concurrency = n;
  }
  const count = out.count ?? DEFAULTS.count;
  const concurrency = out.concurrency ?? DEFAULTS.concurrency;
  if (count < 1) return { problem: 'Send it at least once.' };
  if (concurrency < 1) return { problem: 'At least one at a time.' };
  if (count > LIMITS.count) return { problem: `${count.toLocaleString('en')} is too many: /load sends up to ${LIMITS.count.toLocaleString('en')} requests, it isn't a load-testing tool.` };
  if (concurrency > LIMITS.concurrency) return { problem: `${concurrency} at once is too many: up to ${LIMITS.concurrency}.` };
  return { name: words.join(' '), count, concurrency: Math.min(concurrency, count) };
}

/**
 * Sends `count` requests, `concurrency` at a time, through `sendOne(signal)` (resolving with
 * { status, ms }, throwing when there's no answer). `onProgress(results)` hears each one finish.
 * Stops starting new ones when `signal` aborts; those on their way then end as cancelled and aren't
 * counted. Resolves with { results: [{ status?, error?, ms, at }], started, ended, cancelled }, `at`
 * being when it finished, in ms from the start.
 */
export async function runLoad({ count, concurrency, sendOne, signal, onProgress = () => {}, now = () => performance.now() }) {
  const started = now();
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < count && !signal?.aborted) {
      next++;
      const t0 = now();
      try {
        const r = await sendOne(signal);
        results.push({ status: r.status, ms: r.ms ?? Math.round(now() - t0), at: now() - started });
      } catch (e) {
        if (signal?.aborted) return;
        results.push({ error: String(e.message ?? e).split('\n')[0], ms: Math.round(now() - t0), at: now() - started });
      }
      onProgress(results);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, worker));
  return { results, started, ended: now(), cancelled: Boolean(signal?.aborted) };
}

/** The `p`th percentile of sorted numbers (nearest rank). */
export const percentile = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : 0);

const BARS = '▁▂▃▄▅▆▇█';

/** The latencies in the order they finished, as a sparkline `width` bars wide (each the mean of its share). */
export function sparkline(values, width = 40) {
  if (!values.length) return '';
  const n = Math.min(width, values.length);
  const means = [];
  for (let b = 0; b < n; b++) {
    const part = values.slice(Math.floor((b * values.length) / n), Math.floor(((b + 1) * values.length) / n));
    means.push(part.reduce((x, y) => x + y, 0) / part.length);
  }
  const lo = Math.min(...means);
  const hi = Math.max(...means);
  return means.map((m) => BARS[hi === lo ? 0 : Math.round(((m - lo) / (hi - lo)) * (BARS.length - 1))]).join('');
}

/** What a run came to: { finished, answered, failed, statuses, errors, p50, p90, p95, p99, max, mean, rps, seconds, spark }. */
export function loadStats({ results, started, ended }) {
  const answered = results.filter((r) => r.status != null);
  const ms = answered.map((r) => r.ms).sort((a, b) => a - b);
  const statuses = {};
  for (const r of answered) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
  const errors = {};
  for (const r of results) if (r.error) errors[r.error] = (errors[r.error] ?? 0) + 1;
  const seconds = Math.max(0.001, (ended - started) / 1000);
  const byFinish = [...answered].sort((a, b) => a.at - b.at).map((r) => r.ms);
  return {
    finished: results.length,
    answered: answered.length,
    failed: results.length - answered.length,
    statuses,
    errors,
    p50: percentile(ms, 50),
    p90: percentile(ms, 90),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    max: ms.at(-1) ?? 0,
    mean: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
    rps: results.length / seconds,
    seconds,
    spark: sparkline(byFinish),
  };
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;
const rate = (n) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));

/** The run in one line: "200 requests in 3.1 s · 64.5/s · p95 120 ms · 2 errors". */
export function loadSummary(stats, { count, cancelled = false } = {}) {
  const parts = [`${cancelled ? `Stopped: ${stats.finished} of ${count}` : plural(stats.finished, 'request')} in ${stats.seconds.toFixed(1)} s`, `${rate(stats.rps)}/s`];
  if (stats.answered) parts.push(`p50 ${stats.p50} ms`, `p95 ${stats.p95} ms`);
  const bad = stats.failed + Object.entries(stats.statuses).filter(([s]) => Number(s) >= 400).reduce((n, [, c]) => n + c, 0);
  if (bad) parts.push(plural(bad, 'failure'));
  return parts.join(' · ');
}

/**
 * The report as lines of segments ({ text, tone, status?, bold? }), tones as runner.js's report:
 * what was sent, the latencies, the statuses and errors, and the sparkline.
 */
export function loadReport(stats, { label, count, concurrency, cancelled = false }) {
  const out = [];
  out.push([{ text: label, bold: true }, { text: `  ${plural(count, 'request')}, ${concurrency} at a time`, tone: 'dim' }]);
  if (cancelled) out.push([{ text: `Stopped (esc) after ${stats.finished} of ${count}: the report is of those.`, tone: 'warn' }]);
  out.push([]);
  out.push([{ text: 'Took      ', tone: 'dim' }, { text: `${stats.seconds.toFixed(2)} s · ${rate(stats.rps)} requests a second` }]);
  if (stats.answered) {
    out.push([{ text: 'Latency   ', tone: 'dim' }, { text: `p50 ${stats.p50} ms · p90 ${stats.p90} ms · p95 ${stats.p95} ms · p99 ${stats.p99} ms · max ${stats.max} ms · mean ${stats.mean} ms` }]);
    out.push([{ text: 'Over time ', tone: 'dim' }, { text: stats.spark, tone: 'accent' }, { text: '  (each bar the mean of the requests that finished then)', tone: 'dim' }]);
  }
  out.push([]);
  for (const [status, n] of Object.entries(stats.statuses).sort()) out.push([{ text: `${status}`, status: Number(status), bold: true }, { text: `  ${plural(n, 'response')}` }]);
  for (const [error, n] of Object.entries(stats.errors).sort((a, b) => b[1] - a[1])) out.push([{ text: `✗ ${n}× `, tone: 'del', bold: true }, { text: error, tone: 'del' }]);
  out.push([], [{ text: loadSummary(stats, { count, cancelled }), bold: true }]);
  return out;
}
