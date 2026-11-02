// The arguments of a tools/call, redacted before the proxy forwards them to the node. Every tool
// gets redactValue (lib/redact.js) on every argument, with one exception: the file of the node's
// send_file tool. Its contentBase64 is a whole file as one base64 string, and the high-entropy
// family takes any long random-looking string for a credential, so redacted as one value every
// file became "[REDACTED:high-entropy]" and the node refused it as invalid base64. The file is
// redacted as a file instead:
//   text    (a text-like mimeType, or bytes that are UTF-8 without a NUL): decoded, run through
//           redact() with every family, exactly as the same text pasted into a call would be
//           (so a random token inside the text still goes), then encoded as base64 again. Bytes
//           that are not UTF-8 are read as latin1, which gives every byte back unchanged.
//   binary  (PDF, images, audio, video, office zip formats, anything else): sent unchanged. The
//           base64 of binary bytes is an encoding, not a secret.
// KNOWN GAP: a secret written inside a binary document (the text of a PDF, a .docx, .xlsx or
// .pptx, which are zip archives) is not redacted: reading it would need a PDF and zip reader, and
// this package has no dependencies. Text files are covered; office documents and PDFs are not.
// Every other argument of send_file (filename, mimeType, note) keeps the ordinary redaction.

import { redact, redactValue } from './redact.js';

export const SEND_FILE_TOOL = 'send_file';

/** The node's own check (wybe-node send_file): whitespace removed, both alphabets, padding at most 2. */
const BASE64 = /^[A-Za-z0-9+/_-]*={0,2}$/;

/** A mimeType whose bytes are text. Parameters (charset=...) and case are ignored. */
export function isTextMime(mimeType) {
  const t = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (!t) return false;
  if (t.startsWith('text/')) return true;
  if (/\+(?:json|xml|yaml)$/.test(t)) return true;
  return /^application\/(?:json|ld\+json|xml|x-yaml|yaml|csv|x-csv|markdown|x-markdown|toml|x-toml|x-sh|javascript|x-javascript|ecmascript|sql|x-ndjson|ndjson|x-www-form-urlencoded|x-ipynb\+json)$/.test(t);
}

/** A mimeType that names a binary format: never decoded as text, whatever its bytes look like. */
function isBinaryMime(mimeType) {
  const t = String(mimeType ?? '').split(';')[0].trim().toLowerCase();
  if (/^(?:image|audio|video|font)\//.test(t)) return true;
  if (/^application\/(?:pdf|zip|gzip|x-gzip|x-tar|x-7z-compressed|x-rar-compressed|vnd\.rar|msword|vnd\.ms-|vnd\.openxmlformats-|vnd\.oasis\.opendocument\.|epub\+zip|wasm)/.test(t)) return true;
  return false;
}

/** Magic numbers of binary formats, checked before the bytes are guessed at. */
const MAGIC = [
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x50, 0x4b, 0x03, 0x04], // zip (docx, xlsx, pptx, odt, epub, jar)
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
  [0x1f, 0x8b], // gzip
  [0xd0, 0xcf, 0x11, 0xe0], // old Office (doc, xls, ppt)
];
const hasMagic = (buf) => MAGIC.some((m) => buf.length >= m.length && m.every((b, i) => buf[i] === b));

function isUtf8(buf) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * redactFile(contentBase64, mimeType) -> { contentBase64, hits, kind: 'text' | 'binary' | 'not-base64' }.
 * A value that is not base64 gets the ordinary redaction (the node refuses it anyway).
 */
export function redactFile(contentBase64, mimeType, options = {}) {
  const clean = /\s/.test(contentBase64) ? contentBase64.replace(/\s+/g, '') : contentBase64;
  if (!clean || !BASE64.test(clean) || clean.length % 4 === 1) {
    const r = redact(contentBase64, options);
    return { contentBase64: r.text, hits: r.hits, kind: 'not-base64' };
  }
  const buf = Buffer.from(clean, 'base64');
  const binary = hasMagic(buf) || isBinaryMime(mimeType) || (!isTextMime(mimeType) && (buf.includes(0) || !isUtf8(buf)));
  if (binary) return { contentBase64, hits: [], kind: 'binary' };
  const encoding = isUtf8(buf) ? 'utf8' : 'latin1';
  const r = redact(buf.toString(encoding), options);
  if (r.hits.length === 0) return { contentBase64, hits: [], kind: 'text' }; // nothing found: the file as sent
  return { contentBase64: Buffer.from(r.text, encoding).toString('base64'), hits: r.hits, kind: 'text' };
}

/**
 * redactToolArguments(name, args) -> { value, hits }: what the proxy forwards for one tools/call.
 * Throws like redactValue on a value it cannot walk, so the caller refuses the call.
 */
export function redactToolArguments(name, args, options = {}) {
  const plain = typeof args === 'object' && args !== null && !Array.isArray(args) && Object.getPrototypeOf(args) === Object.prototype;
  if (name !== SEND_FILE_TOOL || !plain || typeof args.contentBase64 !== 'string') return redactValue(args, options);
  const { contentBase64, ...rest } = args;
  const others = redactValue(rest, options);
  const file = redactFile(contentBase64, typeof args.mimeType === 'string' ? args.mimeType : '', options);
  const value = {};
  for (const k of Object.keys(args)) value[k] = k === 'contentBase64' ? file.contentBase64 : others.value[k];
  const totals = new Map();
  for (const h of [...others.hits, ...file.hits]) totals.set(h.family, (totals.get(h.family) ?? 0) + h.count);
  return { value, hits: [...totals].map(([family, count]) => ({ family, count })) };
}
