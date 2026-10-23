// The .http file Hail has open: reading it with the environments beside it, finding one to open,
// and the example /new writes.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { loadEnvironments } from './environments.js';
import { parseHttpFile } from './http-file.js';

/** The file at `path`, read: { path, dir, name, text, requests, variables, environments }. Throws if it can't be read. */
export async function loadHttpFile(path) {
  const full = resolve(path);
  const text = readFileSync(full, 'utf8');
  const { requests, variables } = parseHttpFile(text);
  const dir = dirname(full);
  return { path: full, dir, name: basename(full), text, requests, variables, environments: loadEnvironments(dir) };
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'bin', 'obj']);

/** .http and .rest files under `dir`, two folders deep, as paths relative to it, nearest first. */
export function findHttpFiles(dir, depth = 2) {
  const out = [];
  const walk = (d, level) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) if (e.isFile() && /\.(http|rest)$/i.test(e.name)) out.push(relative(dir, join(d, e.name)).replaceAll('\\', '/'));
    if (level < depth) for (const e of sorted) if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.')) walk(join(d, e.name), level + 1);
  };
  walk(dir, 0);
  return out;
}

export const EXAMPLE = `# Requests for Hail (and VS Code's REST Client, and JetBrains' HTTP Client).
# ### starts a request; ↵ on it in Hail sends it. Variables come from the @lines here and from
# http-client.env.json beside this file ({ "dev": { "host": "..." } }); e in Hail picks the environment.

@host = https://httpbin.org

### Ask for some JSON
GET {{host}}/json
Accept: application/json

### Send some
# @name echo
POST {{host}}/anything
Content-Type: application/json

{
  "sent": "{{$isoTimestamp}}",
  "id": "{{$uuid}}"
}

### Use what came back from the one above
GET {{host}}/anything/{{echo.response.body.json.id}}
`;

/** Writes the example to `path` unless something is there already. Returns whether it wrote it. */
export function writeExample(path) {
  if (existsSync(path)) return false;
  writeFileSync(path, EXAMPLE);
  return true;
}

/**
 * A path given as a command's one argument: as typed, or in quotes. A sibling app's line (family.js
 * quoteArg) quotes a path with a space or a \ in it and escapes each \ and " inside; a path typed in
 * quotes by hand (C:\Users\me) keeps its backslashes.
 */
export function pathArg(text) {
  const s = String(text ?? '').trim();
  const m = /^"((?:[^"\\]|\\.)*)"$/.exec(s);
  if (!m) return s;
  return /^(?:[^\\]|\\[\\"])*$/.test(m[1]) ? m[1].replace(/\\(.)/g, '$1') : m[1];
}
