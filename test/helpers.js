// What the end-to-end tests share: rendering App with a temporary home, waiting for frames, typing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { App } from '../src/ui/App.jsx';

export const KEYS = { down: '\x1b[B', up: '\x1b[A', enter: '\r', esc: '\x1b', backspace: '\x7f', tab: '\t' };

let lastApp = null;

/** A home folder of its own, so the settings a test saves never reach the real one; returns the cleanup. */
export function tempHome() {
  const dir = mkdtempSync(join(tmpdir(), 'hail-'));
  process.env.HAIL_HOME = dir;
  // The family's moods (family.js) go here too, never to the real ~/.family.
  process.env.FAMILY_HOME = join(dir, 'family');
  return () => rmSync(dir, { recursive: true, force: true });
}

/** Renders App with `props` (a config of its own unless given), remembered for until's message. */
export function start(props = {}) {
  lastApp = render(React.createElement(App, { config: { history: [] }, ...props }));
  return lastApp;
}

export async function until(check, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Once it shows, give the new view's key handlers a moment to subscribe, as a person would.
    if (check()) return new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`Timed out waiting for ${what}. Last frame:\n${lastApp?.lastFrame()}`);
}

export const type = async (stdin, text) => {
  for (const ch of text) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
};
