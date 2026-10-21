// Pip, Hail's seabird. One pixel drawing feeds the terminal pet, the SVG logo and the app icon. A
// puffin, in profile: seabirds carry things back and forth over open water, and so does Hail.

/** Who the pet is; the welcome box, the mood lines and the logo's title all say it from here. */
export const PET = { name: 'Pip', kind: 'puffin' };

// The accent's family, as Trawl's Glim, Splice's Twig and Keel's Pinch are coloured from theirs: the
// accent for the outline, a darker shade for the back, a pale face, a near-black eye, and one contrasting colour.
export const PALETTE = {
  G: '#ff875f', // outline, the accent
  D: '#8c4a34', // back and wing
  L: '#ffcfbf', // face and breast
  E: '#1e100b', // eye
  W: '#ffffff', // eye shine
  T: '#ffd75f', // the beak, the one bright colour
};

// 16 × 10 pixels; '.' is transparent. Facing right, with the beak in columns 11–15.
const BASE = [
  '....GGGGG.......',
  '..GGDDDDDGG.....',
  '.GDDDDDDDDDG....',
  '.GDLLLLEWDDGTT..',
  'GDLLLLLEEDDTTTT.',
  'GDLLLLLLLDDGTT..',
  'GDLLLLLLLLDDG...',
  '.GDLLLLLLLDDG...',
  '..GGDLLLLDGG....',
  '....GGGGGG......',
];

// Each mood replaces some rows of the base drawing.
const MOODS = {
  idle: {},
  look: { 3: '.GDLLLLWEDDGTT..' }, // glancing the other way, for the busy animation
  sleep: { 3: '.GDLLLLDDDDGTT..', 4: 'GDLLLLLEEDDTTTT.' },
  happy: { 3: '.GDLLLLDEDDGTT..', 4: 'GDLLLLLEDEDTTTT.' },
  worried: { 3: '.GDLLLLWWDDGTT..', 4: 'GDLLLLLEEDDTT...' },
  // Calling out, beak open: a request has gone and come back.
  wave: { 3: '.GDLLLLEWDDGTTTT', 4: 'GDLLLLLEEDDG....', 5: 'GDLLLLLLLDDGTTTT' },
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

/** A one-line face for the header: ▸ is the beak. */
export const FACES = {
  idle: '(•▸)',
  look: '(•▸)',
  sleep: '(–▸)',
  happy: '(^▸)',
  worried: '(◉▸)',
  wave: '(•▸)~',
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
