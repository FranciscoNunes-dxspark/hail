// Server-sent events (text/event-stream): read as the HTML standard has it, a field per line ("data:",
// "event:", "id:", "retry:"; a line starting with ":" is a comment) and a blank line ending each event.
// Pure.

/** Whether `headers` ([[name, value]]) say the body is an event stream. */
export const isEventStream = (headers) => /^\s*text\/event-stream/i.test(headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '');

/**
 * A reader to `push` text into as it comes; each push returns the events it completed: [{ id, event,
 * data, retry }] (`event` 'message' unless named, `id` the last one seen, as the standard keeps it).
 */
export function eventReader() {
  let buf = '';
  let cur = { data: [], event: null, retry: null };
  let lastId = null;
  return {
    push(text) {
      buf += text;
      const out = [];
      for (;;) {
        // A line ends at \r\n, \n or \r (a \r at the very end may be the first half of \r\n).
        const m = /\r\n|\n|\r/.exec(buf);
        if (!m || (m[0] === '\r' && m.index === buf.length - 1)) break;
        const line = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        if (line === '') {
          if (cur.data.length) out.push({ id: lastId, event: cur.event ?? 'message', data: cur.data.join('\n'), ...(cur.retry != null ? { retry: cur.retry } : {}) });
          cur = { data: [], event: null, retry: null };
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const name = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (name === 'data') cur.data.push(value);
        else if (name === 'event') cur.event = value;
        else if (name === 'id' && !value.includes('\0')) lastId = value;
        else if (name === 'retry' && /^\d+$/.test(value)) cur.retry = Number(value);
      }
      return out;
    },
  };
}

/** The whole events in `text` (an event-stream body, as kept): [{ id, event, data, retry }]. */
export const parseEvents = (text) => eventReader().push(String(text ?? ''));

/** Events as text to read: a line naming each (its number, event and id), then its data, JSON indented. */
export function eventsText(events) {
  return events
    .map((e, i) => {
      let data = e.data;
      if (/^\s*[[{]/.test(data)) {
        try {
          data = JSON.stringify(JSON.parse(data), null, 2);
        } catch {}
      }
      const head = [`#${i + 1}`, e.event !== 'message' ? `event: ${e.event}` : null, e.id != null ? `id: ${e.id}` : null, e.retry != null ? `retry: ${e.retry}` : null].filter(Boolean).join('  ');
      return `${head}\n${data}`;
    })
    .join('\n\n');
}
