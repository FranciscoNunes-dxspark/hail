import React, { useEffect, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/**
 * A list to pick from, as an overlay (ctx.showPicker): the settings, or anything else to choose one of.
 * `items` are { segments, ...anything else the caller needs } (or a function returning them, read each
 * time the picker shows), or `load` fetches them first.
 * ↵ runs `onPick(item)`; `keys` maps other keys to `(item, picked) => ...`, and `actions` to `() => ...` for
 * keys about the whole list. With `range`, v starts and ends a selection of several rows, and `picked`
 * is the rows selected (otherwise just `item`). Esc clears the selection, else closes the picker; an overlay
 * opened from here (the viewer, say) comes back to it, cursor and all, when that one closes.
 */
export function Picker({ picker, ctx, width, height, active }) {
  const { title, hint = '', empty = 'Nothing here.', onPick, keys = {}, actions = {} } = picker;
  // `items` as a function is read afresh whenever the picker shows (a settings list, after a change).
  const [state, setState] = useState(() => {
    const items = typeof picker.items === 'function' ? picker.items() : picker.items;
    return items ? { items } : { loading: true };
  });
  useEffect(() => {
    if (picker.items) return;
    let live = true;
    picker.load().then(
      (items) => {
        // Kept on the overlay, so coming back to it doesn't load again.
        picker.items = items;
        if (live) setState({ items });
      },
      (e) => live && setState({ error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [picker]);

  const items = state.items ?? [];
  const innerH = height - 2;
  const nav = useListNav(items.length, innerH);
  // Read before the first render below writes over it.
  const [returnTo] = useState(picker.index);
  useEffect(() => {
    if (returnTo) nav.setIndex(returnTo);
  }, [picker]);
  picker.index = nav.index;
  const item = items[nav.index];
  const [anchor, setAnchor] = useState(null);
  const span = anchor == null ? null : [Math.min(anchor, nav.index), Math.max(anchor, nav.index)];
  const picked = () => (span ? items.slice(span[0], span[1] + 1) : [item]);

  const press = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    if (key.escape && anchor != null) return setAnchor(null);
    if (key.escape || input === 'q') return ctx.closeOverlay();
    if (input === 'v' && picker.range) return setAnchor(anchor == null ? nav.index : null);
    if (nav.handle(input, key)) return;
    // `actions`: keys about the list rather than a row (add one, say), which work even when it's empty.
    if (actions[input]) return actions[input]();
    if (!item) return;
    if (key.return) return onPick?.(item);
    keys[input]?.(item, picked());
  };
  useInput(press, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) press('', { return: true });
  });

  const status = state.loading ? 'Loading…' : state.error ? state.error : items.length ? null : empty;
  const pos = span ? `${span[1] - span[0] + 1} selected · ` : items.length > innerH ? `${nav.index + 1}/${items.length} · ` : '';
  return (
    <Panel title={title} hint={`${pos}${hint}${hint ? ' · ' : ''}esc close`} width={width} height={height} focused={active}>
      {status ? <Row pointer={false} width={width - 2} segments={[{ text: `  ${status}`, color: state.error ? theme.del : theme.dim }]} /> : null}
      {items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
        <Row
          key={nav.offset + i}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          marked={span && nav.offset + i >= span[0] && nav.offset + i <= span[1]}
          focused={active}
          segments={it.segments}
        />
      ))}
    </Panel>
  );
}
