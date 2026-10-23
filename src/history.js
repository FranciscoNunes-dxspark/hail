// What came back, kept across runs: one JSON line per response, in a file per .http file under
// ~/.hail/history. On opening a file, the last response to each request comes back, so the Response
// view and {{login.response.body.token}} pick up where they left off. What's kept leaves out secrets:
// the values {{$secret}} and {{$azToken}} filled in, and the headers that carry credentials.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './config.js';

export const KEEP = 300;
export const MAX_BODY = 512 * 1024;
const HIDDEN = '••••••';
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|ocp-apim-subscription-key)$|token|secret|password/i;

/** Where `httpFile`'s history is kept. */
export const historyFile = (httpFile, dir = join(configDir(), 'history')) => join(dir, `${createHash('sha1').update(httpFile).digest('hex').slice(0, 16)}.jsonl`);

/** `text` with each of `secrets` blanked out. */
const blank = (text, secrets) => secrets.reduce((t, s) => (s && s.length >= 4 ? t.split(s).join(HIDDEN) : t), String(text ?? ''));

/**
 * What's kept of one response: { label, name, at, request, response, checks } with the secrets used
 * blanked out everywhere (what the response handlers logged too), credential headers hidden, and a
 * body over MAX_BODY cut (`truncated` set).
 */
export function entryFor({ label, name, at, request, response, checks }) {
  const secrets = request.secrets ?? [];
  const headers = (list) => list.map(([k, v]) => [k, SENSITIVE.test(k) ? HIDDEN : blank(v, secrets)]);
  const body = blank(response.body, secrets);
  return {
    label,
    name: name ?? null,
    at,
    request: { method: request.method, url: blank(request.url, secrets), headers: headers(request.headers), body: blank(request.body, secrets) },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: headers(response.headers),
      body: body.length > MAX_BODY ? body.slice(0, MAX_BODY) : body,
      truncated: body.length > MAX_BODY || undefined,
      ms: response.ms,
      size: response.size,
      url: blank(response.url, secrets),
      ...(response.insecure ? { insecure: true } : {}),
      ...(response.proxy ? { proxy: response.proxy } : {}),
    },
    checks: checks
      ? {
          tests: checks.tests.map((t) => ({ name: blank(t.name, secrets), passed: t.passed, ...(t.message ? { message: blank(t.message, secrets) } : {}) })),
          log: checks.log.map((l) => blank(l, secrets)),
          error: checks.error ? blank(checks.error, secrets) : null,
        }
      : undefined,
  };
}

/** The entries in `file`, oldest first; lines that don't read are skipped. */
export function readHistory(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut short (the app closed mid-write) costs only itself.
    }
  }
  return out;
}

/**
 * Adds `entry` to `file` and returns the entries now kept, newest KEEP once well over (so most sends are
 * one append). `entries` is what's kept already, which the app holds; without it the file is read.
 * Never throws: history is a convenience.
 */
export function appendHistory(file, entry, { entries, keep = KEEP } = {}) {
  const all = [...(entries ?? readHistory(file)), entry];
  try {
    mkdirSync(join(file, '..'), { recursive: true });
    if (all.length > keep * 1.2) {
      const kept = all.slice(-keep);
      writeFileSync(file, kept.map((e) => JSON.stringify(e)).join('\n') + '\n');
      return kept;
    }
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A read-only home folder: the response still shows, it just isn't kept.
  }
  return all;
}

export function clearHistory(file) {
  rmSync(file, { force: true });
}

/** The newest entry for each request label: what to show again when a file is opened. */
export function latestByLabel(entries) {
  const out = {};
  for (const e of entries) out[e.label] = e;
  return out;
}

/** The entry before `entry` for the same request, to compare it with. */
export function previousOf(entries, entry) {
  const i = entries.indexOf(entry);
  for (let j = i - 1; j >= 0; j--) if (entries[j].label === entry.label) return entries[j];
  return null;
}
