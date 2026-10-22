// Hoot, Hail's owl. One pixel drawing feeds the terminal pet, the SVG logo and the app icon. Owls carry
// the post, and a request is a letter sent off and answered.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Hoot', kind: 'owl' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a darker shade for the feathers, a paler one for the breast's markings, the
// eyes' discs and pupils, and one contrasting colour for the beak and feet.
export const PALETTE = {
  G: '#e8445a', // outline and ear tufts, the accent
  D: '#7d2632', // feathers
  L: '#b84b5c', // the breast's markings
  W: '#fff1dc', // the eyes' discs
  E: '#1b100b', // pupils
  O: '#ffd75f', // beak and feet, the one bright colour
};

// 16 × 10 pixels; '.' is transparent. Face on: ear tufts, two round eyes, the beak between them, a
// speckled breast and feet. Columns 14–15 are room for a raised wing.
const BASE = [
  '.GG........GG...',
  '.GDGGGGGGGGDG...',
  'GDDDDDDDDDDDDG..',
  'GDWWWDDDDWWWDG..',
  'GDWEWDDDDWEWDG..',
  'GDWWWDOODWWWDG..',
  'GDDLDDOODDLDDG..',
  'GDLDLDDDDLDLDG..',
  '.GDLDLDDLDLDG...',
  '..GOOGGGGOOG....',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 4: 'GDEWWDDDDEWWDG..' }, // glancing the other way, for the busy animation
  sleep: { 3: 'GDDDDDDDDDDDDG..', 4: 'GDEEEDDDDEEEDG..', 5: 'GDDDDDOODDDDDG..' },
  happy: { 3: 'GDDWDDDDDDWDDG..', 4: 'GDWDWDDDDWDWDG..', 5: 'GDDDDDOODDDDDG..' },
  worried: { 3: 'GDWEWDDDDWEWDG..', 4: 'GDWWWDDDDWWWDG..' },
  // A wing up: off it goes with the letter.
  wave: { 2: 'GDDDDDDDDDDDDG.G', 3: 'GDWWWDDDDWWWDGDG', 4: 'GDWEWDDDDWEWDDG.', 5: 'GDWWWDOODWWWDG..' },
};

/** The drawing for a mood, as rows of palette letters. */
export function petPixels(mood = 'idle') {
  const over = MOODS[mood] ?? {};
  return BASE.map((row, i) => over[i] ?? row);
}

/**
 * The drawing as terminal rows of segments, two pixels per cell: "▀" with the top pixel as
 * the text colour and the bottom one as the background.
 */
export function petRows(mood = 'idle') {
  const px = petPixels(mood);
  const rows = [];
  for (let y = 0; y < px.length; y += 2) {
    const segs = [];
    for (let x = 0; x < px[y].length; x++) {
      const top = PALETTE[px[y][x]];
      const bottom = PALETTE[px[y + 1]?.[x]];
      if (top && bottom) segs.push({ text: '▀', color: top, bg: bottom });
      else if (top) segs.push({ text: '▀', color: top });
      else if (bottom) segs.push({ text: '▄', color: bottom });
      else segs.push({ text: ' ' });
    }
    rows.push(segs);
  }
  return rows;
}

/** A one-line owl for the header. */
export const FACES = {
  idle: '{o,o}',
  look: '{o,o}',
  sleep: '{-,-}',
  happy: '{^,^}',
  worried: '{O,O}',
  wave: '{o,o}/',
};

/** How the pet feels right now: about the last result, and whether something is running. */
export function moodFor({ data, busy, lastEntry, now = Date.now() }) {
  if (lastEntry?.status === 'error' && now - lastEntry.at < 8000) return 'worried';
  if (busy) return 'look';
  if (lastEntry?.status === 'ok' && now - lastEntry.at < 4000) return 'happy';
  if (!data) return 'idle';
  return 'wave';
}

/** A sentence for the welcome box. */
export function moodLine(mood, data) {
  if (!data) return `Open a .http file and ${PET.name} will carry its requests.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  const n = data.requests.length;
  return `${n} request${n === 1 ? '' : 's'} in ${data.name}, ready to send.`;
}
