// Environments: http-client.env.json beside the .http file (JetBrains' name, also read by VS Code users
// through it), with http-client.private.env.json over it for secrets that stay out of git. Each holds
// { "dev": { "host": "..." }, "prod": { ... } }; "$shared" (VS Code's) goes into every one.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const ENV_FILES = ['http-client.env.json', 'http-client.private.env.json'];

// Not variables: settings of the environment, as JetBrains has them.
const SETTINGS = new Set(['SSLConfiguration']);

/**
 * The environments in `files` (parsed JSON, later ones over earlier): { names, vars(name), options(name) },
 * `options` being the environment's settings: { insecure } from "SSLConfiguration": { "verifyHostCertificate": false }.
 */
export function environmentsFrom(files) {
  const all = files.filter((f) => f && typeof f === 'object');
  const names = [...new Set(all.flatMap((f) => Object.keys(f).filter((k) => k !== '$shared' && f[k] && typeof f[k] === 'object')))];
  const vars = (name) => {
    const out = {};
    for (const f of all) Object.assign(out, f.$shared, name ? f[name] : undefined);
    for (const k of Object.keys(out)) {
      if (SETTINGS.has(k)) delete out[k];
      else if (out[k] != null && typeof out[k] === 'object') out[k] = JSON.stringify(out[k]);
    }
    return out;
  };
  const options = (name) => {
    const ssl = {};
    for (const f of all) Object.assign(ssl, f.$shared?.SSLConfiguration, name ? f[name]?.SSLConfiguration : undefined);
    return { insecure: ssl.verifyHostCertificate === false };
  };
  return { names, vars, options };
}

/** The environments beside a .http file in `dir`. A file that isn't JSON is an error naming it. */
export function loadEnvironments(dir) {
  const files = ENV_FILES.map((f) => {
    let text;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${f} isn't valid JSON: ${e.message}`);
    }
  });
  return environmentsFrom(files);
}

/** The environment to use for `data`: the one picked for this file last time, else dev or local, else none. */
export function defaultEnvironment(data, saved) {
  const names = data?.environments.names ?? [];
  if (saved && names.includes(saved)) return saved;
  return names.find((n) => /^(dev|local)/i.test(n)) ?? null;
}
