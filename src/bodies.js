// The bodies that are more than text, written as JetBrains writes them: multipart forms, whose parts
// can take a file (`< ./photo.png`), and GraphQL, a query with its variables after it.
//
//   POST {{host}}/upload                       GRAPHQL {{host}}/graphql
//   Content-Type: multipart/form-data; boundary=WebAppBoundary
//                                              query Hero($id: ID!) {
//   --WebAppBoundary                             hero(id: $id) { name }
//   Content-Disposition: form-data; name="title"   }
//
//   Holidays                                   { "id": "1000" }
//   --WebAppBoundary
//   Content-Disposition: form-data; name="photo"; filename="beach.png"
//   Content-Type: image/png
//
//   < ./beach.png
//   --WebAppBoundary--

const header = (headers, name) => headers.find(([k]) => k.toLowerCase() === name)?.[1];

/** The boundary of a multipart Content-Type among `headers`, or null when it isn't one. */
export function multipartBoundary(headers) {
  const type = header(headers, 'content-type') ?? '';
  if (!/^\s*multipart\//i.test(type)) return null;
  return /boundary\s*=\s*"?([^";]+)"?/i.exec(type)?.[1]?.trim() ?? null;
}

/** A line of a multipart body that stands for a file: `< path` as it is, `<@ path` with variables filled in. */
export const FILE_LINE = /^<(@?)\s+(.+?)\s*$/;

/**
 * The multipart body `text` (lines split by \n) as the bytes to send: lines joined with CRLF, as the
 * format wants, and each `< path` line replaced by the file's bytes (read with `readBytes(path)`), `<@`
 * ones by its text with variables filled in (`readText`, `fill`). Binary files go as they are.
 */
export async function multipartPayload(text, { readBytes, readText, fill = async (t) => t }) {
  const lines = String(text).split('\n');
  const chunks = [];
  for (const [i, l] of lines.entries()) {
    if (i) chunks.push(Buffer.from('\r\n'));
    const file = FILE_LINE.exec(l);
    if (!file) chunks.push(Buffer.from(l, 'utf8'));
    else if (file[1]) chunks.push(Buffer.from(await fill(await readText(file[2])), 'utf8'));
    else chunks.push(await readBytes(file[2]));
  }
  // The closing boundary ends with a line break, as browsers send it.
  if (/^--.*--\s*$/.test(lines.at(-1) ?? '')) chunks.push(Buffer.from('\r\n'));
  return Buffer.concat(chunks);
}

/** A multipart body's parts: [{ name, filename, type, file, value }], `file` the path of a `< path` part. */
export function multipartParts(text, boundary) {
  const parts = [];
  let part = null;
  let inHeaders = false;
  const content = [];
  const close = () => {
    if (!part) return;
    while (content.length && !content.at(-1).trim()) content.pop();
    const file = content.length === 1 ? FILE_LINE.exec(content[0]) : null;
    if (file) part.file = file[2];
    else part.value = content.join('\n');
    parts.push(part);
    content.length = 0;
  };
  for (const l of String(text).split('\n')) {
    if (l.trim() === `--${boundary}` || l.trim() === `--${boundary}--`) {
      close();
      part = l.trim().endsWith('--') && l.trim() !== `--${boundary}` ? null : { name: '', filename: null, type: null, file: null, value: '' };
      inHeaders = Boolean(part);
      continue;
    }
    if (!part) continue;
    if (inHeaders) {
      if (!l.trim()) inHeaders = false;
      else if (/^content-disposition\s*:/i.test(l)) {
        part.name = /\bname="([^"]*)"/i.exec(l)?.[1] ?? /\bname=([^;\s]+)/i.exec(l)?.[1] ?? '';
        part.filename = /\bfilename="([^"]*)"/i.exec(l)?.[1] ?? null;
      } else if (/^content-type\s*:/i.test(l)) part.type = l.replace(/^content-type\s*:\s*/i, '').trim();
      continue;
    }
    content.push(l);
  }
  close();
  return parts;
}

/** Whether the request is a GraphQL one: the GRAPHQL method, or JetBrains' X-REQUEST-TYPE: GraphQL. */
export const isGraphql = (method, headers) => method === 'GRAPHQL' || /^graphql$/i.test(header(headers, 'x-request-type') ?? '');

/**
 * A GraphQL body as JSON to POST: the query, and the variables when a JSON object follows it after a
 * blank line. { query, variables? }.
 */
export function graphqlBody(text) {
  const t = String(text).trim();
  const breaks = [...t.matchAll(/\n[ \t]*\n/g)];
  for (let i = breaks.length - 1; i >= 0; i--) {
    const at = breaks[i].index;
    const tail = t.slice(at).trim();
    if (!tail.startsWith('{')) continue;
    try {
      const variables = JSON.parse(tail);
      if (variables && typeof variables === 'object' && !Array.isArray(variables)) return { query: t.slice(0, at).trim(), variables };
    } catch {
      // Not JSON: part of the query, then.
    }
    break;
  }
  return { query: t };
}
