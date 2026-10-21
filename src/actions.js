// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { basename, resolve } from 'node:path';
import { configFile } from './config.js';
import { writeExample } from './files.js';
import { run } from './run.js';
import { formatSize, prepare, send as sendRequest, toCurl } from './send.js';
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

/** The request with its variables filled in, or null (and why) when some have no value. */
async function prepared(ctx, request) {
  const req = await prepare(request, ctx.scope(), { dir: ctx.data.dir });
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
  return ctx.task(
    `${req.method} ${req.url}`,
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
