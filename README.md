<p align="center"><img src="assets/logo.svg" width="120" alt="Pip, the Hail seabird"></p>

# Hail

An HTTP client for the terminal, over .http files.

A keyboard-driven terminal app, a sibling of Splice and Trawl: the same prompt, help window, mouse,
settings and self-updating builds.

> Started from [slipway](https://github.com/FranciscoNunes-dxspark/slipway). The Items view and its data
> (`src/source.js`) are placeholders, there to be replaced by what Hail is really for.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/hail/releases/latest)
and put it on your PATH. It checks for a new version once a day and installs it by itself; the new
version starts the next time you open Hail.

From a checkout (Node 22 or later):

```bash
npm install
npm start
```

## Keys

| Key | What it does |
| --- | --- |
| `1` `2` / `tab` | Items, Log (`shift+tab` goes back) |
| `/` or `:` | The command prompt, with completion |
| `!` | Run a shell command, e.g. `!node --version` |
| `r` | Refresh |
| `esc` | Cancel the running command, or clear the activity lines |
| `,` | Settings |
| `?` | Every key and command |
| `q` / `ctrl+c` | Quit |

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page, `y`
copies, `↵` opens. The mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll
with the wheel, and drag to select text, which is copied when you let go.

## Commands

| Command | What it does |
| --- | --- |
| `/show <item>` | Show an item |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Accent colour, mouse, updates, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

## Settings

`,` or `/settings`. They're kept in `~/.hail/config.json` (`HAIL_HOME` moves it).

| Setting | |
| --- | --- |
| Accent colour | The colour of the cursor, borders and the pet |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Prompt history | Clear it |
