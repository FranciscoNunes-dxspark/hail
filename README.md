<p align="center"><img src="assets/logo.svg" width="120" alt="Hoot, the Hail owl"></p>

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
hail test api.http [--env dev]   # send them all without the screen and report (for CI)
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
joined onto it. After the body, a response handler can check what comes back (see [Checking responses](#checking-responses)).

Hail reads the file again whenever it's saved, so it can sit beside your editor, or you can edit it
in Hail itself.

### Editing the file

The Edit tab (`2`, or `i` on a request in Requests) is the file itself in an editor inside Hail, as
Trawl's SQL console is: `###` lines, comments, `@variables`, methods, URLs, headers and `{{placeholders}}`
each in a colour of their own. Press `↵` or `i` to start typing and `esc` to stop. While you type, every
key is text, so the digits and `q` don't switch views or quit. `ctrl+r` sends the request the cursor is
in (the gutter marks it), as it is on screen, and its response shows beside the text, so you can keep
typing. A click starts typing where it lands.

What you type is saved to the file a moment after you stop (`ctrl+s` saves straight away), keeping its
line endings. When the file is changed somewhere else, the change comes in, unless what you've typed
hasn't been saved yet. `ctrl+z` undoes, a word at a time, and `ctrl+y` redoes, typing or not. `[` and `]`
go to the request before or after, `ctrl+f` (or `/find <text>`) finds text and selects it, and `n` and
`N` find the next and previous match.

As you type, a list under the cursor suggests what could come next: inside `{{`, the variables there are
(the environment's, the file's, `login.response.body.` for each named request, and the built-ins); where
the request line goes, the methods; under it, header names, and values for `Content-Type`, `Accept` and
`Authorization`. `tab` takes the highlighted one; `↑`/`↓` pick another, and then `↵` takes it too. `esc`
closes the list, and `ctrl+n` brings it up where nothing has been typed yet.

Editing keys, as in Trawl's console: arrows, `home`/`end` (`ctrl+e` too), `ctrl+home`/`ctrl+end`,
`ctrl+←`/`ctrl+→` a word at a time, `ctrl+w`, `ctrl+backspace` or `alt+backspace` delete the word before
the cursor and `ctrl+delete` the one after, `ctrl+u`/`ctrl+k` cut to the start or end of the line, and
`tab` inserts two spaces. `shift` with a movement selects, and `ctrl+a` selects everything; `ctrl+c`
copies the selection and `ctrl+x` cuts it (with nothing selected, the line). A drag selects too, and
copies it. `alt+↑`/`alt+↓` move the line, or the selected lines, up or down; `ctrl+d` writes it again
under itself; `ctrl+/` comments it out with `#` or back in; `tab` and `shift+tab` indent selected lines.

### Importing curl

`/import-curl <command>` (or `I` in Requests, which starts it for you to paste into) turns a curl command
into a request at the end of the file, named after its method and path (`### POST /v1/users`), and puts
the cursor on it. It reads what a browser's "Copy as cURL" gives in any shell: bash's quoting and `\`
at line ends, Windows cmd's `^` escapes, PowerShell's backticks, and the lines run together as a paste
into the prompt has them. `-X`, `-H`, `-d` and the other `--data` forms (`@file` becomes a body file),
`--json`, `-u user:password` (an `Authorization: Basic` header), `-F` (a multipart body, files as `< path`
lines), `-G`, `-I`, `-A`, `-e`, `-b` and `-m` (`# @timeout`) carry over; options about how curl itself
runs (`--compressed`, `-L`, `-s`, `-o`…) are dropped, and the ones that mean something Hail does
another way (`-k`) are named when it's added.

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

### Checking responses

JetBrains' response handlers work as they do there: after a request's body, `> {% ... %}` holds a script
(over as many lines as it needs), or `> ./checks.js` names a file of one beside the `.http` file. It runs
when the response comes, and what it found shows with the response: a line for each test, passed or
failed, and what it logged.

```http
### Log in
POST {{host}}/login
Content-Type: application/json

{ "user": "ana", "password": "{{$secret password}}" }

> {%
  client.test("signed in", () => client.assert(response.status === 200, "got " + response.status));
  client.test("a token came back", () => client.assert(response.body.token, "no token"));
  client.global.set("token", response.body.token);
%}

### Who am I
GET {{host}}/me
Authorization: Bearer {{token}}
```

| In a script | |
| --- | --- |
| `client.test(name, fn)` | A test: it passes unless `fn` throws |
| `client.assert(condition, message)` | Throws (failing the test it's in) when the condition is false; outside a test it fails as a test of its own |
| `client.global.set(name, value)` | A variable for the requests after it: `{{name}}` reads it. `client.global.get(name)` reads it back, `clear(name)` and `clearAll()` forget them |
| `client.log(...)` | A line under the response (`console.log` too) |
| `client.exit()` | Stops the script there |
| `response.status`, `response.body` | The status, and the body: parsed when it's JSON, else the text |
| `response.headers.valueOf(name)` | A header's value (`valuesOf(name)` gives every one, for `Set-Cookie`) |
| `response.contentType` | `{ mimeType, charset }` |

A global variable wins over the environment's and the file's of the same name, as the newest value. The
globals last until Hail closes or another file is opened. Scripts run in a sandbox of their own: no
`require`, no `process`, no timers, no files, nothing from Hail but the response, and two seconds to
finish. The tests are kept in the history with the response.

### Sending the whole file

`A` in Requests (or `/send all`) sends every request in the file, top to bottom, each one using what the
ones above it left: their responses and the globals their scripts set. A request with a variable
nothing gives a value is passed over; one that gets no answer stops the run; failed tests don't. Then a
report shows each request's status, how long it took and how its tests went, with the failures under
it.

From the shell, for CI:

```bash
hail test api.http --env dev
```

does the same without the screen: it prints the report and exits with 1 when a test failed, a script
broke, or a request wasn't sent or got no answer (2 when it couldn't run at all, as with a file that
isn't there). Without `--env` it uses the environment Hail would pick (the one chosen last for the
file, else dev or local). Nothing is kept in the history. `{{$secret}}` reads the system's store as Hail
does; on a build server, `{{$processEnv NAME}}` is usually the way to hand it a secret.

### Cookies

A response's `Set-Cookie` is kept, as a browser keeps it: for the site and path it names, until it
expires (or, without an expiry, until Hail closes), `Secure` ones only over https. Later requests to
the same site send them back, unless the request sets `Cookie` itself. Redirects are followed with the
jar, so a sign-in that sets a cookie and redirects carries on signed in. Each file has a jar per
environment, in memory only: nothing about them is written anywhere, and the history hides
`Cookie` and `Set-Cookie` headers. `/cookies` lists them, `/cookies clear` forgets them, and
`# @no-cookie-jar` above a request (JetBrains') keeps that one out of it: it sends none and keeps none.

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
| `1` `2` `3` `4` `5` / `tab` | Requests, Edit, Response, History, Log (`shift+tab` goes back) |
| `↵` | Send the request under the cursor; in Response, send it again; in Edit, start typing |
| `A` | In Requests: send every request, top to bottom, and show a report |
| `i` | Edit the file, typing, on the request under the cursor |
| `ctrl+r` | In Edit: send the request the cursor is in |
| `c` | Copy the request as a curl command, variables filled in |
| `I` | In Requests: import a curl command (starts `/import-curl ` for you to paste after) |
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
the status, how long it took, its size, how its tests went, and the body, JSON indented. A request whose
tests failed has a ✗ beside its status in the list.

### The command palette

`ctrl+p` opens a list of everything you can do from where you are: the keys of the view you're in,
your own keys and commands, and every slash command. Type to narrow it (the words can come in any
order and needn't be whole), `↑`/`↓` pick, `↵` runs the one picked, `esc` closes it. A key runs as if
you'd pressed it in the view; a command that needs something typed after it goes into the prompt for
you to finish.

### Your own commands and keys

Commands of your own go in the settings file (`~/.hail/config.json`), under `"commands"`, and keys
under `"keys"`, for every view (`"global"`) or for one (requests, edit, response, history, log):

```json
{
  "commands": { "dev": "/env dev", "login": ["/env dev", "/send login"] },
  "keys": { "global": { "ctrl+s": "/send" }, "response": { "H": "h" } }
}
```

A command is a line as you'd type it at the prompt, or a list of them run in order, stopping at the
first that fails or asks a question you answer no to. `$1`, `$2`… are the words typed after it, `$*`
all of them. A key maps to another key (the view does what that one does) or to a command line. What
can't be used is said in the activity lines when Hail starts. These work as they do in Splice
and Trawl.

## Commands

| Command | What it does |
| --- | --- |
| `/send [request]` | Send a request by name (the one under the cursor if none is named); `/send all` sends every one and shows a report |
| `/env [name]` | The environment the variables come from (a list to pick from if none is named) |
| `/curl [request]` | Copy a request, filled in, as a curl command |
| `/import-curl <command>` | Add a request to the end of the file from a curl command, and pick it |
| `/open <file.http>` | Open another file |
| `/find <text>` | Find text in the file, in Edit (`n` and `N` go on to the next and the one before) |
| `/secret [name]` | Save a secret in the system's store for `{{$secret name}}` (the saved ones, to replace or forget, if none is named) |
| `/history [clear]` | The responses kept for this file (`clear` forgets them) |
| `/cookies [clear]` | The cookies kept for this file and environment (`clear` forgets them) |
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
| Accent colour | The colour of the cursor, borders and Hoot |
| Mouse | Off leaves selecting text to the terminal |
| Check for new versions | Once a day, in the downloaded builds |
| Install them by itself | Off only says a new version is out |
| Prompt history | Clear it |

## License

MIT, see [LICENSE](LICENSE).
