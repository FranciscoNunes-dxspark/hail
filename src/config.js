import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Read per call so tests can point HAIL_HOME somewhere temporary.
const configDir = () => process.env.HAIL_HOME || join(homedir(), '.hail');

/** Where the settings are kept, to show in /settings. */
export const configFile = () => join(configDir(), 'config.json');

const DEFAULTS = { history: [] };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(configFile(), 'utf8')) };
  } catch {
    // Not there (or unreadable): the defaults.
    return { ...DEFAULTS };
  }
}

export function saveConfig(config) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(configFile(), JSON.stringify(config, null, 2));
  } catch {
    // A read-only home folder shouldn't stop the app; settings just won't stick.
  }
}
