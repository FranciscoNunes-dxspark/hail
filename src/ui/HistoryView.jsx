import React from 'react';
import { useInput } from 'ink';
import { clearHistory, diffEntry, showEntry } from '../actions.js';
import { formatSize } from '../send.js';
import { theme } from '../theme.js';
import { fit, relTime } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { methodColour, statusColour } from './response.js';

// How its tests went, when it had any: "  ✓ 3" or "  ✗ 1/3".
function testsSegment(checks) {
  const tests = checks?.tests ?? [];
  const failed = tests.filter((t) => !t.passed).length + (checks?.error ? 1 : 0);
  if (!tests.length && !failed) return [];
  return [{ text: failed ? `  ✗ ${failed}/${tests.length}` : `  ✓ ${tests.length}`, color: failed ? theme.del : theme.add }];
}

/** The responses kept for the open file, newest first. */
export function HistoryView({ entries, data, focus = null, ctx, width, height, active }) {
  const list = [...entries].reverse();
  const innerH = height - 2;
  // `focus` ({ entry, n }): an entry to put the cursor on (/take logline found it).
  const nav = useListNav(list.length, innerH, { resetKey: `${data?.path}#${focus?.n ?? 0}`, start: Math.max(0, focus ? list.indexOf(focus.entry) : 0) });
  const sel = list[nav.index];
  const labelW = Math.min(36, Math.max(10, ...list.map((e) => e.label.length)));

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (input === 'D') return clearHistory(ctx);
    if (!sel) return;
    if (key.return) showEntry(ctx, sel);
    else if (input === 'd') diffEntry(ctx, sel);
    else if (input === 'y') ctx.copy(sel.response.body, 'the body');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  return (
    <Panel title="History" hint={`${list.length} kept`} width={width} height={height} focused={active}>
      {list.length === 0 ? <Row pointer={false} width={width - 2} segments={[{ text: '  Nothing kept yet: every response to this file\'s requests is.', color: theme.dim }]} /> : null}
      {list.slice(nav.offset, nav.offset + innerH).map((e, i) => (
        <Row
          key={`${e.at}-${i}`}
          width={width - 2}
          selected={nav.offset + i === nav.index}
          focused={active}
          segments={[
            { text: fit(relTime(e.at), 5), color: theme.dim },
            { text: `${e.response.status} `, color: statusColour(e.response.status), bold: true },
            { text: fit(e.request.method, 7), color: methodColour(e.request.method) },
            { text: fit(e.label, labelW), strong: true },
            { text: `  ${e.response.ms} ms · ${formatSize(e.response.size)}`, color: theme.dim },
            ...testsSegment(e.checks),
            { text: `  ${e.request.url}`, color: theme.dim },
          ]}
        />
      ))}
    </Panel>
  );
}
