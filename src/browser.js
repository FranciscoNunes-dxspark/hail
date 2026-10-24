// Opening a page in the system's browser (an OAuth sign-in), through what the system has for it. The
// URL is an argument of its own, never through a shell, so an & in it stays part of it.
import { execFile } from 'node:child_process';

/** Opens `url` in the default browser; resolves once the opener has started, rejects if it can't be. */
export function openInBrowser(url) {
  const [file, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { windowsHide: true }, () => {});
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
