import * as a from './actions.js';

// Slash commands. `args` in square brackets are optional, so picking the command runs it straight away.
// `complete` names the list offered while typing the first argument.
export const COMMANDS = [
  { name: 'send', args: '[request|all]', desc: 'Send a request (the one picked in Requests if none is named); all sends every one, top to bottom, and shows a report', complete: 'requests', run: (ctx, s) => a.send(ctx, s) },
  { name: 'env', args: '[name]', desc: 'The environment the variables come from (a list to pick from if none is named)', complete: 'environments', run: (ctx, s) => a.chooseEnvironment(ctx, s) },
  { name: 'curl', args: '[request]', desc: 'Copy a request, filled in, as a curl command', complete: 'requests', run: (ctx, s) => a.copyCurl(ctx, s) },
  { name: 'import-curl', args: '<curl command>', desc: 'Add a request to the file from a curl command (a browser\'s Copy as cURL, from any shell)', run: (ctx, s) => a.importCurl(ctx, s) },
  { name: 'contract', args: '[openapi file|url|off]', desc: 'Check every response against an OpenAPI or Swagger document (remembered for the file; off forgets it, nothing says which)', run: (ctx, s) => a.contract(ctx, s) },
  { name: 'find', args: '<text>', desc: 'Find text in the file, in the Edit view (n and N go on to the next and the one before)', run: (ctx, s) => ctx.findInEditor(s) },
  { name: 'open', args: '<file.http>', desc: 'Open another .http file', complete: 'files', run: (ctx, s) => a.open(ctx, s) },
  { name: 'new', args: '[file.http]', desc: 'Write an example .http file to start from (requests.http) and open it', run: (ctx, s) => a.newFile(ctx, s) },
  { name: 'secret', args: '[name]', desc: 'Save a secret in the system\'s store for {{$secret name}} (the saved ones, to replace or forget, if none is named)', run: (ctx, s) => a.secret(ctx, s) },
  { name: 'cookies', args: '[clear]', desc: 'The cookies kept for this file and environment (clear forgets them)', run: (ctx, s) => a.cookies(ctx, s) },
  { name: 'history', args: '[clear]', desc: 'The responses kept for this file (clear forgets them)', run: (ctx, s) => (s.trim() === 'clear' ? a.clearHistory(ctx) : ctx.setView('history')) },
  { name: 'draft', args: '<openapi.json|url|file> [what to write]', desc: 'Claude writes requests from an API description, for you to look over and add to the file', run: (ctx, s) => a.draft(ctx, s) },
  { name: 'run', args: '<command>', desc: 'Run a shell command (as ! does)', run: (ctx, s) => a.raw(ctx, s) },
  { name: 'last', desc: 'All the output of the last command', run: (ctx) => ctx.showLast() },
  { name: 'settings', desc: 'Accent colour, theme, mouse, updates, notifications, history', run: (ctx) => a.settings(ctx) },
  { name: 'accent', args: '<#rrggbb>', desc: 'Change the accent colour (default puts it back)', run: (ctx, s) => a.accent(ctx, s) },
  { name: 'update', desc: 'Look for a new version of Hail now and install it', run: (ctx) => ctx.updateNow() },
  { name: 'help', desc: 'Keys and commands', run: (ctx) => ctx.showHelp() },
  { name: 'quit', desc: 'Exit Hail', run: (ctx) => ctx.quit() },
];

/** Exact name, or an unambiguous prefix of one; `user` are your own commands (usercommands.js), after the built-in ones. */
export function findCommand(name, user = []) {
  const n = name.toLowerCase();
  const all = [...COMMANDS, ...user];
  const exact = all.find((c) => c.name === n);
  if (exact) return exact;
  const matches = all.filter((c) => c.name.startsWith(n));
  return matches.length === 1 ? matches[0] : null;
}

function completions(kind, data, files) {
  if (kind === 'requests') return [...(data?.requests ?? []).map((r) => r.name ?? r.label), ...(data?.requests?.length ? ['all'] : [])];
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
export function suggestionsFor(value, { data, files = [], user = [] } = {}) {
  if (!value.startsWith('/')) return [];
  const space = value.indexOf(' ');
  const all = [...COMMANDS, ...user];
  if (space < 0) {
    const names = ranked(all.map((c) => c.name), value.slice(1));
    return names.slice(0, 7).map((name) => {
      const c = all.find((x) => x.name === name);
      const optional = !c.args || c.args.startsWith('[');
      return { label: `/${c.name}`, hint: c.args ?? '', desc: c.desc, insert: `/${c.name}${optional ? '' : ' '}`, run: optional };
    });
  }
  const cmd = findCommand(value.slice(1, space), user);
  const rest = value.slice(space + 1);
  if (!cmd?.complete) return [];
  const names = ranked(completions(cmd.complete, data, files), rest);
  if (names.length === 1 && names[0] === rest) return [];
  return names.slice(0, 7).map((n) => ({ label: n, insert: `/${cmd.name} ${n}`, run: true }));
}
