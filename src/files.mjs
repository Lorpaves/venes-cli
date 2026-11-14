// A session's folder, for someone following the work from afar: what's in it, a level at a time, and
// what's in a file. Everything is inside the folder the session works in, and nothing here changes it.

import fs from 'node:fs';
import path from 'node:path';
import { HelperError } from './errors.mjs';
import { changedPaths } from './git.mjs';

// A folder with more in it than this lists the first ones, and says so.
export const FILE_ENTRIES = 2000;
// As much of a text file as is sent. A longer one is cut at a line's end, and says so.
export const TEXT_BYTES = 512 * 1024;
// A file that isn't text is sent whole up to this size, for the client to show as the picture or the document it is.
export const BINARY_BYTES = 8 * 1024 * 1024;
// How much of a file is looked at to tell whether it's text.
const SNIFF_BYTES = 8 * 1024;
// What a folder's own bookkeeping is, which no one browsing it is after.
const HIDDEN = new Set(['.git', '.DS_Store']);

const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  bmp: 'image/bmp', tiff: 'image/tiff', tif: 'image/tiff', ico: 'image/x-icon', icns: 'image/icns', svg: 'image/svg+xml', pdf: 'application/pdf',
  mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  zip: 'application/zip', gz: 'application/gzip', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', key: 'application/vnd.apple.keynote',
  pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
};

export const mediaTypeOf = file => MEDIA_TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';

// A path a client named, inside the session's folder: the folder itself with none, and one relative to
// it or whole otherwise. Anything that would lead out of the folder is refused.
export function insideFolder(root, named) {
  if (named === undefined || named === null || named === '') return root;
  if (typeof named !== 'string' || named.length > 4096) throw new HelperError('bad_path', 'That isn\'t a path.');
  const resolved = path.resolve(root, named);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new HelperError('bad_path', 'That\'s outside this session\'s folder.');
  return resolved;
}

// Folders first, then files, each by name as Finder sorts them.
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

function entryOf(folder, entry) {
  const file = path.join(folder, entry.name);
  let stat;
  try {
    stat = fs.statSync(file); // through a link, to what it leads to
  } catch {
    return undefined; // a link to nothing, or out of reach
  }
  if (stat.isDirectory()) return { name: entry.name, path: file, kind: 'dir' };
  if (stat.isFile()) return { name: entry.name, path: file, kind: 'file', size: stat.size };
  return undefined;
}

// What happened to an entry, as git tells it: a file by its own change, and a folder by having any inside it.
function changeOf(entry, git) {
  if (!git) return undefined;
  const relative = path.relative(git.root, entry.path);
  if (relative.startsWith('..')) return undefined;
  if (entry.kind === 'file') return git.changed.get(relative);
  const under = `${relative}${path.sep}`;
  for (const changed of git.changed.keys()) if (changed.startsWith(under)) return 'changed';
  return undefined;
}

// What's in a folder of the session's: its folders and files, with what git says has changed among them.
export async function listFolder(root, named, { limit = FILE_ENTRIES, changes = changedPaths } = {}) {
  const folder = insideFolder(root, named);
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HelperError('no_folder', `${folder} isn't a folder on this Mac.`);
    throw new HelperError('unreadable_folder', `${folder} can't be read.`);
  }
  const listed = entries.filter(entry => !HIDDEN.has(entry.name)).map(entry => entryOf(folder, entry)).filter(Boolean);
  const sorted = [...listed.filter(entry => entry.kind === 'dir').sort(byName), ...listed.filter(entry => entry.kind === 'file').sort(byName)];
  const git = await changes(root).catch(() => undefined);
  return {
    root, path: folder, name: path.basename(folder) || folder,
    entries: sorted.slice(0, limit).map(entry => {
      const change = changeOf(entry, git);
      return change ? { ...entry, change } : entry;
    }),
    truncated: sorted.length > limit,
  };
}

// Whether what a file starts with is text: nothing a text file can't have, and good UTF-8 as far as it was read.
export function isText(bytes) {
  if (bytes.includes(0)) return false;
  try {
    // The read can end part way through a character, which is no fault of the file's.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return true;
  } catch {
    return false;
  }
}

function readStart(file, length) {
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, 0));
  } finally {
    fs.closeSync(fd);
  }
}

// A file of the session's: its text, or for anything else its bytes, for the client to show as what it is.
export function readFile(root, named, { textLimit = TEXT_BYTES, binaryLimit = BINARY_BYTES } = {}) {
  const file = insideFolder(root, named);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HelperError('no_file', 'That file isn\'t there any more.');
  }
  if (!stat.isFile()) throw new HelperError('no_file', 'That isn\'t a file.');
  const about = { path: file, name: path.basename(file), size: stat.size };
  try {
    if (isText(readStart(file, Math.min(stat.size, SNIFF_BYTES)))) {
      const bytes = readStart(file, Math.min(stat.size, textLimit));
      if (stat.size <= textLimit) return { ...about, text: bytes.toString('utf8') };
      // Cut at a line's end, so that what's shown is whole lines and whole characters.
      const end = bytes.lastIndexOf(0x0a);
      return { ...about, text: bytes.subarray(0, end < 0 ? bytes.length : end + 1).toString('utf8'), truncated: true };
    }
    const mediaType = mediaTypeOf(file);
    if (stat.size > binaryLimit) return { ...about, mediaType, tooLarge: true };
    return { ...about, mediaType, data: fs.readFileSync(file).toString('base64') };
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('unreadable_file', `${about.name} can't be read.`);
  }
}
