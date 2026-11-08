// The folders a new session can start in: those sessions ran in lately, and any other on this Mac,
// a level at a time as the reader goes through them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HelperError } from './sessions.mjs';

// How many recent folders to offer, and how many stored sessions to look through for them.
export const RECENT_FOLDERS = 20;
export const RECENT_SESSIONS = 200;
// A folder with more in it than this lists the first ones, and says so.
export const FOLDER_ENTRIES = 1000;

function isFolder(file) {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false; // gone, or out of reach
  }
}

// A folder the reader named: whole, and there.
export function checkedFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || folder.length > 4096) throw new HelperError('bad_folder', 'That isn\'t a folder.');
  const resolved = path.resolve(folder);
  if (!isFolder(resolved)) throw new HelperError('no_folder', `${resolved} isn't a folder on this Mac.`);
  return resolved;
}

// The folders in one, as Claude Code's @ lists a folder: no hidden ones, by name as Finder sorts them.
export function subfolders(folder, limit = FOLDER_ENTRIES) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    throw new HelperError('unreadable_folder', `${folder} can't be read.`);
  }
  const names = entries
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || (entry.isSymbolicLink() && isFolder(path.join(folder, entry.name)))))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return { entries: names.slice(0, limit).map(name => ({ name, path: path.join(folder, name) })), truncated: names.length > limit };
}

// Where sessions ran, newest first, once each, and only those still there.
export function recentFolders(sessions, limit = RECENT_FOLDERS) {
  const seen = new Set();
  const folders = [];
  for (const session of sessions) {
    const folder = session.cwd && path.resolve(session.cwd);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    if (!isFolder(folder)) continue;
    folders.push(folder);
    if (folders.length === limit) break;
  }
  return folders;
}

// How many sessions are going in each folder, counting each session once.
export function runningIn(sessionsByID) {
  const counts = new Map();
  for (const session of sessionsByID.values()) {
    if (!session.cwd) continue;
    const folder = path.resolve(session.cwd);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return counts;
}

export const homeFolder = () => os.homedir();
