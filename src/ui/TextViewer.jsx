import React, { useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { wrap } from '../text.js';
import { useMouse } from './hooks.js';
import { Panel, Row } from './parts.jsx';

/** Text over the view (ctx.showText): a command's output, an item. Scrolls; esc or q closes it. */
export function TextViewer({ title, text, loading, ctx, width, height, active, onClose }) {
  const innerW = width - 4;
  const innerH = height - 2;
  const lines = loading ? ['Loading…'] : String(text ?? '').split('\n').flatMap((l) => (l ? wrap(l, innerW) : ['']));
  const [top, setTopState] = useState(0);
  const topRef = useRef(0);
  const max = Math.max(0, lines.length - innerH);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };

  const keys = (input, key) => {
    if (!ctx.overlayHasKeys()) return;
    if (key.escape || input === 'q') return onClose();
    if (input === 'j' || key.downArrow) return setTop(topRef.current + 1);
    if (input === 'k' || key.upArrow) return setTop(topRef.current - 1);
    if (input === ' ' || key.pageDown || (key.ctrl && input === 'd')) return setTop(topRef.current + innerH - 1);
    if (input === 'b' || key.pageUp || (key.ctrl && input === 'u')) return setTop(topRef.current - innerH + 1);
    if (input === 'g') return setTop(0);
    if (input === 'G') return setTop(max);
    if (input === 'y') return ctx.copy(String(text ?? ''), `${lines.length} line${lines.length === 1 ? '' : 's'}`);
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.wheel) setTop(topRef.current + e.wheel * 3);
  });

  const shown = Math.min(top, max);
  const pos = lines.length > innerH ? `${shown + 1}-${Math.min(lines.length, shown + innerH)}/${lines.length} · ` : '';
  return (
    <Panel title={title} hint={`${pos}esc close`} width={width} height={height} focused={active}>
      {lines.slice(shown, shown + innerH).map((l, i) => (
        <Row key={i} pointer={false} width={width - 2} segments={[{ text: ` ${l}`, color: loading ? theme.dim : undefined }]} />
      ))}
    </Panel>
  );
}
