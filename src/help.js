// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-3 / tab', 'Requests, Response, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
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
      ['v', 'The response, the whole width'],
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
    ],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
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
