// Comparing two responses' bodies line by line, for History's d. Pure.

/** The lines of `a` and `b` as [' ' | '-' | '+', line]: a longest-common-subsequence diff. */
export function lineDiff(a, b) {
  const x = String(a).split('\n');
  const y = String(b).split('\n');
  // Too big to compare line by line in reasonable time: say it all changed.
  if (x.length * y.length > 4_000_000) return [...x.map((l) => ['-', l]), ...y.map((l) => ['+', l])];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let [i, j] = [0, 0];
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) (out.push([' ', x[i]]), i++, j++);
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push(['-', x[i++]]);
    else out.push(['+', y[j++]]);
  }
  while (i < x.length) out.push(['-', x[i++]]);
  while (j < y.length) out.push(['+', y[j++]]);
  return out;
}

/** Only the changed lines and `around` lines of context round them, gaps as ['…', '']. */
export function changedOnly(diff, around = 3) {
  const keep = diff.map((_, i) => diff.slice(Math.max(0, i - around), i + around + 1).some(([m]) => m !== ' '));
  const out = [];
  diff.forEach((d, i) => {
    if (keep[i]) out.push(d);
    else if (i === 0 || keep[i - 1]) out.push(['…', '']);
  });
  return out;
}
