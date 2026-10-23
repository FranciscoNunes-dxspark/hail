// One palette for the whole UI, dark or light (the Theme setting: "theme": "dark" | "light" | "auto"
// in the config, as Splice has it). The accent can be changed too, in /settings ("accent": "#hex").
// Everything on screen takes its colours from `theme`, read as it draws, so applyTheme repaints the
// next frame: a module-level table of colours uses getters, never values copied at import.
export const DARK = {
  accent: '#e8445a', // DEFAULT_ACCENT, below
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  info: '#5fafd7',
  warn: '#ffd75f',
  bangMode: '#ff87d7',
  // Behind search matches in a response, and the current one.
  match: '#5f5f00',
  matchHere: '#af8700',
  // Each method in a colour of its own.
  methods: { GET: '#5fafff', POST: '#5fd75f', PUT: '#ffaf5f', PATCH: '#d7af5f', DELETE: '#ff5f5f', GRAPHQL: '#d787ff' },
};

// For a white (or pale) background: darker inks, pale backgrounds behind matches, white on the bars.
export const LIGHT = {
  accent: '#c4203a', // LIGHT_ACCENT, below
  border: '#a8a8a8',
  dim: '#6c6c6c',
  selBg: '#e4e4e4',
  ink: '#ffffff',
  add: '#008700',
  del: '#d70000',
  info: '#005f87',
  warn: '#af5f00',
  bangMode: '#d7005f',
  match: '#ffff87',
  matchHere: '#ffaf00',
  methods: { GET: '#005fd7', POST: '#008700', PUT: '#af5f00', PATCH: '#875f00', DELETE: '#d70000', GRAPHQL: '#8700af' },
};

export const theme = { ...DARK, mode: 'dark' };

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export const DEFAULT_ACCENT = '#e8445a';
// The default accent on a light background: the same red, darker.
export const LIGHT_ACCENT = '#c4203a';

export const THEMES = ['dark', 'light', 'auto'];

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** The accent this theme comes with. */
export const defaultAccent = () => (theme.mode === 'light' ? LIGHT_ACCENT : DEFAULT_ACCENT);

/** Sets the accent; anything that isn't a colour (no setting, say) puts this theme's default back. */
export function setAccent(color) {
  theme.accent = isColour(color) ? color : defaultAccent();
}

/**
 * The terminal's background from COLORFGBG ("15;0", "0;default;15"), which some terminals set: the
 * last number is the background's colour; 7 and 15 (white, bright white) are light. null when it
 * says nothing.
 */
export function backgroundFrom(colorfgbg) {
  const bg = String(colorfgbg ?? '').split(';').at(-1).trim();
  if (!/^\d+$/.test(bg)) return null;
  return bg === '7' || bg === '15' ? 'light' : 'dark';
}

/** The palette a setting asks for: dark, light, or with auto (or none) what COLORFGBG says, else dark. */
export function themeMode(setting, env = process.env) {
  if (setting === 'dark' || setting === 'light') return setting;
  return backgroundFrom(env.COLORFGBG) ?? 'dark';
}

/** Puts the config's theme (dark, light, auto) and accent in place. */
export function applyTheme(config = {}, env = process.env) {
  const mode = themeMode(config.theme, env);
  Object.assign(theme, mode === 'light' ? LIGHT : DARK, { mode });
  setAccent(config.accent);
  return mode;
}
