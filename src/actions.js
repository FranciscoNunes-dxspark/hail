// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { clip, draftPrompt, parseDraft } from './claude.js';
import { configFile } from './config.js';
import { driftSummary, loadContract } from './contract.js';
import { curlToHttp, parseCurl } from './curl.js';
import { KIND_NAMES, importText } from './importers.js';
import { DEFAULT_PORT, routesFor, startMock } from './mock.js';
import { changedOnly, lineDiff } from './diff.js';
import { pathArg, writeExample } from './files.js';
import { previousOf } from './history.js';
import { run } from './run.js';
import { checkSummary } from './checks.js';
import { exchange, inRun, reportLines, runFailed, summaryLine } from './runner.js';
import { openSocket, socketMessages, socketUrl, transcript } from './websocket.js';
import { fill } from './variables.js';
import { loadReport, loadStats, loadSummary, parseLoadArgs, runLoad } from './load.js';
import { GRANT_NAMES, authorizationCode, deviceAuthorization, fillAuthConfig, grantName, readAuthConfig, refreshName } from './oauth.js';
import { formatSize, prepare, prettyBody, send as sendRequest, toCurl } from './send.js';
import { parseTimeout } from './transport.js';
import { nextTheme, settingRows, settingSegments } from './settings.js';
import { applyTheme, defaultAccent, isColour, setAccent, theme } from './theme.js';
import { checkLines, contractLines, statusColour } from './ui/response.js';
import { APP_NAMES, contextIn, copiedNote, describeContext, notMine, projectAt, repoRoot, shareLine, trawlLine } from './family.js';
import { findByRequestId, hostVariable, idsIn, replayBlock, startsWithVariable, rowsJson, rowsRequestBlock, tablePath } from './takes.js';

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

/** Says why filling a request in failed, unless it's been said (a sign-in's own line did); null. */
function failed(ctx, e) {
  if (!e.noted) ctx.note(e.message, 'error');
  return null;
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
async function exchangeFor(ctx, request, req, signal, { live = false } = {}) {
  // An event stream shows as it comes (in the Response view, from Requests), the spinner counting events.
  let first = true;
  const onStream = live
    ? (partial) => {
        if (first && ctx.view() === 'requests') ctx.setView('response');
        first = false;
        ctx.setLiveResponse(request, req, partial);
        ctx.setBusyLabel(`Streaming: ${partial.events} event${partial.events === 1 ? '' : 's'}`);
      }
    : undefined;
  const out = await exchange(req, { signal, globals: ctx.globals(), jar: ctx.cookieJar(), insecure: ctx.environmentOptions().insecure, onStream });
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
  const events = res.stream ? ` · ${res.stream.events} event${res.stream.events === 1 ? '' : 's'}${res.stream.stopped ? ', stopped' : ''}` : '';
  return [`${res.status} ${res.statusText} · ${res.ms} ms · ${formatSize(res.size)}${events}${summary.text ? ` · ${summary.text}` : ''}`, ...(save ? [save] : []), ...failed, ...(checks?.error ? [checks.error] : []), ...drift].join('\n');
}

/** ↵ in Requests, and /send: sends it, and shows what came back. `/send all` sends every one. */
export async function send(ctx, which) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  if (typeof which === 'string' && which.trim().toLowerCase() === 'all' && !ctx.data.requests.some((r) => r.name?.toLowerCase() === 'all')) return sendAll(ctx);
  const request = typeof which === 'object' && which ? which : requestNamed(ctx, which);
  if (!request) return ctx.note(which ? `There's no request called ${which}.` : 'The file has no requests yet.', 'error');
  const req = await prepared(ctx, request).catch((e) => failed(ctx, e));
  if (!req) return;
  // The secrets in it stay out of the activity lines.
  const shown = req.secrets.reduce((t, v) => t.split(v).join('••••••'), req.url);
  if (request.method === 'WEBSOCKET') return openWebSocket(ctx, request, req, shown);
  return ctx.task(
    `${req.method} ${shown}`,
    async (signal) => {
      const out = await exchangeFor(ctx, request, req, signal, { live: true });
      const failed = checkSummary(out.checks).failed;
      const drift = out.contract?.issues.length ?? 0;
      const worried = failed ? `${failed} check${failed === 1 ? '' : 's'} failed` : drift ? `${drift} difference${drift === 1 ? '' : 's'} from the contract` : undefined;
      return { stdout: responseSummary(out), worried };
    },
    { label: 'Sending' },
  );
}

/**
 * ↵ on a WEBSOCKET request: the connection opens in a view of its own, the file's messages go as the
 * server answers, and what's typed there goes too. When it closes, the conversation is kept as the
 * request's response (status 101), in the history too, with the secrets filled in left out.
 */
async function openWebSocket(ctx, request, req, shown) {
  const url = socketUrl(req.url);
  const session = await openSocket({ url, headers: req.headers, messages: socketMessages(req.body), insecure: ctx.environmentOptions().insecure });
  // Typed messages may fill in secrets too; they join the request's, so the history leaves them out.
  session.secrets = req.secrets;
  ctx.showSocket(session, `WEBSOCKET ${socketUrl(shown)}`);
  session.ended.then(() => {
    const body = transcript(session.log);
    ctx.setResponse(request, { ...req, url }, { status: 101, statusText: 'WebSocket', headers: [], body, ms: Date.now() - session.started, size: Buffer.byteLength(body), url });
    const failed = !session.sent && !session.received && session.log.some((m) => m.dir === 'error');
    ctx.note(`WebSocket ${socketUrl(shown)} closed\n${failed ? session.log.find((m) => m.dir === 'error').text : `${session.sent} sent · ${session.received} received`}`, failed ? 'error' : 'info');
  });
  return session;
}

/** ↵ in a WebSocket's view: what was typed, its {{variables}} filled in, sent. */
export async function socketSend(ctx, session, text) {
  const scope = ctx.scope();
  const used = new Set();
  const r = await fill(text, { ...scope, env: { ...scope.env, used } });
  if (r.missing.length) return ctx.note(missingText(ctx, r.missing), 'error');
  // Whatever secret it used stays out of the history, as the request's do.
  session.secrets?.push(...used);
  session.send(r.text);
}

/**
 * A and /send all: every request in the file, top to bottom, each with the variables the ones before
 * it left (their responses, the globals their handlers set). A request with a variable nothing answers
 * is passed over; one that gets no answer stops the run; failed tests don't. The report shows after.
 */
export async function sendAll(ctx) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const requests = ctx.data.requests.filter(inRun);
  if (!requests.length) return ctx.note(ctx.data.requests.length ? 'The file has only WebSockets, which ↵ opens one at a time.' : 'The file has no requests yet.', 'error');
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
  const req = await prepared(ctx, request).catch((e) => failed(ctx, e));
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
  if (!inRun(request)) return ctx.note("A WebSocket isn't something curl sends.", 'error');
  const req = await prepared(ctx, request).catch((e) => failed(ctx, e));
  if (req) ctx.copy(toCurl(req, { dir: ctx.data.dir }), 'it as curl');
}

/**
 * Asks for the secret `name` in a masked field and saves it in the system's store. Resolves with
 * whether it was saved (esc says no).
 */
export async function askForSecret(ctx, name, { replace = false } = {}) {
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

/**
 * /import <file> [--new]: requests from a Postman collection, a HAR recording or an OpenAPI (or Swagger)
 * document, added to the end of the open file through the editor (ctrl+z undoes it), or with --new (or
 * no file open) written to a new .http file beside it and opened. A Postman environment goes into
 * http-client.env.json. Credentials become {{$secret}} placeholders, which is said.
 */
export async function importFrom(ctx, rest) {
  const fresh = /(^|\s)--new(?=\s|$)/.test(rest);
  const arg = pathArg(rest.replace(/(^|\s)--new(?=\s|$)/, ' '));
  if (!arg) return ctx.prefill('/import ');
  const dir = ctx.data?.dir ?? process.cwd();
  const path = resolve(dir, arg);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    return ctx.note(`Couldn't read ${arg}: ${e.code === 'ENOENT' ? "there's no such file" : e.message}`, 'error');
  }
  const env = ctx.environment();
  const taken = new Set(fresh ? [] : [...Object.keys(ctx.data?.variables ?? {}), ...Object.keys(ctx.data?.environments.vars(env) ?? {})]);
  let r;
  try {
    r = importText(text, basename(path), { taken });
  } catch (e) {
    return ctx.note(e.message, 'error');
  }
  const notes = r.notes.length ? `\n${r.notes.join('\n')}` : '';
  if (r.kind === 'postman-env') {
    const envPath = join(dir, 'http-client.env.json');
    let envs = {};
    try {
      envs = JSON.parse(readFileSync(envPath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') return ctx.note(`Couldn't add it to http-client.env.json, which can't be read: ${e.message}`, 'error');
    }
    const { name, vars } = r.environment;
    envs[name] = { ...envs[name], ...vars };
    writeFileSync(envPath, `${JSON.stringify(envs, null, 2)}\n`);
    await ctx.reload();
    ctx.note(`Added the environment ${name} (${Object.keys(vars).length} variable${Object.keys(vars).length === 1 ? '' : 's'}) to http-client.env.json: e picks it${notes}`, 'ok');
    return { kind: r.kind };
  }
  if (!r.requests) return ctx.note(`There are no requests in ${basename(path)}.`, 'error');
  const what = `${r.requests} request${r.requests === 1 ? '' : 's'} from ${basename(path)} (${KIND_NAMES[r.kind]})`;
  if (fresh || !ctx.data) {
    const target = join(dir, `${basename(path).replace(/\.(json|ya?ml|har)$/i, '')}.http`);
    if (existsSync(target)) return ctx.note(`${basename(target)} is there already: /open it and /import ${arg} without --new adds to it.`, 'error');
    writeFileSync(target, r.text);
    await ctx.openFile(target);
    ctx.note(`Imported ${what} into ${basename(target)}${notes}`, 'ok');
  } else {
    const at = ctx.appendRequests(r.text);
    if (at < 0) return;
    ctx.goToRequest(at);
    ctx.note(`Imported ${what} into ${ctx.data.name}: ctrl+z in Edit undoes it${notes}`, 'ok');
  }
  return { kind: r.kind, requests: r.requests };
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
  return ctx.openFile(resolve(pathArg(path)));
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
  if (c.kind === 'rows') return takeRows(ctx, c.data);
  if (c.kind === 'logline') return takeLogline(ctx, c.data);
  return ctx.note(notMine('hail', c), 'error');
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
  if (!hostVar || startsWithVariable(data.url)) return add(false);
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

/**
 * /take rows: rows Trawl copied ({ columns, rows, table? }) as a JSON body (an array of objects, or one
 * object for one row): a new POST request, to {{host}}/<table> when the table is known, or the body of
 * the request under the cursor replaced. Either goes through the editor, so ctrl+z in Edit undoes it.
 */
function takeRows(ctx, data) {
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  if (!Array.isArray(data?.columns) || !Array.isArray(data?.rows) || !data.rows.length) return ctx.note('Those rows are empty.', 'error');
  const n = data.rows.length;
  const what = `${n} row${n === 1 ? '' : 's'}${data.table ? ` of ${data.table}` : ''}`;
  const hostVar = environmentHost(ctx) ?? 'host';
  const sel = ctx.selectedRequest();
  const items = [{ how: 'new', segments: [{ text: 'A new POST request', strong: true }, { text: `  POST {{${hostVar}}}/${tablePath(data.table)}`, color: theme.dim }] }];
  if (sel) items.push({ how: 'replace', segments: [{ text: `The body of ${sel.label}`, strong: true }, { text: '  replaced', color: theme.dim }] });
  ctx.showPicker({
    title: `${what} as a JSON body`,
    hint: '↵ put it there',
    items,
    onPick: (it) => {
      ctx.closeOverlay();
      if (it.how === 'replace') {
        if (!ctx.replaceRequestBody(sel, rowsJson(data))) return;
        ctx.note(`Put ${what} in the body of ${sel.label}: ctrl+z in Edit undoes it`, 'ok');
        return ctx.goToRequest(sel.index);
      }
      const at = ctx.appendRequests(rowsRequestBlock(data, { hostVar }));
      if (at < 0) return;
      ctx.goToRequest(at);
      ctx.note(`Added a POST of ${what} to ${ctx.data.name}: ctrl+z in Edit undoes it`, 'ok');
    },
  });
}

/**
 * /take logline: a log line Bosun copied, found in the History by its request id (`requestId`, else the
 * ids in its text): the newest response whose request or response headers carry it (X-Request-Id,
 * Request-Id, traceparent, correlation ids), shown with the cursor on it.
 */
function takeLogline(ctx, data) {
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  const ids = data?.requestId ? [String(data.requestId)] : idsIn(data?.text);
  if (!ids.length) return ctx.note(`That log line has no request id to look for: ${String(data?.text ?? '').slice(0, 80)}`, 'error');
  const found = findByRequestId(ctx.history(), ids);
  if (!found) return ctx.note(`No response kept for ${ctx.data.name} carries ${ids.join(' or ')}.\nHistory keeps the newest 300; the request may have come from somewhere else.`, 'error');
  ctx.showHistoryEntry(found.entry);
  ctx.note(`${found.entry.label}, ${new Date(found.entry.at).toLocaleString()}: its ${found.header} is ${ids.length === 1 ? ids[0] : 'the one in the log line'}`, 'ok');
}

/**
 * What this project offers the sibling apps, as the command lines to paste into them: { app, line, what }.
 * From the open file's folder and its checkout: Splice opens the checkout, Bosun runs the project when
 * it has something to run, Trawl connects to each database its settings name.
 */
export function familyOffers(dir) {
  const root = repoRoot(dir);
  const projects = [projectAt(dir), ...(root && root !== dir ? [projectAt(root)] : [])];
  const out = [];
  if (root) out.push({ app: 'splice', line: shareLine('open', [root]), what: 'the checkout' });
  const crew = projects.find((p) => p.crew);
  if (crew) out.push({ app: 'bosun', line: shareLine('move', [crew.dir]), what: 'run the project' });
  const seen = new Set();
  for (const db of projects.flatMap((p) => p.databases)) {
    const key = [db.kind, db.server, db.port, db.database].join('|').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ app: 'trawl', line: trawlLine(db, db.name), what: `${db.name} (${db.source})` });
  }
  return out;
}

/** /family: what this project offers the siblings, to pick from; ↵ copies its command line. */
export function family(ctx) {
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  const offers = familyOffers(ctx.data.dir);
  if (!offers.length) return ctx.note(`Nothing here for the sibling apps: ${ctx.data.dir} isn't in a git checkout, has nothing for Bosun to run, and names no databases.`);
  ctx.showPicker({
    title: 'For the sibling apps',
    hint: '↵ copy the command for it',
    items: offers.map((o) => ({ ...o, segments: [{ text: APP_NAMES[o.app].padEnd(7), color: theme.accent, bold: true }, { text: `${o.what}  `, strong: true }, { text: o.line, color: theme.dim }] })),
    onPick: (o) => {
      ctx.copy(o.line, `a command for ${APP_NAMES[o.app]}`);
      ctx.note(copiedNote(o.app, o.line), 'ok');
    },
  });
}


// ---------------------------------------------------------------------------------------------------
// OAuth 2 (oauth.js): {{$auth.token("id")}} and /auth.

/** The OAuth configs of the environment picked, by id ("Security": { "Auth": { … } }). */
const authConfigs = (ctx) => ctx.data?.environments.auth?.(ctx.environment()) ?? {};

/** Where `id`'s token is kept: in memory (`key`) and its refresh token in the store (`store`). */
const authKeys = (ctx, id) => ({ key: `${ctx.data.path}\n${ctx.environment() ?? ''}\n${id}`, store: refreshName(ctx.data.path, ctx.environment(), id) });

/**
 * The auth `id` of the environment picked, its variables filled in and read (oauth.js's readAuthConfig).
 * A {{$secret}} in it (a Client Secret) that isn't saved yet is asked for, as a request's would be.
 */
async function authConfig(ctx, id) {
  const raw = authConfigs(ctx)[id];
  const env = ctx.environment();
  if (!raw) throw new Error(`There's no auth called ${id} in ${env ? `the ${env} environment` : 'the environments'}: "Security": { "Auth": { "${id}": { … } } } in http-client.env.json`);
  let filled = await fillAuthConfig(raw, ctx.scope());
  const unsaved = filled.missing.map((m) => /^\$secret\s+(\S+)$/.exec(m)?.[1]).filter(Boolean);
  if (unsaved.length) {
    for (const name of unsaved) if (!(await askForSecret(ctx, name))) throw new Error(`The secret ${name} the auth ${id} needs wasn't given.`);
    filled = await fillAuthConfig(raw, ctx.scope());
  }
  if (filled.missing.length) throw new Error(`The auth ${id} uses ${filled.missing.map((m) => `{{${m}}}`).join(', ')}, which nothing gives a value`);
  return readAuthConfig(id, filled.raw);
}

/** {{$auth.token("id")}} and {{$auth.idToken("id")}}: the token, signing in (or refreshing) when there's none. */
export async function authToken(ctx, kind, id) {
  if (!ctx.data) throw new Error(NO_FILE);
  const cfg = await authConfig(ctx, id);
  return ctx.tokens.get({ ...authKeys(ctx, id), cfg, kind, interactive: (c) => interactiveSignIn(ctx, c) });
}

/** A sign-in that needs a person (Authorization Code, Device Authorization), with the spinner: esc cancels. */
function interactiveSignIn(ctx, cfg) {
  const how = cfg.grant === 'code' ? codeSignIn : deviceSignIn;
  return ctx.withSignal(`Sign in: ${cfg.id} (${GRANT_NAMES[cfg.grant]})`, (signal) => how(ctx, cfg, signal), { label: 'Signing in', done: `Signed in with ${cfg.id}` });
}

/** Authorization Code: the browser opens on the sign-in page, and its address is said in case it didn't. */
function codeSignIn(ctx, cfg, signal) {
  return authorizationCode(cfg, { signal, openUrl: ctx.openUrl, onUrl: (url) => ctx.note(`Signing in with ${cfg.id} in the browser. If it didn't open, go to:\n${url}`) });
}

/**
 * Device Authorization: the code and where to enter it in the confirm area (↵ opens the page, or copies
 * the code) while Hail polls; it goes when the sign-in is done, and esc (or Cancel) stops it.
 */
async function deviceSignIn(ctx, cfg, signal) {
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let shown = null;
  let over = false;
  const show = async (c) => {
    while (!over) {
      shown = ctx.notice({
        title: `Enter ${c.userCode} at ${c.verificationUri} to sign in with ${cfg.id}`,
        detail: 'Hail carries on by itself once you have · esc cancels',
        options: [
          { label: 'Open the page in the browser', value: 'open' },
          { label: 'Copy the code', value: 'copy' },
          { label: 'Cancel', value: false },
        ],
      });
      const v = await shown.answer;
      if (v === 'closed' || over) return;
      if (v === 'open') await Promise.resolve(ctx.openUrl?.(c.verificationUriComplete ?? c.verificationUri)).catch(() => {});
      else if (v === 'copy') ctx.copy(c.userCode, 'the code');
      else return stop.abort();
    }
  };
  try {
    return await deviceAuthorization(cfg, { signal: stop.signal, onCode: (c) => void show(c) });
  } finally {
    over = true;
    shown?.close();
    signal?.removeEventListener('abort', onAbort);
  }
}

/** How `id` stands, in words (never its token): signed in and for how long, a refresh token kept, or not. */
async function authStatus(ctx, id) {
  const { key, store } = authKeys(ctx, id);
  const s = await ctx.tokens.status(key, store);
  if (s.signedIn) return s.expiresAt ? `signed in, the token runs out in ${Math.max(1, Math.round((s.expiresAt - Date.now()) / 60_000))} min` : 'signed in';
  return s.refresh ? 'not signed in; a refresh token is kept, so the next use refreshes it' : 'not signed in';
}

/** Signs in with `id` now (`again`: forgetting what's kept first), and says how it stands. */
async function signInNow(ctx, id, { again = false } = {}) {
  if (again) await ctx.tokens.forget(...Object.values(authKeys(ctx, id)));
  try {
    await authToken(ctx, 'token', id);
  } catch (e) {
    return failed(ctx, e);
  }
  ctx.note(`${id}: ${await authStatus(ctx, id)}`, 'ok');
}

/**
 * /auth [id|clear]: the OAuth sign-ins of the environment picked and how each stands (↵ signs in again,
 * x forgets it); `/auth <id>` signs in with one (if it isn't already) and says how it stands; `clear`
 * forgets every token, and the refresh tokens kept, for this file and environment.
 */
export async function auth(ctx, rest) {
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  const arg = rest.trim();
  const ids = Object.keys(authConfigs(ctx));
  const env = ctx.environment();
  const where = `${ctx.data.name}${env ? ` in ${env}` : ''}`;
  if (!ids.length) return ctx.note(`No OAuth sign-ins for ${where}: an environment's "Security": { "Auth": { "<id>": { "Type": "OAuth2", "Grant Type": … } } } in http-client.env.json makes one, and {{$auth.token("<id>")}} uses it.`);
  if (arg === 'clear') {
    for (const id of ids) await ctx.tokens.forget(...Object.values(authKeys(ctx, id)));
    return ctx.note(`Forgot the tokens for ${where} (${ids.join(', ')}), and their refresh tokens in ${ctx.credentials.name}`);
  }
  if (arg) {
    const id = ids.find((i) => i.toLowerCase() === arg.toLowerCase());
    if (!id) return ctx.note(`There's no auth called ${arg} for ${where}. There are: ${ids.join(', ')}`, 'error');
    return signInNow(ctx, id);
  }
  ctx.showPicker({
    title: `Sign-ins: ${where}`,
    hint: '↵ sign in again · x forget it',
    load: async () => Promise.all(ids.map(async (id) => ({ id, segments: [{ text: id, strong: true }, { text: `  ${grantName(authConfigs(ctx)[id])}`, color: theme.dim }, { text: `  ${await authStatus(ctx, id)}`, color: theme.dim }] }))),
    onPick: (it) => {
      ctx.closeOverlay();
      signInNow(ctx, it.id, { again: true });
    },
    keys: {
      x: async (it) => {
        await ctx.tokens.forget(...Object.values(authKeys(ctx, it.id)));
        ctx.closeOverlay();
        ctx.note(`Forgot the token for ${it.id}, and its refresh token`);
      },
    },
  });
}

// ---------------------------------------------------------------------------------------------------
// /mock (mock.js): the file's kept responses served on this machine.

/** What the mock serves now: the open file's requests with responses kept, then the contract's examples. */
const mockRoutes = (ctx) =>
  ctx.data ? routesFor({ requests: ctx.data.requests, entries: ctx.history(), vars: { ...ctx.data.variables, ...ctx.data.environments.vars(ctx.environment()) }, spec: ctx.contract().spec }) : [];

/**
 * /mock [port|off]: starts the mock (on 4010 unless a port is given), or stops it when it's running.
 * It serves each request's latest kept response at its method and path, following the history as it
 * grows, and the contract's examples where the file has none; each request it gets is a line in the Log.
 */
export async function mock(ctx, rest) {
  const arg = rest.trim();
  const cur = ctx.mockServer();
  if (arg === 'off' || (!arg && cur)) {
    if (!cur) return ctx.note('The mock isn\'t running.');
    await cur.close();
    ctx.setMockServer(null);
    return ctx.note(`Stopped the mock on port ${cur.port}`);
  }
  if (!ctx.data) return ctx.note(NO_FILE, 'error');
  if (arg && (!/^\d+$/.test(arg) || Number(arg) > 65535)) return ctx.note('/mock takes a port number (4010 unless given), or off.', 'error');
  const port = arg ? Number(arg) : DEFAULT_PORT;
  if (cur) {
    if (cur.port === port) return ctx.note(`The mock is running on http://127.0.0.1:${port}; /mock stops it.`);
    await cur.close();
    ctx.setMockServer(null);
  }
  let server;
  try {
    server = await startMock({
      port,
      routes: () => mockRoutes(ctx),
      onHit: (h) => ctx.note(`mock ${h.method} ${h.path} → ${h.status}${h.label ? `  ${h.label}` : '  (nothing kept for it)'}`),
    });
  } catch (e) {
    return ctx.note(`Couldn't start the mock: ${e.message}`, 'error');
  }
  ctx.setMockServer(server);
  const routes = mockRoutes(ctx);
  const fromContract = routes.filter((r) => r.source === 'contract').length;
  ctx.note(
    `Mock of ${ctx.data.name} on http://127.0.0.1:${server.port}: ${routes.length} route${routes.length === 1 ? '' : 's'}${fromContract ? ` (${fromContract} from the contract)` : ''}${routes.length ? '' : ', none yet: send the requests and their responses are served'}\n${routes.map((r) => `${r.method} ${r.template}  ${r.label}`).join('\n')}`,
    'ok',
  );
  return server;
}
