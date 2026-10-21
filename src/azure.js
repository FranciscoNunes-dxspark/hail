// {{$azToken [resource]}}: a token from the Azure CLI's sign-in, as Trawl and Keel get theirs, so a
// request to Azure (or to anything behind Entra ID) needs no secret in the file. Kept for half an hour.
import { run } from './run.js';

const cache = new Map();
const KEEP_MS = 30 * 60 * 1000;

/** An access token for `resource` (Azure Resource Manager when none is named). */
export async function azToken(resource = 'https://management.azure.com/', { now = Date.now(), runner = run } = {}) {
  const hit = cache.get(resource);
  if (hit && now - hit.at < KEEP_MS) return hit.token;
  const { stdout } = await runner(`az account get-access-token --resource "${resource.replace(/"/g, '')}" --query accessToken -o tsv`);
  const token = stdout.trim();
  if (!token) throw new Error('az gave no token: sign in with az login');
  cache.set(resource, { token, at: now });
  return token;
}
