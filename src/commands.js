import * as a from './actions.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'send', args: '[request]', desc: 'Send a request (the one picked in Requests if none is named)', complete: 'requests', run: (ctx, s) => a.send(ctx, s) },
  { name: 'env', args: '[name]', desc: 'The environment the variables come from (a list to pick from if none is named)', complete: 'environments', run: (ctx, s) => a.chooseEnvironment(ctx, s) },
  { name: 'curl', args: '[request]', desc: 'Copy a request, filled in, as a curl command', complete: 'requests', run: (ctx, s) => a.copyCurl(ctx, s) },
  { name: 'open', args: '<file.http>', desc: 'Open another .http file', complete: 'files', run: (ctx, s) => a.open(ctx, s) },
  { name: 'new', args: '[file.http]', desc: 'Write an example .http file to start from (requests.http) and open it', run: (ctx, s) => a.newFile(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Accent colour, mouse, updates, history', run: (ctx) => a.settings(ctx) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Hail now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Hail', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one. */
export function findCommand(name) {
  const n = name.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === n);
  if (exact) return exact;
  const matches = COMMANDS.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, data, files) {
  if (kind === 'requests') return (data?.requests ?? []).map((r) => r.name ?? r.label);
  if (kind === 'environments') return data?.environments.names ?? [];
  if (kind === 'files') return files;
  return [];
}

function ranked(names, query) {
  const q = query.toLowerCase();
  const starts = names.filter((n) => n.toLowerCase().startsWith(q)).sort((x, y) => (x.toLowerCase() === q ? -1 : y.toLowerCase() === q ? 1 : 0));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(q) && n.toLowerCase().includes(q));
  return [...starts, ...contains];
}

/**
 * What to offer under the prompt for `value`: commands while the name is being typed, then the
 * list a command completes its argument from. `insert` replaces the prompt text; `run` means picking
 * it can run straight away.
 */
export function suggestionsFor(value, { data, files = [] } = {}) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  if (space < 0) {
    const names = ranked(COMMANDS.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = COMMANDS.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space));
  const rest = value.slice(space + 1);
  if (!cmd?.complete) return [];
  const names = ranked(completions(cmd.complete, data, files), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
