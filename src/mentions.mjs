// What an @ in a message can name: the files and folders of the session's folder, best match first,
// as Claude Code's own @ offers them. In a git repository they're the ones git knows, ignored ones
// left out; elsewhere the folder is looked through, a bounded amount of it.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 3000;
const OUTPUT_BYTES = 32 * 1024 * 1024;
// A folder is listed again after this, since files come and go while a session works.
const KEEP_MS = 10_000;
const WALK_LIMIT = 20_000;
const WALK_DEPTH = 8;
const SKIPPED = new Set(['.git', 'node_modules', '.build', 'build', 'dist', 'DerivedData', '.venv', '__pycache__']);
export const MENTION_LIMIT = 20;

async function gitFiles(cwd) {
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      timeout: GIT_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES,
    });
    return stdout.split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function walkedFiles(cwd) {
  const files = [];
  const visit = (dir, depth) => {
    if (depth > WALK_DEPTH || files.length >= WALK_LIMIT) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= WALK_LIMIT) return;
      if (entry.name.startsWith('.') || SKIPPED.has(entry.name)) continue;
      const relative = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(relative, depth + 1);
      else if (entry.isFile()) files.push(relative);
    }
  };
  visit('', 0);
  return files;
}

// Every file, and every folder above one, by its path from the session's folder. Folders end in /.
export async function mentionables(cwd) {
  const files = (await gitFiles(cwd)) ?? walkedFiles(cwd);
  const folders = new Set();
  for (const file of files) {
    for (let at = file.indexOf('/'); at >= 0; at = file.indexOf('/', at + 1)) folders.add(file.slice(0, at + 1));
  }
  return [...folders, ...files];
}

const isSubsequence = (needle, haystack) => {
  let at = 0;
  for (const char of haystack) if (char === needle[at]) at += 1;
  return at === needle.length;
};

// How well a path answers what's typed after the @, lower being better, or undefined for not at
// all: the path starting with it, then its name, then anywhere in it, then its letters in order.
export function rank(entry, query) {
  const lower = entry.toLowerCase();
  const name = path.basename(lower.replace(/\/$/, ''));
  if (!query) return entry.split('/').filter(Boolean).length;
  if (lower.startsWith(query)) return 0;
  if (name.startsWith(query)) return 1;
  if (lower.includes(query)) return 2;
  if (isSubsequence(query, lower)) return 3;
  return undefined;
}

// What an @ followed by `query` can name, best first and shortest first among equals. With nothing
// typed, it's what's at the top of the folder.
export function bestMentions(entries, query = '', limit = MENTION_LIMIT) {
  const wanted = query.toLowerCase();
  return entries
    .map(entry => ({ entry, rank: rank(entry, wanted) }))
    .filter(({ rank: found }) => found !== undefined)
    .sort((a, b) => a.rank - b.rank || a.entry.length - b.entry.length || a.entry.localeCompare(b.entry))
    .slice(0, limit)
    .map(({ entry }) => ({ path: entry, kind: entry.endsWith('/') ? 'dir' : 'file' }));
}

// Lists of folders kept a little while, as the app asks again with every letter typed.
export function mentionFinder({ list = mentionables, now = Date.now, keepMs = KEEP_MS } = {}) {
  const kept = new Map();
  return async (cwd, query, limit) => {
    let found = kept.get(cwd);
    if (!found || now() - found.at > keepMs) {
      found = { at: now(), entries: list(cwd) };
      kept.set(cwd, found);
      found.entries.catch(() => kept.delete(cwd));
    }
    return bestMentions(await found.entries, query, limit);
  };
}
