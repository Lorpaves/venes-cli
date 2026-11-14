// What git says of a session's folder, for someone following the work from afar: the branch, what has
// changed and by how much, a file's diff, the commits, and the branches. That's all read, with the forms
// git keeps stable for programs, and `--no-optional-locks` keeps even `git status` from taking the
// index's lock, which the session's own git may want. At the foot are the few things a reader can do
// from afar: stage and unstage files, commit what's staged, and switch to another branch.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
// A commit runs the repository's hooks, and a switch writes the folder's files.
const CHANGE_TIMEOUT_MS = 60_000;
// How much of what git said goes back to the reader when it wouldn't do something.
const REASON_CHARS = 600;
const MESSAGE_BYTES = 64 * 1024;
// The paths one stage or unstage names.
const PATHS = 1000;
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

// The names at a commit, from `%D` with `--decorate=full`: the branch the folder is on (`head`), other
// branches of this repository's, a remote's branches, and tags. A remote's own HEAD says nothing a reader
// is after, and neither does anything else git keeps there, such as the stash.
export function parseRefs(text) {
  const refs = [];
  for (const entry of (text ?? '').split(', ').filter(Boolean)) {
    if (entry === 'HEAD') refs.push({ name: 'HEAD', kind: 'head' });
    else if (entry.startsWith('HEAD -> refs/heads/')) refs.push({ name: entry.slice('HEAD -> refs/heads/'.length), kind: 'head' });
    else if (entry.startsWith('refs/heads/')) refs.push({ name: entry.slice('refs/heads/'.length), kind: 'branch' });
    else if (entry.startsWith('tag: refs/tags/')) refs.push({ name: entry.slice('tag: refs/tags/'.length), kind: 'tag' });
    else if (entry.startsWith('refs/remotes/') && !entry.endsWith('/HEAD')) refs.push({ name: entry.slice('refs/remotes/'.length), kind: 'remote' });
  }
  return refs;
}

export function parseLog(text) {
  return text.split(RECORD).map(record => record.replace(/^\n/, '')).filter(Boolean).map(record => {
    const [hash, short, subject, author, at, parents, refs] = record.split(FIELD);
    return { hash, short, subject, author, at: Number(at) * 1000, parents: parents ? parents.split(' ') : [], refs: parseRefs(refs) };
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

// The commits that lead to where the folder is, newest first, each with the commits it came from and the
// names at it, which is what a graph of them is drawn from. With `all`, those of every branch, remote
// branch and tag too. No commit comes before one that came from it, and a line of history stays together.
export async function log(cwd, { limit = DEFAULT_COMMITS, skip = 0, all = false } = {}) {
  const root = await rootOf(cwd);
  const wanted = Math.min(Math.max(Number.isInteger(limit) ? limit : DEFAULT_COMMITS, 1), MAX_COMMITS);
  const from = Number.isInteger(skip) && skip > 0 ? skip : 0;
  const format = ['%H', '%h', '%s', '%an', '%at', '%P', '%D'].join('%x1f');
  const which = all === true ? ['--branches', '--remotes', '--tags', 'HEAD'] : [];
  let printed;
  try {
    printed = await git(root, ['log', '--topo-order', '--decorate=full', `--format=${format}%x1e`, `--skip=${from}`, '-n', String(wanted + 1), ...which]);
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
      git(root, ['show', '-s', '--decorate=full', `--format=${format}`, hash]),
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
      parents: parents ? parents.split(' ') : [], refs: parseRefs(refs),
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

// Git, to change something: it takes the locks it needs, and what it says when it won't is for the reader.
async function change(root, args, { literal = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
  // Paths are named as they are, with none of git's patterns read into them.
  const options = ['-c', 'core.quotePath=false', ...(literal ? ['--literal-pathspecs'] : []), '-C', root];
  try {
    return (await exec('git', [...options, ...args], { timeout: CHANGE_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, env })).stdout;
  } catch (error) {
    if (error.killed) throw new HelperError('git_failed', 'Git took too long, and was stopped.');
    const said = `${error.stderr ?? ''}`.trim() || `${error.stdout ?? ''}`.trim() || error.message;
    throw new HelperError('git_failed', said.slice(0, REASON_CHARS));
  }
}

// The paths a client named, each as git names it. With none named, and `all`, there are none to name.
function namedPaths(root, paths, all) {
  if (all === true) return [];
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > PATHS) throw new HelperError('bad_path', 'Say which files.');
  return paths.map(file => repositoryPath(root, file));
}

const hasCommits = root => git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);

// Puts files' changes in the next commit: all that's changed in the repository with `all`, or else the
// paths named. A file that's gone from the folder is staged as gone.
export async function stage(cwd, { paths, all } = {}) {
  const root = await rootOf(cwd);
  const named = namedPaths(root, paths, all);
  await change(root, ['add', '-A', ...(named.length ? ['--', ...named] : [])], { literal: true });
  return {};
}

// Takes files' changes back out of the next commit, and leaves the folder as it is.
export async function unstage(cwd, { paths, all } = {}) {
  const root = await rootOf(cwd);
  const named = namedPaths(root, paths, all);
  // Before the first commit there's nothing to set the index back to, so the files are taken out of it.
  if (await hasCommits(root)) await change(root, ['reset', '-q', ...(named.length ? ['--', ...named] : [])], { literal: true });
  else await change(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...(named.length ? named : ['.'])], { literal: true });
  return {};
}

// Commits what's staged, as whoever git is set up for on this Mac, with the repository's own hooks.
export async function commitStaged(cwd, { message } = {}) {
  const root = await rootOf(cwd);
  if (typeof message !== 'string' || !message.trim()) throw new HelperError('bad_message', 'A commit needs a message.');
  if (Buffer.byteLength(message) > MESSAGE_BYTES) throw new HelperError('bad_message', 'That message is too long.');
  const staged = await git(root, ['diff', '--cached', '--name-only', '-z']);
  if (!staged) throw new HelperError('nothing_staged', 'Nothing is staged to commit.');
  await change(root, ['commit', '-q', '-m', message.trim()]);
  const [hash, short] = (await git(root, ['log', '-1', '--format=%H%x1f%h'])).trim().split(FIELD);
  return { commit: { hash, short } };
}

// Moves the folder to another of the repository's branches. Git won't when that would write over
// changes in the folder, and says which.
export async function switchBranch(cwd, { branch } = {}) {
  const root = await rootOf(cwd);
  const names = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  if (typeof branch !== 'string' || !names.includes(branch)) throw new HelperError('no_branch', 'This repository has no such branch.');
  await change(root, ['switch', '--no-guess', branch]);
  return { branch };
}
