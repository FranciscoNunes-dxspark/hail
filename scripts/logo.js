// Draws the pet into assets/: logo.svg (README, GitHub), logo.png (social preview), logo.ico
// (the Windows executable's icon), and logo-transparent.svg/.png/.ico (just the pet, no background),
// all from the pixels in src/pet.js, each with a "POST" tag in the bottom-right corner,
// as Trawl's Glim has its "SQL" tag and Splice's Twig the Git logo.
//   node scripts/logo.js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PALETTE, PET, petPixels } from '../src/pet.js';

const BG = '#17151a';
// Trim the empty columns kept for the waving paw, so the face sits in the middle.
const full = petPixels('idle');
const used = [...full[0]].map((_, x) => full.some((row) => row[x] !== '.'));
const first = used.indexOf(true);
const last = used.lastIndexOf(true);
const px = full.map((row) => row.slice(first, last + 1));

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16), 255];

// The badge: "POST" in white on blue, a rounded tag, as Trawl's "SQL"; blue, the owl's orange turned
// round, so it stands apart from the beak and feet. It's
// drawn at twice the pet's resolution, the coarsest the letters still read at.
const BADGE = [
  '.bbbbbbbbbbbbbbbbb.',
  'bbbbbbbbbbbbbbbbbbb',
  'bbtttbtttbtttbtttbb',
  'bbtbtbtbtbtbbbbtbbb',
  'bbtttbtbtbtttbbtbbb',
  'bbtbbbtbtbbbtbbtbbb',
  'bbtbbbtttbtttbbtbbb',
  'bbbbbbbbbbbbbbbbbbb',
  '.bbbbbbbbbbbbbbbbb.',
];
// Letters of their own, so the badge's colours never change the owl's.
const COLOURS = { ...PALETTE, b: '#3d7be0', t: '#ffffff' };

// The pet at the badge's resolution: every pixel doubled.
const px2 = px.flatMap((row) => {
  const wide = [...row].map((c) => c + c).join('');
  return [wide, wide];
});

/**
 * The pet at (ox, oy) on a w × h grid of half-pixels, with the badge's top-left corner at (bx, by),
 * cut out of the pet by a one-cell gap. Rows of palette letters, '.' for nothing.
 */
function grid(w, h, ox, oy, bx, by) {
  const badge = (x, y) => BADGE[y - by]?.[x - bx] ?? '.';
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      if (badge(x, y) !== '.') return badge(x, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (badge(x + dx, y + dy) !== '.') return '.';
      return px2[y - oy]?.[x - ox] ?? '.';
    }).join(''),
  );
}

const BW = BADGE[0].length;
const BH = BADGE.length;
// The dark square: 40 half-pixels across, the pet up and to the left of the badge.
const SQUARE = grid(40, 40, 4, 8, 40 - BW - 1, 40 - BH - 2);
// The transparent icon: 32 across, so the usual icon sizes (16, 32, 48 … 256) keep the pet's pixels whole.
const ICON = grid(32, 32, 1, 4, 32 - BW, 32 - BH);
// The pet cropped to the drawing, with room right and below for the badge to sit on.
const CROPPED = grid(px2[0].length + 6, px2.length + 6, 0, 0, px2[0].length + 6 - BW, px2.length + 6 - BH);

/** A grid drawn at `scale` image pixels per cell, as RGBA rows; `inside(x, y)` limits it to a shape. */
function paint(cells, scale, bg = [0, 0, 0, 0], inside = () => true) {
  const rows = [];
  for (let y = 0; y < Math.round(cells.length * scale); y++) {
    const row = [];
    for (let x = 0; x < Math.round(cells[0].length * scale); x++) {
      const c = cells[Math.floor(y / scale)][Math.floor(x / scale)];
      row.push(...(!inside(x, y) ? [0, 0, 0, 0] : COLOURS[c] ? hex(COLOURS[c]) : bg));
    }
    rows.push(row);
  }
  return rows;
}

// The dark rounded square with the pet, as RGBA rows; transparent outside the corners.
function canvas(size) {
  const radius = size * 0.18;
  return paint(SQUARE, size / 40, hex(BG), (x, y) => {
    const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
    const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
    return cx * cx + cy * cy <= radius * radius;
  });
}

// Just the pet on transparency, cropped to the drawing: `scale` image pixels per drawing pixel.
const bare = (scale) => paint(CROPPED, scale / 2);

/** Encodes RGBA rows as a PNG; a number means the square background canvas of that size. */
function png(image) {
  const rows = typeof image === 'number' ? canvas(image) : image;
  const raw = Buffer.concat(rows.map((r) => Buffer.from([0, ...r])));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(rows[0].length / 4, 0);
  ihdr.writeUInt32BE(rows.length, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO files may hold PNGs directly (Windows Vista and later).
// The pet centred on a transparent square, for icons.
const bareSquare = (size) => paint(ICON, size / 32);

// An uncompressed 32-bit icon image: BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit
// transparency mask older readers use. Every program that reads .ico files reads these.
function dib(rows) {
  const w = rows[0].length / 4;
  const h = rows.length;
  const maskRow = Math.ceil(w / 32) * 4;
  const head = Buffer.alloc(40);
  head.writeUInt32LE(40, 0);
  head.writeInt32LE(w, 4);
  head.writeInt32LE(h * 2, 8); // colour rows plus mask rows
  head.writeUInt16LE(1, 12);
  head.writeUInt16LE(32, 14);
  head.writeUInt32LE(w * h * 4 + maskRow * h, 20);
  const pixels = Buffer.alloc(w * h * 4);
  const mask = Buffer.alloc(maskRow * h);
  for (let y = 0; y < h; y++) {
    const src = rows[h - 1 - y];
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = src.slice(x * 4, x * 4 + 4);
      pixels.set([b, g, r, a], (y * w + x) * 4);
      if (a === 0) mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([head, pixels, mask]);
}

/**
 * An .ico with one image per size; `draw(size)` makes each (the dark square by default).
 * Bitmaps up to 128 px and a PNG at 256, the usual layout: some readers can't decode small PNGs.
 */
function ico(sizes, draw = canvas) {
  const images = sizes.map((s) => (s >= 256 ? png(draw(s)) : dib(draw(s))));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map((img, i) => {
    const e = Buffer.alloc(16);
    e[0] = sizes[i] >= 256 ? 0 : sizes[i];
    e[1] = sizes[i] >= 256 ? 0 : sizes[i];
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(img.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

/**
 * Every size in the .ico files side by side, for the README: each drawn exactly as the .ico holds it,
 * then scaled up to `cell` px with whole pixels kept, so the small ones show what they really look like.
 * One row per .ico, on transparency.
 */
function iconSheet(rowsOfIcons, cell = 128, gap = 16) {
  const cols = Math.max(...rowsOfIcons.map((r) => r.length));
  const width = gap + cols * (cell + gap);
  const out = Array.from({ length: gap + rowsOfIcons.length * (cell + gap) }, () => new Array(width * 4).fill(0));
  rowsOfIcons.forEach((icons, r) =>
    icons.forEach((img, c) => {
      const n = img.length;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const sx = Math.floor((x * n) / cell);
          const px = img[Math.floor((y * n) / cell)].slice(sx * 4, sx * 4 + 4);
          out[gap + r * (cell + gap) + y].splice((gap + c * (cell + gap) + x) * 4, 4, ...px);
        }
      }
    }),
  );
  return out;
}

/** The logo as SVG: on its dark rounded square, or with `background: false` just the pet, cropped. */
function svg({ background = true } = {}) {
  const cells = background ? SQUARE : CROPPED;
  const rects = [];
  cells.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (COLOURS[c]) rects.push(`<rect x="${x}" y="${y}" width="1.02" height="1.02" fill="${COLOURS[c]}"/>`);
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cells[0].length} ${cells.length}" shape-rendering="crispEdges">
<title>${PET.name}, the Hail ${PET.kind}</title>
${background ? `<rect width="40" height="40" rx="7.2" fill="${BG}"/>\n` : ''}${rects.join('\n')}
</svg>
`;
}

mkdirSync('assets', { recursive: true });
writeFileSync('assets/logo.svg', svg());
writeFileSync('assets/logo.png', png(512));
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
writeFileSync('assets/logo.ico', ico(ICON_SIZES));
// Just the pet on transparency, for light pages, slides and stickers.
const BARE_SIZES = [16, 32, 48, 64, 128, 256];
writeFileSync('assets/logo-transparent.svg', svg({ background: false }));
writeFileSync('assets/logo-transparent.png', png(bare(32)));
writeFileSync('assets/logo-transparent@4x.png', png(bare(128)));
writeFileSync('assets/logo-transparent.ico', ico(BARE_SIZES, bareSquare));
writeFileSync('assets/logo-icons.png', png(iconSheet([ICON_SIZES.map(canvas), BARE_SIZES.map(bareSquare)])));
console.log('assets/logo.svg, logo.png, logo.ico, logo-transparent.svg, logo-transparent.png, logo-transparent@4x.png, logo-transparent.ico, logo-icons.png');
