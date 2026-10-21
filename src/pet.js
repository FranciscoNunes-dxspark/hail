// Pip, Hail's seabird. One pixel drawing feeds the terminal pet, the SVG logo and the app
// icon. This is slipway's placeholder creature: redraw BASE and MOODS as the real mascot, keep the
// palette letters, and run `node scripts/logo.js` to make assets/ from it.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Pip', kind: 'seabird' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a darker and a paler shade, a near-black with its tint, and one contrasting colour.
export const PALETTE = {
  G: '#ff875f', // outline, the accent
  D: '#8c4a34', // body
  L: '#ffcfbf', // belly
  E: '#1f100b', // eyes
  W: '#ffffff', // eye shine
  T: '#ffb35f', // cheeks, the one warm colour
};

// 16 × 10 pixels; '.' is transparent. The body is columns 0–13; 14–15 are room for a waving fin.
const BASE = [
  '....GGGGGG......',
  '..GGDDDDDDGG....',
  '.GDDDDDDDDDDG...',
  'GDDEWDDDDEWDDG..',
  'GDDEEDDDDEEDDG..',
  'GDTDDDLLDDDTDG..',
  'GDDDDLLLLDDDDG..',
  '.GDDDDLLDDDDG...',
  '..GGDDDDDDGG....',
  '....GGGGGG......',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: 'GDDWEDDDDWEDDG..' }, // glancing the other way, for the busy animation
  sleep: { 3: 'GDDDDDDDDDDDDG..', 4: 'GDDEEDDDDEEDDG..' },
  happy: { 3: 'GDDEDDDDDDEDDG..', 4: 'GDEDEDDDDEDEDG..' },
  worried: { 3: 'GDDWWDDDDWWDDG..', 4: 'GDDEEDDDDEEDDG..' },
  wave: { 2: '.GDDDDDDDDDDG.GG', 3: 'GDDEWDDDDEWDDGDG', 4: 'GDDEEDDDDEEDDGG.' },
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

/** A one-line face for the header. */
export const FACES = {
  idle: '(•ᴗ•)',
  look: '(•ᴗ•)',
  sleep: '(–ᴗ–)',
  happy: '(^ᴗ^)',
  worried: '(◉ᴗ◉)',
  wave: '(•ᴗ•)/',
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
  if (!data) return `${PET.name} is getting things ready.`;
  if (mood === 'worried') return 'Something went wrong: the line below says what.';
  const n = data.items.length;
  return `${n} item${n === 1 ? '' : 's'} to look at.`;
}
