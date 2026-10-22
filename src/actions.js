// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { clip, draftPrompt, parseDraft } from './claude.js';
import { configFile } from './config.js';
import { changedOnly, lineDiff } from './diff.js';
import { writeExample } from './files.js';
import { previousOf } from './history.js';
import { run } from './run.js';
import { formatSize, prepare, prettyBody, send as sendRequest, toCurl } from './send.js';
import { settingRows, settingSegments } from './settings.js';
import { DEFAULT_ACCENT, isColour, setAccent, theme } from './theme.js';

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
 * The request with its variables filled in, or null (and why) when some have no value. A secret
 * that isn't saved yet ({{$secret name}}) is asked for, saved, and the request filled in again.
 */
async function prepared(ctx, request) {
  let req = await prepare(request, ctx.scope(), { dir: ctx.data.dir });
  const unsaved = req.missing.map((m) => /^\$secret\s+(\S+)$/.exec(m)?.[1]).filter(Boolean);
  if (unsaved.length) {
    for (const name of unsaved) if (!(await askForSecret(ctx, name))) return null;
    req = await prepare(request, ctx.scope(), { dir: ctx.data.dir });
  }
  if (!req.missing.length) return req;
  const env = ctx.environment();
  ctx.note(
    `Nothing gives ${req.missing.map((m) => `{{${m}}}`).join(', ')} a value\n${env ? `The environment is ${env}; e picks another.` : 'Pick an environment with e, or set it with @name = value in the file.'}`,
    'error',
  );
  return null;
}

/** ↵ in Requests, and /send: sends it, and shows what came back. */
export async function send(ctx, which) {
  if (!ctx.data) return ctx.note('Open a .http file first: /open <file>, or /new for an example.', 'error');
  const request = typeof which === 'object' && which ? which : requestNamed(ctx, which);
  if (!request) return ctx.note(which ? `There's no request called ${which}.` : 'The file has no requests yet.', 'error');
  const req = await prepared(ctx, request).catch((e) => (ctx.note(e.message, 'error'), null));
  if (!req) return;
  // The secrets in it stay out of the activity lines.
  const shown = req.secrets.reduce((t, v) => t.split(v).join('••••••'), req.url);
  return ctx.task(
    `${req.method} ${shown}`,
    async (signal) => {
      const res = await sendRequest(req, { signal });
      ctx.setResponse(request, req, res);
      return { stdout: `${res.status} ${res.statusText} · ${res.ms} ms · ${formatSize(res.size)}` };
    },
    { label: 'Sending' },
  );
}

/** c in Requests, and /curl: the request, filled in, as a curl command on the clipboard. */
export async function copyCurl(ctx, which) {
  const request = typeof which === 'object' && which ? which : requestNamed(ctx, which);
  if (!request) return ctx.note('Pick a request first.', 'error');
  const req = await prepared(ctx, request).catch((e) => (ctx.note(e.message, 'error'), null));
  if (req) ctx.copy(toCurl(req), 'it as curl');
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

/** A kept response, as the viewer's coloured lines: the request as sent, then what came back. */
export function entryLines(entry) {
  const { request: q, response: r } = entry;
  const out = [
    [{ text: `${q.method} ${q.url}`, bold: true }],
    ...q.headers.map(([k, v]) => [{ text: `${k}: `, color: theme.dim }, { text: v }]),
    ...(q.body ? [[], ...q.body.split('\n').map((l) => [{ text: l }])] : []),
    [],
    [{ text: `${r.status} ${r.statusText}`, bold: true, color: r.status < 400 ? theme.add : theme.del }, { text: `  ${r.ms} ms · ${formatSize(r.size)} · ${new Date(entry.at).toLocaleString()}`, color: theme.dim }],
    ...r.headers.map(([k, v]) => [{ text: `${k}: `, color: theme.dim }, { text: v }]),
    [],
    ...prettyBody(r).split('\n').map((l) => [{ text: l }]),
  ];
  if (r.truncated) out.push([], [{ text: '(cut short: only the first 512 KB is kept)', color: theme.dim }]);
  return out;
}

/** ↵ in History: a kept response in the viewer. */
export function showEntry(ctx, entry) {
  ctx.showText(`${entry.label} · ${new Date(entry.at).toLocaleString()}`, prettyBody(entry.response), { lines: entryLines(entry) });
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
  setAccent(v === 'default' ? DEFAULT_ACCENT : v);
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
  if (row.action === 'accent') return ctx.prefill(`/accent ${ctx.config.accent ?? DEFAULT_ACCENT}`);
  if (row.action === 'clear') {
    const ok = await ctx.confirm({ title: `Clear the prompt history (${row.value})?`, options: YES_NO('Yes, clear it') });
    if (!ok) return;
    ctx.setConfig((c) => ({ ...c, [row.id]: [] }));
    redrawSettings(ctx);
  }
}
