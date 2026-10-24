import React, { useEffect, useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { wrap } from '../text.js';
import { prettyMessage } from '../websocket.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';
import { wrapIndented } from './response.js';

const clock = (at) => new Date(at).toTimeString().slice(0, 8);

/** The session's log as rows of segments `width` wide: each message under a line saying which way it went and when. */
function logRows(log, width) {
  const out = [];
  const tone = { sent: theme.accent, received: theme.add, info: theme.dim, error: theme.del };
  const mark = { sent: '→ sent', received: '← received', info: '·', error: '✗' };
  for (const m of log) {
    if (m.dir === 'info' || m.dir === 'error') {
      for (const [i, l] of wrap(m.text, width - 11).entries()) out.push([{ text: i ? '          ' : `${clock(m.at)}  `, color: theme.dim }, { text: l, color: tone[m.dir] }]);
      continue;
    }
    out.push([{ text: `${clock(m.at)}  `, color: theme.dim }, { text: mark[m.dir], color: tone[m.dir], bold: true }]);
    for (const l of prettyMessage(m.text).split('\n')) for (const part of wrapIndented(l, width - 4)) out.push([{ text: `  ${part}` }]);
  }
  return out;
}

/**
 * A WebSocket session (websocket.js's openSocket), live: what went each way, newest at the bottom (JSON
 * indented), and a line to type a message into, sent with ↵ ({{variables}} filled in). ↑ ↓ and page
 * keys scroll back; esc closes the connection and the view.
 */
export function SocketView({ session, title, ctx, width, height, active, onClose }) {
  const [, setTick] = useState(0);
  useEffect(() => session.subscribe(() => setTick((n) => n + 1)), [session]);
  const [typed, setTypedState] = useState('');
  const typedRef = useRef('');
  const setTyped = (t) => {
    typedRef.current = t;
    setTypedState(t);
  };
  // How far up from the bottom it's scrolled (0 follows what comes in).
  const [back, setBack] = useState(0);
  const innerH = height - 2;
  const rows = logRows(session.log, width - 2);
  const listH = innerH - 2;
  const max = Math.max(0, rows.length - listH);
  const from = Math.max(0, max - Math.min(back, max));

  const keys = async (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    if (key.escape) {
      session.close();
      return onClose();
    }
    if (key.upArrow) return setBack((b) => Math.min(max, b + 1));
    if (key.downArrow) return setBack((b) => Math.max(0, b - 1));
    if (key.pageUp) return setBack((b) => Math.min(max, b + listH - 1));
    if (key.pageDown) return setBack((b) => Math.max(0, b - listH + 1));
    if (key.return) {
      const text = typedRef.current;
      if (!text.trim()) return;
      if (session.state !== 'open') return ctx.note(`The connection is ${session.state}: esc, then ↵ on the request opens it again.`, 'error');
      setTyped('');
      setBack(0);
      return ctx.sendOnSocket(session, text);
    }
    if (key.backspace || key.delete) return setTyped(typedRef.current.slice(0, -1));
    if (key.ctrl && input === 'u') return setTyped('');
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) setTyped(typedRef.current + text);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setBack((b) => Math.max(0, Math.min(max, b - e.wheel * 3)));
  });

  const state = { connecting: 'connecting…', open: 'open', closing: 'closing…', closed: 'closed' }[session.state];
  const shown = rows.slice(from, from + listH);
  const inputW = width - 6;
  return (
    <Panel title={title} hint={`${state} · ${session.sent} sent · ${session.received} received · ↵ send · esc close`} width={width} height={height} focused={active}>
      {shown.map((segs, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ' ' }, ...segs]} />
      ))}
      {Array.from({ length: Math.max(0, listH - shown.length) }, (_, i) => (
        <Row key={`blank${i}`} pointer={false} width={width - 2} segments={[]} />
      ))}
      <Row pointer={false} width={width - 2} segments={[{ text: '─'.repeat(Math.max(0, width - 2)), color: theme.border }]} />
      <Row
        pointer={false}
        width={width - 2}
        segments={[
          { text: ' > ', color: session.state === 'open' ? theme.accent : theme.dim, bold: true },
          { text: typed.slice(-Math.max(1, inputW - 1)) },
          { text: active ? '▏' : '' },
          { text: typed ? '' : session.state === 'open' ? 'type a message, ↵ sends it' : '', color: theme.dim },
        ]}
      />
    </Panel>
  );
}
