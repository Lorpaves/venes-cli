// What git says of a session's folder, for someone following the work from afar: the branch, what has
// changed and by how much, a file's diff, the commits, and the branches. That's all read, with the forms
// git keeps stable for programs, and `--no-optional-locks` keeps even `git status` from taking the
// index's lock, which the session's own git may want. At the foot are the things a reader can do from
// afar: stage and unstage files, throw a file's changes away, commit what's staged, push and pull the
// branch, switch to another branch, and make one.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
// A commit runs the repository's hooks, and a switch writes the folder's files.
const CHANGE_TIMEOUT_MS = 60_000;
// A push and a pull go to the remote and back.
const NETWORK_TIMEOUT_MS = 120_000;
// The files a pull stopped on that are named.
const CONFLICTS = 20;
// As long as a branch's name is let be.
const BRANCH_CHARS = 200;
// How many things go to the Trash at a time.
const TRASHED_AT_ONCE = 8;
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
// The repositories looked for right inside the folder a session started in, and those a session has in all.
const NEARBY_REPOSITORIES = 20;
const SESSION_REPOSITORIES = 24;
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
  let isCounted = false;
  const fields = text.split('\0');
  for (let at = 0; at < fields.length; at++) {
    const entry = fields[at];
    if (entry.startsWith('# branch.oid ')) commit = entry.slice('# branch.oid '.length);
    else if (entry.startsWith('# branch.head ')) state.branch = entry.slice('# branch.head '.length);
    else if (entry.startsWith('# branch.upstream ')) state.upstream = entry.slice('# branch.upstream '.length);
    else if (entry.startsWith('# branch.ab ')) {
      isCounted = true;
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
  // Git counts a branch against the one it follows only while that one is there. With no count, the
  // one it follows is gone from the remote, or was never fetched.
  if (state.upstream && !isCounted) state.upstreamGone = true;
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

// With `literal`, paths are named as they are, with none of git's patterns read into them.
function git(cwd, args, { ok = [], literal = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
  const options = ['--no-optional-locks', '-c', 'core.quotePath=false', ...(literal ? ['--literal-pathspecs'] : []), '-C', cwd];
  return exec('git', [...options, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, env })
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
    // As this system writes a path: on Windows git says C:/work, where everything else says C:\work.
    const top = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
    return top ? path.resolve(top) : undefined;
  } catch {
    return undefined;
  }
}

// The repositories right inside a folder, by name: those a project made of several is kept in.
export function repositoriesUnder(folder, limit = NEARBY_REPOSITORIES) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => !entry.name.startsWith('.') && (entry.isDirectory() || entry.isSymbolicLink()))
    .map(entry => path.join(folder, entry.name))
    // A repository has a `.git` folder, or, as a worktree or a submodule, a `.git` file.
    .filter(inner => fs.existsSync(path.join(inner, '.git')))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, limit);
}

// The repositories a session has to do with, the one to show first first: the one it's in now, those
// it has been in, the latest first, the one it started in, and, when it started in no repository,
// those right inside where it started. A session moves about as it works, and with only where it is
// now it would have a repository at one moment and none at the next. Home has too much in it to look
// through for a session that started there.
export async function repositoriesOf({ now, recent = [], start, home = os.homedir() } = {}) {
  const folders = [...new Set([now, ...recent, start].filter(folder => typeof folder === 'string' && folder))];
  const found = await Promise.all(folders.map(folder => repositoryOf(folder)));
  const roots = found.filter(Boolean);
  const startRoot = start ? found[folders.indexOf(start)] : undefined;
  if (start && !startRoot && path.resolve(start) !== path.resolve(home) && path.resolve(start) !== path.parse(start).root) {
    // Each as git itself names it, which leaves out a folder that only looks like a repository.
    roots.push(...(await Promise.all(repositoriesUnder(start).map(folder => repositoryOf(folder)))).filter(Boolean));
  }
  return [...new Set(roots)].slice(0, SESSION_REPOSITORIES);
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
  return path.relative(root, resolved).split(path.sep).join('/');
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

// The remote a branch that follows none is pushed to: the one git is set to push to, the only one there
// is, or origin. None where the repository has no remote.
async function pushRemote(root) {
  const names = (await git(root, ['remote']).catch(() => '')).split('\n').filter(Boolean);
  if (names.length < 2) return names[0];
  const set = (await git(root, ['config', '--get', 'remote.pushDefault']).catch(() => '')).trim();
  if (names.includes(set)) return set;
  return names.includes('origin') ? 'origin' : names[0];
}

// The branch, how far it is from the one it follows, and what has changed: `staged` is what the next
// commit would take, `changes` what's only in the folder, each file with how many lines it gained and
// lost. `remote` is where a push would make a branch for one that follows none. Undefined outside a
// repository.
export async function status(cwd) {
  const root = await repositoryOf(cwd);
  if (!root) return undefined;
  const [porcelain, unstaged, staged, remote] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
    git(root, ['diff', '--numstat', '-z', '-M']),
    git(root, ['diff', '--cached', '--numstat', '-z', '-M']),
    pushRemote(root),
  ]);
  const state = parseStatus(porcelain);
  const [inFolder, inIndex] = [parseNumstat(unstaged), parseNumstat(staged)];
  const counted = (files, counts) => files.slice(0, CHANGED_FILES).map(file => ({
    ...file, ...(file.status === 'untracked' ? linesOf(path.join(root, file.path)) : counts.get(file.path)),
  }));
  const isTruncated = state.staged.length > CHANGED_FILES || state.changes.length > CHANGED_FILES;
  return {
    root, ...state, ...(remote && { remote }), staged: counted(state.staged, inIndex), changes: counted(state.changes, inFolder),
    ...(isTruncated && { truncated: true }),
  };
}

// How much has changed since the last commit, for one line to say: the files a status lists, staged or not,
// each counted once, and the lines they gained and lost between them. It's what the status itself lists, so
// the line agrees with the page that shows the files. A file that isn't text is a file with no lines.
export function countChanges(state) {
  if (!state) return undefined;
  const listed = [...(state.staged ?? []), ...(state.changes ?? [])];
  const sum = key => listed.reduce((total, file) => total + (file.binary ? 0 : file[key] ?? 0), 0);
  return { files: new Set(listed.map(file => file.path)).size, added: sum('added'), removed: sum('removed') };
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

// What keeps git, and the ssh it runs, from asking anyone anything on the way to a remote: no password,
// no passphrase, no message to edit. There's no one at the computer to answer, and a question would
// only hold things up until their time ran out. What's kept for git already, in a keychain or with an
// agent, is used as it would be in a terminal.
const UNATTENDED = {
  GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
};

// Git, to change something: it takes the locks it needs, and what it says when it won't is for the reader.
// With `network`, it's something that goes to a remote.
async function change(root, args, { literal = false, network = false } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...(network && UNATTENDED) };
  // Paths are named as they are, with none of git's patterns read into them.
  const options = ['-c', 'core.quotePath=false', ...(network ? ['-c', 'core.askPass='] : []), ...(literal ? ['--literal-pathspecs'] : []), '-C', root];
  try {
    return (await exec('git', [...options, ...args], { timeout: network ? NETWORK_TIMEOUT_MS : CHANGE_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, env })).stdout;
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

// Throws away what has changed in the folder and isn't staged, for the paths named, or with `all` for
// the whole repository: a file git follows is as the next commit has it again, and one git doesn't
// follow is gone, a new folder whole. Nothing is lost for good: what a changed file was, and whatever
// git didn't follow, goes to the Trash first, through `trash(root, path)`. What's staged stays staged,
// and what git ignores is left where it is.
//
// `keeps` are folders that are never cleared out, the home folder being one: in a repository whose top
// is one of them, or above one, `all` leaves what git doesn't follow where it is, which there is
// everything else the folder has in it.
export async function discard(cwd, { paths, all } = {}, { trash, keeps = [] } = {}) {
  const root = await rootOf(cwd);
  const named = namedPaths(root, paths, all);
  const among = named.length ? named : ['.'];
  const list = async args => (await git(root, [...args, '-z', '--', ...among], { literal: true })).split('\0').filter(Boolean);
  const holds = kept => { const inside = path.relative(root, path.resolve(kept)); return !inside.startsWith('..') && !path.isAbsolute(inside); };
  const isKept = all === true && keeps.some(holds);
  const [untracked, unmerged, ...tracked] = await Promise.all([
    isKept ? [] : list(['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory']),
    list(['diff', '--name-only', '--diff-filter=U']),
    list(['diff', '--name-only', '--diff-filter=MT']),
    list(['diff', '--name-only', '--diff-filter=D']),
  ]);
  // A file two sides changed is listed as changed too, and is neither thrown away nor put back.
  const [changed, gone] = tracked.map(names => names.filter(name => !unmerged.includes(name)));
  // A few at a time: a folder of new files can be hundreds.
  const leaving = [...changed, ...untracked.map(name => name.replace(/\/$/, ''))];
  for (let at = 0; at < leaving.length; at += TRASHED_AT_ONCE) {
    await Promise.all(leaving.slice(at, at + TRASHED_AT_ONCE).map(name => trash(root, name)));
  }
  const restored = [...changed, ...gone];
  if (restored.length) await change(root, ['restore', '--worktree', '--', ...restored], { literal: true });
  // A file two sides changed isn't one to put back: git says so, in its own words.
  if (unmerged.length) await change(root, ['restore', '--worktree', '--', ...unmerged], { literal: true });
  return {};
}

// Whether a push sent nothing, from what git prints for programs: a line for each branch, which
// starts with `=` for one the remote had already.
export function pushedNothing(printed) {
  const told = printed.split('\n').filter(line => /^[ +\-*!=]\t/.test(line));
  return told.length > 0 && told.every(line => line.startsWith('='));
}

async function onBranch(root) {
  const state = parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']));
  if (state.detached || !state.branch) throw new HelperError('detached_head', 'You’re not on a branch right now.');
  return state;
}

// Sends the branch the folder is on to the branch it follows. One that follows none is made on the
// repository's remote under its own name, and follows that from then on. Nothing is forced: where the
// remote has commits this branch hasn't, git refuses, and says so.
export async function push(cwd) {
  const root = await rootOf(cwd);
  const state = await onBranch(root);
  const args = ['push', '--porcelain'];
  if (!state.upstream) {
    const remote = await pushRemote(root);
    if (!remote) throw new HelperError('no_remote', 'No remote is set up for this repository.');
    args.push('--set-upstream', remote, `refs/heads/${state.branch}:refs/heads/${state.branch}`);
  }
  const printed = await change(root, args, { network: true });
  return { branch: state.branch, upToDate: pushedNothing(printed) };
}

// Brings in what the branch it follows has that this one hasn't, the way git is set up to on this
// computer: by a merge, a rebase, or only where nothing has to be put together. A pull that stops on
// a conflict is taken back, which leaves the folder as it was: there's no one at the computer to settle
// it, and a session working there would find its files half merged. A merge or a rebase that was under
// way before is its owner's: git refuses to pull then, and nothing is taken back.
export async function pull(cwd) {
  const root = await rootOf(cwd);
  const state = await onBranch(root);
  if (!state.upstream) throw new HelperError('no_upstream', 'This branch isn’t tracking a remote branch.');
  const gitFolder = path.resolve(root, (await git(root, ['rev-parse', '--git-dir'])).trim());
  const underWay = () => ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'].filter(name => fs.existsSync(path.join(gitFolder, name)));
  const head = () => git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(printed => printed.trim(), () => '');
  const [before, was] = [underWay(), await head()];
  try {
    await change(root, ['pull', '--no-edit'], { network: true });
  } catch (error) {
    const left = underWay().filter(name => !before.includes(name));
    if (!left.length) throw error;
    const clashed = (await git(root, ['diff', '--name-only', '--diff-filter=U', '-z']).catch(() => '')).split('\0').filter(Boolean);
    await change(root, [left.includes('MERGE_HEAD') ? 'merge' : 'rebase', '--abort']);
    const where = clashed.length ? clashed.slice(0, CONFLICTS).join(', ') : 'some files';
    throw new HelperError('pull_conflict', `Local and remote changes conflict in ${where}. The pull was undone, so nothing changed.`, { paths: clashed.slice(0, CONFLICTS) });
  }
  return { upToDate: (await head()) === was };
}

// Makes a branch where the folder is, and moves the folder to it. What has changed in the folder
// stays as it is.
export async function createBranch(cwd, { name } = {}) {
  const root = await rootOf(cwd);
  const wanted = typeof name === 'string' ? name.trim() : '';
  const bad = () => new HelperError('bad_branch', 'That’s not a valid Git branch name.');
  // Git reads `@{-1}` as the branch the folder was on before, and a dash as an option.
  if (!wanted || wanted.length > BRANCH_CHARS || wanted.startsWith('-') || wanted.includes('@{')) throw bad();
  await git(root, ['check-ref-format', '--branch', wanted]).catch(() => { throw bad(); });
  const names = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n').filter(Boolean);
  if (names.includes(wanted)) throw new HelperError('branch_exists', 'A branch with that name already exists.');
  await change(root, ['switch', '-c', wanted]);
  return { branch: wanted };
}
