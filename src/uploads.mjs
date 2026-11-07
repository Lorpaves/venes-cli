// Pictures and files a client attaches to a message, kept on this Mac where Claude can reach them.
// A picture's path is pasted on its own, which Claude Code turns into an image the way it does one
// dragged into the terminal. A file goes in as an @ reference, which puts its contents in the message.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HelperError } from './errors.mjs';
import { helperPaths } from './paths.mjs';

// The pictures Claude can look at, with the extensions Claude Code knows them by.
const IMAGE_EXTENSIONS = new Map([
  ['image/png', ['png']], ['image/jpeg', ['jpg', 'jpeg']], ['image/gif', ['gif']], ['image/webp', ['webp']],
]);
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
const MAX_NAME_LENGTH = 120;
const MAX_EXTENSION_LENGTH = 16;
// A message needs its files while Claude might look at them again, but not forever.
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const UPLOAD_ID = /^[0-9a-f]{32}$/;
const MEDIA_TYPE = /^[\w.+-]+\/[\w.+-]+$/;
const ABOUT = 'upload.json';
// What Venes types ahead of a message's text: Claude Code shows each pasted picture as one of these,
// and each file is an @ reference, quoted for the spaces a name can have.
const IMAGE_MARK = /^\[Image #\d+\]/;
const QUOTED_REFERENCE = /^@"([^"]+)"/;
const BARE_REFERENCE = /^@?(\/\S+)/;

export const uploadsRoot = () => helperPaths().uploads;

export const isImage = mediaType => IMAGE_EXTENSIONS.has(String(mediaType).toLowerCase());

// A name that's safe as one part of a path and inside an @"…" reference. A picture's has no spaces,
// because Claude Code only turns a pasted path into an image when the paste is the path and nothing
// else, and it ends in its type's extension, which is how Claude Code tells it's a picture.
export function safeName(name, mediaType) {
  const extensions = IMAGE_EXTENSIONS.get(String(mediaType).toLowerCase());
  let base = String(name ?? '').split(/[\\/]/).pop()
    .replace(/\s+/g, extensions ? '-' : ' ')
    .replace(/[\u0000-\u001f\u007f"]/g, '')
    .replace(/^[.\s-]+/, '')
    .trim();
  if (extensions && !extensions.some(extension => base.toLowerCase().endsWith(`.${extension}`))) {
    base = `${base || 'image'}.${extensions[0]}`;
  }
  if (!base) base = 'file';
  if (base.length > MAX_NAME_LENGTH) {
    const extension = path.extname(base);
    base = extension.length <= MAX_EXTENSION_LENGTH
      ? base.slice(0, MAX_NAME_LENGTH - extension.length) + extension
      : base.slice(0, MAX_NAME_LENGTH);
  }
  return base;
}

function sessionFolder(root, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new HelperError('unknown_session', 'Unknown session.');
  return path.join(root, sessionId);
}

const tooLarge = () => new HelperError('too_large', `A file can be up to ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

// Keeps what a client sent for a message it's about to send. `data` is base64.
export function saveUpload(root, { sessionId, name, mediaType, data }) {
  const folder = sessionFolder(root, sessionId);
  const type = typeof mediaType === 'string' ? mediaType.toLowerCase() : '';
  if (!MEDIA_TYPE.test(type)) throw new HelperError('bad_upload', 'This file has no type.');
  if (typeof data !== 'string' || !data) throw new HelperError('bad_upload', 'This file is empty.');
  if (data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) throw tooLarge();
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw new HelperError('bad_upload', 'This file is empty.');
  if (bytes.length > MAX_UPLOAD_BYTES) throw tooLarge();
  const uploadId = crypto.randomBytes(16).toString('hex');
  const about = { name: safeName(name, type), mediaType: type, size: bytes.length, kind: isImage(type) ? 'image' : 'file' };
  const dir = path.join(folder, uploadId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, about.name), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, ABOUT), JSON.stringify(about), { mode: 0o600 });
  return { uploadId, ...about };
}

function readAbout(dir) {
  try {
    const about = JSON.parse(fs.readFileSync(path.join(dir, ABOUT), 'utf8'));
    return typeof about?.name === 'string' && about.name && about.name === path.basename(about.name) ? about : undefined;
  } catch {
    return undefined;
  }
}

// An upload a message names, with where it is. Undefined when it's gone.
export function findUpload(root, sessionId, uploadId) {
  if (typeof uploadId !== 'string' || !UPLOAD_ID.test(uploadId)) return undefined;
  const dir = path.join(sessionFolder(root, sessionId), uploadId);
  const about = readAbout(dir);
  const file = about && path.join(dir, about.name);
  return file && fs.existsSync(file) ? { uploadId, ...about, path: file } : undefined;
}

export function removeUploads(root, sessionId) {
  fs.rmSync(sessionFolder(root, sessionId), { recursive: true, force: true });
}

export function pruneUploads(root, { now = Date.now(), keepMs = KEEP_MS } = {}) {
  let sessions;
  try { sessions = fs.readdirSync(root); } catch { return; }
  for (const session of sessions) {
    const folder = path.join(root, session);
    let uploads;
    try { uploads = fs.readdirSync(folder); } catch { continue; }
    for (const upload of uploads) {
      const dir = path.join(folder, upload);
      try {
        if (now - fs.statSync(dir).mtimeMs > keepMs) fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* gone already */ }
    }
    try { if (!fs.readdirSync(folder).length) fs.rmdirSync(folder); } catch { /* still in use */ }
  }
}

// What's typed for a file: an @ reference, which Claude Code fills in with the file's contents.
export const referenceTo = upload => `@"${upload.path}"`;

// A file kept in `root`, told by its path: the folders are the session's and the upload's.
function describeUpload(root, file) {
  const resolved = path.resolve(file);
  const parts = path.relative(path.resolve(root), resolved).split(path.sep);
  if (parts.length !== 3 || parts.includes('..') || !UPLOAD_ID.test(parts[1])) return undefined;
  const about = readAbout(path.dirname(resolved));
  return { uploadId: parts[1], name: parts[2], mediaType: about?.mediaType, size: about?.size };
}

// A message without what Venes typed ahead of its text: a mark for each picture, and a reference
// for each file in `root`. A picture Claude Code didn't take stays as its path, which counts as a
// file. Only at the start, where Venes puts them: further on, they're part of what someone wrote.
export function splitAttachments(text, root = uploadsRoot()) {
  const files = [];
  let rest = text;
  for (;;) {
    const trimmed = rest.trimStart();
    const mark = trimmed.match(IMAGE_MARK);
    if (mark) {
      rest = trimmed.slice(mark[0].length);
      continue;
    }
    const reference = trimmed.match(QUOTED_REFERENCE) ?? trimmed.match(BARE_REFERENCE);
    const file = reference && describeUpload(root, reference[1]);
    if (!file) break;
    files.push(file);
    rest = trimmed.slice(reference[0].length);
  }
  return rest === text ? { text, files } : { text: rest.trimStart(), files };
}
