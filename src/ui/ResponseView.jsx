import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { lineText, markRanges, matcher } from '../search.js';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { bodyLines, responseLines } from './response.js';

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
  // An event stream on its way keeps its newest events on screen, until it's scrolled up from them.
  const streaming = Boolean(sent?.response.streaming);
  const follow = useRef(true);
  useEffect(() => {
    follow.current = true;
  }, [request?.label]);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    follow.current = topRef.current >= max;
    setTopState(topRef.current);
  };
  // The lines `query` is in. The body's are kept while the query and the body's lines stay the same
  // (they're bodyLines' own array, at the end of `lines`), so a big body is searched once, not per key.
  const found = useRef({ body: null, query: '', hits: [] });
  const hitsFor = (query) => {
    const f = matcher(query);
    if (!f) return [];
    const body = sent ? bodyLines(sent.response, width - 4) : [];
    const head = lines.length - body.length;
    const was = found.current;
    if (was.body !== body || was.query !== query) {
      const hits = [];
      // Typing on to a query only narrows it (the same case rule): look in the lines it was in.
      if (was.body === body && was.query && query.startsWith(was.query) && /[A-Z]/.test(query) === /[A-Z]/.test(was.query)) {
        for (const h of was.hits) if (f(lineText(body[h - was.head])).length) hits.push(head + h - was.head);
      } else for (let i = 0; i < body.length; i++) if (f(lineText(body[i])).length) hits.push(head + i);
      found.current = { body, query, head, hits };
    }
    const { hits, head: then } = found.current;
    const top = [];
    for (let i = 0; i < head; i++) if (f(lineText(lines[i])).length) top.push(i);
    return [...top, ...(then === head ? hits : hits.map((i) => i - then + head))];
  };
  const find = matcher(search.query);
  const hits = hitsFor(search.query);

  /** Puts match `n` (wrapping round) a third of the way down the pane. */
  const goTo = (n, query = searchRef.current.query) => {
    const all = hitsFor(query);
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
  // A search being typed stops when the view loses the keys (a pasted command opened the prompt), keeping what's typed.
  useEffect(() => {
    if (!active && searchRef.current.typing) setSearch({ ...searchRef.current, typing: false });
  }, [active]);
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

  const shown = streaming && follow.current ? max : Math.min(top, max);
  if (streaming && follow.current) topRef.current = max;
  const here = hits[Math.min(search.at, hits.length - 1)];
  // Only the lines on screen are drawn, so only they are marked.
  const visible = lines.slice(shown, shown + innerH);
  const marked = find ? visible.map((l, k) => markRanges(l, find(lineText(l)), { bg: shown + k === here ? theme.matchHere : theme.match, color: theme.ink })) : visible;
  const title = request ? `${request.method} ${request.name ?? request.url}` : 'Response';
  const where = search.query || search.typing ? `/${search.query}${search.typing ? '▏' : ''} ${hits.length ? `${Math.min(search.at, hits.length - 1) + 1}/${hits.length}` : 'no match'} · ` : '';
  const hint = sent ? `${where}${lines.length > innerH ? `${shown + 1}/${lines.length} · ` : ''}/ search · h headers · ↵ send again` : '';
  return (
    <Panel title={title} hint={hint} width={width} height={height} focused={active}>
      {sent ? (
        <Lines lines={marked.map((segs) => [{ text: ' ' }, ...segs])} width={width - 2} height={innerH} />
      ) : (
        <Row pointer={false} width={width - 2} segments={[{ text: request ? '  Not sent yet: ↵ sends it.' : '  Open a .http file to send its requests.', color: theme.dim }]} />
      )}
    </Panel>
  );
}
