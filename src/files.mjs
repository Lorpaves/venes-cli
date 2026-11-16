// A session's folder, for someone following the work from afar: what's in it, a level at a time, and
// what's in a file. Everything is inside the folder the session works in. Besides reading, it makes
// something new, an empty file or folder, under a name that isn't taken; it moves a file or a folder to
// the Trash, where it can be put back from; and it writes a text file's new text, unless the file has
// changed since whoever edited it read it.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';
import { changedPaths } from './git.mjs';
import { computer, isMac } from './platform.mjs';
import { moveToRecycleBin } from './winbin.mjs';

// A folder with more in it than this lists the first ones, and says so.
export const FILE_ENTRIES = 2000;
// As much of a text file as is sent. A longer one is cut at a line's end, and says so.
export const TEXT_BYTES = 512 * 1024;
// A file that isn't text is sent whole up to this size, for the client to show as the picture or the document it is.
export const BINARY_BYTES = 8 * 1024 * 1024;
// A file of any size goes a piece at a time, each no longer than this, so that none of it has to be held
// whole anywhere on the way.
export const CHUNK_BYTES = 1024 * 1024;
// As much as a file edited from afar can be: twice what's read of one to show it whole.
export const WRITE_BYTES = 1024 * 1024;
// How much of a file is looked at to tell whether it's text.
const SNIFF_BYTES = 8 * 1024;
// What a folder's own bookkeeping is, which no one browsing it is after.
const HIDDEN = new Set(['.git', '.DS_Store']);
// macOS's own command for what Finder's Move to Trash does, there from macOS 15.
const TRASH_COMMAND = '/usr/bin/trash';

const exec = promisify(execFile);

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

// Whether `target` is `root` or somewhere under it, the top of the disk being a root that ends in its own slash.
export function isWithin(root, target) {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

// A path a client named, inside the session's folder: the folder itself with none, and one relative to
// it or whole otherwise. Anything that would lead out of the folder is refused.
export function insideFolder(root, named) {
  if (named === undefined || named === null || named === '') return root;
  if (typeof named !== 'string' || named.length > 4096) throw new HelperError('bad_path', 'That isn\'t a path.');
  const resolved = path.resolve(root, named);
  if (!isWithin(root, resolved)) throw new HelperError('bad_path', 'That\'s outside this session\'s folder.');
  return resolved;
}

// The longest a file's name can be on a Mac's disk, in bytes.
const NAME_BYTES = 255;

// A name for something new in a folder: one name and not a path, as Finder would take it, which has no
// slash in it, and no colon, which Finder shows as one.
export function checkedName(name) {
  const given = typeof name === 'string' ? name.trim() : '';
  if (!given || given === '.' || given === '..' || /[/:\0]/.test(given) || Buffer.byteLength(given) > NAME_BYTES) {
    throw new HelperError('bad_name', 'That isn\'t a name a file or a folder can have.');
  }
  return given;
}

// Something new in a folder, and empty: a folder, or a file. A name that's taken is refused, so nothing
// that's there is written over.
export function makeIn(parent, name, { folder = false } = {}) {
  const given = checkedName(name);
  const target = path.join(parent, given);
  try {
    if (folder) fs.mkdirSync(target);
    else fs.closeSync(fs.openSync(target, 'wx'));
  } catch (error) {
    if (error.code === 'EEXIST') throw new HelperError('name_taken', `${given} is already there.`);
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HelperError('no_folder', `${parent} isn't a folder on this ${computer}.`);
    throw new HelperError('unwritable_folder', `Nothing can be made in ${parent}.`);
  }
  return folder ? { name: given, path: target, kind: 'dir' } : { name: given, path: target, kind: 'file', size: 0 };
}

// Something new in a folder of the session's: its own with no `named`, or one inside it. Really inside
// it: a link that leads out of the session's folder isn't followed to make things elsewhere.
export function createEntry(root, named, { name, folder } = {}) {
  const parent = insideFolder(root, named);
  let real;
  try {
    real = { root: fs.realpathSync(root), parent: fs.realpathSync(parent) };
  } catch {
    throw new HelperError('no_folder', `${parent} isn't a folder on this ${computer}.`);
  }
  if (!isWithin(real.root, real.parent)) throw new HelperError('bad_path', 'That\'s outside this session\'s folder.');
  return makeIn(parent, name, { folder: folder === true });
}

// The disk a path is on, as the system numbers it.
const diskOf = file => fs.lstatSync(file).dev;

// The folder a disk is mounted at: the highest one above `folder` that's still on its disk.
function mountOf(folder) {
  let top = folder;
  for (let above = path.dirname(top); above !== top && diskOf(above) === diskOf(folder); above = path.dirname(top)) top = above;
  return top;
}

// A path as a trash's note of where something came from has it: each part of it escaped as in a link.
const escaped = file => file.split('/').map(encodeURIComponent).join('/');

// A time as that note has it: this computer's own, to the second, with no zone.
function stamp(when) {
  const two = number => String(number).padStart(2, '0');
  return `${when.getFullYear()}-${two(when.getMonth() + 1)}-${two(when.getDate())}T${two(when.getHours())}:${two(when.getMinutes())}:${two(when.getSeconds())}`;
}

// A Linux desktop's Trash, as its file managers keep it (the freedesktop.org Trash specification): what's
// trashed goes into a folder `files`, with a note beside it in `info` of where it was and when it went,
// which is what putting it back reads. Something on the home folder's disk goes to the home's trash.
// Something on another disk goes to a trash at that disk's top, since a move can't cross disks.
export function moveToLinuxTrash(target, { home = os.homedir(), data = process.env.XDG_DATA_HOME, uid = process.getuid(), now = new Date() } = {}) {
  const from = path.resolve(target);
  const onHomeDisk = diskOf(path.dirname(from)) === diskOf(home);
  const top = onHomeDisk ? undefined : mountOf(path.dirname(from));
  const trash = onHomeDisk ? path.join(data || path.join(home, '.local', 'share'), 'Trash') : path.join(top, `.Trash-${uid}`);
  const files = path.join(trash, 'files');
  const info = path.join(trash, 'info');
  fs.mkdirSync(files, { recursive: true, mode: 0o700 });
  fs.mkdirSync(info, { recursive: true, mode: 0o700 });
  // In the home's trash the note has the whole path. In a disk's own it's from that disk's top.
  const where = escaped(onHomeDisk ? from : path.relative(top, from));
  const note = `[Trash Info]\nPath=${where}\nDeletionDate=${stamp(now)}\n`;
  const base = path.basename(from);
  for (let count = 1; ; count++) {
    const name = count === 1 ? base : `${base}.${count}`;
    const noted = path.join(info, `${name}.trashinfo`);
    try {
      // The note is made first and only if there's none of that name, which keeps the name for this one.
      fs.writeFileSync(noted, note, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    try {
      fs.renameSync(from, path.join(files, name));
      return;
    } catch (error) {
      fs.rmSync(noted, { force: true });
      throw error;
    }
  }
}

// Moves what's at `target` to the Trash, as Finder's Move to Trash does, so that it can be put back. A
// link goes and what it leads to stays. A test run names a folder of its own in VENES_TRASH, which takes
// what's moved in the Trash's place.
export async function moveToTrash(target, { command = TRASH_COMMAND, instead = process.env.VENES_TRASH, mac = isMac } = {}) {
  if (instead) {
    fs.renameSync(target, path.join(instead, `${Date.now()}-${path.basename(target)}`));
    return;
  }
  if (process.platform === 'win32') {
    moveToRecycleBin(target);
    return;
  }
  if (!mac) {
    moveToLinuxTrash(target);
    return;
  }
  if (!fs.existsSync(command)) throw new HelperError('no_trash', 'Moving things to the Trash from afar needs macOS 15 or later on this Mac.');
  // With -s it fails when the move does, and says nothing otherwise.
  await exec(command, ['-s', target]);
}

// Whether a path goes, inside the session's folder, by something a list of it leaves out: git's own
// folder above all, which isn't to be changed from here. A disk that tells no capitals apart doesn't
// get round it.
function isKept(root, target) {
  const kept = [...HIDDEN].map(name => name.toLowerCase());
  return path.relative(path.resolve(root), target).split(path.sep).some(part => kept.includes(part.toLowerCase()));
}

const isThere = file => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

// A file or a folder of the session's goes to the Trash: something inside its folder, really inside it,
// and neither the folder itself nor what a list of it leaves out, on a disk that tells no capitals apart
// either. `keeps` are folders that stay whatever is asked, with all that's above them: the home folder
// is one, wherever the session is.
export async function trashEntry(root, named, { trash = moveToTrash, keeps = [] } = {}) {
  if (typeof named !== 'string' || named === '') throw new HelperError('bad_path', 'That isn\'t a path.');
  const target = insideFolder(root, named);
  if (target === path.resolve(root)) throw new HelperError('bad_path', 'That folder stays where it is.');
  const name = path.basename(target);
  if (isKept(root, target) || keeps.some(kept => isWithin(target, path.resolve(kept)))) throw new HelperError('bad_path', `${name} stays where it is.`);
  let real;
  try {
    real = { root: fs.realpathSync(root), parent: fs.realpathSync(path.dirname(target)) };
  } catch {
    throw new HelperError('no_file', `${name} isn't there any more.`);
  }
  if (!isWithin(real.root, real.parent)) throw new HelperError('bad_path', 'That\'s outside this session\'s folder.');
  // By where it really is, so that it's the thing named that goes and no link on the way to it.
  const really = path.join(real.parent, name);
  if (!isThere(really)) throw new HelperError('no_file', `${name} isn't there any more.`);
  try {
    await trash(really);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('trash_failed', `${name} couldn't be moved to the Trash.`);
  }
  if (isThere(really)) throw new HelperError('trash_failed', `${name} couldn't be moved to the Trash.`);
  return { name, path: target };
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
  // As git names a path, with slashes on every system.
  const relative = path.relative(git.root, entry.path).split(path.sep).join('/');
  if (relative.startsWith('..')) return undefined;
  if (entry.kind === 'file') return git.changed.get(relative);
  const under = `${relative}/`;
  for (const changed of git.changed.keys()) if (changed.startsWith(under)) return 'changed';
  return undefined;
}

// What's in a folder of the session's: its folders and files, with what git says has changed among them.
// Without `hidden`, those whose names start with a dot are left out, as Finder leaves them out: that's
// for looking about the Mac, where a session's own folder is shown as it is.
export async function listFolder(root, named, { limit = FILE_ENTRIES, changes = changedPaths, hidden = true } = {}) {
  const folder = insideFolder(root, named);
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new HelperError('no_folder', `${folder} isn't a folder on this ${computer}.`);
    throw new HelperError('unreadable_folder', `${folder} can't be read.`);
  }
  const listed = entries.filter(entry => !HIDDEN.has(entry.name) && (hidden || !entry.name.startsWith('.'))).map(entry => entryOf(folder, entry)).filter(Boolean);
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

// What's in a folder anywhere on this Mac, for whoever is choosing where a session starts: listed as a
// session's folder is, by what git says of that folder itself, and with no dot names unless they're asked for.
export function listAnywhere(named, { hidden = false } = {}) {
  const folder = path.resolve(named);
  return listFolder(path.parse(folder).root, folder, { hidden, changes: () => changedPaths(folder) });
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
  // When it last changed goes with it, for a client that edits it to say which file it read.
  const about = { path: file, name: path.basename(file), size: stat.size, modifiedAt: Math.floor(stat.mtimeMs) };
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

// New text for one of the session's files: one that's there, is text, and is really inside the session's
// folder, wherever a link leads. `was` is the size and the time it had when it was read: a file that has
// changed since is left as it is, unless `overwrite` says to write all the same. It's written where it
// is, so that it stays the file it was, with its mode, its links and what Finder knows of it.
export function writeFile(root, named, { text, was, overwrite = false, limit = WRITE_BYTES } = {}) {
  if (typeof named !== 'string' || named === '') throw new HelperError('bad_path', 'That isn\'t a path.');
  const file = insideFolder(root, named);
  const name = path.basename(file);
  if (isKept(root, file)) throw new HelperError('bad_path', `${name} stays as it is.`);
  if (typeof text !== 'string') throw new HelperError('bad_text', 'That isn\'t text.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > limit) throw new HelperError('too_big', `A file edited from here can be up to ${limit / 1024 / 1024} MB.`);
  let real;
  let stat;
  try {
    real = { root: fs.realpathSync(root), file: fs.realpathSync(file) };
    stat = fs.statSync(real.file);
  } catch {
    throw new HelperError('no_file', 'That file isn\'t there any more.');
  }
  if (real.file === real.root || !isWithin(real.root, real.file)) throw new HelperError('bad_path', 'That\'s outside this session\'s folder.');
  if (!stat.isFile()) throw new HelperError('no_file', 'That isn\'t a file.');
  const isAsRead = Number.isSafeInteger(was?.size) && Number.isSafeInteger(was?.modifiedAt)
    && was.size === stat.size && was.modifiedAt === Math.floor(stat.mtimeMs);
  if (!overwrite && !isAsRead) throw new HelperError('file_changed', `${name} has changed since it was read.`);
  try {
    if (!isText(readStart(real.file, Math.min(stat.size, SNIFF_BYTES)))) throw new HelperError('not_text', `${name} isn't a text file.`);
    fs.writeFileSync(real.file, bytes);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('unwritable_file', `${name} can't be written.`);
  }
  const now = fs.statSync(real.file);
  return { path: file, name, size: now.size, modifiedAt: Math.floor(now.mtimeMs) };
}

// A piece of one of the session's files: `length` bytes from `offset`, as they are, for a reader that takes
// the file whole a piece at a time, whatever its size and whatever is in it. Each piece says the file's
// size and when it last changed, so that a reader can tell a file that changed between two pieces. A
// piece that starts at the file's end has nothing in it.
export function readChunk(root, named, { offset = 0, length = CHUNK_BYTES } = {}) {
  const file = insideFolder(root, named);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) throw new HelperError('bad_range', 'That isn\'t a part of a file.');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new HelperError('no_file', 'That file isn\'t there any more.');
  }
  if (!stat.isFile()) throw new HelperError('no_file', 'That isn\'t a file.');
  if (offset > stat.size) throw new HelperError('bad_range', 'That\'s past the end of the file.');
  const wanted = Math.min(length, CHUNK_BYTES, stat.size - offset);
  const buffer = Buffer.alloc(wanted);
  let read = 0;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      // One read can come back short, so it's read until the piece is whole or the file ends.
      while (read < wanted) {
        const got = fs.readSync(fd, buffer, read, wanted - read, offset + read);
        if (got === 0) break;
        read += got;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw new HelperError('unreadable_file', `${path.basename(file)} can't be read.`);
  }
  return {
    path: file, name: path.basename(file), size: stat.size, modifiedAt: Math.floor(stat.mtimeMs), mediaType: mediaTypeOf(file), offset,
    data: buffer.subarray(0, read).toString('base64'),
  };
}
