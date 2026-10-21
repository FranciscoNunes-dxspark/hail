import React, { useRef, useState } from 'react';
import { useInput } from 'ink';
import { theme } from '../theme.js';
import { useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { responseLines } from './response.js';

/** The response to the request picked in Requests, the whole width: scrolls, h shows the headers, y copies the body. */
export function ResponseView({ request, sent, ctx, width, height, active }) {
  const innerH = height - 2;
  const [headers, setHeaders] = useState(false);
  const [top, setTopState] = useState(0);
  const topRef = useRef(0);
  const lines = sent ? responseLines(sent, width - 4, { headers }) : [];
  const max = Math.max(0, lines.length - innerH);
  const setTop = (n) => {
    topRef.current = Math.max(0, Math.min(max, n));
    setTopState(topRef.current);
  };

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
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
  const title = request ? `${request.method} ${request.name ?? request.url}` : 'Response';
  return (
    <Panel title={title} hint={sent ? `${lines.length > innerH ? `${shown + 1}/${lines.length} · ` : ''}h headers · ↵ send again` : ''} width={width} height={height} focused={active}>
      {sent ? (
        <Lines lines={lines.map((segs) => [{ text: ' ' }, ...segs])} width={width - 2} height={innerH} offset={shown} />
      ) : (
        <Row pointer={false} width={width - 2} segments={[{ text: request ? '  Not sent yet: ↵ sends it.' : '  Open a .http file to send its requests.', color: theme.dim }]} />
      )}
    </Panel>
  );
}
