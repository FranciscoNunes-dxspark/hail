// The /settings list: every setting, its value and what ↵ does with it. Pure, so the list is tested
// without the UI; actions.js shows it in a picker and makes the changes.
import { DEFAULT_ACCENT, theme } from './theme.js';
import { fit } from './text.js';

const isOn = (value) => value !== false;
const count = (n, one, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : 'none');

/**
 * The rows, from the config: { id, label, value, note, action }, where `action` is what ↵ does:
 * 'toggle' (an on/off setting named `id`), 'accent', 'clear' (the list named `id`) or 'none'.
 * `mouse`: whether this terminal can report the mouse at all.
 */
export function settingRows(config, { file = '', mouse = true } = {}) {
  const history = config.history ?? [];
  const checks = isOn(config.checkForUpdates);
  return [
    { id: 'accent', label: 'Accent colour', value: config.accent ?? `${DEFAULT_ACCENT} (default)`, colour: config.accent ?? DEFAULT_ACCENT, note: 'type a new one', action: 'accent' },
    {
      id: 'mouse',
      label: 'Mouse',
      value: isOn(config.mouse) ? 'on' : 'off',
      note: !mouse ? "this terminal can't report it" : isOn(config.mouse) ? 'off leaves selecting to the terminal' : 'click, scroll, drag to copy',
      action: 'toggle',
    },
    { id: 'checkForUpdates', label: 'Check for new versions', value: checks ? 'on' : 'off', note: 'once a day, in the downloaded Hail', action: 'toggle' },
    {
      id: 'autoUpdate',
      label: 'Install them by itself',
      value: isOn(config.autoUpdate) ? 'on' : 'off',
      note: checks ? 'they start the next time you open Hail' : 'only while checking is on',
      action: 'toggle',
    },
    { id: 'history', label: 'Prompt history', value: count(history.length, 'entry', 'entries'), note: history.length ? 'clear it' : '', action: history.length ? 'clear' : 'none' },
    { id: 'file', label: 'Settings file', value: file, note: '', action: 'none' },
  ];
}

/** A row as segments: the label, the value (on in green, the accent in its own colour), and what ↵ does. */
export function settingSegments(row) {
  const value =
    row.id === 'accent'
      ? [{ text: '■ ', color: row.colour }, { text: fit(row.value, 26), color: row.colour }]
      : [{ text: fit(row.value, 28), color: row.value === 'on' ? theme.add : row.value === 'off' || row.value === 'none' ? theme.dim : undefined }];
  return [{ text: fit(row.label, 28), strong: true }, ...value, { text: row.note ? `  ↵ ${row.note}` : '', color: theme.dim }];
}
