# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

An HTTP client for the terminal, over .http files. Hail is a keyboard-driven terminal app built with Ink (React for the terminal) on Node 22+. It was started from slipway, and it's a sibling of Splice (a git client) and Trawl (a SQL client). Plain JavaScript ES modules with `.jsx` for components; no TypeScript, no linter config. The README is the user-facing spec; when behaviour changes, update it too.

The shared kit, `scripts/shared-check.js`'s `SHARED` list (`text.js`, `ui/parts.jsx`, `ui/hooks.js`, `mouse.js`, `selection.js`, `clipboard.js`, `jsx-hooks.js`, `register.js`, `version.js`, `help-layout.js`, `ui/HelpView.jsx`, `keymap.js`, `usercommands.js`, `palette.js`, `ui/Palette.jsx`, `run.js`, `credentials.js`, `claude-cli.js`, `scripts/build.js` and itself), is the same as Splice's and Trawl's apart from the apps' names. `node scripts/shared-check.js ../splice [--diff]` reports drift and exits with 1 on it. Keep them the same: a change to one goes into the siblings too, and anything only Hail needs lives in its own file.

## Commands

```bash
npm test                                                       # whole suite (node:test)
node --import ./src/register.js --test test/units.test.js      # one file
node --import ./src/register.js --test --test-name-pattern="settings" test/*.test.js   # tests matching a name
npm start                                                      # run from the checkout (needs a real TTY)
npm run build                                                  # Bun-compiled executable for this machine → dist/
node scripts/logo.js                                           # regenerate assets/ from src/pet.js
node scripts/shared-check.js ../splice [--diff]                # drift in the files shared with a sibling app
```

`--import ./src/register.js` is required whenever Node loads `.jsx`: it installs a module hook (`src/jsx-hooks.js`) that compiles `.jsx` with esbuild on import. There is no dev build step. CI runs `npm test` on Linux and Windows, so path handling and line endings must work on both (`.gitattributes` forces LF).

`patches/ink+6.8.0.patch` (applied by `patch-package` on `npm install`) keeps Ink's width and tokenize caches from one frame to the next, as in the siblings; it about halves the cost of a keystroke. Upgrading Ink means checking `build/output.js` still has `OutputCaches` and remaking the patch (`npx patch-package ink`).

Releases are automatic: every push to main (except Markdown-only ones) runs the Release workflow, which publishes the latest release's version with the patch raised, or `package.json`'s version when that's higher. Compiled builds get the version via `process.env.HAIL_VERSION` (defined by `scripts/build.js`), which also sets `COMPILED`; from a checkout `src/version.js` reads `package.json`, and the update check is skipped.

## Architecture

- **`src/http-file.js`**: parsing `.http` files (VS Code's REST Client and JetBrains' HTTP Client format) into `{ variables, requests }`, pure. A request's `label` (its name, else method and URL) is how responses are kept.
- **`src/variables.js`**: filling in `{{...}}`, pure apart from the built-ins, whose clock, randomness, process environment and `$azToken` come in through `env` so tests fix them. The environment wins over the file's `@variables`; `name.response.body.path` reads earlier responses by request name.
- **`src/environments.js`**: `http-client.env.json` and `http-client.private.env.json` beside the file, `$shared` in each.
- **`src/send.js`**: `prepare` (variables filled in, a body file read), `send` (through `fetch`, which App doesn't stub: tests run a server on 127.0.0.1), `networkError` (fetch's "fetch failed" in words), `prettyBody`, `toCurl`.
- **`src/files.js`**: `loadHttpFile` (what `App`'s `load` prop defaults to: the parsed file and its environments), finding `.http` files, and `/new`'s example. `App` watches the file's folder and reloads when it or an env file changes.
- **`src/credentials.js`**: Trawl's credential store with Hail's names (Credential Manager through PowerShell, `security`, `secret-tool`; secrets on stdin, never argv except macOS). `{{$secret name}}` reads it; `actions.js` `prepared` asks for a missing one (`ctx.askSecret`, the masked `SecretPrompt` from `parts.jsx`) and saves it. The config keeps the names only. App takes it as the `credentials` prop; tests pass `memoryCredentials()`.
- **`src/history.js`**: every response, one JSON line, in `~/.hail/history/<hash of the file's path>.jsonl`. `entryFor` blanks the secret values `prepare` reports in `secrets` (from `$secret` and `$azToken`) everywhere and hides credential headers, so nothing secret reaches the disk; keep it that way for anything new that's filled in from a secret. `App` restores the latest response per request label when a file opens. `src/diff.js` compares two for History's `d`.
- **`src/claude.js`**: `/draft` through `claude -p`, run by the family's shared `claude-cli.js` (no MCP, no settings, no tools). `draftPrompt` and `parseDraft` are pure; App takes `ask` as the `askClaude` prop from `cli.jsx`, and tests stub it.
- **`src/search.js`**: Splice's viewer search (`matcher`, `markRanges`), for the Response view's `/`. A view that takes keys the app would otherwise use sets `ctx.claimsKey(input, key)`; App's dispatcher skips its own keys when it returns true (the Response view clears it when it unmounts).
- **`src/azure.js`**: `{{$azToken}}` through the Azure CLI, as Trawl and Keel get tokens; App takes it as the `azToken` prop.
- **`src/run.js`**: the only place another program is started. Nothing it starts has a terminal, so nothing may wait on a prompt; an abort kills the whole tree (`taskkill /T` on Windows).
- **`src/actions.js`**: every user-facing operation, written once. Keys and slash commands call these with `ctx`. Questions before anything destructive live here (`ctx.confirm({ ..., danger: true })`).
- **`src/commands.js`**: the slash-command table (`name`, `args`, `desc`, optional `complete`, `run(ctx, rest)`) and completion. Args in `[brackets]` are optional, so picking the command runs it at once.
- **`src/ui/App.jsx`**: layout, focus, the prompt, overlays, the activity log and **`ctx`**: a stable object exposing `data` and `config` (getters), `task` (a visible, cancellable job with the spinner), `note`, `confirm`, `prefill`, `showText`, `showPicker`, `copy`, `setConfig`. Read the `Object.assign(ctx, {...})` block before adding an action.
- **`src/ui/*View.jsx`**: one component per tab: Requests (the list, and beside it the request or its response, drawn by `ui/response.js`), Response (the whole width, with search), History (the kept responses), Log. Views must check `ctx.viewHasKeys()` (or `ctx.overlayHasKeys()` in overlays) at the start of their `useInput` handlers. `useListNav` in `src/ui/hooks.js` is the shared cursor and scroll logic.
- **Mouse** (`src/mouse.js`, `src/selection.js`; Splice's `docs/mouse.md` has the design): `terminalMouse` strips mouse reports out of stdin before Ink sees them and hands them to `App` as the `mouse` prop; tests pass a fake (`test/clicks.test.js`). Components register with `useMouse(ctx, handler)`; a view's rows start one line under its panel's top border. Views name their `useInput` handler `keys` so a double-click can call `keys('', { return: true })`.
- **Updates** (`src/update.js`): once a day, GitHub's releases API, then `gh api` while the repository is private. A newer release is installed in the background next to the executable, checked against `SHA256SUMS.txt`. Release file names must match `TARGETS` in `scripts/build.js`. `cli.jsx` passes `checkUpdate` and `installUpdate` only in compiled builds.
- **Config** (`src/config.js`): `~/.hail/config.json`, overridable with `HAIL_HOME` (tests use it). Change it only through `ctx.setConfig`: `App` saves its whole copy. A new setting is a row in `src/settings.js` plus the README's Settings section.
- **Theme and text**: one palette in `src/theme.js`; use `BULLET` instead of `⏺`, and `src/text.js` (`fit`, `wrap`, `stringWidth`) for width-aware truncation, never `.length`.
- **Hoot** (`src/pet.js`, `src/ui/Pet.jsx`): the mascot's pixel art and mood. `assets/` is generated from it by `scripts/logo.js`; don't hand-edit those files.

## Tests

`test/app.test.js` and `test/clicks.test.js` are end-to-end: they write a `.http` file into a temporary folder, start an HTTP server on 127.0.0.1, render `<App>` with `ink-testing-library`, type keys into stdin and assert on `lastFrame()`; nothing reaches the internet. `test/http.test.js` covers the format, variables, environments and sending; `test/keeping.test.js` secrets, history, diffs and drafts; `test/features.test.js` drives those through the UI. Use `until(check, what)` from `test/helpers.js` to wait for frames rather than fixed sleeps. `test/units.test.js` covers commands, help, settings, the pet and the updater.

## Keeping things in sync

Adding or changing a key or command touches several places: the handler (view or `App.jsx`), `src/commands.js` for slash commands, the `?` window's sections in `src/help.js`, and the tables in `README.md`. Commit messages are short sentences describing the change, without type prefixes.
