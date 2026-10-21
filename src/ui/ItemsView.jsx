import React from 'react';
import { useInput } from 'ink';
import { showItem } from '../actions.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';

/** The list of items, with the one under the cursor beside it. slipway's example of a split view. */
export function ItemsView({ data, ctx, width, height, active }) {
  const items = data.items;
  const innerH = height - 2;
  const listW = Math.max(24, Math.floor(width * 0.4));
  const nav = useListNav(items.length, innerH);
  const sel = items[nav.index];
  const nameW = Math.min(24, Math.max(8, ...items.map((it) => it.name.length)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return) showItem(ctx, sel);
    else if (input === 'y') ctx.copy(sel.name);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    // The pane beside the list has nothing to click.
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    // Rows start under the panel's top border.
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  return (
    <>
      <Panel title="Items" hint={`${items.length}`} width={listW} height={height} focused={active}>
        {items.length === 0 ? <Row pointer={false} width={listW - 2} segments={[{ text: '  Nothing here yet.', color: theme.dim }]} /> : null}
        {items.slice(nav.offset, nav.offset + innerH).map((it, i) => (
          <Row
            key={it.name}
            width={listW - 2}
            selected={nav.offset + i === nav.index}
            focused={active}
            segments={[
              { text: fit(it.name, nameW), strong: true },
              { text: `  ${it.kind}`, color: theme.dim },
            ]}
          />
        ))}
      </Panel>
      <Panel title={sel?.name ?? ''} width={width - listW} height={height}>
        <Lines lines={sel ? [[{ text: ` ${sel.kind}`, color: theme.dim }], '', ...sel.detail.split('\n').map((l) => ` ${l}`)] : []} width={width - listW - 2} height={innerH} />
      </Panel>
    </>
  );
}
