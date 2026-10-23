import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { lineText, markRanges, matcher } from '../search.js';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { responseLines } from './response.js';

/**
 * The response to the request picked in Requests, the whole width: scrolls, h shows the headers, y
 * copies the body, / searches it (n and N go from match to match, esc clears the search).
 */
export function ResponseView({ request, sent, ctx, width, height, active }) {
  const innerH = height - 2;
  const [headers, setHeaders] = useState(false);
  const [top, setTopState] = useState(0);
  const topRef = useRef(0);
  // The search: what's typed, whether it's still being typed, and the match the view is on.
  const [search, setSearchState] = useState({ query: '', typing: false, at: 0 });
  const searchRef = useRef(search);
  const setSearch = (s) => {
    searchRef.current = s;
    setSearchState(s);
  };
  const lines = sent ? responseLines(sent, width - 4, { headers, contract: ctx.contractFor(sent) }) : [];
  const max = Math.max(0, lines.length - innerH);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };
  const find = matcher(search.query);
  const hits = find ? lines.map((l, i) => (find(lineText(l)).length ? i : -1)).filter((i) => i >= 0) : [];

  /** Puts match `n` (wrapping round) a third of the way down the pane. */
  const goTo = (n, query = searchRef.current.query) => {
    const f = matcher(query);
    const all = f ? lines.map((l, i) => (f(lineText(l)).length ? i : -1)).filter((i) => i >= 0) : [];
    if (!all.length) return;
    const at = ((n % all.length) + all.length) % all.length;
    setSearch({ ...searchRef.current, query, at });
    setTop(all[at] - Math.floor(innerH / 3));
  };

  const searchKeys = (input, key) => {
    const s = searchRef.current;
    if (s.typing) {
      if (key.escape) return setSearch({ query: '', typing: false, at: 0 });
      if (key.return) return setSearch({ ...s, typing: false });
      if (key.backspace || key.delete) {
        if (!s.query) return setSearch({ query: '', typing: false, at: 0 });
        setSearch({ ...s, query: s.query.slice(0, -1), at: 0 });
        return goTo(0, s.query.slice(0, -1));
      }
      if (key.ctrl || key.meta || !input) return;
      const q = s.query + input.replace(/[\x00-\x1f\x7f]/g, '');
      setSearch({ ...s, query: q });
      return goTo(0, q);
    }
    if (input === '/') return setSearch({ query: '', typing: true, at: 0 });
    if (key.escape) return setSearch({ query: '', typing: false, at: 0 });
    if (input === 'n') return goTo(s.at + 1);
    if (input === 'N') return goTo(s.at - 1);
  };
  // Typing a search, and / n N esc while one is up, are this view's, not the app's.
  useEffect(() => () => void (ctx.claimsKey = null), []);
  ctx.claimsKey = active ? (input, key) => searchRef.current.typing || input === '/' || (Boolean(searchRef.current.query) && (key.escape || input === 'n' || input === 'N')) : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (ctx.claimsKey?.(input, key)) return searchKeys(input, key);
    if (input === 'j' || key.downArrow) return setTop(topRef.current + 1);
    if (input === 'k' || key.upArrow) return setTop(topRef.current - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return setTop(topRef.current + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return setTop(topRef.current - innerH + 1);
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
    if (input === 'h') return setHeaders((h) => !h);
    if (!sent) return;
    if (input === 'y') return ctx.copy(sent.response.body, 'the body');
    if (key.return) return ctx.send(request);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setTop(topRef.current + e.wheel * 3);
  });

  const shown = Math.min(top, max);
  const here = hits[Math.min(search.at, hits.length - 1)];
  const marked = find
    ? lines.map((l, i) => markRanges(l, find(lineText(l)), { bg: i === here ? theme.matchHere : theme.match, color: theme.ink }))
    : lines;
  const title = request ? `${request.method} ${request.name ?? request.url}` : 'Response';
  const where = search.query || search.typing ? `/${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'} · ` : '';
  const hint = sent ? `${where}${lines.length > innerH ? `${shown + 1}/${lines.length} · ` : ''}/ search · h headers · ↵ send again` : '';
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
      {sent ? (
        <Lines lines={marked.map((segs) => [{ text: ' ' }, ...segs])} width={width - 2} height={innerH} offset={shown} />
      ) : (
        <Row pointer={false} width={width - 2} segments={[{ text: request ? '  Not sent yet: ↵ sends it.' : '  Open a .http file to send its requests.', color: theme.dim }]} />
      )}
    </Panel>
  );
}
