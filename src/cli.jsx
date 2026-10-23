import React from 'react';
import { render } from 'ink';
import { resolve } from 'node:path';
import { COMPILED, VERSION } from './version.js';
import { loadConfig } from './config.js';
import { setAccent } from './theme.js';
import { App } from './ui/App.jsx';
import { findHttpFiles } from './files.js';
import { ask } from './claude.js';
import { checkForUpdate, installUpdate, removeOldExecutables } from './update.js';
import { copyToClipboard } from './clipboard.js';
import { terminalMouse } from './mouse.js';

const args = process.argv.slice(2);

// hail test api.http [--env dev]: every request without the UI, for CI.
if (args[0] === 'test') {
  const { runTests } = await import('./headless.js');
  const { osCredentials } = await import('./credentials.js');
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const code = await runTests(args.slice(1), { credentials: osCredentials, color });
  // Everything written gets out before exiting, piped or not (pipes are asynchronous on Windows).
  await new Promise((r) => process.stdout.write('', r));
  await new Promise((r) => process.stderr.write('', r));
  process.exit(code);
}

if (args.includes('-v') || args.includes('--version')) {
  console.log(`hail ${VERSION}`);
  process.exit(0);
}

if (args.includes('-h') || args.includes('--help')) {
  console.log(`hail [file.http]
hail test [file.http] [--env <name>]

An HTTP client for the terminal, over .http files. Opens [file.http], or the
first .http file in the current folder (or the folders under it).

hail test sends every request in the file without the UI, prints a report of
their response handlers' tests, and exits with 1 if anything failed.

Inside: ↵ sends the request under the cursor, e picks the environment,
? shows every key, / the commands.`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('hail needs an interactive terminal.');
  process.exit(1);
}

const config = loadConfig();
setAccent(config.accent);

// Draw on the alternate screen, like a full-screen app, and give the terminal back untouched on exit.
// The window title is saved on the terminal's title stack and popped on exit. Terminals without one
// (Windows Terminal) take an empty title as "back to the default" instead.
process.stdout.write('\x1b[?1049h\x1b[H\x1b[22;0t');
process.on('exit', () => process.stdout.write('\x1b]0;\x07\x1b[23;0t\x1b[?1049l'));
const setTitle = (title) => process.stdout.write(`\x1b]0;${title.replace(/[\x00-\x1f\x7f]/g, '')}\x07`);

// Only the downloaded executables look for updates and install them: a checkout updates with git pull,
// and its package.json version is behind the releases (the Release workflow sets the version as it builds).
const checkUpdate = COMPILED ? checkForUpdate : undefined;
// What an earlier update moved aside; quietly, and it doesn't hold up the start.
if (COMPILED) removeOldExecutables();
// Clicks and the wheel, where the terminal can report them; App turns reporting on unless the setting is off.
// Set up before rendering, so mouse reports never reach Ink as keys.
const mouse = await terminalMouse(process.stdin, process.stdout);
// y copies: to the system clipboard, or through the terminal (OSC 52) over SSH or when that fails.
const copy = (text) => copyToClipboard(text);
const given = args.find((x) => !x.startsWith('-'));
const file = given ? resolve(given) : findHttpFiles(process.cwd()).map((f) => resolve(f))[0];
const app = render(
  <App config={config} initialFile={file} askClaude={ask} checkUpdate={checkUpdate} installUpdate={COMPILED ? installUpdate : undefined} setTitle={setTitle} mouse={mouse} copy={copy} />,
  // Through the mouse's stdout, which watches the frames to select text from.
  { exitOnCtrlC: false, stdout: mouse?.stdout ?? process.stdout },
);
await app.waitUntilExit();
process.exit(0);
