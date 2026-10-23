// `hail test api.http [--env dev]`: every request in the file, top to bottom, without the UI, as
// /send all does it: the report goes to stdout, and the exit code says whether it all went well (0),
// something failed (1: a test, a handler, a request not sent or not answered), or it couldn't run (2).
// For CI. Nothing is kept in the history.
import { resolve } from 'node:path';
import { azToken as azCli } from './azure.js';
import { loadConfig } from './config.js';
import { createJar } from './cookies.js';
import { defaultEnvironment } from './environments.js';
import { findHttpFiles, loadHttpFile } from './files.js';
import { exchange, reportLines, runFailed } from './runner.js';
import { prepare } from './send.js';

export const TEST_USAGE = `hail test [file.http] [--env <name>]

Sends every request in the file, top to bottom, runs their response handlers
(> {% client.test(...) %}), prints a report, and exits with 1 if a test failed,
a handler broke, or a request wasn't sent or got no answer (2 if it couldn't run).`;

/** `hail test`'s arguments: { file, env, help } or { problem }. */
export function testArgs(args) {
  const out = { file: null, env: null, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') out.help = true;
    else if (a === '--env' || a === '-e') {
      out.env = args[++i] ?? null;
      if (!out.env) return { problem: '--env needs the name of an environment' };
    } else if (a.startsWith('--env=')) out.env = a.slice(6);
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
  print(`${data.name}${env ? ` · ${env}` : ''} · ${data.requests.length} request${data.requests.length === 1 ? '' : 's'}\n`);
  const secret = async (name) => {
    try {
      return (await credentials?.get(name)) ?? null;
    } catch {
      return null;
    }
  };
  const responses = {};
  const jar = createJar();
  let globals = {};
  const results = [];
  let stopped = false;
  for (const request of data.requests) {
    const scope = { globals, environment: data.environments.vars(env), file: data.variables, responses, env: { azToken, secret } };
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
      results.push({ request, response: out.response, checks: out.checks });
    } catch (e) {
      results.push({ request, error: e.message });
      stopped = true;
      break;
    }
  }
  print(plainReport(reportLines(results, { left: data.requests.slice(results.length), stopped }), { color }));
  return runFailed(results) ? 1 : 0;
}
