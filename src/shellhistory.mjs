// What a line being typed in a terminal session could go on to be, as zsh-autosuggestions and fish offer
// it: a command run before that starts the same way, or a path its last word starts. The commands are
// the session's own and those the shell keeps in its history file, which is read here and nowhere else,
// and only to answer for a line someone is typing in a session of theirs. Nothing of it is kept.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// How much of the end of a history file is read. A shell keeps thousands of lines, and the newest are
// what a suggestion is made of.
const READ_BYTES = 4 * 1024 * 1024;
// A command longer than this isn't offered: it wouldn't be read on one row of a phone.
const LINE_MOST = 400;
export const SUGGESTIONS = 8;
export const SUGGESTIONS_MOST = 20;
// A line longer than this is past suggesting for.
export const TEXT_MOST = 1000;

// zsh writes the bytes it uses for its own ends, and all above them, as a marker and the byte with one
// bit turned over. So a line with anything but ASCII in it isn't UTF-8 until that's undone.
const META = 0x83;
export function unmetafy(bytes) {
  if (!bytes.includes(META)) return bytes;
  const out = Buffer.alloc(bytes.length);
  let length = 0;
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] === META && at + 1 < bytes.length) {
      at += 1;
      out[length++] = bytes[at] ^ 0x20;
    } else {
      out[length++] = bytes[at];
    }
  }
  return out.subarray(0, length);
}

const ZSH_STAMP = /^: \d+:\d+;/;
const BASH_STAMP = /^#\d+$/;

// The commands in a history file's text, oldest first. zsh's can have when each ran before it
// (`: 1700000000:0;command`), and a command of several lines has a backslash at the end of each but the
// last. bash's can have a line of its own with when each ran (`#1700000000`).
export function commandsIn(text, shell = 'zsh') {
  const lines = text.split('\n');
  const commands = [];
  for (let at = 0; at < lines.length; at++) {
    let line = lines[at];
    if (shell === 'bash') {
      if (!BASH_STAMP.test(line) && line.trim()) commands.push(line.trim());
      continue;
    }
    while (line.endsWith('\\') && at + 1 < lines.length) {
      at += 1;
      line = `${line.slice(0, -1)}\n${lines[at]}`;
    }
    const command = line.replace(ZSH_STAMP, '').trim();
    if (command) commands.push(command);
  }
  return commands;
}

// A shell's history file, read again only when it has changed: its commands, newest first, each once.
export class ShellHistory {
  #kept = new Map();
  #readBytes;

  constructor({ readBytes = READ_BYTES } = {}) {
    this.#readBytes = readBytes;
  }

  commands(file, shell = 'zsh') {
    if (!file) return [];
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return [];
    }
    const kept = this.#kept.get(file);
    if (kept && kept.mtimeMs === stat.mtimeMs && kept.size === stat.size) return kept.commands;
    let commands = [];
    try {
      commands = this.#read(file, stat.size, shell);
    } catch (error) {
      console.error(`shell history: ${error.message}`);
    }
    this.#kept.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, commands });
    return commands;
  }

  #read(file, size, shell) {
    const length = Math.min(size, this.#readBytes);
    const bytes = Buffer.alloc(length);
    const handle = fs.openSync(file, 'r');
    try {
      fs.readSync(handle, bytes, 0, length, size - length);
    } finally {
      fs.closeSync(handle);
    }
    let text = (shell === 'zsh' ? unmetafy(bytes) : bytes).toString('utf8');
    // A read that starts part of the way in starts part of the way through a line.
    if (length < size) text = text.slice(text.indexOf('\n') + 1);
    return [...new Set(commandsIn(text, shell).reverse())];
  }
}

// The lines that go on from `text`, from each list in turn and in each list's own order, each once, at
// most `limit`. A line of several lines isn't one a field of one line can be offered.
export function suggestionsFrom(lists, text, limit = SUGGESTIONS) {
  const found = [];
  const seen = new Set();
  for (const list of lists) {
    for (const line of list) {
      if (line.length <= text.length || line.length > LINE_MOST || !line.startsWith(text) || line.includes('\n') || seen.has(line)) continue;
      seen.add(line);
      found.push(line);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

// Where the last word of a line starts: after the last space or tab that has no backslash before it.
function lastWordStart(text) {
  for (let at = text.length - 1; at >= 0; at--) {
    if ((text[at] === ' ' || text[at] === '\t') && text[at - 1] !== '\\') return at + 1;
  }
  return 0;
}

const NEEDS_ESCAPE = /[ \t'"\\$&;()<>|*?!#$`~[\]{}]/g;

// The commands whose words are the names of files and folders, as far as a line can be told by its first
// word. After any other, a word is taken for a path only when it's written as one.
const TAKES_PATHS = new Set([
  'cd', 'ls', 'll', 'la', 'cat', 'less', 'more', 'head', 'tail', 'bat', 'open', 'code', 'vi', 'vim', 'nvim', 'nano', 'emacs', 'rm', 'cp', 'mv', 'mkdir',
  'rmdir', 'touch', 'chmod', 'chown', 'ln', 'source', '.', 'sh', 'bash', 'zsh', 'node', 'python', 'python3', 'ruby', 'perl', 'du', 'file', 'stat', 'diff',
  'wc', 'tree', 'tar', 'zip', 'unzip', 'pushd',
]);
const LOOKS_LIKE_PATH = /^(\.{0,2}\/|~\/)|\//;

// The lines `text` could be with its last word finished as the name of something in a folder: what's in
// the folder the word names so far, from `cwd`, whose name starts as the word's last part does, by name.
// A folder's has its slash. A word is finished only where it's likely a path: after a command that takes
// files, or written as a path is, with a slash in it. So the first word of a line, which is a command, is
// one only when it says where it is. A word with a quote or a variable in it is left alone, and a word that
// only names a folder so far isn't finished with whatever comes first in it.
export function pathSuggestions(text, { cwd, home = os.homedir(), limit = SUGGESTIONS, readdir = folder => fs.readdirSync(folder, { withFileTypes: true }) } = {}) {
  const start = lastWordStart(text);
  const word = text.slice(start);
  if (!word || /['"$`]/.test(word)) return [];
  const command = start === 0 ? undefined : text.trimStart().split(/[ \t]/, 1)[0];
  if (!LOOKS_LIKE_PATH.test(word) && !(command && TAKES_PATHS.has(command))) return [];
  const typed = word.replace(/\\(.)/g, '$1');
  const slash = typed.lastIndexOf('/');
  const base = typed.slice(slash + 1);
  if (!base) return [];
  const named = typed.slice(0, slash + 1);
  const folder = named.startsWith('~/') ? path.join(home, named.slice(2)) : path.resolve(cwd ?? home, named);
  let entries;
  try {
    entries = readdir(folder);
  } catch {
    return [];
  }
  const isFolder = entry => {
    if (entry.isDirectory()) return true;
    if (!entry.isSymbolicLink()) return false;
    try {
      return fs.statSync(path.join(folder, entry.name)).isDirectory();
    } catch {
      return false;
    }
  };
  return entries
    .filter(entry => entry.name.startsWith(base) && entry.name !== base && (base.startsWith('.') || !entry.name.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(entry => `${text}${entry.name.slice(base.length).replace(NEEDS_ESCAPE, '\\$&')}${isFolder(entry) ? '/' : ''}`);
}

// The file a shell keeps its history in, where it didn't say: each shell's usual one.
export function usualHistoryFile(shell, home = os.homedir()) {
  return path.join(home, shell === 'bash' ? '.bash_history' : '.zsh_history');
}
