import React from 'react';
import { useInput } from 'ink';
import { BULLET, theme } from '../theme.js';
import { relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

const COLOURS = () => ({ error: theme.del, ok: theme.accent, running: theme.dim, info: theme.info });

/** Everything the activity lines have said, oldest first, as the list under the prompt only shows the last two. */
export function LogView({ entries, ctx, width, height, active }) {
  const innerH = height - 2;
  // On the newest, where something just happened.
  const nav = useListNav(entries.length, innerH, { start: Math.max(0, entries.length - 1), resetKey: entries.length });
  const sel = entries[nav.index];

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return) ctx.showText(sel.title, sel.lines.join('\n') || '(no output)');
    else if (input === 'y') ctx.copy([sel.title, ...sel.lines].join('\n'), 'the entry');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  return (
    <Panel title="Log" hint={`${entries.length}`} width={width} height={height} focused={active}>
      {entries.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing has run yet. Try !node --version', color: theme.dim }]} /> : null}
      {entries.slice(nav.offset, nav.offset + innerH).map((e, i) => (
        <Row
          key={e.id}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: `${BULLET} `, color: COLOURS()[e.status] },
            { text: e.title, strong: true },
            { text: `  ${e.lines[0] ?? ''}`, color: theme.dim },
            { text: `  ${relTime(e.at)}`, color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
