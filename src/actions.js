// Every user-facing operation, written once: keys and slash commands both call these with `ctx`
// (built in ui/App.jsx). Questions before anything destructive belong here too (ctx.confirm).
import { configFile } from './config.js';
import { run } from './run.js';
import { settingRows, settingSegments } from './settings.js';
import { DEFAULT_ACCENT, isColour, setAccent } from './theme.js';

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

/** An item in the viewer: ↵ in Items, or /show <name>. */
export function showItem(ctx, name) {
  const it = typeof name === 'string' ? ctx.data?.items.find((x) => x.name.toLowerCase() === name.trim().toLowerCase()) : name;
  if (!it) return ctx.note(name ? `There's no item called ${name}.` : 'Name an item: /show <item>', 'error');
  ctx.showText(it.name, `${it.kind}\n\n${it.detail}`);
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
