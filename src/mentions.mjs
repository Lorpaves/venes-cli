// What an @ in a message can name, found the way Claude Code's own @ finds it, so a phone is offered
// what the terminal would offer. What's typed after the @ that starts like a path lists the folder it
// points into. Anything else is looked for among the project's files and the folders above them, and
// scored as Claude Code scores them: the most letters together, at the start of a name or a word.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// As many as Claude Code shows: of the project's files, and of a folder's entries.
export const MENTION_LIMIT = 15;
const FOLDER_ENTRY_LIMIT = 10;
const FOLDER_READ_LIMIT = 5000;
const TRACKED_TIMEOUT_MS = 5000;
const UNTRACKED_TIMEOUT_MS = 10_000;
const SEARCH_TIMEOUT_MS = 10_000;
const SEARCH_OUTPUT_BYTES = 20_000_000;
// A project is looked through again once this has passed, or once git's index has changed. One
// outside git that took longer than SLOW_SEARCH_MS to look through isn't looked through again.
const REFRESH_MS = 5000;
const SLOW_SEARCH_MS = 1000;
// Projects kept looked through at once, the ones asked about most recently.
const KEPT_PROJECTS = 8;
const VERSION_CONTROL = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];

// How a path scores for what's typed.
const MATCH = 16;
const BOUNDARY = 8;
const CAMEL = 6;
const ADJACENT = 4;
const FIRST = 8;
const GAP_OPEN = 3;
const GAP = 1;
const QUERY_CHARACTERS = 64;

const LOWER_A = 97;
const LOWER_Z = 122;
const UPPER_A = 65;
const UPPER_Z = 90;
const SLASH = 47;
const BACKSLASH = 92;
const isLower = code => code >= LOWER_A && code <= LOWER_Z;
const isUpper = code => code >= UPPER_A && code <= UPPER_Z;
const isSeparator = code => code === SLASH || code === BACKSLASH;
// What a name or a word starts after.
const isBoundary = code => isSeparator(code) || code === 45 || code === 95 || code === 46 || code === 32;

function bonusAt(text, position, isFirst) {
  if (position === 0) return isFirst ? FIRST : 0;
  const before = text.charCodeAt(position - 1);
  if (isBoundary(before)) return BOUNDARY;
  if (isLower(before) && isUpper(text.charCodeAt(position))) return CAMEL;
  return 0;
}

function bonuses(text, positions, count) {
  let total = bonusAt(text, positions[0], true);
  for (let index = 1; index < count; index += 1) total += bonusAt(text, positions[index], false);
  return total;
}

// The letters typed found in order within the name alone, from `nameStart`: what being together and
// apart there is worth, or -Infinity when they aren't all in it.
function nameScore(text, characters, nameStart, positions) {
  let score = 0;
  let last = nameStart - 1;
  for (let index = 0; index < characters.length; index += 1) {
    const found = text.indexOf(characters[index], last + 1);
    if (found === -1) return -Infinity;
    positions[index] = found;
    const gap = found - last - 1;
    if (index > 0) score += gap === 0 ? ADJACENT : -(GAP_OPEN + gap * GAP);
    last = found;
  }
  return score;
}

// Paths looked through for what's typed. A path's letters are kept as bits, so most paths that can't
// match are passed over without being read.
export class FileIndex {
  constructor(paths) {
    this.paths = [...new Set(paths.filter(entry => entry.length > 0))];
    const count = this.paths.length;
    this.lowerPaths = new Array(count);
    this.letters = new Int32Array(count);
    this.lengths = new Uint16Array(count);
    this.nameStarts = new Uint16Array(count);
    this.nameLetters = new Int32Array(count);
    this.positions = new Int32Array(QUERY_CHARACTERS);
    this.namePositions = new Int32Array(QUERY_CHARACTERS);
    for (let index = 0; index < count; index += 1) this.#add(index);
  }

  #add(index) {
    const lower = this.paths[index].toLowerCase();
    this.lowerPaths[index] = lower;
    const length = lower.length;
    this.lengths[index] = length;
    let letters = 0;
    let nameStart = 0;
    let nameLetters = 0;
    for (let at = 0; at < length; at += 1) {
      const code = lower.charCodeAt(at);
      if (isLower(code)) {
        letters |= 1 << (code - LOWER_A);
        nameLetters |= 1 << (code - LOWER_A);
      } else if (isSeparator(code) && at < length - 1) {
        nameStart = at + 1;
        nameLetters = 0;
      }
    }
    this.letters[index] = letters;
    this.nameStarts[index] = length === this.paths[index].length ? nameStart : 0;
    this.nameLetters[index] = nameLetters;
  }

  // The best `limit` for `query`, best first. A capital letter makes the whole query match case.
  search(query, limit) {
    if (limit <= 0 || query.length === 0) return [];
    const matchesCase = query !== query.toLowerCase();
    const wanted = matchesCase ? query : query.toLowerCase();
    const count = Math.min(wanted.length, QUERY_CHARACTERS);
    const characters = new Array(count);
    let wantedLetters = 0;
    for (let index = 0; index < count; index += 1) {
      const character = wanted.charAt(index);
      characters[index] = character;
      const code = character.charCodeAt(0);
      if (isLower(code)) wantedLetters |= 1 << (code - LOWER_A);
    }
    const ceiling = count * (MATCH + BOUNDARY) + FIRST + 32;
    const best = [];
    let threshold = -Infinity;
    const { paths, lowerPaths, letters, lengths, nameStarts, nameLetters, positions, namePositions } = this;
    paths: for (let index = 0; index < paths.length; index += 1) {
      if ((letters[index] & wantedLetters) !== wantedLetters) continue;
      const text = matchesCase ? paths[index] : lowerPaths[index];
      let found = text.indexOf(characters[0]);
      if (found === -1) continue;
      positions[0] = found;
      let gaps = 0;
      let together = 0;
      let last = found;
      for (let at = 1; at < count; at += 1) {
        found = text.indexOf(characters[at], last + 1);
        if (found === -1) continue paths;
        positions[at] = found;
        const gap = found - last - 1;
        if (gap === 0) together += ADJACENT;
        else gaps += GAP_OPEN + gap * GAP;
        last = found;
      }
      const nameStart = nameStarts[index];
      const inName = gaps > 0 && positions[0] < nameStart && (nameLetters[index] & wantedLetters) === wantedLetters
        ? nameScore(text, characters, nameStart, namePositions) : -Infinity;
      if (best.length === limit && ceiling + Math.max(together - gaps, inName) <= threshold) continue;
      const original = paths[index];
      let score = together - gaps + bonuses(original, positions, count);
      if (inName !== -Infinity) score = Math.max(score, inName + bonuses(original, namePositions, count));
      score += count * MATCH + Math.max(0, 32 - (lengths[index] >> 2));
      if (best.length < limit) {
        best.push({ index, score });
        if (best.length === limit) {
          best.sort((a, b) => a.score - b.score);
          threshold = best[0].score;
        }
      } else if (score > threshold) {
        let low = 0;
        let high = best.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (best[middle].score < score) low = middle + 1;
          else high = middle;
        }
        best.splice(low, 0, { index, score });
        best.shift();
        threshold = best[0].score;
      }
    }
    best.sort((a, b) => b.score - a.score);
    return best.map(({ index }) => paths[index]);
  }
}

const mention = entry => ({ path: entry, kind: entry.endsWith(path.sep) ? 'dir' : 'file' });

// What's typed after an @ that's a path: from home, from the top, from here, or from the folder above.
export const isPathLike = typed => typed.startsWith('~/') || typed.startsWith('/') || typed.startsWith('./') || typed.startsWith('../')
  || typed === '~' || typed === '.' || typed === '..';

// A path typed in `base`, as the full path it stands for.
export function expandPath(typed, base) {
  if (typed.includes('\0') || base.includes('\0')) throw new Error('Path contains null bytes');
  const trimmed = typed.trim();
  if (!trimmed) return path.normalize(base).normalize('NFC');
  if (trimmed === '~') return os.homedir().normalize('NFC');
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2)).normalize('NFC');
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed).normalize('NFC');
  return path.resolve(base, trimmed).normalize('NFC');
}

// The folder a typed path points into, and what's typed of the name in it.
function folderOf(typed, base) {
  if (!typed) return { folder: base, start: '' };
  const expanded = expandPath(typed, base);
  if (typed.endsWith('/')) return { folder: expanded, start: '' };
  return { folder: path.dirname(expanded), start: path.basename(typed) };
}

// A folder's entries, hidden ones left out, folders first and then by name.
function folderEntries(folder) {
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({ name: entry.name, isFolder: entry.isDirectory() }))
      .sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1))
      .slice(0, FOLDER_READ_LIMIT);
  } catch {
    return [];
  }
}

// What a typed path can go on to name, written the way it was typed.
export function pathMentions(typed, cwd, limit = FOLDER_ENTRY_LIMIT) {
  let place;
  try {
    place = folderOf(typed, cwd);
  } catch {
    return [];
  }
  const start = place.start.toLowerCase();
  const slash = typed.lastIndexOf('/');
  let lead = slash >= 0 ? typed.slice(0, slash + 1) : '';
  if (lead.startsWith('./')) lead = lead.slice(2);
  return folderEntries(place.folder)
    .filter(entry => entry.name.toLowerCase().startsWith(start))
    .slice(0, Math.min(limit, FOLDER_ENTRY_LIMIT))
    .map(entry => ({ path: `${lead}${entry.name}${entry.isFolder ? '/' : ''}`, kind: entry.isFolder ? 'dir' : 'file' }));
}

// What's in the session's folder itself, in the order the folder gives, for an @ with nothing after it.
function folderListing(cwd) {
  try {
    return fs.readdirSync(cwd, { withFileTypes: true }).map(entry => (entry.isDirectory() ? `${entry.name}${path.sep}` : entry.name));
  } catch {
    return [];
  }
}

// Every folder above the paths, each once, ending in the separator.
export function foldersAbove(paths) {
  const folders = new Set();
  for (const entry of paths) {
    let folder = path.dirname(entry);
    while (folder !== '.' && !folders.has(folder)) {
      const parent = path.dirname(folder);
      if (parent === folder) break;
      folders.add(folder);
      folder = parent;
    }
  }
  return [...folders].map(folder => folder + path.sep);
}

// The repository a folder is in: where a .git folder or file is, looking up from it.
export function repositoryOf(cwd) {
  for (let folder = path.resolve(cwd); ;) {
    try {
      const found = fs.lstatSync(path.join(folder, '.git'));
      if (found.isDirectory() || found.isFile()) return folder;
      if (found.isSymbolicLink()) return undefined;
    } catch { /* not here */ }
    const parent = path.dirname(folder);
    if (parent === folder) return undefined;
    folder = parent;
  }
}

function gitIndexTime(cwd) {
  const root = repositoryOf(cwd);
  if (!root) return null;
  try {
    return fs.statSync(path.join(root, '.git', 'index')).mtimeMs;
  } catch {
    return null;
  }
}

async function gitLines(root, args, timeout) {
  try {
    const { stdout } = await exec('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, timeout, maxBuffer: SEARCH_OUTPUT_BYTES });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return undefined;
  }
}

const fromFolder = (cwd, root, files) => (cwd === root ? files : files.map(file => path.relative(cwd, path.join(root, file))));

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// Whether ignored files are left out, as Claude Code's `respectGitignore` says, which is on unless a
// setting turns it off.
export function respectsGitignore(cwd, env = process.env) {
  const config = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const settings = [
    path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'),
    env.VENES_CLAUDE_SETTINGS || path.join(config, 'settings.json'),
  ];
  for (const file of settings) {
    const value = readJson(file)?.respectGitignore;
    if (typeof value === 'boolean') return value;
  }
  const global = readJson(env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(os.homedir(), '.claude.json'));
  return typeof global?.respectGitignore === 'boolean' ? global.respectGitignore : true;
}

function onPath(name, env = process.env) {
  for (const folder of (env.PATH ?? '').split(':')) {
    const file = path.join(folder, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* not in this one */ }
  }
  return undefined;
}

const MACH_O = new Set(['cffaedfe', 'cefaedfe', 'cafebabe', 'feedfacf']);

function isProgram(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const magic = Buffer.alloc(4);
      fs.readSync(fd, magic, 0, 4, 0);
      return MACH_O.has(magic.toString('hex'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// The ripgrep Claude Code would use: the one built into it, or else the one on the PATH.
export function findRipgrep(env = process.env) {
  const claude = onPath('claude', env);
  const program = claude && fs.realpathSync(claude);
  if (program && isProgram(program)) return { command: program, args: ['--no-config'], argv0: 'rg' };
  const rg = onPath('rg', env);
  return rg ? { command: rg, args: [] } : undefined;
}

// What a program prints, up to a size, or nothing if it takes too long. Only spawn can give a program
// the name it's started by, which is how Claude Code's own ripgrep is reached.
function output(command, args, { cwd, argv0 }) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, argv0, stdio: ['ignore', 'pipe', 'ignore'] });
    const pieces = [];
    let bytes = 0;
    let isDone = false;
    const finish = text => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish('');
    }, SEARCH_TIMEOUT_MS);
    child.stdout.on('data', piece => {
      const room = SEARCH_OUTPUT_BYTES - bytes;
      pieces.push(piece.subarray(0, room));
      bytes += Math.min(piece.length, room);
      if (piece.length >= room) {
        child.kill('SIGKILL');
        const text = Buffer.concat(pieces).toString('utf8');
        finish(text.slice(0, text.lastIndexOf('\n') + 1));
      }
    });
    child.on('error', () => finish(''));
    child.on('close', () => finish(Buffer.concat(pieces).toString('utf8')));
  });
}

async function searchedFiles(cwd, respectGitignore, ripgrep) {
  if (!ripgrep) return [];
  const args = [...ripgrep.args, '--files', '--follow', '--hidden', ...VERSION_CONTROL.flatMap(name => ['--glob', `!${name}/`])];
  if (!respectGitignore) args.push('--no-ignore-vcs');
  const listed = await output(ripgrep.command, [...args, cwd], { cwd, argv0: ripgrep.argv0 });
  return listed.split('\n').filter(Boolean).map(file => path.relative(cwd, file));
}

// What the @ of a session in `cwd` looks among, in Claude Code's order: in a repository, the files git
// has, every file of the repository from the session's folder; then the ones it hasn't, unless
// they're ignored. Each with the folders above them.
export async function projectPaths(cwd, { respectGitignore = respectsGitignore(cwd), ripgrep = findRipgrep() } = {}) {
  const root = repositoryOf(cwd);
  const tracked = root && await gitLines(root, ['ls-files', '--recurse-submodules'], TRACKED_TIMEOUT_MS);
  if (tracked) {
    const files = fromFolder(cwd, root, tracked);
    const others = await gitLines(root, ['ls-files', '--others', ...(respectGitignore ? ['--exclude-standard'] : [])], UNTRACKED_TIMEOUT_MS) ?? [];
    const untracked = fromFolder(cwd, root, others);
    if (!untracked.length) return [...foldersAbove(files), ...files];
    return [...files, ...foldersAbove(files), ...untracked, ...foldersAbove(untracked)];
  }
  const files = await searchedFiles(cwd, respectGitignore, ripgrep);
  return [...foldersAbove(files), ...files];
}

// Finds what an @ followed by `typed` names for a session in `cwd`. A project is looked through once
// and kept, and looked through again in the background as Claude Code does.
export function mentionFinder({ list = projectPaths, now = Date.now, gitIndex = gitIndexTime } = {}) {
  const projects = new Map();

  const refresh = (cwd, project) => {
    const startedAt = now();
    project.refreshing = Promise.resolve(list(cwd))
      .then(paths => {
        project.index = new FileIndex(paths);
        project.searchMs = now() - startedAt;
      })
      .catch(() => {
        project.index ??= new FileIndex([]);
      })
      .finally(() => {
        project.refreshing = undefined;
        project.refreshedAt = now();
      });
    return project.refreshing;
  };

  const indexFor = async cwd => {
    let project = projects.get(cwd);
    if (project) projects.delete(cwd);
    project ??= {};
    projects.set(cwd, project);
    while (projects.size > KEPT_PROJECTS) projects.delete(projects.keys().next().value);
    if (!project.refreshing) {
      const indexTime = gitIndex(cwd);
      const isStale = indexTime !== null && indexTime !== project.indexTime;
      const isSlowOutsideGit = indexTime === null && project.searchMs > SLOW_SEARCH_MS;
      if (!project.index || (!isSlowOutsideGit && (isStale || now() - project.refreshedAt >= REFRESH_MS))) {
        project.indexTime = indexTime;
        refresh(cwd, project);
      }
    }
    if (!project.index) await project.refreshing;
    return project.index;
  };

  return async (cwd, typed = '', limit = MENTION_LIMIT) => {
    if (isPathLike(typed)) {
      const found = pathMentions(typed, cwd, limit);
      if (found.length) return found;
    }
    const wanted = Math.min(limit, MENTION_LIMIT);
    if (typed === '' || typed === '.' || typed === './') {
      indexFor(cwd).catch(() => {});
      return folderListing(cwd).slice(0, wanted).map(mention);
    }
    let query = typed.startsWith('./') ? typed.slice(2) : typed;
    if (query.startsWith('~')) {
      try {
        query = expandPath(query, cwd);
      } catch {
        return [];
      }
    }
    return (await indexFor(cwd)).search(query, wanted).map(mention);
  };
}
