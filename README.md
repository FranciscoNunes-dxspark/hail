<p align="center"><img src="assets/logo.svg" width="120" alt="Pip, the Hail owl"></p>

# Hail

An HTTP client for the terminal, over `.http` files: the format VS Code's REST Client and JetBrains'
HTTP Client already read, so the requests live in the repository next to the code and work in all
three. Open a file, pick a request, press `↵`.

A sibling of [Splice](https://github.com/FranciscoNunes-dxspark/splice) and
[Trawl](https://github.com/FranciscoNunes-dxspark/trawl): the same prompt, help window, mouse,
settings and self-updating builds.

## Install

Download the build for your platform from the [latest release](https://github.com/FranciscoNunes-dxspark/hail/releases/latest)
and put it on your PATH. It checks for a new version once a day and installs it by itself; the new
version starts the next time you open Hail.

From a checkout (Node 22 or later):

```bash
npm install
npm start -- api.http
```

## Use

```bash
hail api.http     # that file
hail              # the first .http (or .rest) file in this folder or the two below it
```

With none, `/new` writes an example to start from.

```http
@host = https://api.example.com

### Log in
# @name login
POST {{host}}/login
Content-Type: application/json

{ "user": "ana", "password": "{{password}}" }

### Who am I
GET {{host}}/me
Authorization: Bearer {{login.response.body.token}}
```

`###` starts a request, and the rest of its line names it. Under it: the method and URL (a plain URL is
a GET), the headers, a blank line, and the body. A body can come from a file: `< ./body.json` as it is,
`<@ ./body.json` with its variables filled in. Query lines under the URL (`?page=2`, `&size=10`) are
joined onto it. JetBrains' response handlers (`> {% ... %}`) are skipped.

Hail reads the file again whenever it's saved, so it can sit beside your editor.

### Variables

`{{name}}` in the URL, the headers or the body. Values come from, first to last:

| Where | |
| --- | --- |
| The environment | `http-client.env.json` beside the file: `{ "dev": { "host": "http://localhost:3000" }, "prod": { ... } }`, with `"$shared"` going into every one. `http-client.private.env.json` beside it goes over it, for secrets kept out of git. `e` picks the environment; Hail starts on one called dev or local and remembers the choice for each file |
| The file | `@name = value` lines |
| Earlier responses | `{{login.response.body.token}}` is the `token` field of what the request named `login` (`# @name login`) got back; a path like `data.items[0].id` (or `$.data…`) reaches further in, `.headers.X-Request-Id` reads a header |
| Secrets | `{{$secret api-key}}`: kept in the system's own credential store (Windows Credential Manager, the macOS Keychain, the Secret Service keyring on Linux), never in a file. The first request that needs one asks for it in a hidden field and saves it; `/secret <name>` saves or replaces one, `/secret` lists them to replace or forget |
| Built-ins | `{{$uuid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt 1 100}}`, `{{$processEnv NAME}}` or `{{$env.NAME}}` (this computer's environment), `{{$azToken [resource]}}` (a token from the Azure CLI's sign-in, Azure Resource Manager's unless a resource is named) |

A secret can sit in an environment file too (`"apiKey": "{{$secret prod-api-key}}"`), so the file can
be committed. The environment wins over the file, so a file can hold defaults that environments override. A
variable can be made of others. A request with a variable nothing gives a value isn't sent: Hail
says which.

### History

Every response is kept, across runs, in `~/.hail/history` (one file per `.http` file). When a file is
opened, each request's last response is there again, so its variables work before anything is sent.
The History tab lists them newest first: `↵` shows one, `d` compares it with the response before it to
the same request, `D` forgets them all. What's kept leaves out the secrets and Azure tokens that were
filled in, wherever they turn up (the server's answer too), and hides the headers that carry
credentials (`Authorization`, `Cookie`, `Set-Cookie`, API keys and anything named like a token or
password). Bodies over 512 KB are cut. The newest 300 responses per file are kept.

### Claude drafts requests

`/draft <openapi.json, a URL, or any file> [what to write]` hands an API description to Claude (through
Claude Code, signed in as you are) and asks for requests in this format: a name for each, path
parameters and auth as variables, example bodies, and the file's own variables used rather than
declared again. The draft shows first; it's added to the open file only once you say yes (a new
`requests.http` if none is open). The description can be an OpenAPI or Swagger document, or the code
that defines the routes.

```
/draft openapi.json the order endpoints
/draft https://petstore3.swagger.io/api/v3/openapi.json
/draft ../server/routes.js
```

## Keys

| Key | What it does |
| --- | --- |
| `1` `2` `3` `4` / `tab` | Requests, Response, History, Log (`shift+tab` goes back) |
| `↵` | Send the request under the cursor; in Response, send it again |
| `c` | Copy the request as a curl command, variables filled in |
| `y` | Copy the request's URL; in Response, the body |
| `v` | The response, the whole width |
| `h` | In Response: show or hide the headers |
| `/` then `n` `N` | In Response: search the response (matches show as you type; a capital letter makes it match case), then go from match to match; `esc` clears it |
| `d` `D` | In History: compare with the response before it · forget them all |
| `e` | Pick the environment |
| `r` | Read the file again |
| `/` or `:` | The command prompt, with completion |
| `!` | Run a shell command, e.g. `!node --version` |
| `esc` | Cancel the request on its way, or clear the activity lines |
| `,` | Settings |
| `?` | Every key and command |
| `q` / `ctrl+c` | Quit |

In lists: `j` `k` or the arrows move, `g` `G` go to the top and bottom, `ctrl+d` `ctrl+u` page. The
mouse works too: click a tab, a row or the prompt, double-click for `↵`, scroll with the wheel, and
drag to select text, which is copied when you let go.

Beside the list is the request under the cursor as written, or, once it's been sent, its response:
the status, how long it took, its size, and the body, JSON indented.

## Commands

| Command | What it does |
| --- | --- |
| `/send [request]` | Send a request by name (the one under the cursor if none is named) |
| `/env [name]` | The environment the variables come from (a list to pick from if none is named) |
| `/curl [request]` | Copy a request, filled in, as a curl command |
| `/open <file.http>` | Open another file |
| `/secret [name]` | Save a secret in the system's store for `{{$secret name}}` (the saved ones, to replace or forget, if none is named) |
| `/history [clear]` | The responses kept for this file (`clear` forgets them) |
| `/draft <spec> [what]` | Claude writes requests from an API description, for you to look over and add |
| `/new [file.http]` | Write an example file to start from (`requests.http`) and open it |
| `/run <command>` | Run a shell command (as `!` does) |
| `/last` | All the output of the last command |
| `/settings` | Accent colour, mouse, updates, history |
| `/accent <#rrggbb>` | Change the accent colour (`default` puts it back) |
| `/update` | Look for a new version now and install it |
| `/help` | Keys and commands |
| `/quit` | Exit |

## Settings

`,` or `/settings`. They're kept in `~/.hail/config.json` (`HAIL_HOME` moves it), with the environment
picked for each file, the files opened lately and the names (never the values) of the secrets saved.

| Setting | |
| --- | --- |
| Accent colour | The colour of the cursor, borders and Pip |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Prompt history | Clear it |
