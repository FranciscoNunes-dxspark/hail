import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, useInput, useStdin } from 'ink';
import { copyCurl, send } from '../actions.js';
import { accept, completeAt } from '../complete.js';
import * as ed from '../editor.js';
import { blockAt, highlight } from '../http-file.js';
import { fit } from '../text.js';
import { theme } from '../theme.js';
import { atLeast } from '../mouse.js';
import { useMouse } from './hooks.js';
import { Lines, Panel } from './parts.jsx';
import { methodColour, responseLines } from './response.js';

const COLORS = () => ({
  separator: theme.accent,
  comment: theme.dim,
  variable: theme.info,
  url: undefined,
  version: theme.dim,
  header: theme.info,
  value: undefined,
  file: theme.info,
  handler: theme.add,
  placeholder: theme.warn,
  directive: theme.bangMode,
  boundary: theme.accent,
  keyword: theme.bangMode,
});
const KIND_COLORS = () => ({ environment: theme.warn, file: theme.info, response: theme.add, builtin: theme.bangMode, header: theme.info, value: undefined });
const MENU_ROWS = 8;
// Typing one of these keeps the suggestions coming; anything else (a space, a bracket) closes them.
const WORD_CHAR = /^[\w$.{-]$/;
// ctrl+backspace arrives as \b where backspace is \x7f: everywhere but Windows's console without VT
// input (Node before 22.17), which sends \b for backspace itself. alt+backspace works everywhere.
const CTRL_BACKSPACE = process.platform !== 'win32' || typeof Bun !== 'undefined' || atLeast(process.version, 22, 17);

/** Lays `add` over a row of segments from column `x`, padding the row when it's shorter. */
function overlay(segs, x, add) {
  const cells = segs.flatMap((s) => [...s.text].map((ch) => ({ ...s, text: ch })));
  while (cells.length < x) cells.push({ text: ' ' });
  const top = add.flatMap((s) => [...s.text].map((ch) => ({ ...s, text: ch })));
  cells.splice(x, top.length, ...top);
  const out = [];
  for (const c of cells) {
    const last = out.at(-1);
    if (last && last.color === c.color && last.bg === c.bg && last.bold === c.bold && !last.cursor && !c.cursor) last.text += c.text;
    else out.push({ ...c });
  }
  return out;
}

/** The request the cursor is in: the one whose block (### to ###) holds the cursor's line, or null. */
export function requestAtCursor(requests, editor) {
  const { start, end } = blockAt(editor.lines, editor.row);
  return requests.find((r) => r.line - 1 >= start && r.line - 1 <= end) ?? null;
}

/**
 * The file itself, to edit: ↵ or i starts typing and esc stops, so the number keys and q are text
 * while typing and views or quit otherwise. It's saved as you type; ctrl+r sends the request the
 * cursor is in, and what came back shows beside the text.
 */
export function EditView({ data, responses, editor, editing, ctx, width, height, active }) {
  const top = useRef(0);
  const left = useRef(0);
  const text = ed.toText(editor);
  const lines = useMemo(() => highlight(text), [text]);
  const innerH = height - 2;
  // The response beside the text when there's room for both.
  const paneW = width >= 100 ? Math.floor(width * 0.4) : 0;
  const editW = width - paneW;
  const gutterW = String(editor.lines.length).length + 2;
  const textW = Math.max(10, editW - 2 - gutterW);
  const colors = COLORS();
  // The request picked in Requests when this came on screen, before the cursor's takes its place.
  const picked = useRef(ctx.selectedRequest());
  const current = requestAtCursor(data.requests, editor);
  const block = current ? blockAt(editor.lines, editor.row) : null;
  if (current) ctx.selectRequest(current.index);
  const sent = current ? responses[current.label] : null;

  // Back from Requests on another request than the cursor's: the cursor goes to it.
  useEffect(() => {
    const r = picked.current;
    if (r && r.index !== requestAtCursor(ctx.data.requests, ctx.editor)?.index) ctx.setEditor({ lines: ctx.editor.lines, row: r.line - 1, col: 0 });
  }, []);

  // Scrolled with the wheel, the text stays where it was put, the cursor out of sight if need be,
  // until a key changes the text, moves the cursor or starts or stops typing.
  const free = useRef(null);
  const [, setScrolled] = useState(0);
  if (free.current && (free.current.editor !== editor || free.current.editing !== editing)) free.current = null;
  if (!free.current) {
    if (editor.row < top.current) top.current = editor.row;
    if (editor.row >= top.current + innerH) top.current = editor.row - innerH + 1;
    if (editor.col < left.current) left.current = editor.col;
    if (editor.col >= left.current + textW) left.current = editor.col - textW + 1;
  }

  const set = (next) => ctx.setEditor(next);
  const sendCurrent = () => {
    const r = requestAtCursor(ctx.data.requests, ctx.editor);
    return r ? send(ctx, r) : ctx.note('The cursor isn\'t in a request: ### starts one.', 'error');
  };
  // ### lines, the one before the cursor's block or after it.
  const jump = (dir) => {
    const e = ctx.editor;
    const { start, end } = blockAt(e.lines, e.row);
    const row = dir < 0 ? (start > 0 ? blockAt(e.lines, start - 1).start : 0) : end + 1;
    if (row < e.lines.length) set({ lines: e.lines, row, col: 0 });
  };
  const sources = () => {
    const s = ctx.scope();
    return { environment: s.environment, file: s.file, requests: ctx.data.requests.filter((r) => r.name).map((r) => r.name) };
  };

  // The suggestions under the cursor while typing: { index, force, moved } or null when closed.
  // The list itself is worked out from the text each time, so it can't fall behind the typing.
  const [menu, setMenuState] = useState(null);
  const menuRef = useRef(null);
  const setMenu = (next) => {
    menuRef.current = next;
    setMenuState(next);
  };

  // Keys while not typing: start typing, send, and move about.
  const keys = (input, key) => {
    if (!ctx.viewHasKeys()) return;
    const editor = ctx.editor;
    if (key.return || input === 'i') return ctx.setEditing(true);
    if (key.ctrl && input === 'r') return sendCurrent();
    if (key.ctrl && input === 's') return ctx.saveEditor();
    if (key.ctrl && input === 'z') return ctx.undoEdit();
    if (key.ctrl && input === 'y') return ctx.redoEdit();
    if (key.ctrl && input === 'f') return ctx.prefill('/find ');
    if (input === 'n' || input === 'N') return ctx.findInEditor('', { back: input === 'N' });
    if (input === 'c') {
      const r = requestAtCursor(ctx.data.requests, editor);
      return r ? copyCurl(ctx, r) : undefined;
    }
    if (input === 'v' && sent) return ctx.setView('response');
    if (input === '[' || input === ']') return jump(input === '[' ? -1 : 1);
    if (key.downArrow || input === 'j') return set(ed.move(editor, { rows: 1 }));
    if (key.upArrow || input === 'k') return set(ed.move(editor, { rows: -1 }));
    if (key.leftArrow || input === 'h') return set(ed.move(editor, { cols: -1 }));
    if (key.rightArrow || input === 'l') return set(ed.move(editor, { cols: 1 }));
    if (key.pageDown) return set(ed.move(editor, { rows: innerH - 1 }));
    if (key.pageUp) return set(ed.move(editor, { rows: -(innerH - 1) }));
    if (input === 'g') return set({ lines: editor.lines, row: 0, col: 0 });
    if (input === 'G') return set({ lines: editor.lines, row: editor.lines.length - 1, col: 0 });
  };
  useInput(keys, { isActive: active && !editing });

  // The mouse, typing or not. The text starts under the top border, after the border and the gutter.
  // A click puts the cursor on the character under it and starts typing, a double-click selects the
  // word and a triple the line, and one on a suggestion takes it. A drag selects the text it covers
  // (and copies it).
  const popupRef = useRef(null);
  const dragFrom = useRef(null);
  const cellAt = (editor, x, y) => ed.clickAt(editor, top.current + y - 1, x - 1 - gutterW, { left: left.current });
  useMouse(
    ctx,
    (e) => {
      if (e.x >= editW) return;
      const editor = ctx.editor;
      if (e.wheel) {
        top.current = Math.max(0, Math.min(top.current + e.wheel * 3, editor.lines.length - innerH));
        free.current = { editor, editing };
        return setScrolled((n) => n + 1);
      }
      if (e.drag) {
        setMenu(null);
        ctx.setEditing(true);
        dragFrom.current ??= cellAt(editor, e.from.x, e.from.y);
        const next = { ...cellAt(editor, e.x, e.y), anchor: { row: dragFrom.current.row, col: dragFrom.current.col } };
        set(next);
        if (!e.release) return;
        dragFrom.current = null;
        const sel = ed.selectedText(next);
        if (sel?.text) ctx.copySelection(sel.text);
        return;
      }
      if (e.y < 1 || e.y > innerH) return;
      const pop = popupRef.current;
      const k = e.y - 1 - (pop?.y ?? 0);
      if (pop?.items && k >= 0 && k < pop.items.length && e.x - 1 >= pop.x && e.x - 1 < pop.x + pop.w) {
        set(accept(editor, pop.completion, pop.items[k]));
        return setMenu(null);
      }
      setMenu(null);
      ctx.setEditing(true);
      const at = cellAt(editor, e.x, e.y);
      set(e.triple ? ed.selectLine(at) : e.double ? ed.selectWord(at) : at);
    },
    { drags: (e) => e.x < editW && e.y >= 1 && e.y <= innerH },
  );

  // Ink reports backspace (\x7f in most terminals) and the delete key (ESC [3~) both as key.delete, so
  // the key's own bytes, which Ink hands its input listeners one key at a time, tell them apart. This
  // listener comes before the one below, so it has the key first.
  const { internal_eventEmitter: inputs } = useStdin();
  const rawKey = useRef('');
  useEffect(() => {
    if (!inputs) return;
    const note = (data) => {
      rawKey.current = data;
    };
    inputs.on('input', note);
    return () => inputs.off('input', note);
  }, [inputs]);

  // Keys while typing. Ink gives a paste as one input; insert() splits its lines.
  useInput(
    (input, key) => {
      if (!ctx.editorHasKeys()) return;
      // Edit the latest text, not this render's: fast typing outruns re-rendering.
      const editor = ctx.editor;
      const open = menuRef.current;
      const completion = open && completeAt(editor, sources(), { force: open.force });
      const items = completion?.items ?? [];
      if (items.length) {
        // tab takes the suggestion; ↵ only once one was picked with ↑↓ (or asked for with ctrl+n),
        // so ↵ after a word still starts a new line.
        const pick = items[Math.min(open.index, items.length - 1)];
        if (key.escape) return setMenu(null);
        if (key.upArrow || key.downArrow) return setMenu({ ...open, index: (open.index + (key.upArrow ? items.length - 1 : 1)) % items.length, moved: true });
        if (key.tab || (key.return && (open.moved || open.force))) {
          set(accept(editor, completion, pick));
          // A response's path goes on: login.response.body. waits for the field.
          return setMenu(pick.insert.endsWith('.') ? { index: 0 } : null);
        }
      }
      // ctrl+n asks for suggestions anywhere. So does ctrl+space where the terminal sends it as NUL.
      if (key.ctrl && (input === 'n' || input === '`' || input === '@')) return setMenu({ index: 0, force: true });
      if (open) setMenu(null);
      // esc lets go of a selection first, then stops typing.
      if (key.escape && ed.selection(editor)) return set({ lines: editor.lines, row: editor.row, col: editor.col });
      // ctrl+c copies the selection; with nothing selected it stops typing, as esc does.
      if (key.ctrl && input === 'c' && ed.selection(editor)) return ctx.copySelection(ed.selectedText(editor).text);
      if (key.escape || (key.ctrl && input === 'c')) return ctx.setEditing(false);
      if (key.ctrl && input === 'r') return sendCurrent();
      if (key.ctrl && input === 's') return ctx.saveEditor();
      if (key.ctrl && input === 'z') return ctx.undoEdit();
      if (key.ctrl && input === 'y') return ctx.redoEdit();
      if (key.return) return set(ed.newline(editor));
      if (key.backspace || key.delete) {
        const forward = key.delete && rawKey.current.startsWith('\x1b[3');
        // A word at a time: ctrl+delete forward; ctrl+backspace or alt+backspace back.
        const word = forward ? key.ctrl : key.meta || (CTRL_BACKSPACE && rawKey.current === '\b');
        const next = forward ? (word ? ed.deleteWordForward : ed.deleteForward) : word ? ed.deleteWordBack : ed.backspace;
        ctx.setEditor(next(editor), { merge: !word });
        return open ? setMenu({ index: 0, force: open.force }) : undefined;
      }
      // ctrl+/ (which terminals send as \x1f) comments the line, or the selected lines, out or back in.
      if (input === '\x1f' || (key.ctrl && input === '/')) return set(ed.toggleComment(editor));
      if (key.ctrl && input === 'd') return set(ed.duplicate(editor));
      // alt+↑/↓ moves the line (or the selected lines) up or down.
      if (key.meta && !key.shift && (key.upArrow || key.downArrow)) {
        const moved = ed.moveLines(editor, key.upArrow ? -1 : 1);
        return moved ? set(moved) : undefined;
      }
      // shift with a movement selects; ctrl moves (or with shift, selects) a word at a time, and with
      // home or end to the start or end of the text.
      const step =
        key.ctrl && (key.leftArrow || key.rightArrow)
          ? (e) => ed.wordMove(e, key.leftArrow ? -1 : 1)
          : key.leftArrow || key.rightArrow
            ? (e) => ed.move(e, { cols: key.leftArrow ? -1 : 1 })
            : key.upArrow || key.downArrow
              ? (e) => ed.move(e, { rows: key.upArrow ? -1 : 1 })
              : key.home
                ? key.ctrl ? ed.textStart : ed.lineStart
                : key.end
                  ? key.ctrl ? ed.textEnd : ed.lineEnd
                  : null;
      if (step && key.shift) return set(ed.extend(editor, step));
      if (step && key.ctrl) return set(step(editor));
      if (key.ctrl && input === 'w') return set(ed.deleteWordBack(editor));
      if (key.ctrl && input === 'x') {
        const cut = ed.cut(editor);
        if (!cut) return;
        set(cut.editor);
        return ctx.copySelection(cut.text, 'Cut');
      }
      if (key.ctrl && input === 'f') return ctx.prefill('/find ');
      if (key.leftArrow) return set(ed.move(editor, { cols: -1 }));
      if (key.rightArrow) return set(ed.move(editor, { cols: 1 }));
      if (key.upArrow) return set(ed.move(editor, { rows: -1 }));
      if (key.downArrow) return set(ed.move(editor, { rows: 1 }));
      if (key.pageUp) return set(ed.move(editor, { rows: -(innerH - 1) }));
      if (key.pageDown) return set(ed.move(editor, { rows: innerH - 1 }));
      if (key.ctrl && input === 'a') return set(ed.selectAll(editor));
      if (key.home) return set(ed.lineStart(editor));
      if (key.end || (key.ctrl && input === 'e')) return set(ed.lineEnd(editor));
      if (key.ctrl && input === 'u') return set(ed.killLine(editor));
      if (key.ctrl && input === 'k') return set(ed.killLine(editor, { toEnd: true }));
      if (key.tab) {
        // tab and shift+tab indent the selected lines; shift+tab alone takes the cursor's line back.
        const sel = ed.selection(editor);
        if (key.shift || (sel && sel.start.row !== sel.end.row)) return set(ed.indentLines(editor, key.shift ? -1 : 1));
        return set(ed.insert(editor, '  '));
      }
      if (key.ctrl || key.meta || !input) return;
      const typed = input.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, '');
      if (!typed) return;
      // One character of a word joins the undo step before it; a space, or a paste, starts one.
      ctx.setEditor(ed.insert(editor, typed), { merge: typed.length === 1 && typed !== ' ' });
      if (WORD_CHAR.test(typed)) setMenu({ index: 0 });
    },
    { isActive: active && editing },
  );

  // The suggestions, drawn over the text under the word being typed (above it near the bottom).
  const completion = editing && menu ? completeAt(editor, sources(), { force: menu.force }) : null;
  const items = completion?.items ?? [];
  let popup = null;
  if (items.length) {
    const y = editor.row - top.current;
    const room = Math.max(innerH - y - 1, y);
    const shown = Math.min(MENU_ROWS, items.length, room);
    const sel = Math.min(menu.index, items.length - 1);
    const first = Math.max(0, Math.min(sel - shown + 1, items.length - shown));
    const visible = items.slice(first, first + shown);
    const labelW = Math.min(36, Math.max(...visible.map((i) => i.label.length)));
    const detailW = Math.min(28, Math.max(...visible.map((i) => i.detail.length)));
    const w = Math.min(textW, labelW + detailW + 4);
    const kinds = KIND_COLORS();
    popup = {
      y: innerH - y - 1 >= shown ? y + 1 : y - shown,
      x: gutterW + Math.max(0, Math.min(completion.from - left.current, textW - w)),
      // For clicks: what each line is, and how wide they all are.
      items: visible,
      completion,
      w,
      lines: visible.map((item, k) => {
        const on = first + k === sel;
        const bg = on ? theme.accent : theme.selBg;
        const label = fit(item.label, Math.max(1, Math.min(labelW, w - 2)));
        const detail = fit(item.detail, Math.max(0, w - 3 - label.length));
        return [
          { text: ` ${label} `, color: on ? theme.ink : item.kind === 'method' ? methodColour(item.label) : kinds[item.kind], bg, bold: on },
          { text: `${detail} `, color: on ? theme.ink : theme.dim, bg },
        ];
      }),
    };
  }
  popupRef.current = popup;

  const sel = ed.selection(editor);
  const rows = [];
  for (let i = top.current; i < Math.min(editor.lines.length, top.current + innerH); i++) {
    // The gutter marks the request ctrl+r sends.
    const inRequest = block && i >= block.start && i <= block.end;
    const gutter = [
      { text: inRequest ? '▌' : ' ', color: theme.accent },
      { text: `${String(i + 1).padStart(gutterW - 2)} `, color: i === editor.row ? theme.accent : theme.dim },
    ];
    // The visible slice of the line, coloured, with the cursor drawn in reverse while typing.
    const segs = [];
    let x = 0;
    for (const run of lines[i] ?? []) {
      const color = run.kind === 'method' ? methodColour(run.text.toUpperCase()) : colors[run.kind];
      const bold = run.kind === 'method' || run.kind === 'separator' || run.kind === 'keyword' || run.kind === 'boundary';
      for (const ch of run.text) {
        if (x >= left.current && x < left.current + textW) {
          const cursor = editing && i === editor.row && x === editor.col;
          const last = segs.at(-1);
          const bg = ed.isSelected(sel, i, x) ? theme.selBg : undefined;
          if (!cursor && last && !last.cursor && last.color === color && last.bg === bg && last.bold === bold) last.text += ch;
          else segs.push({ text: ch, color, cursor, bg, bold });
        }
        x++;
      }
    }
    if (editing && i === editor.row && editor.col >= x) segs.push({ text: ' ', cursor: true });
    let all = [...gutter, ...segs];
    const over = popup?.lines[i - top.current - popup.y];
    if (over) all = overlay(all, popup.x, over);
    rows.push(
      <Text key={i} wrap="truncate">
        {all.map((s, k) => (
          <Text key={k} color={s.color} backgroundColor={s.bg} bold={s.bold} inverse={s.cursor}>
            {s.text}
          </Text>
        ))}
      </Text>,
    );
  }
  // A list under the last line runs on into the empty space below it.
  if (popup) {
    for (let k = rows.length; k < Math.min(innerH, popup.y + popup.lines.length); k++) {
      const over = popup.lines[k - popup.y];
      const all = over ? overlay([], popup.x, over) : [{ text: '' }];
      rows.push(
        <Text key={`m${k}`} wrap="truncate">
          {all.map((s, j) => (
            <Text key={j} color={s.color} backgroundColor={s.bg} bold={s.bold}>
              {s.text}
            </Text>
          ))}
        </Text>,
      );
    }
  }

  // Short, beside the file's name: the bottom line has the keys.
  const hint = items.length
    ? 'tab take it · ↑↓ pick · esc close'
    : sel
      ? 'selected · ctrl+c copy · ctrl+x cut'
      : editing
        ? `line ${editor.row + 1}, column ${editor.col + 1}`
        : `${editor.lines.length} lines`;
  const pane = !paneW
    ? null
    : sent
      ? responseLines(sent, paneW - 4)
      : current
        ? [[{ text: 'ctrl+r sends ', color: theme.dim }, { text: current.label, bold: true }], [{ text: 'What comes back shows here.', color: theme.dim }]]
        : [[{ text: 'Put the cursor in a request (### starts one) to send it.', color: theme.dim }]];
  return (
    <>
      <Panel title={data.name} hint={hint} width={editW} height={height} focused={active}>
        {rows}
      </Panel>
      {pane ? (
        <Panel title={sent ? 'Response' : 'Request'} hint={sent ? 'v full view' : ''} width={paneW} height={height}>
          <Lines lines={pane.map((segs) => [{ text: ' ' }, ...segs])} width={paneW - 2} height={innerH} />
        </Panel>
      ) : null}
    </>
  );
}
