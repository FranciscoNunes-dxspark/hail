import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdin } from 'ink';
import { watch } from 'node:fs';
import { basename } from 'node:path';
import * as a from '../actions.js';
import { azToken as azCli } from '../azure.js';
import { osCredentials } from '../credentials.js';
import { appendHistory, clearHistory, entryFor, historyFile, latestByLabel, readHistory } from '../history.js';
import { COMMANDS, findCommand, suggestionsFor } from '../commands.js';
import { saveConfig } from '../config.js';
import { HELP } from '../help.js';
import { commandsSection, sectionFor } from '../help-layout.js';
import { findHttpFiles, loadHttpFile } from '../files.js';
import { BULLET, theme } from '../theme.js';
import { fitSegments, stringWidth } from '../text.js';
import { VERSION } from '../version.js';
import { useTerminalSize } from './hooks.js';
import { Confirm, Panel, PromptBox, Row, SecretPrompt, Spinner, Suggestions, confirmHeight } from './parts.jsx';
import { HistoryView } from './HistoryView.jsx';
import { HelpView } from './HelpView.jsx';
import { LogView } from './LogView.jsx';
import { Picker } from './Picker.jsx';
import { RequestsView } from './RequestsView.jsx';
import { ResponseView } from './ResponseView.jsx';
import { TextViewer } from './TextViewer.jsx';
import { WELCOME_HEIGHT, Welcome } from './Pet.jsx';
import { FACES, moodFor } from '../pet.js';

const VIEWS = [
  { id: 'requests', label: 'Requests' },
  { id: 'response', label: 'Response' },
  { id: 'history', label: 'History' },
  { id: 'log', label: 'Log' },
];

// What ? shows: help.js's sections, then the slash commands.
const HELP_SECTIONS = [...HELP, commandsSection(COMMANDS)];

const HINTS = {
  requests: '↵ send · c copy as curl · y copy the URL · v the response, full view · e environment',
  response: '↵ send again · h headers · y copy the body · j/k space scroll',
  history: '↵ show it · d compare with the one before · D forget them all',
  log: '↵ all its output · y copy it',
};

const firstLine = (s) => String(s ?? '').split('\n')[0];

function Header({ data, env, width, loading, mood }) {
  const segs = [
    { text: `${FACES[mood]} `, color: theme.accent, bold: true },
    { text: 'Hail', bold: true },
  ];
  if (data) {
    segs.push({ text: '  │  ', color: theme.border }, { text: data.name, bold: true });
    segs.push({ text: '  env ', color: theme.dim }, { text: env ?? (data.environments.names.length ? 'none' : '—'), color: env ? theme.warn : theme.dim, bold: Boolean(env) });
  } else if (loading) segs.push({ text: '  loading…', color: theme.dim });
  const path = data?.dir ?? '';
  return <Row pointer={false} width={width} segments={[...fitSegments(segs, Math.max(20, width - stringWidth(path) - 1)), { text: ' ' }, { text: path, color: theme.dim }]} />;
}

/** The environment to use for `data`: the one picked for this file last time, else dev or local, else none. */
export function defaultEnvironment(data, saved) {
  const names = data?.environments.names ?? [];
  if (saved && names.includes(saved)) return saved;
  return names.find((n) => /^(dev|local)/i.test(n)) ?? null;
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
export function App({ config: initialConfig, initialFile, load = loadHttpFile, azToken = azCli, credentials = osCredentials, askClaude, checkUpdate, installUpdate, setTitle, mouse, copy }) {
  const { exit } = useApp();
  const { columns, rows } = useTerminalSize();
  const [config, setConfigState] = useState(initialConfig);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('requests');
  // What came back, by request label: { request, response, at }, `request` as it was sent.
  const [responses, setResponses] = useState({});
  const responsesRef = useRef({});
  const selectedRef = useRef(0);
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
  // The pet looks happy (or worried) for a few seconds after a result; re-render when that wears off.
  const [, setMoodTick] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setMoodTick((n) => n + 1), 8100);
    return () => clearTimeout(t);
  }, [entries]);
  // A word in the bottom line for a moment ("Copied 3 lines"), where it moves nothing on screen.
  const [flash, setFlash] = useState(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3000);
    return () => clearTimeout(t);
  }, [flash]);

  // Async actions read the latest state through refs, not through stale closures.
  const dataRef = useRef(null);
  const busyRef = useRef(null);
  const configRef = useRef(config);
  const promptRef = useRef(prompt);
  const confirmRef = useRef(null);
  const nextId = useRef(1);
  const historyPos = useRef(-1);
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
    const id = nextId.current++;
    setEntries((list) => [...list.slice(-99), { id, lines: [], at: Date.now(), ...e }]);
    return id;
  };
  const updateEntry = (id, patch) => setEntries((list) => list.map((e) => (e.id === id ? { ...e, at: Date.now(), ...patch } : e)));

  const note = (text, status = 'info') => {
    const [title, ...lines] = String(text).split('\n');
    addEntry({ title, status, lines });
  };

  const reload = async () => {
    const file = fileRef.current;
    if (!file) return setLoading(false);
    try {
      const d = await load(file);
      if (fileRef.current !== file) return;
      const first = dataRef.current?.path !== d.path;
      dataRef.current = d;
      setData(d);
      // Opened: what came back last time, so the responses and their variables carry on.
      if (first) {
        const hf = historyFile(d.path);
        const entries = readHistory(hf);
        historyRef.current = { file: hf, entries };
        setHistory(entries);
        responsesRef.current = Object.fromEntries(Object.entries(latestByLabel(entries)).map(([label, e]) => [label, { request: e.request, response: e.response, at: e.at }]));
        setResponses(responsesRef.current);
      }
    } catch (e) {
      note(`Couldn't read ${basename(file)}: ${firstLine(e.message)}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const openFile = async (file) => {
    fileRef.current = file;
    dataRef.current = null;
    setData(null);
    setLoading(true);
    responsesRef.current = {};
    setResponses({});
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
    const b = { label, started: Date.now(), abort: () => controller.abort() };
    busyRef.current = b;
    setBusy(b);
    const id = addEntry({ title, status: 'running' });
    setWelcome(false);
    try {
      const { stdout = '', stderr = '' } = await start(controller.signal);
      const out = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      lastOutput.current = { title, text: out || '(no output)' };
      updateEntry(id, { status: 'ok', lines: out ? out.split('\n') : ['Done'] });
      return { ok: true, out };
    } catch (error) {
      lastOutput.current = { title, text: error.message };
      updateEntry(id, { status: 'error', lines: error.cancelled ? ['Cancelled'] : error.message.split('\n') });
      return { ok: false, error };
    } finally {
      busyRef.current = null;
      setBusy(null);
      if (refresh) await reload();
    }
  };

  const confirm = (req) =>
    new Promise((done) => {
      const full = { options: [{ label: 'Yes', value: true }, { label: 'No', value: false }], ...req, id: nextId.current++, done };
      confirmRef.current = full;
      setConfirmReq(full);
    });
  const onConfirm = (value) => {
    const req = confirmRef.current;
    confirmRef.current = null;
    answerKey.current = keySeq.current;
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
  if (!ctxRef.current) ctxRef.current = { get data() { return dataRef.current; }, get config() { return configRef.current; }, mouseHandlers: [] };
  const ctx = ctxRef.current;
  Object.assign(ctx, {
    task,
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
        environment: d && env ? d.environments.vars(env) : (d?.environments.vars(null) ?? {}),
        file: d?.variables ?? {},
        responses: named,
        env: { azToken, secret: (name) => credentials.get(name) },
      };
    },
    // The views say which request the cursor is on, so commands and the Response view act on it.
    selectRequest: (i) => (selectedRef.current = i),
    selectedRequest: () => dataRef.current?.requests[selectedRef.current] ?? null,
    selectedIndex: () => selectedRef.current,
    setResponse: (request, sentAs, response) => {
      const at = Date.now();
      responsesRef.current = { ...responsesRef.current, [request.label]: { request: sentAs, response, at } };
      setResponses(responsesRef.current);
      const h = historyRef.current;
      if (!h.file) return;
      const entry = entryFor({ label: request.label, name: request.name, at, request: sentAs, response });
      historyRef.current = { file: h.file, entries: appendHistory(h.file, entry, { entries: h.entries }) };
      setHistory(historyRef.current.entries);
    },
    history: () => historyRef.current.entries,
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
    // Views call this first in their key handlers, for the same reason as the dispatcher below.
    viewHasKeys: () => focusRef.current === 'view' && !overlayRef.current && !confirmRef.current && answerKey.current !== keySeq.current,
    overlayHasKeys: () => focusRef.current === 'view' && !confirmRef.current && answerKey.current !== keySeq.current,
    quit: () => exit(),
    refresh: () => reload(),
    showText: (title, text, opts = {}) => setOverlay({ title, text, ...opts }),
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
    showHelp: () => setOverlay({ kind: 'help', start: sectionFor(HELP_SECTIONS, view) }),
    showLast: () => (lastOutput.current ? setOverlay({ ...lastOutput.current }) : note('No command has run yet.')),
  });

  const submit = async (raw) => {
    const text = raw.trim();
    setPrompt('');
    setFocus('view');
    if (!text) return;
    const history = [text, ...(configRef.current.history ?? []).filter((h) => h !== text)].slice(0, 100);
    setConfig((c) => ({ ...c, history }));
    try {
      if (text.startsWith('!')) return await a.raw(ctx, text.slice(1));
      const [, name, rest] = text.replace(/^\//, '').match(/^(\S+)\s*([\s\S]*)$/);
      const cmd = findCommand(name);
      if (!cmd) return note(`Unknown command: /${name}. Type / to see them all.`, 'error');
      await cmd.run(ctx, rest.trim());
    } catch (e) {
      note(firstLine(e.message), 'error');
    }
  };

  useEffect(() => {
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
  const suggestions = focus === 'prompt' && !confirmReq ? suggestionsFor(prompt.value, { data, files }) : [];
  const sel = Math.min(sugIndex, Math.max(0, suggestions.length - 1));

  // Line editing in the prompt.
  const promptKeys = (input, key) => {
    const { value, cursor } = promptRef.current;
    const items = suggestionsFor(value, { data: dataRef.current, files: value.startsWith('/open ') ? findHttpFiles(process.cwd()) : [] });
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
    if (key.ctrl && input === 'c') return exit();
    if (confirmRef.current || overlayRef.current || answerKey.current === keySeq.current) return;
    if (ctx.claimsKey?.(input, key)) return;
    globalKeys(input, key);
  });

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
    if (e.type === 'copy') {
      const n = e.text.split('\n').length;
      return setFlash({ text: n > 1 ? `Copied ${n} lines` : `Copied ${e.text.length} character${e.text.length === 1 ? '' : 's'}` });
    }
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
  // The welcome box only appears when the terminal has room for it next to a useful view.
  const showWelcome = welcome && H >= 28;
  const mainH = Math.max(6, H - 2 - act.length - (busy ? 1 : 0) - bottom - 1 - (showWelcome ? WELCOME_HEIGHT : 0));
  const viewActive = focus === 'view' && !overlay && !confirmReq;
  layout.current = {
    mainTop: 2,
    mainH,
    promptTop: 2 + mainH + (showWelcome ? WELCOME_HEIGHT : 0) + act.length + (busy ? 1 : 0),
    sugCount: suggestions.length,
    tabs: tabLabels(entries),
  };

  let main;
  if (overlay?.kind === 'help') {
    main = <HelpView sections={HELP_SECTIONS} start={overlay.start} ctx={ctx} width={W} height={mainH} active={focus === 'view' && !confirmReq} onClose={ctx.closeOverlay} />;
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
    main = <HistoryView entries={history} data={data} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else if (view === 'response') {
    const request = ctx.selectedRequest();
    main = <ResponseView request={request} sent={request ? responses[request.label] : null} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  } else {
    main = <RequestsView data={data} responses={responses} ctx={ctx} width={W} height={mainH} active={viewActive} />;
  }

  const left = flash
    ? flash.text
    : focus === 'prompt'
      ? 'enter run · tab complete · ↑↓ pick or history · esc back'
      : overlay?.kind === 'help'
        ? 'j/k section · space scroll · / search · esc close'
        : overlay?.kind === 'picker'
          ? 'j/k move · ↵ change · esc close'
          : overlay
            ? 'j/k scroll · space page · y copy · esc close'
            : HINTS[view];
  const right = focus === 'prompt' ? '' : '  / commands · ! shell · , settings · ? help';

  return (
    <Box flexDirection="column" width={W} height={H}>
      <Header data={data} env={environment()} width={W} loading={loading} mood={mood} />
      <Tabs view={view} entries={entries} width={W} />
      <Box height={mainH} width={W}>
        {main}
      </Box>
      {showWelcome ? <Welcome mood={mood} data={data} width={W} update={update} /> : null}
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
