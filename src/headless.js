// `hail test api.http [--env dev]`: every request in the file, top to bottom, without the UI, as
// /send all does it: the report goes to stdout, and the exit code says whether it all went well (0),
// something failed (1: a test, a handler, a request not sent or not answered), or it couldn't run (2).
// For CI. Nothing is kept in the history.
import { resolve } from 'node:path';
import { historyFile, readHistory } from './history.js';
import { DEFAULT_PORT, routesFor, startMock } from './mock.js';
import { azToken as azCli } from './azure.js';
import { loadConfig } from './config.js';
import { createJar } from './cookies.js';
import { defaultEnvironment } from './environments.js';
import { findHttpFiles, loadHttpFile } from './files.js';
import { readFileSync, statSync } from 'node:fs';
import { parseHttpFile } from './http-file.js';
import { checkContract, loadContract } from './contract.js';
import { exchange, inRun, reportLines, runFailed } from './runner.js';
import { prepare } from './send.js';
import { createTokens, fillAuthConfig, readAuthConfig, refreshName } from './oauth.js';

export const TEST_USAGE = `hail test [file.http] [--env <name>] [--contract <openapi file or URL>] [--contract-strict]

Sends every request in the file, top to bottom, runs their response handlers
(> {% client.test(...) %}), prints a report, and exits with 1 if a test failed,
a handler broke, or a request wasn't sent or got no answer (2 if it couldn't run).

Responses are checked against the contract /contract set for the file in Hail
(or --contract's); drifting from it counts as failing only with --contract-strict.`;

/** `hail test`'s arguments: { file, env, help } or { problem }. */
export function testArgs(args) {
  const out = { file: null, env: null, help: false, contract: null, strict: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--contract') {
      out.contract = args[++i] ?? null;
      if (!out.contract) return { problem: '--contract needs an OpenAPI file or URL' };
    } else if (a.startsWith('--contract=')) out.contract = a.slice(11);
    else if (a === '--contract-strict') out.strict = true;
    else if (a.startsWith('-')) return { problem: `${a} isn't an option of hail test` };
    else if (out.file) return { problem: `One file at a time: ${out.file} or ${a}?` };
    else out.file = a;
  }
  return out;
}

const ANSI = { add: 32, del: 31, dim: 2, warn: 33 };
const statusTone = (s) => (s < 300 ? 'add' : s < 400 ? null : s < 500 ? 'warn' : 'del');

/** The report's lines as text, coloured with ANSI codes when `color`. */
export function plainReport(lines, { color = false } = {}) {
  const paint = (seg) => {
    const tone = seg.status ? statusTone(seg.status) : seg.tone;
    const codes = [seg.bold ? 1 : null, ANSI[tone]].filter(Boolean);
    return color && codes.length ? `\x1b[${codes.join(';')}m${seg.text}\x1b[0m` : seg.text;
  };
  return lines.map((segs) => segs.map(paint).join('')).join('\n');
}

/**
 * Runs `args` (what follows `hail test`); `print` and `printError` take a line each. Resolves with the
 * exit code. `credentials` answers {{$secret}} (a missing one leaves the request unsent), `azToken`
 * {{$azToken}}, `fetch` is the network (tests stub nothing: they run a server).
 */
export async function runTests(args, { print = console.log, printError = console.error, credentials, azToken = azCli, config = loadConfig(), color = false, cwd = process.cwd() } = {}) {
  const a = testArgs(args);
  if (a.problem) {
    printError(`${a.problem}\n\n${TEST_USAGE}`);
    return 2;
  }
  if (a.help) {
    print(TEST_USAGE);
    return 0;
  }
  const path = a.file ? resolve(cwd, a.file) : findHttpFiles(cwd).map((f) => resolve(cwd, f))[0];
  if (!path) {
    printError('No .http file here: name one, hail test api.http');
    return 2;
  }
  let data;
  try {
    data = await loadHttpFile(path);
  } catch (e) {
    printError(`Couldn't read ${path}: ${e.message.split('\n')[0]}`);
    return 2;
  }
  const names = data.environments.names;
  if (a.env && !names.includes(a.env)) {
    printError(names.length ? `There's no environment called ${a.env}. There are: ${names.join(', ')}` : `There are no environments beside ${data.name} (http-client.env.json).`);
    return 2;
  }
  const env = a.env ?? defaultEnvironment(data, config.environments?.[data.path]);
  // The contract: --contract's, else the one /contract set for this file.
  const source = a.contract ?? config.contracts?.[data.path] ?? null;
  let contract = null;
  if (source) {
    try {
      contract = await loadContract(source, { dir: a.contract ? cwd : data.dir });
    } catch (e) {
      printError(`The contract: ${e.message}`);
      if (a.contract || a.strict) return 2;
    }
  }
  const sockets = data.requests.length - data.requests.filter(inRun).length;
  print(`${data.name}${env ? ` · ${env}` : ''} · ${data.requests.length} request${data.requests.length === 1 ? '' : 's'}${sockets ? ` (${sockets} WebSocket${sockets === 1 ? '' : 's'} left out)` : ''}${contract ? ` · contract ${source}` : ''}\n`);
  const secret = async (name) => {
    try {
      return (await credentials?.get(name)) ?? null;
    } catch {
      return null;
    }
  };
  // {{$auth.token("id")}}: Client Credentials and Password sign in here; the others need a refresh token
  // kept by a sign-in in Hail itself (in the same store), as there's no one to sign in.
  const tokens = createTokens({ credentials, onNote: printError });
  const auth = async (kind, id) => {
    const raw = data.environments.auth(env)[id];
    if (!raw) throw new Error(`There's no auth called ${id} in ${env ? `the ${env} environment` : 'the environments'}`);
    const filled = await fillAuthConfig(raw, { globals, environment: data.environments.vars(env), file: data.variables, responses, env: { azToken, secret } });
    if (filled.missing.length) throw new Error(`The auth ${id} uses ${filled.missing.map((m) => `{{${m}}}`).join(', ')}, which nothing gives a value`);
    return tokens.get({ key: id, store: refreshName(data.path, env, id), cfg: readAuthConfig(id, filled.raw), kind });
  };
  const responses = {};
  const jar = createJar();
  let globals = {};
  const results = [];
  let stopped = false;
  const requests = data.requests.filter(inRun);
  for (const request of requests) {
    const scope = { globals, environment: data.environments.vars(env), file: data.variables, responses, env: { azToken, secret, auth } };
    let req;
    try {
      req = await prepare(request, scope, { dir: data.dir });
    } catch (e) {
      results.push({ request, skipped: e.message });
      continue;
    }
    if (req.missing.length) {
      results.push({ request, skipped: `nothing gives ${req.missing.map((m) => `{{${m}}}`).join(', ')} a value` });
      continue;
    }
    try {
      const out = await exchange(req, { globals, jar, insecure: data.environments.options(env).insecure });
      globals = out.globals;
      if (request.name) responses[request.name] = out.response;
      const drift = contract ? checkContract(contract.spec, req, out.response) : undefined;
      results.push({ request, response: out.response, checks: out.checks, saved: out.saved, contract: drift });
    } catch (e) {
      results.push({ request, error: e.message });
      stopped = true;
      break;
    }
  }
  print(plainReport(reportLines(results, { left: requests.slice(results.length), stopped, strict: a.strict }), { color }));
  return runFailed(results, { strict: a.strict }) ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------
// `hail mock api.http [--port 4010] [--env dev]`: the file's kept responses served on this machine, as
// /mock does inside Hail, until it's stopped (ctrl+c). Something Bosun can run as a process.

export const MOCK_USAGE = `hail mock [file.http] [--port <port>] [--env <name>]

Serves the latest response kept in Hail's history for each request in the file,
at its method and path ({{variables}} in a path match any segment), on
http://127.0.0.1:<port> (${DEFAULT_PORT} unless given); where the file has none, the examples
of the contract /contract set for it. Anything else gets a 404 listing what's
served. The history is read again as it changes. ctrl+c stops it.`;

/** `hail mock`'s arguments: { file, env, port, help } or { problem }. */
export function mockArgs(args) {
  const out = { file: null, env: null, port: DEFAULT_PORT, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
    else if (a === '--port' || a === '-p' || a.startsWith('--port=')) {
      const v = a.startsWith('--port=') ? a.slice(7) : args[++i];
      if (!/^\d+$/.test(v ?? '') || Number(v) > 65535) return { problem: '--port needs a port number' };
      out.port = Number(v);
    } else if (a.startsWith('-')) return { problem: `${a} isn't an option of hail mock` };
    else if (out.file) return { problem: `One file at a time: ${out.file} or ${a}?` };
    else out.file = a;
  }
  return out;
}

/** Something read again only when its file's modified time or size changes. */
function whenChanged(path, read) {
  let at = null;
  let value;
  return () => {
    let m = '';
    try {
      const st = statSync(path);
      m = `${st.mtimeMs}:${st.size}`;
    } catch {}
    if (m !== at) {
      at = m;
      value = read();
    }
    return value;
  };
}

/**
 * Runs `args` (what follows `hail mock`). Resolves with { code } when it can't start (or for --help), else
 * with the running mock: { code: null, port, close() }. Each hit is printed.
 */
export async function runMock(args, { print = console.log, printError = console.error, config = loadConfig(), cwd = process.cwd(), onStart } = {}) {
  const a = mockArgs(args);
  if (a.problem) {
    printError(`${a.problem}\n\n${MOCK_USAGE}`);
    return { code: 2 };
  }
  if (a.help) {
    print(MOCK_USAGE);
    return { code: 0 };
  }
  const path = a.file ? resolve(cwd, a.file) : findHttpFiles(cwd).map((f) => resolve(cwd, f))[0];
  if (!path) {
    printError('No .http file here: name one, hail mock api.http');
    return { code: 2 };
  }
  let data;
  try {
    data = await loadHttpFile(path);
  } catch (e) {
    printError(`Couldn't read ${path}: ${e.message.split('\n')[0]}`);
    return { code: 2 };
  }
  const names = data.environments.names;
  if (a.env && !names.includes(a.env)) {
    printError(names.length ? `There's no environment called ${a.env}. There are: ${names.join(', ')}` : `There are no environments beside ${data.name} (http-client.env.json).`);
    return { code: 2 };
  }
  const env = a.env ?? defaultEnvironment(data, config.environments?.[data.path]);
  let spec = null;
  const source = config.contracts?.[data.path];
  if (source) {
    try {
      spec = (await loadContract(source, { dir: data.dir })).spec;
    } catch (e) {
      printError(`The contract (left out): ${e.message}`);
    }
  }
  const file = whenChanged(path, () => {
    try {
      return { ...data, ...parseHttpFile(readFileSync(path, 'utf8')) };
    } catch {
      return data;
    }
  });
  const history = whenChanged(historyFile(data.path), () => readHistory(historyFile(data.path)));
  const routes = () => {
    const d = file();
    return routesFor({ requests: d.requests, entries: history(), vars: { ...d.variables, ...data.environments.vars(env) }, spec });
  };
  let mock;
  try {
    mock = await startMock({ port: a.port, routes, onHit: (h) => print(`${h.method} ${h.path} → ${h.status}${h.label ? `  ${h.label}` : ''}`) });
  } catch (e) {
    printError(`Couldn't start the mock: ${e.message}`);
    return { code: 2 };
  }
  const list = routes();
  print(`Mock of ${data.name}${env ? ` · ${env}` : ''} on http://127.0.0.1:${mock.port} · ${list.length} route${list.length === 1 ? '' : 's'}${list.length ? '' : ' (send the requests in Hail first: their responses are kept)'}`);
  for (const r of list) print(`  ${r.method.padEnd(6)} ${r.template}  ${r.label}${r.source === 'contract' ? ' (contract)' : ''}`);
  onStart?.(mock);
  return { code: null, ...mock };
}
