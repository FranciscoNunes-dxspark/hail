// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-5 / tab', 'Requests, Edit, Response, History, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['ctrl+p', 'Command palette: every slash command (yours too) and the keys of the view you\'re in, filtered as you type; ↵ runs one (a command that takes more goes into the prompt)'],
      ['e', 'Pick the environment the variables come from'],
      ['!', 'Run a shell command, e.g.  !node --version'],
      ['r', 'Read the file again (it also reloads by itself when saved)'],
      ['esc', 'Cancel the request on its way, or clear the activity lines'],
      [',', 'Settings (/settings): accent colour, mouse, updates, history'],
      ['?', 'This help'],
      ['q / ctrl+c', 'Quit'],
      ['mouse', 'Click a tab, a row or the prompt · double-click does ↵ · the wheel scrolls\ndrag to select text, copied when you let go'],
    ],
  },
  {
    title: 'Lists',
    rows: [
      ['j k / ↑ ↓', 'Move'],
      ['g G', 'Top, bottom'],
      ['ctrl+d ctrl+u', 'Page down, up'],
    ],
  },
  {
    title: 'Requests',
    about: "the file's requests; beside them, the one under the cursor, or what came back once it's sent",
    views: ['requests'],
    rows: [
      ['↵', 'Send it'],
      ['c', 'Copy it as a curl command, variables filled in'],
      ['y', 'Copy its URL'],
      ['i', 'Edit the file, typing, on this request'],
      ['v', 'The response, the whole width'],
    ],
  },
  {
    title: 'Edit',
    about: "the file itself, saved as you type; beside it, what came back to the request the cursor is in",
    views: ['edit'],
    rows: [
      ['↵ or i', 'Start typing (a click does too, where it lands); while typing, every key is text (digits and q too)'],
      ['esc', 'Stop typing'],
      ['ctrl+r', 'Send the request the cursor is in, as it is on screen (the ▌ in the gutter marks it)'],
      ['ctrl+s', 'Save now, rather than a moment after typing stops'],
      ['ctrl+z  ctrl+y', 'Undo · Redo (a word at a time; also when not typing)'],
      ['ctrl+f  n N', 'Find (/find <text>) · the next match · the one before (n N when not typing)'],
      ['[  ]', 'The request before · the one after'],
      ['j k  g G', 'Move between lines (when not typing)'],
      ['c  v', 'Copy the request as curl · its response, the whole width'],
      ['Typing', 'arrows · backspace, delete · home/end (ctrl+e end too) · ctrl+home/ctrl+end the top, the bottom · tab two spaces\nctrl+←/→ a word at a time · ctrl+w, ctrl+backspace or alt+backspace delete a word back · ctrl+delete one forward\nctrl+u/ctrl+k cut to the start/end of the line'],
      ['Selecting', 'shift+movement selects (esc lets go) · ctrl+a everything · typing replaces it · a drag selects and copies\nctrl+c copy it · ctrl+x cut it (with nothing selected, the line) · ctrl+c with nothing selected stops typing'],
      ['Lines', 'alt+↑/↓ move the line (or the selected lines) up or down · ctrl+d duplicate it (or the selection)\nctrl+/ comment it out with # (or back in) · tab/shift+tab indent the selected lines (shift+tab alone: the line)'],
      ['Suggestions', "variables inside {{ (the environment's, the file's, the named requests' responses, the built-ins), the method, header names and some values\ntab take one · ↑↓ pick (then ↵ takes it) · esc close · ctrl+n (or ctrl+space) ask for them anywhere"],
    ],
  },
  {
    title: 'Response',
    views: ['response'],
    rows: [
      ['j k  space  g G', 'Scroll'],
      ['h', 'Show or hide the headers'],
      ['y', 'Copy the body'],
      ['↵', 'Send the request again'],
      ['/', 'Search the response: matches show as you type, ↵ keeps it (a capital letter makes it match case)'],
      ['n N', 'Next, previous match · esc clears the search'],
    ],
  },
  {
    title: 'History',
    about: "every response to this file's requests, newest first, kept across runs (secrets and credential headers left out)",
    views: ['history'],
    rows: [
      ['↵', 'The request as sent and what came back'],
      ['d', 'How it differs from the response before it to the same request'],
      ['y', 'Copy the body'],
      ['D', 'Forget them all (/history clear)'],
    ],
  },
  {
    title: 'Variables',
    about: 'in the URL, headers and body, as {{name}}',
    rows: [
      ['@name = value', 'A variable of the file, on a line of its own'],
      ['http-client.env.json', 'Environments beside the file: { "dev": { "host": "…" } }; "$shared" goes into each\nhttp-client.private.env.json over it, for secrets kept out of git'],
      ['{{login.response.body.token}}', 'From the response to the request named login (# @name login); .headers.Name for a header'],
      ['{{$uuid}} {{$timestamp}}', 'Built-ins; also $isoTimestamp, $randomInt min max, $processEnv NAME, $env.NAME'],
      ['{{$azToken resource}}', "A token from the Azure CLI's sign-in (az login)"],
      ['{{$secret name}}', "A secret kept in the system's credential store, asked for the first time it's used (/secret saves or replaces one)"],
    ],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Your own commands and keys',
    about: 'in the settings file (config.json), read when Hail starts; what\'s wrong with them is said in the log then',
    rows: [
      ['"commands"', '{ "dev": "/env dev", "login": ["/env dev", "/send login"] }: a line as typed at the prompt, or a list run in order, stopping at the first that fails (or that you answer no); { "run": …, "desc": … } gives it a description. They show in the / menu, the palette and Slash commands below'],
      ['$1 $2  $*', 'What\'s typed after it: a word each ("quoted words" are one), or all of it; a command with no $ gets it at the end of its line'],
      ['"keys"', '{ "global": { "ctrl+s": "/send" }, "response": { "H": "h" } }: a key to another key (the view does what that one does) or to a command line, anywhere or in one view (requests, edit, response, history, log). They work while a view has the keys, never while typing; Your keys (above Slash commands) lists them'],
      ['key names', 'a character (x, X, +), ctrl+s, alt+x, shift+tab, F1-F12, enter, esc, tab, space, backspace, delete, up, down, left, right, home, end, pageup, pagedown'],
    ],
  },
  {
    title: 'Viewer',
    about: 'output',
    rows: [
      ['j k  space  g G', 'Scroll'],
      ['esc / q', 'Close'],
    ],
  },
];
