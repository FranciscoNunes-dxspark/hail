// One palette for the whole UI. The accent can be changed in /settings (it's "accent": "#hex" in the config).
export const theme = {
  accent: '#ff875f', // DEFAULT_ACCENT, below
  border: '#5f5f5f',
  dim: '#8a8a8a',
  selBg: '#303030',
  ink: '#121212',
  add: '#5fd75f',
  del: '#ff5f5f',
  info: '#5fafd7',
  warn: '#ffd75f',
  bangMode: '#ff87d7',
};

// Windows terminals draw ⏺ as a wide emoji, so use the plain circle there (as Claude Code does).
export const BULLET = process.platform === 'win32' ? '●' : '⏺';

export const DEFAULT_ACCENT = '#ff875f';

/** Whether `color` is something the accent can be: "#rrggbb". */
export const isColour = (color) => typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color);

/** Sets the accent; anything that isn't a colour (no setting, say) puts the default back. */
export function setAccent(color) {
  theme.accent = isColour(color) ? color : DEFAULT_ACCENT;
}
