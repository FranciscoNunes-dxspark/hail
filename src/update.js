// Whether a newer Hail has been released, and installing it. Asked at most once a day, in the
// background, and silent when it can't tell (offline, no gh). "checkForUpdates": false in the config
// turns it all off; "autoUpdate": false keeps the check but only says a release is out.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VERSION } from './version.js';

export const REPO = 'FranciscoNunes-dxspark/hail';
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const DAY = 24 * 60 * 60 * 1000;

/** Runs the GitHub CLI, resolving with its stdout. */
function gh(args, { signal } = {}) {
  return new Promise((resolve, reject) =>
    execFile('gh', args, { signal, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim())) : resolve(stdout),
    ),
  );
}

/** Compares two "1.2.3" versions (a leading v is fine); a pre-release sorts before its release. Unreadable ones count as equal. */
export function compareVersions(a, b) {
  const parse = (v) => String(v ?? '').trim().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)(-.+)?$/);
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (Boolean(x[4]) !== Boolean(y[4])) return x[4] ? -1 : 1;
  return 0;
}

/** The latest release, as { version, url }. Throws if it can't be found out. */
export async function fetchLatestRelease() {
  // Without a sign-in first: that works for anyone once the repository is public, with nothing installed.
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `hail/${VERSION}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) return release(await res.json());
  } catch {
    // Offline or blocked; gh may still get through.
  }
  // A private repository answers 404 to that, so ask through gh, with the sign-in it already has.
  return release(JSON.parse(await gh(['api', `repos/${REPO}/releases/latest`], { signal: AbortSignal.timeout(15000) })));
}

function release(body) {
  const version = String(body?.tag_name ?? '').replace(/^v/, '');
  if (!version) throw new Error('No release found');
  return { version, url: body.html_url || RELEASES_URL };
}

/**
 * What the last check found (`last`: { at, latest, url } from the config), asking again when it's
 * a day old. Resolves with { checked, newer }; `checked` goes back into the config.
 */
export async function checkForUpdate(last, { current = VERSION, now = Date.now(), fetchLatest = fetchLatestRelease } = {}) {
  let checked = last;
  // A check from the future (the clock moved back) counts as stale too.
  if (!last?.latest || !(now - last.at >= 0 && now - last.at < DAY)) {
    const latest = await fetchLatest();
    checked = { at: now, latest: latest.version, url: latest.url };
  }
  return { checked, newer: compareVersions(checked.latest, current) > 0 };
}

// The release file for each platform; these names come from TARGETS in scripts/build.js.
const ASSETS = {
  'win32-x64': 'hail-windows-x64.exe',
  'linux-x64': 'hail-linux-x64',
  'linux-arm64': 'hail-linux-arm64',
  'darwin-x64': 'hail-macos-x64',
  'darwin-arm64': 'hail-macos-arm64',
};
const CHECKSUMS = 'SHA256SUMS.txt';
const DOWNLOAD_MS = 10 * 60 * 1000;
const WORK_PREFIX = '.hail-update-';

/** The release file that runs on `platform` and `arch`, or null if there's none. */
export function assetName(platform = process.platform, arch = process.arch) {
  return ASSETS[`${platform}-${arch}`] ?? null;
}

/** sha256sum's output ("<hash>  <name>", or "<hash> *<name>" for binary mode) as a Map from name to hash. */
export function parseChecksums(text) {
  const out = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (m) out.set(m[2], m[1].toLowerCase());
  }
  return out;
}

/** Downloads release `version`'s files `names` into `dir`: straight from GitHub, or through gh while the repository is private. */
async function downloadAssets(version, names, dir) {
  try {
    for (const name of names) {
      const res = await fetch(`https://github.com/${REPO}/releases/download/v${version}/${name}`, {
        headers: { 'User-Agent': `hail/${VERSION}` },
        signal: AbortSignal.timeout(DOWNLOAD_MS),
      });
      if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(join(dir, name)));
    }
    return;
  } catch {
    // A private repository answers 404; gh has a sign-in that can read it.
  }
  await gh(['release', 'download', `v${version}`, '--repo', REPO, '--dir', dir, '--clobber', ...names.flatMap((n) => ['--pattern', n])], {
    signal: AbortSignal.timeout(DOWNLOAD_MS),
  });
}

/** The version an executable says it is (`hail --version`), or null if it doesn't answer. */
function versionOf(exe) {
  return new Promise((resolve) => {
    execFile(exe, ['--version'], { timeout: 10000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : (/hail (\S+)/.exec(stdout)?.[1] ?? null)),
    );
  });
}

/**
 * Replaces the executable `exe` with release `version`, which then runs from the next start. The
 * download goes into a folder next to `exe` (the same disk, so the swap is a rename) and must match the
 * release's SHA256SUMS.txt. Windows won't overwrite a running program but will rename it, so there the
 * old one moves aside to `<exe>.old.<time>`, for removeOldExecutables to delete on a later start.
 * Resolves with "installed", or "already" if `exe` is that version already (another Hail window got
 * there first). Throws, with `exe` as it was, if anything goes wrong: a folder Hail can't write to,
 * no download, a checksum that doesn't match.
 */
export async function installUpdate(
  version,
  { exe = process.execPath, platform = process.platform, arch = process.arch, download = downloadAssets, installed = versionOf } = {},
) {
  const name = assetName(platform, arch);
  if (!name) throw new Error(`there's no release build for ${platform} ${arch}`);
  if ((await installed(exe)) === version) return 'already';
  const work = await mkdtemp(join(dirname(exe), WORK_PREFIX));
  try {
    await download(version, [name, CHECKSUMS], work);
    const want = parseChecksums(await readFile(join(work, CHECKSUMS), 'utf8')).get(name);
    if (!want) throw new Error(`the release has no checksum for ${name}`);
    const file = join(work, name);
    const got = createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
    if (got !== want) throw new Error(`the download of ${name} doesn't match its checksum`);
    if (platform !== 'win32') {
      await chmod(file, 0o755);
      // Replaces it in one step; a Hail still running keeps the copy it started from.
      await rename(file, exe);
    } else {
      const aside = `${exe}.old.${Date.now()}`;
      await rename(exe, aside);
      try {
        await rename(file, exe);
      } catch (e) {
        await rename(aside, exe);
        throw e;
      }
    }
    return 'installed';
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Deletes what earlier updates left next to `exe`: old executables moved aside (one still running stays
 * until a later start) and download folders of updates that were interrupted (an hour old, so a
 * download in another Hail window right now isn't touched).
 */
export async function removeOldExecutables(exe = process.execPath, { now = Date.now() } = {}) {
  const dir = dirname(exe);
  const old = `${basename(exe)}.old.`;
  for (const f of await readdir(dir).catch(() => [])) {
    const path = join(dir, f);
    if (f.startsWith(old)) await rm(path, { force: true }).catch(() => {});
    else if (f.startsWith(WORK_PREFIX)) {
      const s = await stat(path).catch(() => null);
      if (s && now - s.mtimeMs > 60 * 60 * 1000) await rm(path, { recursive: true, force: true }).catch(() => {});
    }
  }
}
