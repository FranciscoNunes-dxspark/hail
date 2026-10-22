// Searching a response (/ then n/N), and picking out the matches in a line's segments. Splice's, as
// its viewer searches. Pure, so it's tested without the UI.

/**
 * A function finding `query` in a text, as [from, to) offsets. Smart case: a query with a capital
 * letter matches case for case, one without matches any case. Null for an empty query.
 */
export function matcher(query) {
  if (!query) return null;
  const sensitive = /[A-Z]/.test(query);
  const q = sensitive ? query : query.toLowerCase();
  return (text) => {
    const t = sensitive ? text : text.toLowerCase();
    const out = [];
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) out.push([i, i + q.length]);
    return out;
  };
}

/** A line's text: the line itself, or its segments' text joined. */
export const lineText = (line) => (typeof line === 'string' ? line : line.map((s) => s.text).join(''));

/** The indexes of the lines `query` is found in. */
export function matchingLines(lines, query) {
  const find = matcher(query);
  if (!find) return [];
  const out = [];
  lines.forEach((l, i) => find(lineText(l)).length && out.push(i));
  return out;
}

/** `segments` with the parts inside `ranges` ([from, to) offsets into their joined text) restyled with `style`. */
export function markRanges(segments, ranges, style) {
  if (!ranges?.length) return segments;
  const inside = (at) => ranges.some(([a, b]) => at >= a && at < b);
  const out = [];
  let pos = 0;
  for (const s of segments) {
    const end = pos + s.text.length;
    const cuts = new Set([pos, end]);
    for (const [a, b] of ranges) {
      if (a > pos && a < end) cuts.add(a);
      if (b > pos && b < end) cuts.add(b);
    }
    const points = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k < points.length - 1; k++) {
      const text = s.text.slice(points[k] - pos, points[k + 1] - pos);
      if (text) out.push(inside(points[k]) ? { ...s, ...style, text } : { ...s, text });
    }
    pos = end;
  }
  return out;
}
