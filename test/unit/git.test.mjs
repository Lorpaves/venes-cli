import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  branches, changedPaths, commit, commitStaged, countChanges, createBranch, diff, discard, hunksOf, log, parseBranches, parseLog, parseNameStatus, parseNumstat,
  parseRefs, parseStatus, pull, push, pushedNothing, repositoriesOf, repositoriesUnder, repositoryOf, stage, status, switchBranch, unstage,
} from '../../src/git.mjs';

const ON_WINDOWS = process.platform === 'win32';

// A repository of the test's own, with nothing of this Mac's git settings in it.
function repository(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  git('init', '-q', '-b', 'main');
  // For the commits made through the code under test, which runs git as this Mac has it set up.
  for (const [key, value] of [['user.name', 'Ada'], ['user.email', 'ada@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) {
    git('config', key, value);
  }
  return { root, git, write, env };
}

// A repository with a remote beside it that its branch follows, and someone else's copy of that remote,
// to move it on from: `theirs(name, text)` commits a file there and pushes it.
function withRemote(t) {
  const made = committed(t);
  const folder = prefix => {
    const made = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(made, { recursive: true, force: true }));
    return made;
  };
  const [remote, other] = [folder('venes-git-remote-'), folder('venes-git-other-')];
  const run = (...args) => execFileSync('git', ['-c', 'user.name=Bo', '-c', 'user.email=bo@example.com', '-c', 'commit.gpgsign=false', ...args], { env: made.env, encoding: 'utf8' });
  run('init', '-q', '--bare', '-b', 'main', remote);
  made.git('remote', 'add', 'origin', remote);
  // As git is set up here for the tests, whatever this Mac's own settings are.
  for (const [key, value] of [['pull.rebase', 'false'], ['push.default', 'simple'], ['merge.ff', 'true']]) made.git('config', key, value);
  made.git('push', '-q', '-u', 'origin', 'main');
  run('clone', '-q', remote, other);
  const theirs = (name, text) => {
    fs.writeFileSync(path.join(other, name), text);
    run('-C', other, 'add', '-A');
    run('-C', other, 'commit', '-q', '-m', `Theirs: ${name}`);
    run('-C', other, 'push', '-q');
  };
  return { ...made, remote, theirs };
}

// A Trash of the test's own: what went there, by its path in the repository, with what a file had in it.
function fakeTrash(root) {
  const went = [];
  const trash = async (folder, name) => {
    const target = path.join(folder, name);
    went.push([path.relative(root, target), fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf8') : null]);
    fs.rmSync(target, { recursive: true });
  };
  return { went, trash };
}

function committed(t) {
  const made = repository(t);
  made.write('README.md', '# Venes\n\none\ntwo\nthree\n');
  made.write('src/app.js', 'const a = 1;\nconst b = 2;\n');
  made.write('old name.txt', 'kept as it is\nline two\nline three\n');
  made.git('add', '-A');
  made.git('commit', '-q', '-m', 'First commit', '-m', 'With a body\nof two lines.');
  return made;
}

test('what has changed is counted as the status lists it: each file once, and the lines of them all', () => {
  const counted = countChanges({
    staged: [{ path: 'a.js', status: 'modified', added: 3, removed: 1 }, { path: 'logo.png', status: 'added', binary: true }],
    // Changed again since it was staged, a new file, and one too big to have been counted.
    changes: [{ path: 'a.js', status: 'modified', added: 2, removed: 4 }, { path: 'new.txt', status: 'untracked', added: 7, removed: 0 }, { path: 'big.bin', status: 'untracked' }],
  });
  assert.deepEqual(counted, { files: 4, added: 12, removed: 5 });
  assert.deepEqual(countChanges({ staged: [], changes: [] }), { files: 0, added: 0, removed: 0 });
  // Outside a repository there's nothing to count.
  assert.equal(countChanges(undefined), undefined);
});

test('a status is read from the form git keeps for programs', () => {
  const text = [
    '# branch.oid 1234567890abcdef', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/app.js', '1 A. N... 000000 100644 100644 000 ccc new file.txt',
    '2 R. N... 100644 100644 100644 ddd eee R100 new name.txt', 'old name.txt', '1 MM N... 100644 100644 100644 fff ggg both.txt',
    'u UU N... 100644 100644 100644 100644 hhh iii jjj clash.txt', '? notes/todo.md', '',
  ].join('\0');
  assert.deepEqual(parseStatus(text), {
    ahead: 2, behind: 1, branch: 'main', upstream: 'origin/main',
    staged: [{ path: 'new file.txt', status: 'added' }, { path: 'new name.txt', status: 'renamed', from: 'old name.txt' }, { path: 'both.txt', status: 'modified' }],
    changes: [
      { path: 'src/app.js', status: 'modified' }, { path: 'both.txt', status: 'modified' }, { path: 'clash.txt', status: 'conflicted' },
      { path: 'notes/todo.md', status: 'untracked' },
    ],
  });
});

test('with no branch checked out, the commit stands in for one', () => {
  assert.deepEqual(parseStatus('# branch.oid 1234567890abcdef\0# branch.head (detached)\0'), { ahead: 0, behind: 0, staged: [], changes: [], branch: '1234567', detached: true });
  assert.deepEqual(parseStatus('# branch.oid (initial)\0# branch.head (detached)\0'), { ahead: 0, behind: 0, staged: [], changes: [], branch: undefined, detached: true });
});

test('lines gained and lost are read by path, a rename by its new one, and a binary file has none', () => {
  const counts = parseNumstat(['3\t1\tsrc/app.js', '-\t-\tlogo.png', '0\t0\t', 'old name.txt', 'new name.txt', '12\t0\twith\ttab.txt', ''].join('\0'));
  assert.deepEqual([...counts], [
    ['src/app.js', { added: 3, removed: 1 }], ['logo.png', { binary: true }], ['new name.txt', { added: 0, removed: 0 }], ['with\ttab.txt', { added: 12, removed: 0 }],
  ]);
  assert.equal(parseNumstat('').size, 0);
});

test('what happened to each path of a commit is read, with where a renamed one came from', () => {
  assert.deepEqual(parseNameStatus(['M', 'src/app.js', 'A', 'new.txt', 'D', 'gone.txt', 'R087', 'old.txt', 'new name.txt', ''].join('\0')), [
    { path: 'src/app.js', status: 'modified' }, { path: 'new.txt', status: 'added' }, { path: 'gone.txt', status: 'deleted' },
    { path: 'new name.txt', status: 'renamed', from: 'old.txt' },
  ]);
});

test('a diff is its hunks, without git\'s own header, cut at a line\'s end when it\'s long', () => {
  const printed = 'diff --git a/a.txt b/a.txt\nindex 111..222 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+2\n@@ -9 +9 @@\n-x\n+y\n';
  assert.deepEqual(hunksOf(printed), { diff: '@@ -1,2 +1,2 @@\n one\n-two\n+2\n@@ -9 +9 @@\n-x\n+y\n' });
  assert.deepEqual(hunksOf('@@ -1 +1 @@\n-a\n+b\n'), { diff: '@@ -1 +1 @@\n-a\n+b\n' });
  assert.deepEqual(hunksOf(''), { diff: '' });
  assert.deepEqual(hunksOf('diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'), { diff: '', binary: true });
  assert.deepEqual(hunksOf(printed, 30), { diff: '@@ -1,2 +1,2 @@\n one\n-two\n+2\n', truncated: true });
});

test('commits and branches are read a record at a time', () => {
  const printed = 'aaa\x1fa1\x1fFix the thing\x1fAda\x1f1767323045\x1fbbb ccc\x1fHEAD -> refs/heads/main, refs/remotes/origin/main\x1e\n'
    + 'bbb\x1fb1\x1fStart\x1fGrace\x1f1767323000\x1f\x1f\x1e\n';
  assert.deepEqual(parseLog(printed), [
    {
      hash: 'aaa', short: 'a1', subject: 'Fix the thing', author: 'Ada', at: 1767323045000, parents: ['bbb', 'ccc'],
      refs: [{ name: 'main', kind: 'head' }, { name: 'origin/main', kind: 'remote' }],
    },
    { hash: 'bbb', short: 'b1', subject: 'Start', author: 'Grace', at: 1767323000000, parents: [], refs: [] },
  ]);
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseBranches('main\x1f*\x1forigin/main\x1fahead 2, behind 1\x1f1767323045\x1fFix the thing\nold\x1f \x1f\x1f\x1f1767000000\x1fStart\n'), [
    { name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1, at: 1767323045000, subject: 'Fix the thing' },
    { name: 'old', current: false, ahead: 0, behind: 0, at: 1767000000000, subject: 'Start' },
  ]);
});

test('the names at a commit are told apart by what they are', () => {
  assert.deepEqual(parseRefs('HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD, refs/heads/feature/x, refs/stash'), [
    { name: 'main', kind: 'head' }, { name: 'v1.0', kind: 'tag' }, { name: 'origin/main', kind: 'remote' }, { name: 'feature/x', kind: 'branch' },
  ]);
  assert.deepEqual(parseRefs('HEAD, refs/heads/main'), [{ name: 'HEAD', kind: 'head' }, { name: 'main', kind: 'branch' }]);
  assert.deepEqual(parseRefs(''), []);
  assert.deepEqual(parseRefs(undefined), []);
});

test('a folder that\'s in no repository has none, and one inside a repository has its top', async t => {
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-nogit-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.equal(await repositoryOf(outside), undefined);
  assert.equal(await status(outside), undefined);
  assert.equal(await changedPaths(outside), undefined);
  assert.equal(await repositoryOf(undefined), undefined);
  assert.equal(await repositoryOf('/no/such/folder/anywhere'), undefined);
  await assert.rejects(log(outside), error => error.code === 'no_repository');
  const { root } = committed(t);
  assert.equal(await repositoryOf(path.join(root, 'src')), root);
});

test('a clean repository says its branch and nothing more', async t => {
  const { root } = committed(t);
  assert.deepEqual(await status(root), { root, ahead: 0, behind: 0, branch: 'main', staged: [], changes: [] });
});

test('what has changed is told apart by whether the next commit would take it, each with its lines', async t => {
  const { root, git, write } = committed(t);
  write('README.md', '# Venes\n\none\n2\nthree\nfour\n');             // changed in the folder only
  write('src/app.js', 'const a = 1;\n');                              // staged
  git('add', 'src/app.js');
  git('mv', 'old name.txt', 'new name.txt');                          // renamed, staged
  write('notes/待办.md', 'one\ntwo\nthree');                           // untracked, no line end at its end
  write('logo.bin', Buffer.from([0, 1, 2, 3]));
  const state = await status(path.join(root, 'src'));
  assert.equal(state.root, root);
  assert.equal(state.branch, 'main');
  assert.deepEqual(state.staged, [
    { path: 'new name.txt', status: 'renamed', from: 'old name.txt', added: 0, removed: 0 },
    { path: 'src/app.js', status: 'modified', added: 0, removed: 1 },
  ]);
  assert.deepEqual(state.changes, [
    { path: 'README.md', status: 'modified', added: 2, removed: 1 },
    { path: 'logo.bin', status: 'untracked', binary: true },
    { path: 'notes/待办.md', status: 'untracked', added: 3, removed: 0 },
  ]);
  const { changed } = await changedPaths(root);
  assert.deepEqual([...changed].sort(), [['README.md', 'modified'], ['logo.bin', 'untracked'], ['new name.txt', 'renamed'], ['notes/待办.md', 'untracked'], ['src/app.js', 'modified']]);
});

test('a file\'s diff is what\'s in the folder, what\'s staged, or all of a file git doesn\'t follow yet', async t => {
  const { root, git, write } = committed(t);
  write('README.md', '# Venes\n\none\n2\nthree\n');
  write('src/app.js', 'const a = 1;\nconst b = 3;\n');
  git('add', 'src/app.js');
  write('src/app.js', 'const a = 1;\nconst b = 3;\nconst c = 4;\n');
  write('notes/todo.md', 'first\nsecond\n');
  assert.deepEqual(await diff(root, { path: 'README.md' }), { diff: '@@ -1,5 +1,5 @@\n # Venes\n \n one\n-two\n+2\n three\n' });
  assert.deepEqual(await diff(root, { path: 'src/app.js', staged: true }), { diff: '@@ -1,2 +1,2 @@\n const a = 1;\n-const b = 2;\n+const b = 3;\n' });
  assert.deepEqual(await diff(root, { path: 'src/app.js' }), { diff: '@@ -1,2 +1,3 @@\n const a = 1;\n const b = 3;\n+const c = 4;\n' });
  assert.deepEqual(await diff(root, { path: 'notes/todo.md' }), { diff: '@@ -0,0 +1,2 @@\n+first\n+second\n' });
  // One that hasn't changed has nothing to show, and one outside the repository isn't looked at.
  assert.deepEqual(await diff(root, { path: 'old name.txt' }), { diff: '' });
  await assert.rejects(diff(root, { path: '../elsewhere.txt' }), error => error.code === 'bad_path');
  await assert.rejects(diff(root, {}), error => error.code === 'bad_path');
  write('logo.bin', Buffer.from([0, 1, 2, 3]));
  assert.deepEqual(await diff(root, { path: 'logo.bin' }), { diff: '', binary: true });
});

test('the commits come newest first, a page at a time', async t => {
  const { root, git, write } = committed(t);
  for (const number of [2, 3, 4]) {
    write('README.md', `# Venes\n\n${number}\n`);
    git('commit', '-q', '-am', `Commit ${number}`);
  }
  const first = await log(root, { limit: 3 });
  assert.deepEqual(first.commits.map(entry => entry.subject), ['Commit 4', 'Commit 3', 'Commit 2']);
  assert.equal(first.hasMore, true);
  assert.deepEqual(first.commits[0].refs, [{ name: 'main', kind: 'head' }]);
  assert.deepEqual(first.commits.map(entry => entry.parents), [[first.commits[1].hash], [first.commits[2].hash], [first.commits[2].parents[0]]]);
  assert.deepEqual([first.commits[0].author, first.commits[0].at, first.commits[0].hash.length, first.commits[0].short.length >= 7], ['Ada', Date.parse('2026-01-02T03:04:05Z'), 40, true]);
  const second = await log(root, { limit: 3, skip: 3 });
  assert.deepEqual([second.commits.map(entry => entry.subject), second.hasMore], [['First commit'], false]);
});

test('a repository with no commit yet has none to list', async t => {
  const { root } = repository(t);
  assert.deepEqual(await log(root), { commits: [], hasMore: false });
  assert.deepEqual((await status(root)).branch, 'main');
});

test('a commit says who made it, all it says, and what it did to each file', async t => {
  const { root, git, write } = committed(t);
  write('README.md', '# Venes\n\none\n2\nthree\n');
  git('mv', 'old name.txt', 'new name.txt');
  fs.rmSync(path.join(root, 'src/app.js'));
  write('added.txt', 'new\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Second commit');
  const { commits } = await log(root, { limit: 2 });
  const second = await commit(root, { commit: commits[0].hash });
  assert.deepEqual([second.commit.subject, second.commit.body, second.commit.author, second.commit.email, second.commit.parents], ['Second commit', '', 'Ada', 'ada@example.com', [commits[1].hash]]);
  assert.deepEqual(second.files, [
    { path: 'README.md', status: 'modified', added: 1, removed: 1 },
    { path: 'added.txt', status: 'added', added: 1, removed: 0 },
    { path: 'new name.txt', status: 'renamed', from: 'old name.txt', added: 0, removed: 0 },
    { path: 'src/app.js', status: 'deleted', added: 0, removed: 2 },
  ]);
  assert.deepEqual(await diff(root, { path: 'README.md', commit: commits[0].short }), { diff: '@@ -1,5 +1,5 @@\n # Venes\n \n one\n-two\n+2\n three\n' });
  // The first commit of all is everything it added, against nothing.
  const first = await commit(root, { commit: commits[1].hash });
  assert.deepEqual([first.commit.subject, first.commit.body, first.commit.parents, first.files.length], ['First commit', 'With a body\nof two lines.', [], 3]);
  assert.equal((await diff(root, { path: 'src/app.js', commit: commits[1].hash })).diff, '@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;\n');
  await assert.rejects(commit(root, { commit: 'main; rm -rf /' }), error => error.code === 'bad_commit');
  await assert.rejects(commit(root, { commit: 'abcdef1234' }), error => error.code === 'bad_commit');
  await assert.rejects(diff(root, { path: 'README.md', commit: '--output=/tmp/x' }), error => error.code === 'bad_commit');
});

test('the branches are listed with the one the folder is on', async t => {
  const { root, git, write } = committed(t);
  git('checkout', '-q', '-b', 'feature/one');
  write('README.md', '# Venes\n');
  git('commit', '-q', '-am', 'On the branch');
  const listed = (await branches(root)).branches;
  assert.deepEqual(listed.map(branch => [branch.name, branch.current, branch.subject]).sort(), [['feature/one', true, 'On the branch'], ['main', false, 'First commit']]);
  assert.equal((await status(root)).branch, 'feature/one');
});

test('with every branch asked for, the commits of the others come too, a merge with both it came from', async t => {
  const { root, git, write } = committed(t);
  git('checkout', '-q', '-b', 'side');
  write('side.txt', 'side\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'On the side');
  git('checkout', '-q', 'main');
  write('main.txt', 'main\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'On main');
  git('merge', '-q', '--no-ff', '-m', 'Merge side', 'side');
  git('tag', 'v1');
  git('checkout', '-q', '-b', 'later', 'side');
  write('later.txt', 'later\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Later, apart');
  git('checkout', '-q', 'main');

  const own = (await log(root)).commits;
  assert.deepEqual(own.map(entry => entry.subject).sort(), ['First commit', 'Merge side', 'On main', 'On the side']);
  const { commits } = await log(root, { all: true });
  const bySubject = Object.fromEntries(commits.map(entry => [entry.subject, entry]));
  assert.deepEqual(Object.keys(bySubject).sort(), ['First commit', 'Later, apart', 'Merge side', 'On main', 'On the side']);
  assert.deepEqual(bySubject['Merge side'].parents, [bySubject['On main'].hash, bySubject['On the side'].hash]);
  assert.deepEqual(bySubject['Merge side'].refs, [{ name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }]);
  assert.deepEqual(bySubject['Later, apart'].refs, [{ name: 'later', kind: 'branch' }]);
  assert.deepEqual(bySubject['On the side'].refs, [{ name: 'side', kind: 'branch' }]);
  // No commit comes before one that came from it.
  const place = new Map(commits.map((entry, index) => [entry.hash, index]));
  for (const entry of commits) for (const parent of entry.parents) assert.ok(place.get(parent) > place.get(entry.hash), entry.subject);
  assert.deepEqual((await commit(root, { commit: bySubject['Merge side'].hash })).commit.refs, [{ name: 'main', kind: 'head' }, { name: 'v1', kind: 'tag' }]);
});

// One of its files has a * in its name, which Windows doesn't allow in one.
test('files are staged and taken back out, by name or all at once', { skip: process.platform === 'win32' }, async t => {
  const { root, git, write } = committed(t);
  write('README.md', '# Venes\n\nchanged\n');
  write('notes/a *.md', 'new\n');
  fs.rmSync(path.join(root, 'src/app.js'));
  git('mv', 'old name.txt', 'new name.txt');
  const paths = async () => {
    const state = await status(root);
    return [state.staged.map(file => `${file.status} ${file.path}`).sort(), state.changes.map(file => `${file.status} ${file.path}`).sort()];
  };
  assert.deepEqual(await paths(), [['renamed new name.txt'], ['deleted src/app.js', 'modified README.md', 'untracked notes/a *.md']]);

  assert.deepEqual(await stage(root, { paths: ['README.md', 'notes/a *.md', 'src/app.js'] }), {});
  assert.deepEqual(await paths(), [['added notes/a *.md', 'deleted src/app.js', 'modified README.md', 'renamed new name.txt'], []]);
  // A renamed file is two paths to git: where it was, and where it is.
  await unstage(root, { paths: ['new name.txt', 'old name.txt', 'src/app.js'] });
  assert.deepEqual(await paths(), [['added notes/a *.md', 'modified README.md'], ['deleted old name.txt', 'deleted src/app.js', 'untracked new name.txt']]);
  await unstage(root, { all: true });
  assert.deepEqual((await paths())[0], []);
  await stage(root, { all: true });
  assert.deepEqual(await paths(), [['added notes/a *.md', 'deleted src/app.js', 'modified README.md', 'renamed new name.txt'], []]);
  // A name is taken as it is, with none of git's patterns read into it.
  write('notes/a b.md', 'another\n');
  await unstage(root, { all: true });
  await stage(root, { paths: ['notes/a *.md'] });
  assert.deepEqual((await paths())[0], ['added notes/a *.md']);

  await assert.rejects(stage(root, { paths: ['../outside.txt'] }), error => error.code === 'bad_path');
  await assert.rejects(stage(root, { paths: [] }), error => error.code === 'bad_path');
  await assert.rejects(stage(root, {}), error => error.code === 'bad_path');
  await assert.rejects(unstage(root, { paths: 'README.md' }), error => error.code === 'bad_path');
  await assert.rejects(stage(root, { paths: ['not there.txt'] }), error => error.code === 'git_failed' && /not there\.txt/.test(error.message));
});

test('before the first commit, staged files can still be taken back out', async t => {
  const { root, write } = repository(t);
  write('a.txt', 'a\n');
  write('b/c.txt', 'c\n');
  await stage(root, { all: true });
  assert.deepEqual((await status(root)).staged.map(file => file.path).sort(), ['a.txt', 'b/c.txt']);
  await unstage(root, { paths: ['a.txt'] });
  assert.deepEqual((await status(root)).staged.map(file => file.path), ['b/c.txt']);
  await unstage(root, { all: true });
  assert.deepEqual([(await status(root)).staged, (await status(root)).changes.map(file => file.path).sort()], [[], ['a.txt', 'b/c.txt']]);
});

test('what\'s staged is committed with a message, and nothing staged is none to make', async t => {
  const { root, write } = committed(t);
  await assert.rejects(commitStaged(root, { message: 'Nothing' }), error => error.code === 'nothing_staged');
  write('README.md', '# Venes\n\nchanged\n');
  write('left.txt', 'not staged\n');
  await stage(root, { paths: ['README.md'] });
  await assert.rejects(commitStaged(root, { message: '   ' }), error => error.code === 'bad_message');
  await assert.rejects(commitStaged(root, {}), error => error.code === 'bad_message');
  const made = await commitStaged(root, { message: '  Change the readme\n\nAnd say why.\n' });
  const { commits } = await log(root, { limit: 2 });
  assert.deepEqual([made.commit.hash, made.commit.short], [commits[0].hash, commits[0].short]);
  assert.deepEqual([commits[0].subject, commits[0].author, commits[0].parents], ['Change the readme', 'Ada', [commits[1].hash]]);
  assert.equal((await commit(root, { commit: made.commit.hash })).commit.body, 'And say why.');
  // What wasn't staged is still only in the folder.
  const state = await status(root);
  assert.deepEqual([state.staged, state.changes.map(file => file.path)], [[], ['left.txt']]);
});

test('a hook that refuses a commit says why', async t => {
  const { root, git, write } = committed(t);
  const hooks = path.join(root, '.git', 'hooks-of-the-test');
  fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "the hook says no" >&2\nexit 1\n', { mode: 0o755 });
  git('config', 'core.hooksPath', hooks);
  write('README.md', '# Venes\n\nchanged\n');
  await stage(root, { all: true });
  await assert.rejects(commitStaged(root, { message: 'Refused' }), error => error.code === 'git_failed' && /the hook says no/.test(error.message));
  assert.equal((await log(root)).commits.length, 1);
});

test('the folder moves to another branch, unless that would write over what\'s changed', async t => {
  const { root, git, write } = committed(t);
  git('checkout', '-q', '-b', 'feature/one');
  write('README.md', '# Venes\n\non the branch\n');
  git('commit', '-q', '-am', 'On the branch');
  assert.deepEqual(await switchBranch(root, { branch: 'main' }), { branch: 'main' });
  assert.equal((await status(root)).branch, 'main');
  // A change that the other branch has its own version of stays, and git says so.
  write('README.md', '# Venes\n\nmine\n');
  await assert.rejects(switchBranch(root, { branch: 'feature/one' }), error => error.code === 'git_failed' && /README\.md/.test(error.message));
  assert.equal((await status(root)).branch, 'main');
  git('checkout', '-q', '--', 'README.md');
  await switchBranch(root, { branch: 'feature/one' });
  assert.equal((await status(root)).branch, 'feature/one');
  for (const branch of ['no-such', '--detach', 'main; rm -rf /', undefined, 7, 'HEAD']) {
    await assert.rejects(switchBranch(root, { branch }), error => error.code === 'no_branch', `${branch}`);
  }
});

test('nothing changes outside a repository', async t => {
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-nogit-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  for (const act of [() => stage(outside, { all: true }), () => unstage(outside, { all: true }), () => commitStaged(outside, { message: 'x' }), () => switchBranch(outside, { branch: 'main' })]) {
    await assert.rejects(act(), error => error.code === 'no_repository');
  }
});

// A project kept as several repositories in one folder that isn't one itself, with a folder of none beside them.
function project(t) {
  const top = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-project-')));
  t.after(() => fs.rmSync(top, { recursive: true, force: true }));
  for (const name of ['ios', 'helper', 'Tap 2', 'Tap 10']) {
    fs.mkdirSync(path.join(top, name, 'src'), { recursive: true });
    execFileSync('git', ['init', '-q', '-b', 'main', path.join(top, name)]);
  }
  fs.mkdirSync(path.join(top, 'notes', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(top, '.hidden'));
  execFileSync('git', ['init', '-q', path.join(top, '.hidden')]);
  // A worktree and a submodule have a `.git` file where a repository has a folder.
  fs.mkdirSync(path.join(top, 'worktree'));
  fs.writeFileSync(path.join(top, 'worktree', '.git'), 'gitdir: elsewhere\n');
  fs.writeFileSync(path.join(top, 'a-file'), 'not a folder\n');
  return top;
}

test('the repositories right inside a folder are found by name, and nothing deeper or hidden', t => {
  const top = project(t);
  assert.deepEqual(repositoriesUnder(top).map(root => path.basename(root)), ['helper', 'ios', 'Tap 2', 'Tap 10', 'worktree']);
  assert.deepEqual(repositoriesUnder(top, 2).map(root => path.basename(root)), ['helper', 'ios']);
  assert.deepEqual(repositoriesUnder(path.join(top, 'notes')), []);
  assert.deepEqual(repositoriesUnder(path.join(top, 'no-such-folder')), []);
});

test('a session that moves about keeps its repositories: where it is, where it has been, and those inside where it started', async t => {
  const top = project(t);
  const [ios, helper, notes] = ['ios', 'helper', 'notes'].map(name => path.join(top, name));
  const names = async about => (await repositoriesOf({ home: '/no/home', ...about })).map(root => path.relative(top, root));
  // In a folder of no repository now, it still has the one it was last in, first, then the rest.
  assert.deepEqual(await names({ now: notes, recent: [notes, path.join(helper, 'src'), ios], start: top }), ['helper', 'ios', 'Tap 2', 'Tap 10']);
  // Back in one, that one is first.
  assert.deepEqual(await names({ now: path.join(ios, 'src'), recent: [path.join(ios, 'src'), notes, helper], start: top }), ['ios', 'helper', 'Tap 2', 'Tap 10']);
  // One that has been nowhere but where it started has those inside it.
  assert.deepEqual(await names({ now: top, recent: [top], start: top }), ['helper', 'ios', 'Tap 2', 'Tap 10']);
  assert.deepEqual(await names({ now: top }), []);
  // One that started in a repository has that, and its neighbours aren't looked for.
  assert.deepEqual(await names({ now: notes, recent: [notes], start: helper }), ['helper']);
  assert.deepEqual(await names({ now: helper, start: helper }), ['helper']);
  // A folder that has gone, or was never one, is no one's repository.
  assert.deepEqual(await names({ now: path.join(top, 'gone'), recent: [undefined, 7, '', path.join(top, 'gone')], start: notes }), []);
  assert.deepEqual(await repositoriesOf(), []);
  // Home has too much in it to look through.
  assert.deepEqual(await repositoriesOf({ now: top, start: top, home: top }), []);
  assert.deepEqual((await repositoriesOf({ now: ios, start: top, home: top })).map(root => path.basename(root)), ['ios']);
});

test('a branch whose own on the remote is gone says so, where git has no count for it', () => {
  const gone = parseStatus(['# branch.oid abc', '# branch.head topic', '# branch.upstream origin/topic', ''].join('\0'));
  assert.deepEqual([gone.upstream, gone.upstreamGone, gone.ahead, gone.behind], ['origin/topic', true, 0, 0]);
  const counted = parseStatus(['# branch.oid abc', '# branch.head topic', '# branch.upstream origin/topic', '# branch.ab +0 -0', ''].join('\0'));
  assert.equal(counted.upstreamGone, undefined);
  assert.equal(parseStatus(['# branch.oid abc', '# branch.head topic', ''].join('\0')).upstreamGone, undefined);
});

test('a push that sent nothing is told from what git prints for programs', () => {
  assert.equal(pushedNothing('To /tmp/remote\n=\trefs/heads/main:refs/heads/main\t[up to date]\nDone\n'), true);
  assert.equal(pushedNothing('To /tmp/remote\n \trefs/heads/main:refs/heads/main\tabc..def\nDone\n'), false);
  assert.equal(pushedNothing('To /tmp/remote\n*\trefs/heads/new:refs/heads/new\t[new branch]\nDone\n'), false);
  assert.equal(pushedNothing(''), false);
});

test('a branch is pushed to the one it follows, and one that follows none is made on the remote', { skip: ON_WINDOWS }, async t => {
  const { root, git, write } = withRemote(t);
  assert.equal((await status(root)).remote, 'origin');
  // Level with the branch it follows, there's nothing to send.
  assert.deepEqual(await push(root), { branch: 'main', upToDate: true });
  write('README.md', '# Venes\n\nmore\n');
  git('commit', '-q', '-am', 'More');
  assert.equal((await status(root)).ahead, 1);
  assert.deepEqual(await push(root), { branch: 'main', upToDate: false });
  assert.equal((await status(root)).ahead, 0);
  // A new branch follows none: it's made on the remote under its own name, and follows that.
  git('switch', '-q', '-c', 'feature/x');
  const before = await status(root);
  assert.deepEqual([before.upstream, before.remote], [undefined, 'origin']);
  assert.deepEqual(await push(root), { branch: 'feature/x', upToDate: false });
  const after = await status(root);
  assert.deepEqual([after.upstream, after.ahead, after.upstreamGone], ['origin/feature/x', 0, undefined]);
  assert.deepEqual(await push(root), { branch: 'feature/x', upToDate: true });
});

test('a push the remote has moved on from is refused in git\'s words, and nothing is forced', { skip: ON_WINDOWS }, async t => {
  const { root, git, write, theirs, remote } = withRemote(t);
  theirs('theirs.txt', 'theirs\n');
  const there = execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' });
  write('mine.txt', 'mine\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Mine');
  await assert.rejects(push(root), error => error.code === 'git_failed' && /rejected|fetch first|failed to push/.test(error.message));
  assert.equal(execFileSync('git', ['-C', remote, 'rev-parse', 'main'], { encoding: 'utf8' }), there);
});

test('with no remote there\'s nowhere to push, with no branch followed nothing to pull, and on no branch neither', { skip: ON_WINDOWS }, async t => {
  const { root, git } = committed(t);
  assert.equal((await status(root)).remote, undefined);
  await assert.rejects(push(root), { code: 'no_remote' });
  await assert.rejects(pull(root), { code: 'no_upstream' });
  git('checkout', '-q', '--detach');
  await assert.rejects(push(root), { code: 'detached_head' });
  await assert.rejects(pull(root), { code: 'detached_head' });
});

test('a pull brings in what the branch it follows has, and says when there was nothing to bring', { skip: ON_WINDOWS }, async t => {
  const { root, theirs } = withRemote(t);
  assert.deepEqual(await pull(root), { upToDate: true });
  theirs('theirs.txt', 'theirs\n');
  assert.deepEqual(await pull(root), { upToDate: false });
  assert.equal(fs.readFileSync(path.join(root, 'theirs.txt'), 'utf8'), 'theirs\n');
  assert.deepEqual(await pull(root), { upToDate: true });
});

for (const rebase of ['false', 'true']) {
  test(`a pull that stops on a conflict is taken back, and the folder is as it was (pull.rebase ${rebase})`, { skip: ON_WINDOWS }, async t => {
    const { root, git, write, theirs } = withRemote(t);
    git('config', 'pull.rebase', rebase);
    theirs('README.md', '# Theirs\n');
    write('README.md', '# Mine\n');
    git('commit', '-q', '-am', 'Mine');
    write('left alone.txt', 'not committed\n');
    const head = git('rev-parse', 'HEAD');
    await assert.rejects(pull(root), error => {
      assert.equal(error.code, 'pull_conflict');
      assert.deepEqual(error.details, { paths: ['README.md'] });
      assert.equal(error.message, 'Local and remote changes conflict in README.md. The pull was undone, so nothing changed.');
      return true;
    });
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Mine\n');
    assert.equal(git('status', '--porcelain'), '?? "left alone.txt"\n');
    for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply']) assert.equal(fs.existsSync(path.join(root, '.git', name)), false, name);
  });
}

test('a merge that was under way before a pull is its owner\'s, and isn\'t taken back', { skip: ON_WINDOWS }, async t => {
  const { root, git, write } = withRemote(t);
  git('switch', '-q', '-c', 'side');
  write('README.md', '# Side\n');
  git('commit', '-q', '-am', 'Side');
  git('switch', '-q', 'main');
  write('README.md', '# Main\n');
  git('commit', '-q', '-am', 'Main');
  assert.throws(() => git('merge', 'side'));
  await assert.rejects(pull(root), { code: 'git_failed' });
  assert.ok(fs.existsSync(path.join(root, '.git', 'MERGE_HEAD')), 'the merge is still under way');
});

test('a file\'s changes are thrown away, and what it was goes to the Trash', { skip: ON_WINDOWS }, async t => {
  const { root, git, write } = committed(t);
  const { went, trash } = fakeTrash(root);
  write('README.md', 'changed\n');
  write('new.txt', 'new\n');
  write('src/app.js', 'staged\n');
  git('add', 'src/app.js');
  write('src/app.js', 'staged, then changed\n');
  fs.rmSync(path.join(root, 'old name.txt'));
  await discard(root, { paths: ['README.md'] }, { trash });
  assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Venes\n\none\ntwo\nthree\n');
  assert.deepEqual(went, [['README.md', 'changed\n']]);
  // A new file goes, one that was deleted comes back, and one that's staged goes back to what's staged.
  await discard(root, { paths: ['new.txt', 'old name.txt', 'src/app.js'] }, { trash });
  assert.equal(fs.existsSync(path.join(root, 'new.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'old name.txt'), 'utf8'), 'kept as it is\nline two\nline three\n');
  assert.equal(fs.readFileSync(path.join(root, 'src/app.js'), 'utf8'), 'staged\n');
  assert.deepEqual(went.slice(1).sort(), [['new.txt', 'new\n'], ['src/app.js', 'staged, then changed\n']]);
  const after = await status(root);
  assert.deepEqual([after.staged.map(file => file.path), after.changes], [['src/app.js'], []]);
  // With nothing changed in what's named, nothing is done.
  await discard(root, { paths: ['README.md'] }, { trash });
  assert.equal(went.length, 3);
});

test('everything that isn\'t staged is thrown away at once, a new folder whole, and what git ignores is left', { skip: ON_WINDOWS }, async t => {
  const { root, git, write } = committed(t);
  const { went, trash } = fakeTrash(root);
  write('.gitignore', 'ignored.log\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Ignore the log');
  write('ignored.log', 'kept\n');
  write('fresh/a.txt', 'a\n');
  write('fresh/deep/b.txt', 'b\n');
  write('README.md', 'changed\n');
  write('staged.txt', 'staged\n');
  git('add', 'staged.txt');
  await discard(root, { all: true }, { trash });
  assert.deepEqual(went.sort(), [['README.md', 'changed\n'], ['fresh', null]]);
  assert.equal(fs.readFileSync(path.join(root, 'ignored.log'), 'utf8'), 'kept\n');
  const after = await status(root);
  assert.deepEqual([after.staged.map(file => file.path), after.changes], [['staged.txt'], []]);
});

test('in a repository that holds a folder that\'s kept, as the home folder is, all leaves what git doesn\'t follow', { skip: ON_WINDOWS }, async t => {
  const { root, write } = committed(t);
  const { went, trash } = fakeTrash(root);
  write('Documents/letter.txt', 'not git\'s\n');
  write('README.md', 'changed\n');
  // The repository's top is the folder that's kept, and then is above it.
  for (const kept of [root, path.join(root, 'Documents')]) {
    write('README.md', 'changed\n');
    await discard(root, { all: true }, { trash, keeps: [kept] });
    assert.equal(fs.readFileSync(path.join(root, 'Documents/letter.txt'), 'utf8'), 'not git\'s\n');
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), '# Venes\n\none\ntwo\nthree\n');
  }
  assert.deepEqual(went, [['README.md', 'changed\n'], ['README.md', 'changed\n']]);
  // One named is still thrown away, and so is everything where the folder kept is somewhere else.
  await discard(root, { paths: ['Documents/letter.txt'] }, { trash, keeps: [root] });
  assert.equal(fs.existsSync(path.join(root, 'Documents/letter.txt')), false);
  write('Documents/letter.txt', 'again\n');
  await discard(root, { all: true }, { trash, keeps: [path.dirname(root)] });
  assert.equal(fs.existsSync(path.join(root, 'Documents')), false);
});

test('only what\'s named is thrown away, as it\'s named, and only inside the repository', { skip: ON_WINDOWS }, async t => {
  const { root, write } = committed(t);
  const { went, trash } = fakeTrash(root);
  // A name with one of git's pattern letters in it is that file, and no other.
  write('a*.txt', 'star\n');
  write('ab.txt', 'other\n');
  await discard(root, { paths: ['a*.txt'] }, { trash });
  assert.deepEqual(went, [['a*.txt', 'star\n']]);
  assert.equal(fs.readFileSync(path.join(root, 'ab.txt'), 'utf8'), 'other\n');
  await assert.rejects(discard(root, { paths: ['../outside'] }, { trash }), { code: 'bad_path' });
  await assert.rejects(discard(root, {}, { trash }), { code: 'bad_path' });
  await assert.rejects(discard(root, { paths: [] }, { trash }), { code: 'bad_path' });
});

test('a file both sides changed isn\'t put back, and git says so', { skip: ON_WINDOWS }, async t => {
  const { root, git, write } = committed(t);
  const { went, trash } = fakeTrash(root);
  git('switch', '-q', '-c', 'side');
  write('README.md', '# Side\n');
  git('commit', '-q', '-am', 'Side');
  git('switch', '-q', 'main');
  write('README.md', '# Main\n');
  git('commit', '-q', '-am', 'Main');
  assert.throws(() => git('merge', 'side'));
  await assert.rejects(discard(root, { paths: ['README.md'] }, { trash }), error => error.code === 'git_failed' && /unmerged/.test(error.message));
  assert.deepEqual(went, []);
});

test('a branch is made where the folder is, and the folder moves to it with what has changed', async t => {
  const { root, write } = committed(t);
  write('README.md', 'changed\n');
  assert.deepEqual(await createBranch(root, { name: ' feature/new ' }), { branch: 'feature/new' });
  const state = await status(root);
  assert.deepEqual([state.branch, state.changes.map(file => file.path)], ['feature/new', ['README.md']]);
  await assert.rejects(createBranch(root, { name: 'main' }), { code: 'branch_exists' });
  await assert.rejects(createBranch(root, { name: 'feature/new' }), { code: 'branch_exists' });
  for (const name of ['', ' ', 'a b', '-x', 'a..b', '@{-1}', 'x.lock', 'a~1', 'x'.repeat(201), 7, undefined]) {
    await assert.rejects(createBranch(root, { name }), { code: 'bad_branch' }, String(name));
  }
  assert.equal((await status(root)).branch, 'feature/new');
});
