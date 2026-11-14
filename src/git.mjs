// What git says of a session's folder, for someone following the work from afar: the branch, what has
// changed and by how much, a file's diff, the commits, and the branches. All of it is read, with the
// forms git keeps stable for programs, and nothing here changes the repository. `--no-optional-locks`
// keeps even `git status` from taking the index's lock, which the session's own git may want.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const OUTPUT_BYTES = 64 * 1024 * 1024;
const SHORT_COMMIT = 7;
// A diff longer than this is cut, and says so.
export const DIFF_BYTES = 512 * 1024;
// The changed files listed, each way, before the list says there are more.
export const CHANGED_FILES = 500;
const DEFAULT_COMMITS = 30;
const MAX_COMMITS = 200;
// An untracked file's lines are counted up to this size. A bigger one says nothing of its length.
const COUNTED_BYTES = 1024 * 1024;
const FIELD = '\x1f';
const RECORD = '\x1e';
const COMMIT = /^[0-9a-f]{4,40}$/;

const STAGED = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'modified' };
const UNSTAGED = { M: 'modified', D: 'deleted', T: 'modified', A: 'added' };

// `git status --porcelain=v2 --branch -z`: headers that start with "#", then an entry for each path, whose
// first letter says what kind it is and whose XY says what changed in the index and in the folder. A
// renamed one is followed by the path it had.
export function parseStatus(text) {
  const state = { ahead: 0, behind: 0, staged: [], changes: [] };
  let commit;
  const fields = text.split('\0');
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at];
    if (entry.startsWith('# branch.oid ')) commit = entry.slice('# branch.oid '.length);
    else if (entry.startsWith('# branch.head ')) state.branch = entry.slice('# branch.head '.length);
    else if (entry.startsWith('# branch.upstream ')) state.upstream = entry.slice('# branch.upstream '.length);
    else if (entry.startsWith('# branch.ab ')) {
      const [, ahead, behind] = /\+(\d+) -(\d+)/.exec(entry) ?? [];
      state.ahead = Number(ahead) || 0;
      state.behind = Number(behind) || 0;
    } else if (entry.startsWith('? ')) state.changes.push({ path: entry.slice(2), status: 'untracked' });
    else if (entry.startsWith('u ')) state.changes.push({ path: entry.split(' ').slice(10).join(' '), status: 'conflicted' });
    else if (entry.startsWith('1 ') || entry.startsWith('2 ')) {
      const isRenamed = entry.startsWith('2 ');
      const parts = entry.split(' ');
      const [index, tree] = parts[1];
      const file = parts.slice(isRenamed ? 9 : 8).join(' ');
      const from = isRenamed ? fields[++at] : undefined;
      if (index !== '.') state.staged.push({ path: file, status: STAGED[index] ?? 'modified', ...(from && { from }) });
      if (tree !== '.') state.changes.push({ path: file, status: UNSTAGED[tree] ?? 'modified' });
    }
  }
  // With no branch checked out, the commit it's at stands in, as git's own prompt has it.
  if (state.branch === '(detached)') {
    state.branch = commit && commit !== '(initial)' ? commit.slice(0, SHORT_COMMIT) : undefined;
    state.detached = true;
  }
  return state;
}

// `git diff --numstat -z`: how many lines each file gained and lost, by its path. A binary file has
// none to count. A renamed one is told by the path it has now.
export function parseNumstat(text) {
  const counts = new Map();
  const fields = text.split('\0');
  for (let at = 0; at < fields.length; at++) {
    const [added, removed, ...rest] = fields[at].split('\t');
    if (removed === undefined) continue;
    const file = rest.join('\t'); // a name can have a tab in it
    // A rename has an empty path here, and then the old one and the new one.
    const name = file === '' ? fields[(at += 2)] : file;
    if (!name) continue;
    counts.set(name, added === '-' ? { binary: true } : { added: Number(added), removed: Number(removed) });
  }
  return counts;
}

// `--name-status -z`: a letter for what happened to each path, and for a rename or a copy the path it came from.
export function parseNameStatus(text) {
  const files = [];
  const fields = text.split('\0');
  for (let at = 0; at + 1 < fields.length; at++) {
    const letter = fields[at][0];
    if (!letter) continue;
    if (letter === 'R' || letter === 'C') {
      const from = fields[++at];
      files.push({ path: fields[++at], status: STAGED[letter], from });
    } else files.push({ path: fields[++at], status: STAGED[letter] ?? 'modified' });
  }
  return files;
}

// What `git diff` prints for one file, from its first hunk on, which is all of it a reader sees: git's own
// header lines say nothing the list didn't. A binary file has no hunks, and says so instead.
export function hunksOf(text, limit = DIFF_BYTES) {
  const start = text.startsWith('@@') ? 0 : text.indexOf('\n@@') + 1;
  if (start === 0 && !text.startsWith('@@')) return { diff: '', ...(/^Binary files /m.test(text) && { binary: true }) };
  const hunks = text.slice(start);
  if (Buffer.byteLength(hunks) <= limit) return { diff: hunks };
  // Cut at a line's end, so that what's shown is whole lines.
  const cut = Buffer.from(hunks).subarray(0, limit).toString();
  return { diff: cut.slice(0, cut.lastIndexOf('\n') + 1), truncated: true };
}

export function parseLog(text) {
  return text.split(RECORD).map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [hash, short, subject, author, at, refs] = record.split(FIELD);
    return { hash, short, subject, author, at: Number(at) * 1000, refs: refs ? refs.split(', ').filter(Boolean) : [] };
  });
}

export function parseBranches(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [name, head, upstream, track, at, subject] = line.split(FIELD);
    const [, ahead] = /ahead (\d+)/.exec(track ?? '') ?? [];
    const [, behind] = /behind (\d+)/.exec(track ?? '') ?? [];
    return {
      name, current: head === '*', ...(upstream && { upstream }), ahead: Number(ahead) || 0, behind: Number(behind) || 0,
      at: Number(at) * 1000, subject,
    };
  });
}

function git(cwd, args, { ok = [] } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  return exec('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, env })
    .then(({ stdout }) => stdout, error => {
      // `git diff --no-index` says there's a difference with its exit code, which is no failure.
      if (ok.includes(error.code) && typeof error.stdout === 'string') return error.stdout;
      throw error;
    });
}

const notARepository = () => new HelperError('no_repository', 'This folder isn\'t in a git repository.');

// The top folder of the repository a folder is in, or undefined: no repository, no git on this Mac, or no such folder.
export async function repositoryOf(cwd) {
  if (!cwd) return undefined;
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function rootOf(cwd) {
  const root = await repositoryOf(cwd);
  if (!root) throw notARepository();
  return root;
}

// A path in the repository as git names it, from one a client sent: relative to its top, and inside it.
function repositoryPath(root, file) {
  if (typeof file !== 'string' || !file || file.length > 4096) throw new HelperError('bad_path', 'That isn\'t a file.');
  const resolved = path.resolve(root, file);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new HelperError('bad_path', 'That file isn\'t in this repository.');
  return path.relative(root, resolved);
}

function checkedCommit(hash) {
  if (typeof hash !== 'string' || !COMMIT.test(hash)) throw new HelperError('bad_commit', 'That isn\'t a commit.');
  return hash;
}

// How many lines an untracked file has, which is what adding it would add. Nothing for one that's big, or isn't text.
function linesOf(file) {
  try {
    const { size } = fs.statSync(file);
    if (size > COUNTED_BYTES) return {};
    const bytes = fs.readFileSync(file);
    if (bytes.includes(0)) return { binary: true };
    let lines = 0;
    for (const byte of bytes) if (byte === 0x0a) lines += 1;
    return { added: lines + (bytes.length && bytes.at(-1) !== 0x0a ? 1 : 0), removed: 0 };
  } catch {
    return {};
  }
}

// The branch, how far it is from the one it follows, and what has changed: `staged` is what the next
// commit would take, `changes` what's only in the folder, each file with how many lines it gained and
// lost. Undefined outside a repository.
export async function status(cwd) {
  const root = await repositoryOf(cwd);
  if (!root) return undefined;
  const [porcelain, unstaged, staged] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(root, ['diff', '--numstat', '-z', '-M']),
    git(root, ['diff', '--cached', '--numstat', '-z', '-M']),
  ]);
  const state = parseStatus(porcelain);
  const [inFolder, inIndex] = [parseNumstat(unstaged), parseNumstat(staged)];
  const counted = (files, counts) => files.slice(0, CHANGED_FILES).map(file => ({
    ...file, ...(file.status === 'untracked' ? linesOf(path.join(root, file.path)) : counts.get(file.path)),
  }));
  const isTruncated = state.staged.length > CHANGED_FILES || state.changes.length > CHANGED_FILES;
  return { root, ...state, staged: counted(state.staged, inIndex), changes: counted(state.changes, inFolder), ...(isTruncated && { truncated: true }) };
}

// The paths that have changed, by what happened to each, for a file list to mark: relative to the repository's top.
export async function changedPaths(cwd) {
  const state = await status(cwd).catch(() => undefined);
  if (!state) return undefined;
  const changed = new Map();
  for (const file of [...state.staged, ...state.changes]) changed.set(file.path, file.status);
  return { root: state.root, changed };
}

// One file's diff: what's only in the folder, what's staged, or what a commit did to it.
export async function diff(cwd, { path: file, staged = false, commit } = {}) {
  const root = await rootOf(cwd);
  const name = repositoryPath(root, file);
  const shared = ['--no-color', '--no-ext-diff', '-U3', '-M'];
  let printed;
  if (commit !== undefined) {
    printed = await git(root, ['show', '--format=', ...shared, '-m', '--first-parent', checkedCommit(commit), '--', name]);
  } else if (staged) {
    printed = await git(root, ['diff', '--cached', ...shared, '--', name]);
  } else {
    printed = await git(root, ['diff', ...shared, '--', name]);
    // A file git doesn't follow yet has no diff of its own: it's all new, against nothing.
    if (!printed) {
      const tracked = await git(root, ['ls-files', '--', name]);
      if (!tracked.trim()) printed = await git(root, ['diff', '--no-index', ...shared, '--', '/dev/null', name], { ok: [1] });
    }
  }
  return hunksOf(printed);
}

// The commits that lead to where the folder is, newest first.
export async function log(cwd, { limit = DEFAULT_COMMITS, skip = 0 } = {}) {
  const root = await rootOf(cwd);
  const wanted = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_COMMITS, 1), MAX_COMMITS);
  const from = Number.isInteger(skip) && skip > 0 ? skip : 0;
  const format = ['%H', '%h', '%s', '%an', '%at', '%D'].join('%x1f');
  let printed;
  try {
    printed = await git(root, ['log', `--format=${format}%x1e`, `--skip=${from}`, '-n', String(wanted + 1)]);
  } catch (error) {
    // A repository with no commit yet has nothing to list, which git says as an error.
    if (/does not have any commits yet|bad default revision/.test(error.stderr ?? '')) return { commits: [], hasMore: false };
    throw error;
  }
  const commits = parseLog(printed);
  return { commits: commits.slice(0, wanted), hasMore: commits.length > wanted };
}

// One commit: who made it, when, all it says, and the files it changed.
export async function commit(cwd, { commit: hash } = {}) {
  const root = await rootOf(cwd);
  const format = ['%H', '%h', '%s', '%b', '%an', '%ae', '%at', '%P', '%D'].join('%x1f');
  const about = ['--format=', '-m', '--first-parent', '-M', checkedCommit(hash)];
  let printed;
  try {
    printed = await Promise.all([
      git(root, ['show', '-s', `--format=${format}`, hash]),
      git(root, ['show', '--name-status', '-z', ...about]),
      git(root, ['show', '--numstat', '-z', ...about]),
    ]);
  } catch {
    throw new HelperError('bad_commit', 'That commit isn\'t in this repository.');
  }
  const [meta, names, numbers] = printed;
  const [full, short, subject, body, author, email, at, parents, refs] = meta.replace(/\n$/, '').split(FIELD);
  const counts = parseNumstat(numbers);
  const files = parseNameStatus(names);
  return {
    commit: {
      hash: full, short, subject, body: body.trim(), author, email, at: Number(at) * 1000,
      parents: parents ? parents.split(' ') : [], refs: refs ? refs.split(', ').filter(Boolean) : [],
    },
    files: files.slice(0, CHANGED_FILES).map(file => ({ ...file, ...counts.get(file.path) })),
    ...(files.length > CHANGED_FILES && { truncated: true }),
  };
}

// The branches in the repository, the one last committed to first.
export async function branches(cwd) {
  const root = await rootOf(cwd);
  const format = ['%(refname:short)', '%(HEAD)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(committerdate:unix)', '%(subject)'].join('%1f');
  return { branches: parseBranches(await git(root, ['for-each-ref', '--sort=-committerdate', `--format=${format}`, 'refs/heads'])) };
}
