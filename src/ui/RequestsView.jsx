import React from 'react';
import { useInput } from 'ink';
import { copyCurl, send } from '../actions.js';
import { theme } from '../theme.js';
import { fit } from '../text.js';
import { useListNav, useMouse } from './hooks.js';
import { Lines, Panel, Row } from './parts.jsx';
import { methodColour, requestLines, responseLines, statusColour } from './response.js';

/** The file's requests, with the one under the cursor beside them: its response once sent, else the request itself. */
export function RequestsView({ data, responses, ctx, width, height, active }) {
  const requests = data.requests;
  const innerH = height - 2;
  const listW = Math.max(30, Math.floor(width * 0.4));
  // Back from another tab, on the request it was on.
  const nav = useListNav(requests.length, innerH, { resetKey: data.path, start: Math.min(ctx.selectedIndex(), Math.max(0, requests.length - 1)) });
  const sel = requests[nav.index];
  ctx.selectRequest(nav.index);
  const sent = sel ? responses[sel.label] : null;

  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    if (nav.handle(input, key)) return;
    if (!sel) return;
    if (key.return) send(ctx, sel);
    else if (input === 'c') copyCurl(ctx, sel);
    else if (input === 'y') ctx.copy(sel.url);
    // The Edit view, typing, with the cursor on this request.
    else if (input === 'i') {
      ctx.setView('edit');
      ctx.setEditing(true);
    }
    else if (input === 'v' && sent) ctx.setView('response');
  };
  useInput(keys, { isActive: active });
  useMouse(ctx, (e) => {
    if (e.x >= listW) return;
    if (e.wheel) return nav.scrollBy(e.wheel * 3);
    if (nav.pick(e.y - 1) && e.double) keys('', { return: true });
  });

  const paneW = width - listW;
  const lines = !sel ? [] : sent ? responseLines(sent, paneW - 4) : requestLines(sel, paneW - 4);
  return (
    <>
      <Panel title={data.name} hint={`${requests.length}`} width={listW} height={height} focused={active}>
        {requests.length === 0 ? <Row pointer={false} width={listW - 2} segments={[{ text: '  No requests yet: ### starts one.', color: theme.dim }]} /> : null}
        {requests.slice(nav.offset, nav.offset + innerH).map((r, i) => {
          const done = responses[r.label]?.response;
          return (
            <Row
              key={r.index}
              width={listW - 2}
              selected={nav.offset + i === nav.index}
              focused={active}
              segments={[
                { text: fit(r.method, 7), color: methodColour(r.method), bold: true },
                { text: done ? `${done.status} ` : '', color: done ? statusColour(done.status) : undefined },
                { text: r.name ?? r.url, strong: true },
              ]}
            />
          );
        })}
      </Panel>
      <Panel title={sent ? 'Response' : 'Request'} hint={sent ? 'v full view' : '↵ send'} width={paneW} height={height}>
        <Lines lines={lines.map((segs) => [{ text: ' ' }, ...segs])} width={paneW - 2} height={innerH} />
      </Panel>
    </>
  );
}
