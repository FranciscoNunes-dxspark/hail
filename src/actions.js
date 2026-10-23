// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { clip, draftPrompt, parseDraft } from './claude.js';
import { configFile } from './config.js';
import { driftSummary, loadContract } from './contract.js';
import { curlToHttp, parseCurl } from './curl.js';
import { changedOnly, lineDiff } from './diff.js';
import { writeExample } from './files.js';
import { previousOf } from './history.js';
import { run } from './run.js';
import { checkSummary } from './checks.js';
import { exchange, reportLines, runFailed, summaryLine } from './runner.js';
import { loadReport, loadStats, loadSummary, parseLoadArgs, runLoad } from './load.js';
import { formatSize, prepare, prettyBody, send as sendRequest, toCurl } from './send.js';
import { parseTimeout } from './transport.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { checkLines, contractLines, statusColour } from './ui/response.js';
import { contextIn, describeContext } from './family.js';
import { OWNERS, hostVariable, replayBlock } from './takes.js';

const YES_NO = (yes) => [
  { label: yes, value: true },
  { label: 'No', value: false },
];

/** ! and /run: a shell command, with the spinner, esc to cancel and its output in the activity lines. */
export function raw(ctx, command) {
  const text = command.trim();
  if (!text) return ctx.note('Type a command after !, e.g. !node --version', 'error');
  return ctx.task(text, (signal) => run(text, { signal }), { label: 'Running' });
}

/** A request by its name or label (what /send and /curl are given), or the one picked in Requests. */
function requestNamed(ctx, name) {
  const requests = ctx.data?.requests ?? [];
  const n = name?.trim().toLowerCase();
  if (!n) return ctx.selectedRequest();
  return requests.find((r) => r.name?.toLowerCase() === n) ?? requests.find((r) => r.label.toLowerCase() === n) ?? requests.find((r) => r.label.toLowerCase().includes(n));
}

/**
 * The request with its variables filled in, or null when a secret it needs was asked for and not
 * given. A secret that isn't saved yet ({{$secret name}}) is asked for, saved, and the request filled
 * in again. `missing` on what it returns lists the variables nothing gave a value.
 */
async function fillRequest(ctx, request) {
  let req = await prepare(request, ctx.scope(), { dir: ctx.data.dir });
  const unsaved = req.missing.map((m) => /^\$secret\s+(\S+)$/.exec(m)?.[1]).filter(Boolean);
  if (unsaved.length) {
    for (const name of unsaved) if (!(await askForSecret(ctx, name))) return null;
    req = await prepare(request, ctx.scope(), { dir: ctx.data.dir });
  }
  return req;
}

/** Why a request with variables nothing answers isn't sent, in words. */
function missingText(ctx, missing) {
  const env = ctx.environment();
  return `Nothing gives ${missing.map((m) => `{{${m}}}`).join(', ')} a value\n${env ? `The environment is ${env}; e picks another.` : 'Pick an environment with e, or set it with @name = value in the file.'}`;
}

/** The request with its variables filled in, or null (and why) when some have no value. */
async function prepared(ctx, request) {
  const req = await fillRequest(ctx, request);
  if (!req) return null;
  if (!req.missing.length) return req;
  ctx.note(missingText(ctx, req.missing), 'error');
  return null;
}

/** Sends a filled-in request with what the session holds for it, and keeps what came back. */
async function exchangeFor(ctx, request, req, signal) {
  const out = await exchange(req, { signal, globals: ctx.globals(), jar: ctx.cookieJar(), insecure: ctx.environmentOptions().insecure });
  ctx.setGlobals(out.globals);
  ctx.setResponse(request, req, out.response, { checks: out.checks, saved: out.saved });
  return { ...out, contract: ctx.contractFor({ request: req, response: out.response }) ?? undefined };
}

/** What a response says in the activity lines: its status, time and size, and how its tests went. */
function responseSummary({ response: res, checks, saved, contract }) {
  const summary = checkSummary(checks);
  const drift = contract?.issues.length ? [`⚠ ${driftSummary(contract)}`] : [];
  const failed = (checks?.tests ?? []).filter((t) => !t.passed).map((t) => `✗ ${t.name}`);
  const save = saved?.error ?? (saved ? `Saved to ${saved.shown}` : null);
  return [`${res.status} ${res.statusText} · ${res.ms} ms · ${formatSize(res.size)}${summary.text ? ` · ${summary.text}` : ''}`, ...(save ? [save] : []), ...failed, ...(checks?.error ? [checks.error] : []), ...drift].join('\n');
}

/** ↵ in Requests, and /send: sends it, and shows what came back. `/send all` sends every one. */
export async function send(ctx, which) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  if (typeof which === 'string' && which.trim().toLowerCase() === 'all' && !ctx.data.requests.some((r) => r.name?.toLowerCase() === 'all')) return sendAll(ctx);
  const request = typeof which === 'object' && which ? which : requestNamed(ctx, which);
  if (!request) return ctx.note(which ? `There's no request called ${which}.` : 'The file has no requests yet.', 'error');
  const req = await prepared(ctx, request).catch((e) => (ctx.note(e.message, 'error'), null));
  if (!req) return;
  // The secrets in it stay out of the activity lines.
  const shown = req.secrets.reduce((t, v) => t.split(v).join('••••••'), req.url);
  return ctx.task(`${req.method} ${shown}`, async (signal) => ({ stdout: responseSummary(await exchangeFor(ctx, request, req, signal)) }), { label: 'Sending' });
}

/**
 * A and /send all: every request in the file, top to bottom, each with the variables the ones before
 * it left (their responses, the globals their handlers set). A request with a variable nothing answers
 * is passed over; one that gets no answer stops the run; failed tests don't. The report shows after.
 */
export async function sendAll(ctx) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const requests = ctx.data.requests;
  if (!requests.length) return ctx.note('The file has no requests yet.', 'error');
  const results = [];
  let stopped = false;
  const done = await ctx.task(
    `Send all ${requests.length} request${requests.length === 1 ? '' : 's'} in ${ctx.data.name}`,
    async (signal) => {
      for (const request of requests) {
        if (signal.aborted) throw Object.assign(new Error('Cancelled'), { cancelled: true });
        let req;
        try {
          req = await fillRequest(ctx, request);
        } catch (e) {
          results.push({ request, skipped: e.message });
          continue;
        }
        if (!req) {
          results.push({ request, skipped: 'a secret it needs wasn\'t given' });
          continue;
        }
        if (req.missing.length) {
          results.push({ request, skipped: `nothing gives ${req.missing.map((m) => `{{${m}}}`).join(', ')} a value` });
          continue;
        }
        try {
          results.push({ request, ...(await exchangeFor(ctx, request, req, signal)) });
        } catch (e) {
          if (e.cancelled) throw e;
          results.push({ request, error: e.message });
          stopped = true;
          break;
        }
      }
      const text = summaryLine(results, { stopped });
      if (runFailed(results)) throw new Error(text);
      return { stdout: text };
    },
    { label: 'Sending all' },
  );
  if (!results.length) return;
  const cancelled = done.error?.cancelled;
  const left = requests.slice(results.length);
  const lines = reportLines(results, { left, stopped: stopped || cancelled });
  ctx.showText(`Sent all: ${ctx.data.name}${ctx.environment() ? ` · ${ctx.environment()}` : ''}`, lines.map((segs) => segs.map((x) => x.text).join('')).join('\n'), { lines: toned(lines) });
}

/** A report's lines (runner.js's or load.js's segments, by tone) in the viewer's colours. */
const toned = (lines) => {
  const tones = { add: theme.add, del: theme.del, dim: theme.dim, warn: theme.warn, accent: theme.accent };
  return lines.map((segs) => segs.map(({ text, tone, status, bold }) => ({ text, bold, color: status ? statusColour(status) : tones[tone] })));
};

/**
 * /load [request] [count] [concurrency] (L in Requests): the request, its variables filled in once, sent
 * `count` times, `concurrency` at a time, through the same send as ↵ but without the cookie jar, its
 * response handlers or >> saving, and nothing kept in the history. The spinner counts them; esc stops it
 * and reports what finished. Up to 5,000 requests, 100 at a time.
 */
export async function load(ctx, rest) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const args = parseLoadArgs(rest);
  if (args.problem) return ctx.note(args.problem, 'error');
  const request = requestNamed(ctx, args.name);
  if (!request) return ctx.note(args.name ? `There's no request called ${args.name}.` : 'The file has no requests yet.', 'error');
  const req = await prepared(ctx, request).catch((e) => (ctx.note(e.message, 'error'), null));
  if (!req) return;
  const { count, concurrency } = args;
  const options = req.options ?? {};
  const insecure = ctx.environmentOptions().insecure;
  let run = null;
  let shownAt = 0;
  const done = await ctx.task(
    `Load ${request.label}: ${count} × ${concurrency} at a time`,
    async (signal) => {
      run = await runLoad({
        count,
        concurrency,
        signal,
        sendOne: (s) => sendRequest(req, { signal: s, jar: null, follow: !options['no-redirect'], timeout: parseTimeout(options.timeout), insecure }),
        onProgress: (results) => {
          // The spinner says how far it's got, at most ten times a second.
          if (Date.now() - shownAt < 100 && results.length < count) return;
          shownAt = Date.now();
          const errors = results.filter((r) => r.error).length;
          ctx.setBusyLabel(`Load: ${results.length}/${count}${errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}`);
        },
      });
      return { stdout: loadSummary(loadStats(run), { count, cancelled: run.cancelled }) };
    },
    { label: `Load: 0/${count}` },
  );
  if (!done.ok || !run?.results.length) return;
  const stats = loadStats(run);
  const lines = loadReport(stats, { label: `${req.method} ${request.label}`, count, concurrency, cancelled: run.cancelled });
  ctx.showText(`Load: ${request.label}`, lines.map((segs) => segs.map((x) => x.text).join('')).join('\n'), { lines: toned(lines) });
  return { stats };
}

/** c in Requests, and /curl: the request, filled in, as a curl command on the clipboard. */
export async function copyCurl(ctx, which) {
  const request = typeof which === 'object' && which ? which : requestNamed(ctx, which);
  if (!request) return ctx.note('Pick a request first.', 'error');
  const req = await prepared(ctx, request).catch((e) => (ctx.note(e.message, 'error'), null));
  if (req) ctx.copy(toCurl(req, { dir: ctx.data.dir }), 'it as curl');
}

/**
 * Asks for the secret `name` in a masked field and saves it in the system's store. Resolves with
 * whether it was saved (esc says no).
 */
async function askForSecret(ctx, name, { replace = false } = {}) {
  const store = ctx.credentials;
  const answer = await ctx.askSecret({
    title: `${replace ? 'A new value for' : 'The value of'} the secret ${name}`,
    detail: `Kept in ${store.name}, never in a file; {{$secret ${name}}} reads it. esc cancels.`,
  });
  if (!answer?.value) return false;
  try {
    await store.set(name, { user: name, password: answer.value });
  } catch (e) {
    ctx.note(`Couldn't save ${name}: ${e.message}`, 'error');
    return false;
  }
  ctx.setConfig((c) => ({ ...c, secrets: [...new Set([...(c.secrets ?? []), name])].sort() }));
  ctx.note(`Saved the secret ${name} in ${store.name}`, 'ok');
  return true;
}

/** /secret <name>: saves (or replaces) a secret; with no name, the ones saved so far, to replace or forget. */
export async function secret(ctx, name) {
  const n = name.trim();
  if (n) {
    if (!/^[\w.-]+$/.test(n)) return ctx.note('A secret\'s name is letters, digits, dots, dashes and underscores.', 'error');
    return askForSecret(ctx, n, { replace: (ctx.config.secrets ?? []).includes(n) });
  }
  const names = ctx.config.secrets ?? [];
  if (!names.length) return ctx.note('No secrets saved yet. /secret <name> saves one; {{$secret <name>}} in a request reads it.');
  ctx.showPicker({
    title: 'Secrets',
    hint: '↵ replace · x forget',
    items: () => (ctx.config.secrets ?? []).map((n) => ({ name: n, segments: [{ text: n, strong: true }, { text: `  {{$secret ${n}}}`, color: theme.dim }] })),
    onPick: (it) => askForSecret(ctx, it.name, { replace: true }),
    keys: {
      x: async (it) => {
        const ok = await ctx.confirm({ title: `Forget the secret ${it.name}?`, detail: `It's removed from ${ctx.credentials.name}.`, danger: true, options: YES_NO('Yes, forget it') });
        if (!ok) return;
        await ctx.credentials.remove(it.name);
        ctx.setConfig((c) => ({ ...c, secrets: (c.secrets ?? []).filter((x) => x !== it.name) }));
        ctx.closeOverlay();
        ctx.note(`Forgot the secret ${it.name}`);
      },
    },
  });
}

/** A kept response, as the viewer's coloured lines: the request as sent, then what came back (and how it compares with `contract`). */
export function entryLines(entry, contract = null) {
  const { request: q, response: r } = entry;
  const out = [
    [{ text: `${q.method} ${q.url}`, bold: true }],
    ...q.headers.map(([k, v]) => [{ text: `${k}: `, color: theme.dim }, { text: v }]),
    ...(q.body ? [[], ...q.body.split('\n').map((l) => [{ text: l }])] : []),
    [],
    [{ text: `${r.status} ${r.statusText}`, bold: true, color: r.status < 400 ? theme.add : theme.del }, { text: `  ${r.ms} ms · ${formatSize(r.size)} · ${new Date(entry.at).toLocaleString()}`, color: theme.dim }],
    ...(entry.saved ? [[{ text: entry.saved.error ?? `Saved to ${entry.saved.shown}`, color: entry.saved.error ? theme.del : theme.dim }]] : []),
    ...checkLines(entry.checks),
    ...contractLines(contract),
    ...r.headers.map(([k, v]) => [{ text: `${k}: `, color: theme.dim }, { text: v }]),
    [],
    ...prettyBody(r).split('\n').map((l) => [{ text: l }]),
  ];
  if (r.truncated) out.push([], [{ text: '(cut short: only the first 512 KB is kept)', color: theme.dim }]);
  return out;
}

/** ↵ in History: a kept response in the viewer. */
export function showEntry(ctx, entry) {
  ctx.showText(`${entry.label} · ${new Date(entry.at).toLocaleString()}`, prettyBody(entry.response), { lines: entryLines(entry, ctx.contractFor?.(entry)) });
}

/** d in History: how a response differs from the one before it to the same request. */
export function diffEntry(ctx, entry) {
  const before = previousOf(ctx.history(), entry);
  if (!before) return ctx.note(`That's the first response to ${entry.label} kept: nothing to compare it with.`);
  const a = `${before.response.status} ${before.response.statusText}\n\n${prettyBody(before.response)}`;
  const b = `${entry.response.status} ${entry.response.statusText}\n\n${prettyBody(entry.response)}`;
  const diff = changedOnly(lineDiff(a, b));
  const same = diff.every(([m]) => m === ' ');
  const colour = { '-': theme.del, '+': theme.add, '…': theme.dim };
  const lines = same ? [[{ text: 'The same status and body as the one before.', color: theme.dim }]] : diff.map(([m, l]) => [{ text: m === '…' ? '…' : `${m} ${l}`, color: colour[m] }]);
  ctx.showText(`${entry.label}: ${new Date(before.at).toLocaleString()} → ${new Date(entry.at).toLocaleString()}`, diff.map(([m, l]) => `${m} ${l}`).join('\n'), { lines });
}

/** D in History and /history clear: forgets what's been kept for the open file. */
export async function clearHistory(ctx) {
  const n = ctx.history().length;
  if (!n) return ctx.note('Nothing kept for this file yet.');
  const ok = await ctx.confirm({ title: `Forget the ${n} response${n === 1 ? '' : 's'} kept for ${ctx.data.name}?`, danger: true, options: YES_NO('Yes, forget them') });
  if (ok) ctx.clearHistory();
}

/**
 * /draft <spec> [what to write]: Claude writes requests from an OpenAPI document (a file or a URL),
 * or any text describing an API, shows them, and adds them to the open file once you say so (a new
 * requests.http when none is open).
 */
export async function draft(ctx, rest) {
  const [, from, want] = /^(\S+)\s*([\s\S]*)$/.exec(rest.trim()) ?? [];
  if (!from) return ctx.note('Name the description: /draft <openapi.json, a URL, or routes.js> [what to write]', 'error');
  if (!ctx.askClaude) return ctx.note('Claude isn\'t available here.', 'error');
  const d = ctx.data;
  const target = d?.path ?? resolve('requests.http');
  let answer;
  const done = await ctx.task(
    `Claude drafts requests from ${from}`,
    async (signal) => {
      const spec = /^https?:\/\//.test(from) ? await (await fetch(from, { signal })).text() : await readFile(resolve(d?.dir ?? '.', from), 'utf8');
      const prompt = draftPrompt({
        want: want.trim(),
        variables: Object.keys(d?.variables ?? {}),
        environment: d ? Object.keys(d.environments.vars(ctx.environment())) : [],
        labels: (d?.requests ?? []).map((r) => r.label),
      });
      answer = parseDraft(await ctx.askClaude(prompt, { input: clip(spec), cwd: d?.dir, signal }));
      return { stdout: `${answer.requests.length} request${answer.requests.length === 1 ? '' : 's'}: ${answer.requests.map((r) => r.label).slice(0, 4).join(', ')}${answer.requests.length > 4 ? '…' : ''}` };
    },
    { label: 'Claude is writing' },
  );
  if (!done.ok) return;
  ctx.showText(`Claude's draft: ${answer.requests.length} request${answer.requests.length === 1 ? '' : 's'}`, answer.text);
  const ok = await ctx.confirm({ title: `Add ${answer.requests.length === 1 ? 'it' : `these ${answer.requests.length}`} to ${basename(target)}?`, detail: 'Look them over above first; you can edit the file afterwards.', options: YES_NO('Yes, add them') });
  ctx.closeOverlay();
  if (!ok) return;
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  appendFileSync(target, `${before && !before.endsWith('\n') ? '\n' : ''}${before ? '\n' : ''}${answer.text}`);
  if (!d) await ctx.openFile(target);
  else await ctx.reload();
  ctx.note(`Added ${answer.requests.length} request${answer.requests.length === 1 ? '' : 's'} to ${basename(target)}`, 'ok');
}

/**
 * /import-curl <command> (I in Requests): a curl command line, as a browser's "Copy as cURL" gives it in
 * any shell, added to the end of the file as a request named after its method and path, and picked.
 */
export async function importCurl(ctx, text) {
  if (!text.trim()) return ctx.prefill('/import-curl ');
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  let parsed;
  try {
    parsed = parseCurl(text);
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const block = curlToHttp(parsed);
  const at = ctx.appendRequests(block);
  if (at < 0) return;
  ctx.goToRequest(at);
  const title = block.split('\n')[0].replace(/^###\s*/, '');
  const left = parsed.ignored.length ? `\nLeft out: ${parsed.ignored.join(', ')}${parsed.ignored.includes('-k') ? ' (an environment\'s "SSLConfiguration": { "verifyHostCertificate": false } skips checking certificates)' : ''}` : '';
  ctx.note(`Added ${title} to ${ctx.data.name}${left}`, 'ok');
}

/** /cookies [clear]: the cookies kept for this file and environment, or forgets them. */
export function cookies(ctx, rest) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const jar = ctx.cookieJar();
  const env = ctx.environment();
  const where = `${ctx.data.name}${env ? ` in ${env}` : ''}`;
  if (rest.trim() === 'clear') {
    const n = jar.clear();
    return ctx.note(n ? `Forgot the ${n} cookie${n === 1 ? '' : 's'} kept for ${where}` : `No cookies kept for ${where}.`);
  }
  if (rest.trim()) return ctx.note('/cookies shows them; /cookies clear forgets them.', 'error');
  const list = jar.list();
  if (!list.length) return ctx.note(`No cookies kept for ${where} yet: a response's Set-Cookie puts them here.`);
  const lines = [];
  let site = null;
  for (const c of list) {
    if (c.domain !== site) {
      if (site !== null) lines.push([]);
      site = c.domain;
      lines.push([{ text: `${c.hostOnly ? '' : '.'}${c.domain}`, bold: true, color: theme.accent }]);
    }
    const flags = [c.path, c.expires === null ? 'until Hail closes' : `until ${new Date(c.expires).toLocaleString()}`, c.secure ? 'https only' : '', c.httpOnly ? 'HttpOnly' : ''].filter(Boolean).join(' · ');
    lines.push([{ text: `  ${c.name}`, bold: true }, { text: `=${c.value}` }, { text: `  ${flags}`, color: theme.dim }]);
  }
  ctx.showText(`Cookies: ${where} · ${list.length}`, list.map((c) => `${c.domain}\t${c.path}\t${c.name}=${c.value}`).join('\n'), { lines });
}

/**
 * /contract <openapi file or URL>: every response to the open file's requests is checked against it
 * from now on (remembered for the file); `off` forgets it; nothing says which it is.
 */
export async function contract(ctx, rest) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const arg = rest.trim();
  const cur = ctx.contract();
  const name = ctx.data.name;
  if (!arg) {
    if (!cur.source) return ctx.note(`${name} has no contract. /contract <openapi.json, openapi.yaml or a URL> checks every response against it.`);
    if (cur.error) return ctx.note(`${name}'s contract, ${cur.source}, couldn't be read: ${cur.error}`, 'error');
    return ctx.note(`${name} is checked against ${cur.source}${cur.spec ? ` (${cur.operations} operations)` : ''}. /contract off forgets it.`);
  }
  if (arg === 'off') {
    if (!cur.source) return ctx.note(`${name} has no contract to forget.`);
    ctx.setContract(null);
    return ctx.note(`${name}'s responses aren't checked against ${cur.source} any more`);
  }
  const source = /^https?:\/\//i.test(arg) ? arg : resolve(ctx.data.dir, arg);
  return ctx.task(
    `Contract ${arg}`,
    async (signal) => {
      const c = await loadContract(source, { dir: ctx.data.dir, signal });
      ctx.setContract(source, c);
      return { stdout: `${c.operations} operation${c.operations === 1 ? '' : 's'}: every response to ${name}'s requests is checked against it` };
    },
    { label: 'Reading the contract' },
  );
}

/** e and /env: the environment the variables come from, named or picked from a list. */
export function chooseEnvironment(ctx, name) {
  const names = ctx.data?.environments.names ?? [];
  if (!names.length) return ctx.note('No environments: put an http-client.env.json beside the file, e.g. { "dev": { "host": "http://localhost:3000" } }', 'error');
  if (name?.trim()) {
    const n = names.find((x) => x.toLowerCase() === name.trim().toLowerCase());
    if (!n) return ctx.note(`There's no environment called ${name.trim()}. There are: ${names.join(', ')}`, 'error');
    return ctx.setEnvironment(n);
  }
  const current = ctx.environment();
  ctx.showPicker({
    title: 'Environment',
    index: Math.max(0, names.indexOf(current)),
    items: names.map((n) => ({ name: n, segments: [{ text: n === current ? '● ' : '  ', color: theme.accent }, { text: n, strong: true }] })),
    onPick: (it) => {
      ctx.setEnvironment(it.name);
      ctx.closeOverlay();
    },
  });
}

/** /open: another .http file. */
export async function open(ctx, path) {
  if (!path.trim()) return ctx.prefill('/open ');
  return ctx.openFile(resolve(path.trim()));
}

/** /new: writes an example .http file (requests.http unless named) and opens it. */
export async function newFile(ctx, path) {
  const file = resolve(path.trim() || 'requests.http');
  if (!writeExample(file)) return ctx.note(`${basename(file)} is there already; /open ${path.trim() || 'requests.http'} opens it.`, 'error');
  ctx.note(`Wrote ${basename(file)}, an example to start from`, 'ok');
  return ctx.openFile(file);
}

/** /accent: a new accent colour, or `default` for the one Hail comes with. */
export function accent(ctx, value) {
  const v = value.trim();
  if (v !== 'default' && !isColour(v)) return ctx.note('An accent is a colour like #5fafff (or default).', 'error');
  ctx.setConfig((c) => {
    const { accent: _, ...rest } = c;
    return v === 'default' ? rest : { ...c, accent: v };
  });
  setAccent(v === 'default' ? null : v);
  redrawSettings(ctx);
}

/** , and /settings: every setting in a list; ↵ changes the one under the cursor. */
export function settings(ctx, { replace = false, index } = {}) {
  ctx.showPicker(
    {
      title: 'Settings',
      index,
      items: () => settingRows(ctx.config, { file: configFile(), mouse: ctx.mouseAvailable }).map((row) => ({ row, segments: settingSegments(row) })),
      redraw: (at) => settings(ctx, { replace: true, index: at }),
      onPick: (it) => changeSetting(ctx, it.row),
    },
    { replace },
  );
}

/** Shows the settings again after a change, if they're what's on screen. */
export function redrawSettings(ctx) {
  const o = ctx.overlay();
  if (o?.redraw) o.redraw(o.index);
}

async function changeSetting(ctx, row) {
  if (row.action === 'toggle') {
    ctx.setConfig((c) => ({ ...c, [row.id]: c[row.id] === false }));
    return redrawSettings(ctx);
  }
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? defaultAccent()}`);
  if (row.action === 'theme') {
    ctx.setConfig((c) => ({ ...c, theme: nextTheme(c) }));
    applyTheme(ctx.config);
    return redrawSettings(ctx);
  }
  if (row.action === 'clear') {
    const ok = await ctx.confirm({ title: `Clear the prompt history (${row.value})?`, options: YES_NO('Yes, clear it') });
    if (!ok) return;
    ctx.setConfig((c) => ({ ...c, [row.id]: [] }));
    redrawSettings(ctx);
  }
}

/**
 * /take <context> (or a context pasted bare): what a sibling app copied for Hail. A request (Sonar's
 * logs) is replayed, rows (Trawl) become a body, a log line (Bosun) is found in the history by its
 * request id; the other kinds are another app's.
 */
export async function take(ctx, rest) {
  const text = String(rest ?? '').trim();
  if (!text) return ctx.note('Paste what a sibling app copied for Hail: /take family:v1:…', 'error');
  const c = contextIn(text);
  if (!c) return ctx.note("That isn't something a sibling app copied (they start family:v1:).", 'error');
  if (c.kind === 'request') return takeRequest(ctx, c.data);
  const owner = OWNERS[c.kind];
  return ctx.note(`That's for ${owner ?? 'another app'}: paste it into ${owner ?? 'its'}'s prompt (${describeContext(c)}).`, 'error');
}

const NO_FILE = 'Open a .http file first: /open <file>, or /new for an example.';

/** The variable the picked environment names the API's address with ({{host}}, {{baseUrl}}), or null. */
const environmentHost = (ctx) => hostVariable(ctx.data?.environments.vars(ctx.environment()) ?? {});

/**
 * /take request: a request (Sonar copies them from its logs and incidents) added to the end of the file
 * as `### replay <METHOD> <path>` and picked, ready to send. When the environment says where the API is
 * ({{host}}, {{baseUrl}}), it's asked whether to send it there or to where it came from.
 */
async function takeRequest(ctx, data) {
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  if (!data?.url) return ctx.note('That request has no URL.', 'error');
  const hostVar = environmentHost(ctx);
  const add = (useHost) => {
    const { block, dropped } = replayBlock(data, { hostVar: useHost ? hostVar : null });
    const at = ctx.appendRequests(block);
    if (at < 0) return;
    ctx.goToRequest(at);
    const title = block.split('\n')[0].replace(/^###\s*/, '');
    ctx.note(`Added ${title} to ${ctx.data.name}: ↵ sends it${dropped.length ? `\nLeft out ${dropped.join(', ')}: credentials don't travel between apps` : ''}`, 'ok');
  };
  if (!hostVar) return add(false);
  const env = ctx.environment();
  let origin;
  try {
    origin = new URL(data.url).origin;
  } catch {
    origin = data.url;
  }
  ctx.showPicker({
    title: `Replay ${String(data.method ?? 'GET').toUpperCase()} ${data.url}`,
    hint: '↵ add it',
    items: [
      { useHost: true, segments: [{ text: `To ${env ?? 'the environment'}`, strong: true }, { text: `  {{${hostVar}}} = ${ctx.data.environments.vars(env)[hostVar]}`, color: theme.dim }] },
      { useHost: false, segments: [{ text: 'As it came', strong: true }, { text: `  ${origin}`, color: theme.dim }] },
    ],
    onPick: (it) => {
      ctx.closeOverlay();
      add(it.useHost);
    },
  });
}
