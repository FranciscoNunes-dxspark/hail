// Enough YAML to read an OpenAPI or Swagger document, which are as often YAML as JSON: block mappings
// and sequences by indentation, plain, quoted and block (| and >) scalars, flow [lists] and {maps},
// comments. Anchors, aliases, tags and documents after the first aren't read. Pure.

const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{[\]-][^#]*?|-[^\s#][^#]*?)\s*:(?=\s|$)/;
const indentOf = (s) => {
  let n = 0;
  while (s.charCodeAt(n) === 32) n++;
  return n;
};
const blank = (s) => !s.trim() || /^\s*#/.test(s) || /^(---|\.\.\.)(\s.*)?$/.test(s);
const isItem = (t) => t === '-' || t.startsWith('- ');

/** A plain scalar as the value it stands for: null, true, false, a number, else the text. */
function plain(s) {
  const t = s.replace(/^!!?\w+\s+/, '').replace(/^&\S+\s*/, '');
  if (/^(null|Null|NULL|~)?$/.test(t)) return null;
  if (/^(true|True|TRUE)$/.test(t)) return true;
  if (/^(false|False|FALSE)$/.test(t)) return false;
  if (/^[-+]?(\d+|\d*\.\d+|\d+\.\d*)([eE][-+]?\d+)?$/.test(t)) return Number(t);
  if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t, 16);
  return t;
}

function unquote(s) {
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"')) {
    // Without a backslash there's nothing to unescape: JSON.parse would give back what's between the
    // quotes, or fail and leave it to the slice below.
    if (!s.includes('\\')) return s.slice(1, -1);
    try {
      return JSON.parse(s.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1').replace(/\\([0e ])/g, (_, c) => ({ 0: '\\u0000', e: '\\u001b', ' ': ' ' })[c]));
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** The text before a comment (` #`), quotes respected. */
function uncomment(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '\\' && q === '"') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s[{,:]/.test(s[i - 1])) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/** A flow collection ([a, b], {a: 1}) or a quoted or plain scalar inside one. */
function flow(s) {
  let p = 0;
  const ws = () => {
    while (p < s.length && /\s/.test(s[p])) p++;
  };
  const scalar = (stops) => {
    ws();
    if (s[p] === '"' || s[p] === "'") {
      const q = s[p];
      let e = p + 1;
      for (; e < s.length; e++) {
        if (q === '"' && s[e] === '\\') e++;
        else if (s[e] === q) {
          if (q === "'" && s[e + 1] === "'") e++;
          else break;
        }
      }
      const out = unquote(s.slice(p, e + 1));
      p = e + 1;
      return out;
    }
    let e = p;
    while (e < s.length && !stops.includes(s[e]) && !(s[e] === ':' && /[\s,\]}]/.test(s[e + 1] ?? ' '))) e++;
    const out = plain(s.slice(p, e).trim());
    p = e;
    return out;
  };
  const value = () => {
    ws();
    if (s[p] === '[') {
      p++;
      const out = [];
      for (;;) {
        ws();
        if (s[p] === ']' || p >= s.length) {
          p++;
          return out;
        }
        out.push(value());
        ws();
        if (s[p] === ',') p++;
      }
    }
    if (s[p] === '{') {
      p++;
      const out = {};
      for (;;) {
        ws();
        if (s[p] === '}' || p >= s.length) {
          p++;
          return out;
        }
        const key = scalar(',}:');
        ws();
        let v = null;
        if (s[p] === ':') {
          p++;
          v = value();
        }
        out[String(key)] = v;
        ws();
        if (s[p] === ',') p++;
      }
    }
    return scalar(',]}');
  };
  return value();
}

/** The YAML document in `text` as plain values. Throws when it's plainly not YAML. */
export function parseYaml(text) {
  const L = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/\t/g, '  ').split('\n');
  let i = 0;
  const skip = () => {
    while (i < L.length && blank(L[i])) i++;
  };

  // A scalar after "key:" or "- " (`rest`, comment removed), on a line indented `ind`; more lines can follow.
  const scalarValue = (rest, ind) => {
    const blockScalar = /^([|>])([+-]?)\d*$/.exec(rest);
    if (blockScalar) {
      const lines = [];
      let inner = null;
      while (i < L.length && (!L[i].trim() || indentOf(L[i]) > ind)) {
        if (L[i].trim() && inner === null) inner = indentOf(L[i]);
        lines.push(L[i]);
        i++;
      }
      const body = lines.map((l) => l.slice(inner ?? 0));
      while (body.length && !body.at(-1).trim()) body.pop();
      let out = blockScalar[1] === '|' ? body.join('\n') : body.join('\n').replace(/([^\n])\n(?=[^\n ])/g, '$1 ');
      if (blockScalar[2] !== '-') out += '\n';
      return out;
    }
    if (rest.startsWith('[') || rest.startsWith('{')) {
      let text = rest;
      const balanced = (t) => {
        let d = 0;
        let q = null;
        for (let k = 0; k < t.length; k++) {
          const c = t[k];
          if (q) {
            if (c === '\\' && q === '"') k++;
            else if (c === q) q = null;
          } else if (c === '"' || c === "'") q = c;
          else if (c === '[' || c === '{') d++;
          else if (c === ']' || c === '}') d--;
        }
        return d <= 0;
      };
      while (!balanced(text) && i < L.length) text += ` ${uncomment(L[i++].trim())}`;
      return flow(text);
    }
    if (rest.startsWith('"') || rest.startsWith("'")) {
      let text = rest;
      const q = rest[0];
      const closed = (t) => (q === "'" ? /[^']'$|^''$|[^']('')*'$/.test(t.slice(1)) && t.length > 1 : /(^|[^\\])(\\\\)*"$/.test(t.slice(1)));
      while (!closed(text) && i < L.length) text += ` ${L[i++].trim()}`;
      return unquote(text);
    }
    // A plain scalar can go on over more indented lines.
    let text = rest;
    while (i < L.length && L[i].trim() && !/^\s*#/.test(L[i]) && indentOf(L[i]) > ind) text += ` ${uncomment(L[i++].trim())}`;
    return plain(text);
  };

  const block = (min) => {
    skip();
    if (i >= L.length || indentOf(L[i]) < min) return null;
    const ind = indentOf(L[i]);
    return isItem(L[i].slice(ind)) ? sequence(ind) : mapping(ind);
  };

  const sequence = (ind) => {
    const out = [];
    for (;;) {
      skip();
      if (i >= L.length || indentOf(L[i]) !== ind || !isItem(L[i].slice(ind))) return out;
      const t = L[i].slice(ind);
      const after = t.slice(1);
      const rest = uncomment(after).trim();
      const inner = ind + 1 + indentOf(after);
      if (!rest) {
        i++;
        out.push(block(ind + 1));
      } else if (KEY.test(rest) || isItem(rest)) {
        // "- key: value" starts a mapping (or "- - x" a sequence) indented where the key is.
        L[i] = ' '.repeat(inner) + after.slice(indentOf(after));
        out.push(block(inner));
      } else {
        i++;
        out.push(scalarValue(rest, ind));
      }
    }
  };

  const mapping = (ind) => {
    const out = {};
    for (;;) {
      skip();
      if (i >= L.length || indentOf(L[i]) !== ind) return out;
      const t = L[i].slice(ind);
      if (isItem(t)) return out;
      const m = KEY.exec(t);
      i++;
      if (!m) {
        if (!Object.keys(out).length && i === 1) throw new Error("It isn't YAML or JSON.");
        continue;
      }
      const key = String(unquote(m[1].trim()));
      const rest = uncomment(t.slice(m[0].length)).trim().replace(/^&\S+\s*/, '');
      if (rest) out[key] = scalarValue(rest, ind);
      else {
        skip();
        const next = i < L.length ? indentOf(L[i]) : -1;
        out[key] = next > ind ? block(ind + 1) : next === ind && isItem(L[i].slice(ind)) ? sequence(ind) : null;
      }
    }
  };

  skip();
  if (i >= L.length) return null;
  const t = L[i].trim();
  if (t.startsWith('[') || t.startsWith('{')) return flow(L.slice(i).map((l) => uncomment(l.trim())).join(' '));
  return block(0);
}
