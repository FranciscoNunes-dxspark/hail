// Where Hail's data comes from. This is the placeholder: a fixed list, so the views, tests and
// demo work before there's anything real to read. Replace it with the real thing (a server, an API,
// a CLI to shell out to) keeping the shape: an async read that a view shows and a test can stand in for.

const ITEMS = [
  { name: 'anchor', kind: 'tool', detail: 'Holds the boat in place.\nHeavy, and best let go of on purpose.' },
  { name: 'bowline', kind: 'knot', detail: 'A fixed loop at the end of a rope.\nIt holds under load and still unties easily.' },
  { name: 'capstan', kind: 'tool', detail: 'A drum turned by hand to haul in a line.' },
  { name: 'clove hitch', kind: 'knot', detail: 'Two turns round a post, crossed over themselves.' },
  { name: 'fender', kind: 'tool', detail: 'Hangs over the side so the hull doesn\'t meet the quay.' },
  { name: 'figure eight', kind: 'knot', detail: 'A stopper at the end of a line, so it can\'t run out through a block.' },
  { name: 'halyard', kind: 'line', detail: 'Raises a sail, a flag or a yard.' },
  { name: 'reef knot', kind: 'knot', detail: 'Ties two ends of the same line, as round a furled sail.' },
  { name: 'sheet', kind: 'line', detail: 'Trims a sail: let it out, haul it in.' },
  { name: 'winch', kind: 'tool', detail: 'A capstan with gears, for the sheets.' },
];

/** The items, as { name, kind, detail }. Async, as the real source will be; `delay` is for trying a slow one. */
export async function loadItems({ delay = 0 } = {}) {
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return ITEMS.map((it) => ({ ...it }));
}
