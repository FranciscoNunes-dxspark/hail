// Filling in {{variables}}: from the chosen environment, the file's own @variables, earlier responses
// ({{login.response.body.token}}) and the built-ins ({{$uuid}}, {{$timestamp}}…). Pure apart from the
// built-ins that read the clock, the dice, the process's environment or a sign-in, which come in `env`.
import { randomUUID } from 'node:crypto';

const PLACEHOLDER = /\{\{\s*(.+?)\s*\}\}/g;

/**
 * The built-ins, by name; each takes its arguments (what follows the name, split on spaces). `now`,
 * `random` and `processEnv` stand in for the real ones in tests; `azToken(resource)` returns a token,
 * `secret(name)` a saved secret (or null). Every secret filled in is added to `used`, so what's kept
 * of a request afterwards can leave it out.
 */
export function builtins({ now = () => Date.now(), random = Math.random, processEnv = process.env, uuid = randomUUID, azToken, secret, used } = {}) {
  const env = (name) => processEnv[name];
  return {
    $timestamp: () => String(Math.floor(now() / 1000)),
    $isoTimestamp: () => new Date(now()).toISOString(),
    $uuid: () => uuid(),
    $guid: () => uuid(),
    '$random.uuid': () => uuid(),
    $randomInt: ([min = '0', max = '1000']) => String(Math.floor(Number(min) + random() * (Number(max) - Number(min)))),
    $processEnv: ([name]) => env(name),
    $azToken: async ([resource]) => {
      const token = await azToken?.(resource);
      if (token) used?.add(token);
      return token;
    },
    $secret: async ([name]) => {
      const value = name ? await secret?.(name) : null;
      if (value) used?.add(value);
      return value ?? undefined;
    },
  };
}

/** A value inside a parsed JSON body, by a path like `data.items[0].id` (a leading `$.` is fine). */
export function pathIn(value, path) {
  const parts = path.replace(/^\$\.?/, '').match(/[^.[\]]+/g) ?? [];
  let v = value;
  for (const p of parts) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[p];
  }
  return v;
}

/** `{{name.response.body.path}}` or `{{name.response.headers.Name}}` from the responses so far (by request name). */
function fromResponse(expr, responses) {
  const m = /^([\w-]+)\.response\.(body|headers)(?:\.(.+))?$/.exec(expr);
  if (!m) return undefined;
  const r = responses[m[1]];
  if (!r) return undefined;
  if (m[2] === 'headers') return m[3] ? r.headers.find(([k]) => k.toLowerCase() === m[3].toLowerCase())?.[1] : undefined;
  if (!m[3] || m[3] === '*' || m[3] === '$') return r.body;
  let json;
  try {
    json = JSON.parse(r.body);
  } catch {
    return undefined;
  }
  const v = pathIn(json, m[3]);
  return v === undefined ? undefined : typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/**
 * `text` with its {{placeholders}} filled in: { text, missing } where `missing` lists the ones nothing
 * answered, left in place. `scope`: { environment, file, responses, env } (env: builtins' options).
 * The environment wins over the file's own variables, so a file can keep defaults the environments
 * override; either can use other variables in its values.
 */
export async function fill(text, { environment = {}, file = {}, responses = {}, env = {} } = {}, depth = 0) {
  const fns = builtins(env);
  const missing = [];
  const out = [];
  let last = 0;
  for (const m of String(text).matchAll(PLACEHOLDER)) {
    out.push(text.slice(last, m.index));
    last = m.index + m[0].length;
    const expr = m[1];
    let value;
    if (expr.startsWith('$')) {
      const [name, ...args] = expr.split(/\s+/);
      const dotted = /^\$env\.(.+)$/.exec(name);
      value = dotted ? env.processEnv?.[dotted[1]] ?? process.env[dotted[1]] : await fns[name]?.(args);
    } else if (Object.hasOwn(environment, expr) || Object.hasOwn(file, expr)) {
      const raw = String(Object.hasOwn(environment, expr) ? environment[expr] : file[expr]);
      // Variables made of other variables, to a depth that a loop can't go past.
      if (depth < 10) {
        const inner = await fill(raw, { environment, file, responses, env }, depth + 1);
        value = inner.text;
        missing.push(...inner.missing);
      } else value = raw;
    } else value = fromResponse(expr, responses);
    if (value == null) {
      missing.push(expr);
      out.push(m[0]);
    } else out.push(value);
  }
  out.push(String(text).slice(last));
  return { text: out.join(''), missing: [...new Set(missing)] };
}
