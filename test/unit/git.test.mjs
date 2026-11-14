import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  branches, changedPaths, commit, diff, hunksOf, log, parseBranches, parseLog, parseNameStatus, parseNumstat, parseStatus, repositoryOf, status,
} from '../../src/git.mjs';

// A repository of the test's own, with nothing of this Mac's git settings in it.
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-git-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z' };
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', '-c', 'commit.gpgsign=false', ...args], { env, encoding: 'utf8' });
  const write = (name, text) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  };
  git('init', '-q', '-b', 'main');
  return { root, git, write };
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
  const printed = 'aaa\x1fa1\x1fFix the thing\x1fAda\x1f1767323045\x1fHEAD -> main, origin/main\x1e\nbbb\x1fb1\x1fStart\x1fGrace\x1f1767323000\x1f\x1e\n';
  assert.deepEqual(parseLog(printed), [
    { hash: 'aaa', short: 'a1', subject: 'Fix the thing', author: 'Ada', at: 1767323045000, refs: ['HEAD -> main', 'origin/main'] },
    { hash: 'bbb', short: 'b1', subject: 'Start', author: 'Grace', at: 1767323000000, refs: [] },
  ]);
  assert.deepEqual(parseLog(''), []);
  assert.deepEqual(parseBranches('main\x1f*\x1forigin/main\x1fahead 2, behind 1\x1f1767323045\x1fFix the thing\nold\x1f \x1f\x1f\x1f1767000000\x1fStart\n'), [
    { name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 1, at: 1767323045000, subject: 'Fix the thing' },
    { name: 'old', current: false, ahead: 0, behind: 0, at: 1767000000000, subject: 'Start' },
  ]);
});

test('a folder that\'s in no repository has none, and one inside a repository has its top', async t => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-nogit-')));
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
  assert.deepEqual(first.commits[0].refs, ['HEAD -> main']);
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
