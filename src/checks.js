// JetBrains' response handlers: `> {% ... %}` after a request (or `> ./checks.js`), run on what came
// back. They run in a sandbox of their own (node:vm, a context with nothing of this process in it: no
// require, no process, no timers), with a time limit, and see the subset of JetBrains' API that checks
// a response and passes values on:
//
//   client.test(name, fn)        a test: passes unless fn throws (client.assert inside it throws)
//   client.assert(cond, message) throws unless cond holds
//   client.log(...values)        a line under the response
//   client.global.set(name, v)   a global variable, which {{name}} reads from then on
//   client.global.get(name)      …and reads back here; also isEmpty(), clear(name), clearAll()
//   client.exit()                stops the script there
//   response.status              200
//   response.body                the parsed JSON when it's JSON, else the text
//   response.headers.valueOf(n)  a header's value (the first), valuesOf(n) all of them
//   response.contentType         { mimeType, charset }
//
// Nothing crosses into the sandbox but one JSON string, and nothing comes out but another, so a script
// can't reach this process through an object it was handed.
import vm from 'node:vm';

/** How long a script may run before it's stopped, in milliseconds. */
export const SCRIPT_TIMEOUT = 2000;

// Built inside the sandbox from __input (a string), leaving __out for the results.
const PRELUDE = `(() => {
  const input = JSON.parse(globalThis.__input);
  delete globalThis.__input;
  const out = { tests: [], log: [], globals: input.globals };
  globalThis.__out = out;
  class Failed extends Error {}
  class Exit extends Error {}
  globalThis.__Exit = Exit;
  globalThis.__Failed = Failed;
  const text = (v) => {
    if (typeof v === 'string') return v;
    try {
      const s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  const message = (e) => (e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
  let body = input.body;
  if (/json/i.test(input.contentType.mimeType) || /^\\s*[[{]/.test(body)) {
    try {
      body = JSON.parse(body);
    } catch {}
  }
  const headers = input.headers;
  const values = (name) => headers.filter((h) => h[0].toLowerCase() === String(name).toLowerCase()).map((h) => h[1]);
  globalThis.client = {
    test(name, fn) {
      try {
        fn();
        out.tests.push({ name: text(name), passed: true });
      } catch (e) {
        if (e instanceof Exit) throw e;
        out.tests.push({ name: text(name), passed: false, message: message(e) });
      }
    },
    assert(cond, msg) {
      if (!cond) throw new Failed(msg === undefined ? 'Assertion failed' : text(msg));
    },
    log(...args) {
      out.log.push(args.map(text).join(' '));
    },
    exit() {
      throw new Exit();
    },
    global: {
      set(name, value) {
        out.globals[String(name)] = value == null ? '' : typeof value === 'object' ? text(value) : String(value);
      },
      get(name) {
        return Object.prototype.hasOwnProperty.call(out.globals, name) ? out.globals[name] : null;
      },
      isEmpty() {
        return Object.keys(out.globals).length === 0;
      },
      clear(name) {
        delete out.globals[name];
      },
      clearAll() {
        for (const k of Object.keys(out.globals)) delete out.globals[k];
      },
    },
  };
  globalThis.console = { log: client.log, info: client.log, warn: client.log, error: client.log };
  globalThis.response = {
    status: input.status,
    body,
    contentType: input.contentType,
    headers: { valueOf: (name) => values(name)[0] ?? null, valuesOf: (name) => values(name) },
  };
})();`;

// What a top-level throw becomes: an assertion outside a test fails as one; anything else is the
// script's error, said back as the expression's value.
const AFTER = `(() => {
  const e = globalThis.__thrown;
  if (e === undefined || e instanceof __Exit) return '';
  const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  if (!(e instanceof __Failed)) return message;
  __out.tests.push({ name: message, passed: false, message });
  return '';
})()`;

/** The response's Content-Type as JetBrains gives it: { mimeType, charset }. */
export function contentType(headers) {
  const raw = headers.find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const [mime, ...params] = raw.split(';');
  const charset = params.map((p) => /^\s*charset\s*=\s*"?([^";]+)"?/i.exec(p)?.[1]).find(Boolean);
  return { mimeType: mime.trim(), charset: charset ?? (/json|text|xml/i.test(mime) ? 'utf-8' : null) };
}

// A context of its own (DONT_CONTEXTIFY gives it an ordinary global object of its own realm, so not
// even the global leads back here); runtimes without that flag get an empty contextified object.
function newContext() {
  const flag = vm.constants?.DONT_CONTEXTIFY;
  try {
    return flag ? vm.createContext(flag, { microtaskMode: 'afterEvaluate' }) : vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  } catch {
    return vm.createContext({});
  }
}

/**
 * Runs `scripts` ([{ script, name }], in order, sharing one sandbox) on `response` ({ status, headers,
 * body }), with `globals` ({ name: value }) to start from. Resolves with { tests: [{ name, passed,
 * message }], log: [text], globals, error }: `globals` as the scripts left them, `error` the first
 * script's error that wasn't a failed test (a mistake in it, or running out of time).
 */
export function runChecks(scripts, response, { globals = {}, timeout = SCRIPT_TIMEOUT } = {}) {
  const context = newContext();
  context.__input = JSON.stringify({ status: response.status, headers: response.headers, body: response.body ?? '', contentType: contentType(response.headers), globals: { ...globals } });
  vm.runInContext(PRELUDE, context);
  let error = null;
  for (const { script, name = 'the response handler' } of scripts) {
    try {
      vm.runInContext(`globalThis.__thrown = undefined;\ntry {\n${script}\n} catch (e) { globalThis.__thrown = e; }`, context, { timeout, filename: name });
    } catch (e) {
      // A syntax error, or out of time: the try above never ran, or was stopped.
      const why = /timed out/i.test(e?.message) ? `it ran for over ${timeout / 1000} s, so it was stopped` : e?.message ?? String(e);
      error ??= `${name}: ${why}`;
      continue;
    }
    const thrown = vm.runInContext(AFTER, context);
    if (thrown) error ??= `${name}: ${thrown}`;
  }
  const out = JSON.parse(vm.runInContext('JSON.stringify(__out)', context));
  return { tests: out.tests, log: out.log, globals: out.globals, error };
}

/** "3 passed", "1 of 3 failed", or '' without tests; `failed` counts the failures. */
export function checkSummary(checks) {
  const tests = checks?.tests ?? [];
  const failed = tests.filter((t) => !t.passed).length;
  if (!tests.length) return { text: checks?.error ? 'the handler failed' : '', failed: checks?.error ? 1 : 0, total: 0 };
  return { text: failed ? `${failed} of ${tests.length} test${tests.length === 1 ? '' : 's'} failed` : `${tests.length} test${tests.length === 1 ? '' : 's'} passed`, failed: failed + (checks.error ? 1 : 0), total: tests.length };
}
