// What ? shows (ui/HelpView.jsx, laid out by help-layout.js): sections of [keys, what they do]. A \n
// in the text starts a line of its own; a string is a note; { heading } starts a part of a section.
// `views` are the views ? opens on that section from. The slash commands come from commands.js, as
// a section of their own after these.
export const HELP = [
  {
    title: 'Anywhere',
    rows: [
      ['1-2 / tab', 'Items, Log (shift+tab goes back)'],
      ['/ or :', 'Command prompt (slash commands, with completion)'],
      ['!', 'Run a shell command, e.g.  !node --version'],
      ['r', 'Refresh'],
      ['esc', 'Cancel the running command, or clear the activity lines'],
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
      ['y', 'Copy it'],
    ],
  },
  {
    title: 'Items',
    views: ['items'],
    rows: [['↵', 'Show the item']],
  },
  {
    title: 'Log',
    about: 'what has run, newest at the bottom',
    views: ['log'],
    rows: [['↵', 'All of its output']],
  },
  {
    title: 'Viewer',
    about: 'output, items',
    rows: [
      ['j k  space  g G', 'Scroll'],
      ['esc / q', 'Close'],
    ],
  },
];
