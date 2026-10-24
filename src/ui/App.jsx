import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { readFileSync, watch, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { azToken as azCli } from '../azure.js';
import { osCredentials } from '../credentials.js';
import { appendHistory, clearHistory, entryFor, historyFile, latestByLabel, readHistory } from '../history.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import * as ed from '../editor.js';
import { parseHttpFile } from '../http-file.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '../help-layout.js';
import { findHttpFiles, loadHttpFile } from '../files.js';
import { defaultEnvironment } from '../environments.js';
import { createJar } from '../cookies.js';
import { createTokens } from '../oauth.js';
import { checkContract, loadContract } from '../contract.js';
import { contextIn, pastedLine, readMoods, writeMood } from '../family.js';
import { replaceBody } from '../takes.js';
import { worthNotifying } from '../notify.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { VERSION } from '../version.js';
import { useKeyTranslation, useTerminalSize } from './hooks.js';
import { keymapSection, parseKeymap, translateKey } from '../keymap.js';
import { expandLines, userCommands } from '../usercommands.js';
import { paletteItems } from '../palette.js';
import { Palette } from './Palette.jsx';
import { Confirm, Panel, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { HistoryView } from './HistoryView.jsx';
import { HelpView } from './HelpView.jsx';
import { LogView } from './LogView.jsx';
import { Picker } from './Picker.jsx';
import { RequestsView } from './RequestsView.jsx';
import { ResponseView } from './ResponseView.jsx';
import { EditView } from './EditView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { SocketView } from './SocketView.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, familyMood, moodFor, reactionLine } from '../pet.js';

const VIEWS = [
  { id: 'requests', label: 'Requests' },
  { id: 'edit', label: 'Edit' },
  { id: 'response', label: 'Response' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

const VIEW_LABELS = Object.fromEntries(VIEWS.map((v) => [v.id, v.label]));

// What ? shows: help.js's sections, the keys you mapped, then the slash commands, yours with them.
const helpSections = (user, keymap) => [...HELP, ...[keymapSection(keymap, VIEW_LABELS)].filter(Boolean), commandsSection([...COMMANDS, ...user])];

// ctrl+p, as the terminal sends it: the command palette.
const CTRL_P = '\x10';
// How often responses coming one after another redraw the screen, in milliseconds.
const SHOW_EVERY = 100;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const HINTS = {
  requests: '↵ send · A send all · L load · I import curl · i edit it · c copy as curl · y copy the URL · v the response, full view · e environment',
  edit: '↵ or i type · ctrl+r send · ctrl+s save · ctrl+z undo · ctrl+f find · [ ] requests · c copy as curl',
  response: '↵ send again · h headers · y copy the body · j/k space scroll',
  history: '↵ show it · d compare with the one before · D forget them all',
  log: '↵ all its output · y copy it',
};

const firstLine = (s) => String(s ?? '').split('\n')[0];
// "3 lines" or "12 characters", for what was copied.
const copiedText = (text) => {
  const n = text.split('\n').length;
  return n > 1 ? `${n} lines` : `${text.length} character${text.length === 1 ? '' : 's'}`;
};

function Header({ data, env, width, loading, mood, mock }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Hail', bold: true },
  ];
  if (data) {
    segs.push({ text: '  │  ', color: theme.border }, { text: data.name, bold: true });
    segs.push({ text: '  env ', color: theme.dim }, { text: env ?? (data.environments.names.length ? 'none' : '—'), color: env ? theme.warn : theme.dim, bold: Boolean(env) });
    if (mock) segs.push({ text: '  mock ', color: theme.dim }, { text: `:${mock.port}`, color: theme.accent, bold: true });
  } else if (loading) segs.push({ text: '  loading…', color: theme.dim });
  const path = data?.dir ?? '';
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, Math.max(20, width - stringWidth(path) - 1)), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

/** The tabs' labels and the columns each one covers (`from` up to `to`), which clicks are matched against. */
function tabLabels(entries) {
  let x = 0;
  return VIEWS.map((v, i) => {
    let label = ` ${i + 1} ${v.label}`;
    if (v.id === 'log' && entries.length) label += ` ${entries.length}`;
    label += ' ';
    const from = x;
    x += stringWidth(label) + 1;
    return { id: v.id, label, from, to: from + stringWidth(label) };
  });
}

function Tabs({ view, entries, width }) {
  const segs = [];
  for (const t of tabLabels(entries)) {
    const on = t.id === view;
    segs.push({ text: t.label, bg: on ? theme.accent : undefined, color: on ? theme.ink : theme.dim, bold: on }, { text: ' ' });
  }
  return <Row pointer={false} width={width} segments={segs} />;
}

// The last two results, Claude Code style: "● node --version" then "  ⎿  output".
function activityRows(entries) {
  const out = [];
  for (const e of entries.slice(-2)) {
    const color = { error: theme.del, ok: theme.accent, running: theme.dim, info: theme.info }[e.status];
    out.push([{ text: `${BULLET} `, color }, { text: e.title, bold: e.status !== 'info' }]);
    const max = e.status === 'error' ? 3 : 2;
    e.lines.slice(0, max).forEach((l, i) =>
      out.push([{ text: i === 0 ? '  ⎿  ' : '     ', color: theme.dim }, { text: l, color: e.status === 'error' ? theme.del : theme.dim }]),
    );
    if (e.lines.length > max) out.push([{ text: '     ' }, { text: `… +${e.lines.length - max} lines (/last to see all)`, color: theme.dim }]);
  }
  return out.slice(-6);
}

const DOUBLE_CLICK_MS = 400;

// `initialFile` is the .http file to open (none: Hail says how to open or make one). `load` reads it
// (files.js's loadHttpFile; tests may pass their own), `azToken` answers {{$azToken}}, `credentials` keeps
// {{$secret}}s (credentials.js's; tests pass memoryCredentials), `askClaude` is claude.js's ask from cli.jsx
// (tests pass a stub; without it /draft says Claude isn't available). `mouse` is mouse.js's
// terminalMouse() from cli.jsx (missing where the terminal can't report it); tests pass their own.
// `copy` puts text on the clipboard (cli.jsx's; tests pass a stub). `checkUpdate` and `installUpdate`
// come only in the downloaded builds, so tests and checkouts never go online or replace anything.
// `notify(title, body)` says a long run has finished (cli.jsx rings the terminal's bell and raises a
// desktop notification); tests pass a recorder or nothing. `familyEvery` is how often (ms) the sibling
// apps' moods are read (family.js; FAMILY_HOME moves them, which tests do). `openUrl` opens a page in
// the browser (an OAuth sign-in; cli.jsx's browser.js), which tests stub.
export function App({ config: initialConfig, initialFile, load = loadHttpFile, azToken = azCli, credentials = osCredentials, askClaude, checkUpdate, installUpdate, setTitle, mouse, copy, notify, openUrl, familyEvery = 30_000 }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('requests');
  // What came back, by request label: { request, response, at }, `request` as it was sent.
  const [responses, setResponses] = useState({});
  const responsesRef = useRef({});
  // Cookie jars (cookies.js), one per file and environment, for as long as Hail runs.
  const jarsRef = useRef(new Map());
  // client.global.set's variables: kept for the open file until another is opened or Hail closes.
  const globalsRef = useRef({});
  // The open file's contract (/contract): where it's from, the document, and each response's check of it.
  const contractRef = useRef({ path: null, source: null, spec: null, error: null, checked: new WeakMap() });
  const [, setContractTick] = useState(0);
  const selectedRef = useRef(0);
  // Counts goToRequest's jumps, so the Requests view moves its cursor even while it's on screen.
  const [jump, setJump] = useState(0);
  // The History entry to put the cursor on (/take logline), counted so it moves even while on screen.
  const [historyFocus, setHistoryFocus] = useState(null);
  const fileRef = useRef(initialFile ?? null);
  // The responses kept for the open file, oldest first (history.js), and the file they're kept in.
  const [history, setHistory] = useState([]);
  const historyRef = useRef({ file: null, entries: [] });
  const [focus, setFocusState] = useState('view');
  const [prompt, setPromptState] = useState({ value: '', cursor: 0 });
  const [sugIndex, setSugIndex] = useState(0);
  const [overlay, setOverlayState] = useState(null);
  const [confirmReq, setConfirmReq] = useState(null);
  const [entries, setEntries] = useState([]);
  const [busy, setBusy] = useState(null);
  const [welcome, setWelcome] = useState(true);
  const [update, setUpdate] = useState(null);
  // /mock's server (mock.js), while it runs: shown in the header, stopped when Hail closes.
  const [mockServer, setMockServerState] = useState(null);
  const mockRef = useRef(null);
  useEffect(() => () => void mockRef.current?.close(), []);
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A sibling's mood Hoot remarks on (family.js's readMoods), once each, until esc.
  const [reaction, setReaction] = useState(null);
  const seenMoods = useRef(new Set());
  const familyOn = config.familyMoods !== false;
  useEffect(() => {
    if (!familyOn) return setReaction(null);
    const look = () => {
      const m = readMoods('hail').find((x) => reactionLine(x) && !seenMoods.current.has(`${x.app}:${x.at}`));
      if (!m) return;
      seenMoods.current.add(`${m.app}:${m.at}`);
      setReaction(m);
    };
    look();
    const t = setInterval(look, familyEvery);
    return () => clearInterval(t);
  }, [familyOn, familyEvery]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // Errors said and questions answered no, counted so a line of your own command knows it failed.
  const errorCount = useRef(0);
  const declines = useRef(0);
  // Your own commands and keys (the config's "commands" and "keys"), and what was wrong with them.
  const custom = useMemo(() => {
    const mine = userCommands(config.commands, COMMANDS.map((c) => c.name));
    const commands = mine.commands.map((c) => ({ ...c, run: (_, rest) => ctx.runUserCommand(c, rest) }));
    const keymap = parseKeymap(config.keys, VIEWS.map((v) => v.id));
    return { commands, keymap, sections: helpSections(commands, keymap), problems: [...mine.problems.map((p) => `commands: ${p}`), ...keymap.problems.map((p) => `keys: ${p}`)] };
  }, [config.commands, config.keys]);
  const customRef = useRef(custom);
  customRef.current = custom;
  const viewRef = useRef(view);
  viewRef.current = view;
  // A key picked in the palette, sent to the view once it's back on screen (the effect below).
  const pendingKey = useRef(null);

  // Async actions read the latest state through refs, not through stale closures.
  const dataRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const nextId = useRef(1);
  // OAuth tokens (oauth.js), in memory per file, environment and auth id; refresh tokens go to `credentials`.
  const tokensRef = useRef(null);
  tokensRef.current ??= createTokens({
    credentials,
    onSignIn: ({ id, how }) => how === 'signed in' && note(`Signed in with ${id}`, 'ok'),
    onNote: (text) => note(text, 'error'),
  });
  const historyPos = useRef(-1);
  // What /find (ctrl+f in the Edit view) looked for last, for n and N.
  const lastFind = useRef('');
  const lastOutput = useRef(null);
  // Counts keypresses, ahead of every handler, so the dispatcher can tell the key that opened the prompt.
  const keySeq = useRef(0);
  const prefillKey = useRef(-1);
  // The key that answered the last confirmation: it's that one's, and no other handler's.
  const answerKey = useRef(-1);
  const { internal_eventEmitter: inputEvents } = useStdin();
  useEffect(() => {
    if (!inputEvents) return;
    const count = () => keySeq.current++;
    inputEvents.prependListener('input', count);
    return () => inputEvents.removeListener('input', count);
  }, [inputEvents]);

  const setConfig = (update) => {
    const next = update(configRef.current);
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  };

  const focusRef = useRef('view');
  const overlayRef = useRef(null);
  const setFocus = (f) => {
    focusRef.current = f;
    setFocusState(f);
  };
  const setOverlay = (next) => {
    const cur = overlayRef.current;
    let o = typeof next === 'function' ? next(cur) : next;
    // An overlay opened from a picker goes back to the picker when closed.
    if (o && o !== cur && !o.back && cur?.kind === 'picker' && typeof next !== 'function') o = { ...o, back: cur };
    overlayRef.current = o;
    setOverlayState(o);
  };
  const pickerIds = useRef(0);

  const setPrompt = (value, cursor = value.length) => {
    promptRef.current = { value, cursor };
    setPromptState(promptRef.current);
  };

  const addEntry = (e) => {
    if (e.status === 'error') errorCount.current++;
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-99), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => {
    if (patch.status === 'error') errorCount.current++;
    setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));
  };

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  // The file as the Edit view has it: the text being edited, its undo steps, and what's on disk (the
  // text last read or written, and its line endings). Typing is saved a moment after it stops, and a
  // change made to the file elsewhere comes in when nothing typed is waiting to be saved.
  const [editor, setEditorState] = useState(() => ed.fromText(''));
  const editorRef = useRef(editor);
  const undoRef = useRef(ed.newHistory());
  const diskRef = useRef({ path: null, text: '', eol: '\n' });
  const saveTimer = useRef(null);
  const unsaved = () => Boolean(diskRef.current.path) && ed.toText(editorRef.current) !== diskRef.current.text;
  // Writes what's typed now, rather than when typing stops. False when it couldn't.
  const saveEditor = () => {
    clearTimeout(saveTimer.current);
    if (!unsaved()) return true;
    const disk = diskRef.current;
    const text = ed.toText(editorRef.current);
    try {
      writeFileSync(disk.path, disk.eol === '\n' ? text : text.replaceAll('\n', disk.eol));
      diskRef.current = { ...disk, text };
      return true;
    } catch (e) {
      note(`Couldn't save ${basename(disk.path)}: ${firstLine(e.message)}`, 'error');
      return false;
    }
  };
  // Every change to the text is a step ctrl+z can undo; `merge` (typing) joins the keystrokes of a
  // word into one. The requests are read from the text straight away, so ctrl+r sends what's on screen.
  const setEditor = (next, { merge = false, record = true } = {}) => {
    const prev = editorRef.current;
    const changed = next.lines !== prev.lines && ed.toText(next) !== ed.toText(prev);
    if (record && changed) undoRef.current = ed.record(undoRef.current, prev, { merge });
    editorRef.current = next;
    setEditorState(next);
    if (!changed || !dataRef.current) return;
    dataRef.current = { ...dataRef.current, ...parseHttpFile(ed.toText(next)) };
    setData(dataRef.current);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(saveEditor, 400);
  };
  const stepEditor = (step, nothing) => {
    const r = step(undoRef.current, editorRef.current);
    if (!r) return note(nothing);
    undoRef.current = r.history;
    setEditor(r.editor, { record: false });
  };
  // A file just read (`first`: opened) and the editor brought together: a new file's text goes into
  // it; then a change made elsewhere does, unless typing is waiting to be saved, whose requests count.
  const withEditor = (d, first) => {
    let raw = d.text;
    try {
      raw ??= readFileSync(d.path, 'utf8');
    } catch {
      raw = null;
    }
    const text = raw?.replace(/\r\n?/g, '\n') ?? '';
    if (first) {
      clearTimeout(saveTimer.current);
      // A file that can't be read is never written over.
      diskRef.current = { path: raw == null ? null : d.path, text, eol: /\r\n/.test(raw ?? '') ? '\r\n' : '\n' };
      undoRef.current = ed.newHistory();
      editorRef.current = ed.fromText(text);
      setEditorState(editorRef.current);
      return d;
    }
    if (unsaved()) return { ...d, ...parseHttpFile(ed.toText(editorRef.current)) };
    if (raw == null || text === diskRef.current.text) return d;
    diskRef.current = { ...diskRef.current, text };
    const prev = editorRef.current;
    const lines = ed.fromText(text).lines;
    const row = Math.min(prev.row, lines.length - 1);
    undoRef.current = ed.record(undoRef.current, prev);
    editorRef.current = { lines, row, col: Math.min(prev.col, lines[row].length) };
    setEditorState(editorRef.current);
    return d;
  };
  // What's typed is saved when Hail closes too.
  useEffect(() => () => saveEditor(), []);

  const reload = async () => {
    const file = fileRef.current;
    if (!file) return setLoading(false);
    try {
      const loaded = await load(file);
      if (fileRef.current !== file) return;
      const first = dataRef.current?.path !== loaded.path;
      const d = withEditor(loaded, first);
      dataRef.current = d;
      setData(d);
      // Opened: what came back last time, so the responses and their variables carry on.
      if (first) {
        const hf = historyFile(d.path);
        const entries = readHistory(hf);
        historyRef.current = { file: hf, entries };
        setHistory(entries);
        responsesRef.current = Object.fromEntries(Object.entries(latestByLabel(entries)).map(([label, e]) => [label, { request: e.request, response: e.response, at: e.at, checks: e.checks, saved: e.saved }]));
        setResponses(responsesRef.current);
        readContract(d);
      }
    } catch (e) {
      note(`Couldn't read ${basename(file)}: ${firstLine(e.message)}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  // The contract /contract set for file `d`, read when the file opens (and on r); a URL is fetched.
  const readContract = async (d) => {
    const source = configRef.current.contracts?.[d.path] ?? null;
    contractRef.current = { path: d.path, source, spec: null, error: null, checked: new WeakMap() };
    setContractTick((n) => n + 1);
    if (!source) return;
    try {
      const c = await loadContract(source, { dir: d.dir });
      if (contractRef.current.path !== d.path || contractRef.current.source !== source) return;
      contractRef.current = { ...contractRef.current, spec: c.spec, operations: c.operations };
    } catch (e) {
      if (contractRef.current.path !== d.path) return;
      contractRef.current = { ...contractRef.current, error: e.message };
      note(`The contract for ${d.name}: ${firstLine(e.message)}`, 'error');
    }
    setContractTick((n) => n + 1);
  };

  const openFile = async (file) => {
    saveEditor();
    fileRef.current = file;
    dataRef.current = null;
    setData(null);
    setLoading(true);
    responsesRef.current = {};
    setResponses({});
    globalsRef.current = {};
    selectedRef.current = 0;
    setOverlay(null);
    setView('requests');
    await reload();
    if (dataRef.current) setConfig((c) => ({ ...c, recent: [file, ...(c.recent ?? []).filter((f) => f !== file)].slice(0, 20) }));
  };

  // The environment picked for this file (kept in the config, by file), if it still has it.
  const environment = () => defaultEnvironment(dataRef.current, configRef.current.environments?.[dataRef.current?.path]);

  // One command at a time, with the spinner, esc to cancel, and a line in the activity log.
  // `start(signal)` resolves with { stdout, stderr }.
  const task = async (title, start, { label = 'Working', refresh = false } = {}) => {
    if (busyRef.current) {
      note(`Wait for "${busyRef.current.label}" to finish (esc cancels it).`, 'error');
      return { ok: false, error: new Error('busy') };
    }
    const controller = new AbortController();
    const b = { label, started: Date.now(), abort: () => controller.abort(), signal: controller.signal };
    busyRef.current = b;
    setBusy(b);
    const id = addEntry({ title, status: 'running' });
    setWelcome(false);
    // A long run that ends says so, for when you've looked away (Settings' "Notify when done").
    const tell = (line) => notify && worthNotifying(Date.now() - b.started, configRef.current) && notify(`Hail: ${title}`, line);
    try {
      // `worried`: it went, but not well (tests failed, the contract drifted), which Hoot shows.
      const { stdout = '', stderr = '', worried } = await start(controller.signal);
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'], ...(worried ? { worried } : {}) });
      tell(firstLine(out) || 'Done');
      return { ok: true, out };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      if (!error.cancelled) tell(firstLine(error.message));
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh) await reload();
    }
  };

  // A response on screen at once, and while they come quicker than that (A sends a file's worth) at
  // most every SHOW_EVERY ms, so a run isn't spent redrawing; the last always shows. What the screen
  // gets is the refs as they are then.
  const shownAt = useRef(0);
  const showTimer = useRef(null);
  const showResponses = () => {
    if (showTimer.current) return;
    const show = () => {
      showTimer.current = null;
      shownAt.current = Date.now();
      setResponses(responsesRef.current);
      setHistory(historyRef.current.entries);
    };
    const wait = shownAt.current + SHOW_EVERY - Date.now();
    if (wait <= 0) show();
    else showTimer.current = setTimeout(show, wait);
  };
  useEffect(() => () => clearTimeout(showTimer.current), []);

  // What the spinner says, changed while the task runs (/load's count).
  const setBusyLabel = (label) => {
    if (!busyRef.current) return;
    busyRef.current = { ...busyRef.current, label };
    setBusy(busyRef.current);
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  // A question that something else can also put away: { answer, close }. `answer` resolves with the
  // option picked, or 'closed' when `close()` took it away first (a device sign-in that finished).
  const notice = (req) => {
    let close;
    const answer = new Promise((done) => {
      const full = { options: [{ label: 'Cancel', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
      close = () => {
        if (confirmRef.current !== full) return;
        confirmRef.current = null;
        setConfirmReq(null);
        done('closed');
      };
    });
    return { answer, close };
  };
  // `fn(signal)` under the task running now (its esc cancels it), or, with none, as a task of its own
  // titled `title`: a sign-in that a send needs before it can go. A failure is said once, by the task.
  const withSignal = async (title, fn, { label, done = 'Done' } = {}) => {
    if (busyRef.current) return fn(busyRef.current.signal);
    let out;
    const r = await task(title, async (signal) => {
      out = await fn(signal);
      return { stdout: done };
    }, { label });
    if (!r.ok) throw Object.assign(r.error, { noted: true });
    return out;
  };
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    answerKey.current = keySeq.current;
    if (value === false || value == null) declines.current++;
    setConfirmReq(null);
    req?.done(value);
  };

  const prefill = (text, cursor = text.length) => {
    setPrompt(text, cursor);
    setSugIndex(0);
    historyPos.current = -1;
    setFocus('prompt');
    // Noted so that the key that did this isn't also typed into the prompt (see the dispatcher).
    prefillKey.current = keySeq.current;
  };

  const ctxRef = useRef(null);
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; }, get config() { return configRef.current; }, get editor() { return editorRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    task,
    setBusyLabel,
    openFile,
    environment,
    setEnvironment: (name) => {
      const path = dataRef.current?.path;
      if (!path) return;
      setConfig((c) => ({ ...c, environments: { ...c.environments, [path]: name } }));
      note(`Variables now come from ${name}`);
    },
    // Where {{variables}} come from: the environment, the file's @variables, the responses so far by name.
    scope: () => {
      const d = dataRef.current;
      const env = environment();
      const named = {};
      for (const r of d?.requests ?? []) if (r.name && responsesRef.current[r.label]) named[r.name] = responsesRef.current[r.label].response;
      return {
        globals: globalsRef.current,
        environment: d && env ? d.environments.vars(env) : (d?.environments.vars(null) ?? {}),
        file: d?.variables ?? {},
        responses: named,
        env: { azToken, secret: (name) => credentials.get(name), auth: (kind, id) => a.authToken(ctx, kind, id) },
      };
    },
    // The open file's contract: { source, spec, operations, error } (spec null without one).
    contract: () => contractRef.current,
    // /contract: `source` (null forgets it) and what loadContract read from it, kept for this file.
    setContract: (source, loaded = null) => {
      const path = dataRef.current?.path;
      if (!path) return;
      setConfig((c) => {
        const contracts = { ...c.contracts };
        if (source) contracts[path] = source;
        else delete contracts[path];
        return { ...c, contracts };
      });
      contractRef.current = { path, source, spec: loaded?.spec ?? null, operations: loaded?.operations, error: null, checked: new WeakMap() };
      setContractTick((n) => n + 1);
    },
    // How a response (`sent`: { request, response }) compares with the contract, worked out once; null without one.
    contractFor: (sent) => {
      const c = contractRef.current;
      if (!c.spec || !sent?.response || !sent.request) return null;
      if (!c.checked.has(sent.response)) c.checked.set(sent.response, checkContract(c.spec, sent.request, sent.response));
      return c.checked.get(sent.response);
    },
    // The environment's settings (environments.js's options): { insecure }.
    environmentOptions: () => dataRef.current?.environments.options?.(environment()) ?? {},
    // The cookies kept for the open file in the environment picked.
    cookieJar: () => {
      const key = `${dataRef.current?.path ?? ''}\n${environment() ?? ''}`;
      if (!jarsRef.current.has(key)) jarsRef.current.set(key, createJar());
      return jarsRef.current.get(key);
    },
    // The global variables response handlers set (client.global.set), for the open file while Hail runs.
    globals: () => globalsRef.current,
    setGlobals: (g) => (globalsRef.current = g),
    // Requests added to the end of the file (/import-curl), as typing them in Edit would: saved at once,
    // undone with ctrl+z. Resolves with the index of the first one added, or -1 with no file open.
    appendRequests: (block) => {
      if (!dataRef.current) return -1;
      const before = dataRef.current.requests.length;
      const cur = ed.toText(editorRef.current);
      const sep = !cur.trim() ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
      const next = ed.fromText(cur + sep + block);
      setEditor({ ...next, row: (cur + sep).split('\n').length - 1, col: 0 });
      saveEditor();
      return before;
    },
    // The body of `request` replaced by `body` (takes.js's replaceBody), as typing it in Edit would:
    // saved at once, undone with ctrl+z. False with no file open.
    replaceRequestBody: (request, body) => {
      if (!dataRef.current) return false;
      const r = replaceBody(editorRef.current.lines, request.line, body);
      setEditor({ lines: r.lines, row: r.row, col: 0 });
      saveEditor();
      return true;
    },
    // Puts the Requests view's cursor on request `i`, on screen.
    goToRequest: (i) => {
      selectedRef.current = i;
      setJump((n) => n + 1);
      setView('requests');
    },
    // The views say which request the cursor is on, so commands and the Response view act on it.
    selectRequest: (i) => (selectedRef.current = i),
    selectedRequest: () => dataRef.current?.requests[selectedRef.current] ?? null,
    selectedIndex: () => selectedRef.current,
    // `extra`: { checks, saved } (how its response handlers went, where >> saved its body).
    setResponse: (request, sentAs, response, extra = {}) => {
      const at = Date.now();
      responsesRef.current = { ...responsesRef.current, [request.label]: { request: sentAs, response, at, ...extra } };
      const h = historyRef.current;
      if (h.file) {
        const entry = entryFor({ label: request.label, name: request.name, at, request: sentAs, response, checks: extra.checks, saved: extra.saved });
        historyRef.current = { file: h.file, entries: appendHistory(h.file, entry, { entries: h.entries }) };
      }
      showResponses();
    },
    // An event stream's response so far, on screen while it comes; setResponse keeps the whole of it.
    setLiveResponse: (request, sentAs, partial) => {
      responsesRef.current = { ...responsesRef.current, [request.label]: { request: sentAs, response: partial, at: Date.now() } };
      showResponses();
    },
    view: () => viewRef.current,
    mockServer: () => mockRef.current,
    setMockServer: (m) => {
      mockRef.current = m;
      setMockServerState(m);
    },
    history: () => historyRef.current.entries,
    // The History view, its cursor on `entry`, and the entry shown.
    showHistoryEntry: (entry) => {
      setHistoryFocus((f) => ({ entry, n: (f?.n ?? 0) + 1 }));
      setView('history');
      a.showEntry(ctx, entry);
    },
    clearHistory: () => {
      const h = historyRef.current;
      if (h.file) clearHistory(h.file);
      historyRef.current = { file: h.file, entries: [] };
      setHistory([]);
      note('Forgot the responses kept for this file');
    },
    // A view that takes keys the app would otherwise use (the Response view's search) says so here.
    claimsKey: null,
    askSecret: (req) => confirm({ ...req, secret: true, options: [] }),
    notice,
    withSignal,
    tokens: tokensRef.current,
    openUrl,
    credentials,
    askClaude,
    send: (request) => a.send(ctx, request),
    note,
    confirm,
    prefill,
    reload,
    setView,
    // Whether this terminal can report the mouse at all (/settings says so).
    mouseAvailable: Boolean(mouse),
    // /update: asks for the latest release now, whatever the daily check last said, and installs it.
    updateNow: () => {
      if (!checkUpdate) return note(`This Hail (${VERSION}) runs from a checkout: git pull updates it.`);
      if (update?.state === 'installing') return note(`Hail ${update.latest} is being installed already.`);
      if (update?.state === 'installed') return note(`Hail ${update.latest} is installed. It starts the next time you open Hail.`);
      const said = (text) => ({ stdout: text, stderr: '' });
      return task(
        'Looking for a new version of Hail',
        async () => {
          const { checked, newer } = await checkUpdate(null);
          setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
          if (!newer) return said(`Hail ${VERSION} is the latest version.`);
          if (!installUpdate) {
            setUpdate({ ...checked, state: 'out' });
            return said(`Hail ${checked.latest} is out (you have ${VERSION}). Download it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installing' });
          try {
            await installUpdate(checked.latest);
          } catch (e) {
            setUpdate({ ...checked, state: 'out' });
            throw new Error(`Hail ${checked.latest} is out, but it couldn't be installed: ${firstLine(e.message)}\nDownload it from ${checked.url}`);
          }
          setUpdate({ ...checked, state: 'installed' });
          return said(`Hail ${checked.latest} is installed. It starts the next time you open Hail.`);
        },
        { label: 'Updating Hail' },
      );
    },
    // y in the views: `text` to the clipboard, said in the bottom line as "Copied <what>".
    copy: (text, what = text) => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `Copied ${what}` });
    },
    // The Edit view's text: changed (setEditor), saved now rather than when typing stops, and undone.
    setEditor,
    saveEditor: () => {
      if (!diskRef.current.path) return note("There's no file to save to.", 'error');
      if (saveEditor()) setFlash({ text: `Saved ${basename(diskRef.current.path)}` });
    },
    undoEdit: () => stepEditor(ed.undo, 'Nothing to undo.'),
    redoEdit: () => stepEditor(ed.redo, 'Nothing to redo.'),
    // Typing in the Edit view is a focus of its own. Stopping waits until this key has been handled
    // everywhere, so the esc (or ctrl+c) that ends typing isn't also taken as a global key.
    setEditing: (on) => (on ? setFocus('editor') : queueMicrotask(() => focusRef.current === 'editor' && setFocus('view'))),
    editorHasKeys: () => focusRef.current === 'editor' && !overlayRef.current && !confirmRef.current,
    // Text selected with the mouse in the Edit view, or cut with ctrl+x: copied, and said for a moment.
    copySelection: (text, verb = 'Copied') => {
      if (!copy) return note("Copying to the clipboard isn't available here.", 'error');
      copy(text);
      setFlash({ text: `${verb} ${copiedText(text)}` });
    },
    // /find and ctrl+f: the next place the text is in the file, selected (with `back`, the one before);
    // no text finds the last one again, as n and N do.
    findInEditor: (query, { back = false } = {}) => {
      if (!dataRef.current) return note('Open a .http file first: /open <file>, or /new for an example.', 'error');
      const q = query || lastFind.current;
      if (!q) return note('Nothing to find yet: ctrl+f (or /find <text>) asks for it.');
      lastFind.current = q;
      const found = ed.find(editorRef.current, q, { back });
      if (!found) return note(`"${q}" isn't in ${dataRef.current.name}.`, 'error');
      setEditor(found);
      setView('edit');
    },
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    refresh: async () => {
      await reload();
      if (dataRef.current) readContract(dataRef.current);
    },
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
    // A WebSocket's session (websocket.js), live over the view; it closes when the view does.
    showSocket: (session, title) => setOverlay({ kind: 'socket', session, title, onClosed: () => session.close() }),
    sendOnSocket: (session, text) => a.socketSend(ctx, session, text),
    // A list to pick from: { title, hint, items | load, onPick, keys, empty } (see Picker.jsx).
    // `replace`: swaps the picker on screen for this one (the same list, redrawn after a change), keeping
    // where it goes back to, instead of opening on top of it.
    showPicker: (picker, { replace = false } = {}) => {
      const next = { ...picker, kind: 'picker', id: ++pickerIds.current };
      if (replace) setOverlay((cur) => ({ ...next, back: cur?.back }));
      else setOverlay(next);
    },
    overlay: () => overlayRef.current,
    // Settings change through App's copy, the only one written to disk (ctx.config reads it).
    setConfig,
    closeOverlay: () => {
      const closing = overlayRef.current;
      // As a function, so a picker going back to another picker isn't given this one to return to.
      setOverlay((cur) => cur?.back ?? null);
      closing?.onClosed?.();
    },
    // On the section for the view on screen.
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(customRef.current.sections, view) }),
    // Your own command `cmd` (usercommands.js) with what was typed after it, and any line as typed at
    // the prompt; both resolve false when it failed.
    runUserCommand: (cmd, rest) => runUserCommand(cmd, rest),
    runLine: (text) => runLine(text),
    openPalette: () => openPalette(),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  // One line as typed at the prompt: a shell command after !, else a slash command. Resolves false
  // when it failed: it threw, said an error, or a question it asked was answered no (so your own
  // commands stop there).
  const runLine = async (text) => {
    const [errors, declined] = [errorCount.current, declines.current];
    try {
      let r;
      if (text.startsWith('!')) r = await a.raw(ctx, text.slice(1));
      // A sibling's context pasted at the prompt without /take (after a / or not).
      else if (contextIn(text.replace(/^\//, ''))) r = await a.take(ctx, text.replace(/^\//, ''));
      else {
        const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
        const cmd = findCommand(name, customRef.current.commands);
        if (!cmd) {
          note(`Unknown command: /${name}. Type / to see them all.`, 'error');
          return false;
        }
        r = await cmd.run(ctx, rest.trim());
      }
      return r !== false && r?.ok !== false && errorCount.current === errors && declines.current === declined;
    } catch (e) {
      note(firstLine(e.message), 'error');
      return false;
    }
  };

  // One of your own commands: its lines in order, with what was typed after it filled in, stopping at
  // the first that fails. Commands of yours may run each other, but not round in a circle.
  const userDepth = useRef(0);
  const runUserCommand = async (cmd, rest) => {
    if (userDepth.current >= 5) {
      note(`/${cmd.name}: your commands run each other round in a circle, so it stopped.`, 'error');
      return false;
    }
    const lines = expandLines(cmd, rest);
    userDepth.current++;
    try {
      for (const [i, line] of lines.entries()) {
        if (await runLine(line)) continue;
        if (i < lines.length - 1) note(`/${cmd.name} stopped at ${line}: the ${plural(lines.length - i - 1, 'line')} after it didn't run.`, 'error');
        return false;
      }
      return true;
    } finally {
      userDepth.current--;
    }
  };

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    await runLine(text);
  };

  // ctrl+p: the palette, over the view, starting from what's typed in the prompt when it's open there.
  const openPalette = () => {
    const typed = focusRef.current === 'prompt' ? promptRef.current.value.trim() : '';
    if (focusRef.current === 'prompt') setFocus('view');
    setOverlay({ kind: 'palette', query: typed.startsWith('!') ? '' : typed.replace(/^\//, '') });
  };
  // What's picked in it: a key goes to the view, a command runs, or waits in the prompt for what it
  // takes. After every handler has had the ↵ that picked it, so it isn't also the prompt's.
  const runPicked = (it) =>
    queueMicrotask(() => {
      ctx.closeOverlay();
      if (it.key) pendingKey.current = it.key.seq;
      else if (it.ask) prefill(`${it.command} `);
      else runLine(it.command);
    });

  // Your keys, where they come in: while a view has the keys (never while typing, in a confirm or
  // over an overlay), a key you mapped becomes the key it stands for, for the view and App alike, or
  // runs its command line. Then ctrl+p opens the palette, from a view or the prompt.
  const sendKey = useKeyTranslation((input) => {
    // A paste while a view has the keys: a command line (or a sibling's context) goes into the prompt,
    // for ↵, rather than being taken as keys. Not while typing in Edit, or over an overlay.
    // (A terminal ends a pasted line with \r, which the family's rule takes as a \n.)
    const text = focusRef.current === 'view' && !overlayRef.current && !confirmRef.current ? pastedLine(input) : null;
    if (text) {
      setPrompt(text.replace(/[\x00-\x1f\x7f]/g, ''));
      setSugIndex(0);
      historyPos.current = -1;
      setFocus('prompt');
      return null;
    }
    let out = input;
    if (focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && !ctx.claimsKey?.(input, {})) {
      const b = translateKey(customRef.current.keymap, viewRef.current, input);
      if (b?.command) {
        queueMicrotask(() => runLine(b.command));
        return null;
      }
      if (b?.key) out = b.key.seq;
    }
    if (out === CTRL_P && !overlayRef.current && !confirmRef.current && (focusRef.current === 'view' || focusRef.current === 'prompt')) {
      openPalette();
      return null;
    }
    return out;
  });
  useEffect(() => {
    if (pendingKey.current == null || overlayRef.current) return;
    const k = pendingKey.current;
    pendingKey.current = null;
    sendKey(k);
  });

  useEffect(() => {
    if (custom.problems.length) {
      const text = ['Some of your commands or keys in the config were left out:', ...custom.problems].join('\n');
      note(text, 'error');
      lastOutput.current = { title: 'Your commands and keys', text };
    }
    (async () => {
      await reload();
      if (!fileRef.current) note('No .http file here. /new writes an example to start from; /open <file> opens one.');
      // After the first load, so it doesn't slow it down.
      if (checkUpdate && configRef.current.checkForUpdates !== false) {
        checkUpdate(configRef.current.lastUpdateCheck).then(
          ({ checked, newer }) => {
            setConfig((c) => ({ ...c, lastUpdateCheck: checked }));
            if (!newer) return;
            const outNote = (why = '') => note(`Hail ${checked.latest} is out (you have ${VERSION})${why}.\nDownload it from ${checked.url}`);
            if (!installUpdate || configRef.current.autoUpdate === false) {
              setUpdate({ ...checked, state: 'out' });
              return outNote();
            }
            // In the background, without the spinner: nothing waits on it, and it only counts from the next start.
            setUpdate({ ...checked, state: 'installing' });
            installUpdate(checked.latest).then(
              () => {
                setUpdate({ ...checked, state: 'installed' });
                note(`Hail ${checked.latest} is installed. It starts the next time you open Hail.`);
              },
              (e) => {
                setUpdate({ ...checked, state: 'out' });
                outNote(`, but it couldn't be installed: ${firstLine(e.message)}`);
              },
            );
          },
          // Offline, or no way to ask: try again next time.
          () => {},
        );
      }
    })();
  }, []);

  // The file reloads when it's saved, so it can be edited beside Hail.
  useEffect(() => {
    if (!data?.path) return;
    let t;
    let watcher;
    try {
      watcher = watch(data.dir, (_, name) => {
        if (name && name !== data.name && !/http-client(\.private)?\.env\.json$/.test(name)) return;
        clearTimeout(t);
        t = setTimeout(() => reload(), 150);
      });
    } catch {
      // Some file systems can't be watched; r reloads.
      return;
    }
    return () => {
      clearTimeout(t);
      watcher.close();
    };
  }, [data?.path]);

  // cli.jsx passes the terminal's title setter; tests pass a stub or nothing.
  const title = data ? `${data.name} — Hail` : 'Hail';
  useEffect(() => {
    setTitle?.(title);
  }, [title]);

  // .http files to /open, looked for while that's being typed.
  const files = focus === 'prompt' && prompt.value.startsWith('/open ') ? findHttpFiles(process.cwd()) : [];
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { user: customRef.current.commands, data, files, environment: environment() }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { user: customRef.current.commands, data: dataRef.current, files: value.startsWith('/open ') ? findHttpFiles(process.cwd()) : [], environment: environment() });
    const pick = items[Math.min(sugIndex, items.length - 1)];
    const edit = (v, c) => {
      setPrompt(v, c);
      setSugIndex(0);
    };
    if (key.ctrl && input === 'c') return value ? edit('', 0) : exit();
    if (key.escape) return setFocus('view');
    if (key.return) {
      if (pick && value.trim() !== pick.insert.trim()) return pick.run ? submit(pick.insert) : edit(pick.insert);
      return submit(value);
    }
    if (key.tab) return pick ? edit(pick.insert) : undefined;
    if (key.upArrow || key.downArrow) {
      if (items.length) return setSugIndex((s) => (s + (key.upArrow ? items.length - 1 : 1)) % items.length);
      const history = configRef.current.history ?? [];
      const pos = Math.max(-1, Math.min(history.length - 1, historyPos.current + (key.upArrow ? 1 : -1)));
      historyPos.current = pos;
      return setPrompt(pos < 0 ? '' : history[pos]);
    }
    if (key.leftArrow) return setPrompt(value, Math.max(0, cursor - 1));
    if (key.rightArrow) return setPrompt(value, Math.min(value.length, cursor + 1));
    // Most terminals send DEL for backspace, which Ink reports as `delete`.
    if (key.backspace || key.delete) {
      if (!value) return setFocus('view');
      if (cursor > 0) edit(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (key.ctrl && input === 'a') return setPrompt(value, 0);
    if (key.ctrl && input === 'e') return setPrompt(value, value.length);
    if (key.ctrl && input === 'u') return edit(value.slice(cursor), 0);
    if (key.ctrl && input === 'w') {
      const start = value.slice(0, cursor).replace(/\S+\s*$/, '').length;
      return edit(value.slice(0, start) + value.slice(cursor), start);
    }
    if (key.ctrl || key.meta || !input) return;
    const text = input.replace(/[\r\n]+/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (text) edit(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  // Keys that work in every view.
  const globalKeys = (input, key) => {
    if (key.escape) {
      if (busyRef.current) busyRef.current.abort();
      else {
        setEntries((list) => list.map((e) => ({ ...e, shown: false })));
        setWelcome(false);
        setReaction(null);
      }
      return;
    }
    if (input === '/' || input === ':') return prefill('/');
    if (input === '!') return prefill('!');
    if (input === '?') return ctx.showHelp();
    if (input === ',') return a.settings(ctx);
    if (input === 'q') return exit();
    const n = Number(input);
    if (n >= 1 && n <= VIEWS.length) return setView(VIEWS[n - 1].id);
    if (key.tab) {
      const i = VIEWS.findIndex((v) => v.id === view);
      return setView(VIEWS[(i + (key.shift ? VIEWS.length - 1 : 1)) % VIEWS.length].id);
    }
    if (input === 'r') return ctx.refresh();
    if (input === 'e') return a.chooseEnvironment(ctx);
  };

  // One dispatcher reading focus from refs, which change the instant focus moves. Handlers that
  // switch on with the next render would let fast typing (or a paste) after "/" leak into the view.
  useInput((input, key) => {
    // Ink calls the handlers for a key in no fixed order. When a view's ran first and opened the prompt,
    // this same key mustn't then be typed into it.
    if (focusRef.current === 'prompt' && !confirmRef.current) return prefillKey.current === keySeq.current ? undefined : promptKeys(input, key);
    // While typing in the Edit view, every key is the editor's: the digits, q, ctrl+c too.
    if (focusRef.current === 'editor') return;
    if (key.ctrl && input === 'c') return exit();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    if (ctx.claimsKey?.(input, key)) return;
    globalKeys(input, key);
  });

  // Typing stops when the Edit view goes off screen.
  useEffect(() => {
    if (view !== 'edit' && focusRef.current === 'editor') setFocus('view');
  }, [view]);

  // The terminal reports the mouse while the setting is on (it is unless set off).
  useEffect(() => {
    mouse?.enable(config.mouse !== false);
  }, [config.mouse]);

  // Where things were drawn, for matching clicks against (set as the layout below is worked out).
  const layout = useRef(null);
  const lastPress = useRef(null);
  // The component under a point of the main area (`y` counted from its top), and that `y` in it.
  const mouseTarget = (y) => {
    const target = ctx.mouseHandlers.findLast((h) => h.top <= y);
    return target && { target, y: y - target.top };
  };
  const onMouse = (e) => {
    if (e.type === 'copy') return setFlash({ text: `Copied ${copiedText(e.text)}` });
    if (e.button === 'left' && !e.release && !e.drag) {
      const prev = lastPress.current;
      const now = Date.now();
      const count = prev && prev.x === e.x && prev.y === e.y && now - prev.at < DOUBLE_CLICK_MS ? prev.count + 1 : 1;
      e.double = count === 2;
      e.triple = count === 3;
      // A fourth click starts over rather than counting on.
      lastPress.current = count < 3 ? { x: e.x, y: e.y, at: now, count } : null;
    } else if (!e.drag && e.button !== 'wheel') return;
    // A confirmation's options are picked with keys.
    if (confirmRef.current || !layout.current) return;
    const { mainTop, mainH, promptTop, sugCount, tabs } = layout.current;
    if (e.drag) {
      // A drag the component it started in takes itself (claimDrags below; useMouse's `drags`).
      const hit = mouseTarget(e.from.y - mainTop);
      if (!hit) return;
      if (focusRef.current === 'prompt') setFocus('view');
      return hit.target.handle({ ...e, y: e.y - mainTop - hit.target.top, from: { x: e.from.x, y: hit.y } });
    }
    if (e.y === mainTop - 1 && !e.wheel) {
      const tab = tabs.find((t) => e.x >= t.from && e.x < t.to);
      if (!tab) return;
      // Whatever is open over the view closes: a click on a tab should never do nothing.
      for (let n = 0; overlayRef.current && n < 20; n++) ctx.closeOverlay();
      setFocus('view');
      return setView(tab.id);
    }
    if (e.y >= mainTop && e.y < mainTop + mainH) {
      // Like esc, a click on the view leaves the prompt's text for later.
      if (!e.wheel && focusRef.current === 'prompt') setFocus('view');
      const hit = mouseTarget(e.y - mainTop);
      return hit?.target.handle({ ...e, y: hit.y });
    }
    if (e.wheel) return;
    if (e.y >= promptTop && e.y < promptTop + 3) {
      // The text starts after the border, the padding and "> ", scrolled as PromptBox scrolls it.
      const { value, cursor } = promptRef.current;
      const inner = columns - 6;
      const start = focusRef.current === 'prompt' ? Math.max(0, cursor - inner + 1) : 0;
      setPrompt(value, Math.max(0, Math.min(value.length, start + e.x - 4)));
      return setFocus('prompt');
    }
    const sug = e.y - promptTop - 3;
    if (sug >= 0 && sug < sugCount) {
      setSugIndex(sug);
      // As ↵ would, on the suggestion under the pointer.
      if (e.double) promptKeys('', { return: true });
    }
  };
  const mouseRef = useRef(onMouse);
  mouseRef.current = onMouse;
  useEffect(() => mouse?.subscribe((e) => mouseRef.current(e)), [mouse]);
  // Drags that start where the component on screen selects for itself skip the screen selection.
  useEffect(
    () =>
      mouse?.claimDrags?.((e) => {
        const at = layout.current;
        if (confirmRef.current || !at || e.y < at.mainTop || e.y >= at.mainTop + at.mainH) return false;
        const hit = mouseTarget(e.y - at.mainTop);
        return Boolean(hit?.target.drags?.({ ...e, y: hit.y }));
      }),
    [mouse],
  );

  // Layout: everything is sized to the terminal, one row short of it so Ink never clears the screen.
  const W = columns;
  const H = Math.max(12, rows - 1);
  // esc hides the activity lines; the Log view keeps them all.
  const act = activityRows(entries.filter((e) => e.shown !== false));
  const bottom = confirmReq ? confirmHeight(confirmReq) : 3 + suggestions.length;
  const mood = moodFor({ data, busy, lastEntry: entries.at(-1) });
  // Hoot's mood, for the siblings, written whenever it changes.
  const shared = familyMood(mood, { busy, lastEntry: entries.at(-1) });
  useEffect(() => {
    if (familyOn) writeMood('hail', shared);
  }, [shared.mood, familyOn]);
  const reactionRow = reaction ? [{ text: reactionLine(reaction), color: theme.accent }, { text: '  esc', color: theme.dim }] : null;
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - (reactionRow ? 1 : 0) - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + (reactionRow ? 1 : 0) + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries),
  };

  // The palette's list: this view's keys, yours, then the commands.
  const paletteList = useMemo(
    () => paletteItems({ commands: COMMANDS, user: custom.commands, sections: HELP.filter((s) => s.title === 'Anywhere' || s.views?.includes(view)), keymap: custom.keymap, view, skip: ['ctrl+p'] }),
    [custom, view],
  );

  let main;
  if (overlay?.kind === 'palette') {
    // Closed once every handler has had the esc, or App's would also take it (and clear the log).
    main = <Palette items={paletteList} query={overlay.query} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onPick={runPicked} onClose={() => queueMicrotask(ctx.closeOverlay)} />;
  } else if (overlay?.kind === 'help') {
    main = <HelpView sections={custom.sections} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (overlay?.kind === 'socket') {
    main = <SocketView key={overlay.session.started} session={overlay.session} title={overlay.title} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (overlay?.kind === 'picker') {
    main = <Picker key={overlay.id} picker={overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} />;
  } else if (overlay) {
    main = <TextViewer {...overlay} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
  } else if (view === 'log') {
    main = <LogView entries={entries} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (!data) {
    main = (
      <Panel title={VIEWS.find((v) => v.id === view).label} width={W} height={mainH}>
        <Text color={theme.dim}>{loading ? '  Loading…' : fileRef.current ? '  The file couldn\'t be read: r tries again.' : '  No .http file open. /new writes an example; /open <file> opens one.'}</Text>
      </Panel>
    );
  } else if (view === 'history') {
    main = <HistoryView entries={history} data={data} focus={historyFocus} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'edit') {
    main = <EditView data={data} responses={responses} editor={editor} editing={focus === 'editor'} ctx={ctx} width={W} height={mainH} active={(viewActive || focus === 'editor') && !overlay && !confirmReq} />;
  } else if (view === 'response') {
    const request = ctx.selectedRequest();
    main = <ResponseView request={request} sent={request ? responses[request.label] : null} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <RequestsView data={data} responses={responses} jump={jump} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : focus === 'editor'
        ? 'typing: every key is text · ctrl+r send · ctrl+s save · ctrl+z undo · alt+↑↓ move the line · ctrl+/ comment · esc stop'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'palette'
        ? 'type to filter · ↑↓ pick · ↵ run it (a key in the view; a command that takes more goes into the prompt) · esc close'
        : overlay?.kind === 'picker'
          ? 'j/k move · ↵ change · esc close'
          : overlay?.kind === 'socket'
          ? 'type a message · ↵ send it · ↑↓ pgup pgdn scroll back · esc close the connection'
          : overlay
            ? 'j/k scroll · space page · y copy · esc close'
            : HINTS[view];
  const right = focus === 'prompt' || focus === 'editor' ? '' : '  / commands · ! shell · , settings · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} env={environment()} width={W} loading={loading} mood={mood} mock={mockServer} />
      <Tabs view={view} entries={entries} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={data} width={W} update={update} /> : null}
      {reactionRow ? <Row pointer={false} width={W} segments={reactionRow} /> : null}
      {act.map((segs, i) => (
        <Row key={i} pointer={false} width={W} segments={segs} />
      ))}
      {busy ? <Spinner label={busy.label} started={busy.started} width={W} /> : null}
      {confirmReq ? (
        confirmReq.secret ? (
          <SecretPrompt key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        ) : (
          <Confirm key={confirmReq.id} req={confirmReq} width={W} onDone={onConfirm} />
        )
      ) : (
        <PromptBox value={prompt.value} cursor={prompt.cursor} focused={focus === 'prompt'} width={W} placeholder="↵ sends the request · / for commands · e environment · ? for shortcuts" />
      )}
      {suggestions.length ? <Suggestions items={suggestions} selected={sel} width={W} /> : null}
      <Row
        pointer={false}
        width={W}
        segments={[...fitSegments([{ text: `  ${left}`, color: theme.dim }], W - stringWidth(right)), { text: right, color: theme.dim }]}
      />
    </Box>
  );
}
