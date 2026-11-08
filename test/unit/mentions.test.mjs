import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FileIndex, findRipgrep, foldersAbove, isPathLike, mentionFinder, pathMentions, projectPaths } from '../../src/mentions.mjs';

function folder(t, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-mentions-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const git = (dir, ...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);

test('what starts like a path is one, and nothing else is', () => {
  for (const typed of ['./', '../', '~/', '/', '~', '.', '..', './a', '../a', '~/a', '/a']) assert.equal(isPathLike(typed), true, typed);
  for (const typed of ['', 'a', '.a', '~a', '...', 'src/', 'a/../b']) assert.equal(isPathLike(typed), false, typed);
});

test('a path lists the folder it points into: folders first, hidden ones left out, written as it was typed', t => {
  const dir = folder(t, { 'app/src/main.swift': '', 'app/README.md': '', 'app/.hidden': '', 'helper/x.mjs': '', 'Notes.md': '', 'b.txt': '', '.env': '' });
  const cwd = path.join(dir, 'app');
  assert.deepEqual(pathMentions('../', cwd), [
    { path: '../app/', kind: 'dir' }, { path: '../helper/', kind: 'dir' }, { path: '../b.txt', kind: 'file' }, { path: '../Notes.md', kind: 'file' },
  ]);
  assert.deepEqual(pathMentions('../HE', cwd).map(m => m.path), ['../helper/']);
  assert.deepEqual(pathMentions('../helper/', cwd).map(m => m.path), ['../helper/x.mjs']);
  assert.deepEqual(pathMentions('./', cwd).map(m => m.path), ['src/', 'README.md']);
  assert.deepEqual(pathMentions('./src/m', cwd).map(m => m.path), ['src/main.swift']);
  assert.deepEqual(pathMentions(`${dir}/hel`, cwd).map(m => m.path), [`${dir}/helper/`]);
  assert.deepEqual(pathMentions('../nothing', cwd), []);
  assert.deepEqual(pathMentions('.', cwd), []);
});

test('a folder offers ten of its entries at most', t => {
  const dir = folder(t, Object.fromEntries(Array.from({ length: 12 }, (_, n) => [`f${String(n).padStart(2, '0')}.txt`, ''])));
  assert.equal(pathMentions('./', dir).length, 10);
  assert.equal(pathMentions('./', dir, 3).length, 3);
});

test('the best matches come first, scored by letters together and at the start of a name or word', () => {
  const index = new FileIndex(['src/', 'test/', 'test/unit/', 'docs/', 'src/terminal.mjs', 'src/status.mjs', 'src/StatusLine.swift',
    'test/unit/terminal.test.mjs', 'README.md', 'docs/term-sheet.md', 'stem.txt']);
  assert.deepEqual(index.search('term', 15), ['src/terminal.mjs', 'docs/term-sheet.md', 'test/unit/terminal.test.mjs']);
  assert.deepEqual(index.search('st', 15), ['stem.txt', 'src/status.mjs', 'src/StatusLine.swift', 'src/terminal.mjs', 'test/', 'test/unit/',
    'docs/term-sheet.md', 'test/unit/terminal.test.mjs']);
  assert.deepEqual(index.search('tt', 15), ['test/', 'test/unit/', 'stem.txt', 'test/unit/terminal.test.mjs', 'src/status.mjs', 'docs/term-sheet.md',
    'src/StatusLine.swift']);
  assert.deepEqual(index.search('src/s', 15), ['src/status.mjs', 'src/StatusLine.swift', 'src/terminal.mjs']);
  assert.deepEqual(index.search('rdme', 15), ['README.md']);
  assert.deepEqual(index.search('zzz', 15), []);
});

test('a capital letter makes the match mind case, and fewer asked for can come in another order among equals', () => {
  const few = new FileIndex(['src/terminal.mjs', 'docs/term-sheet.md', 'test/unit/terminal.test.mjs', 'src/StatusLine.swift', 'src/status.mjs']);
  assert.deepEqual(few.search('SL', 15), ['src/StatusLine.swift']);
  assert.deepEqual(few.search('ts', 2), ['docs/term-sheet.md', 'test/unit/terminal.test.mjs']);
  const more = new FileIndex(['src/', 'test/', 'test/unit/', 'docs/', 'src/terminal.mjs', 'src/status.mjs', 'src/StatusLine.swift',
    'test/unit/terminal.test.mjs', 'README.md', 'docs/term-sheet.md', 'stem.txt']);
  assert.deepEqual(more.search('term', 2), ['docs/term-sheet.md', 'src/terminal.mjs']);
});

test('the folders above paths come once each, ending in a slash', () => {
  assert.deepEqual(foldersAbove(['a/b/c.txt', 'a/d.txt', '../x/y.txt', 'top.txt']), ['a/b/', 'a/', '../x/', '../']);
});

test('in a repository, every file git has from the session\'s folder, then new ones, each with the folders above them', async t => {
  const dir = folder(t, { '.gitignore': 'secret/\n', 'app/src/main.swift': '', 'app/README.md': '', 'helper/x.mjs': '', 'secret/key': '' });
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'one');
  const settings = { respectGitignore: true, ripgrep: undefined };
  assert.deepEqual(await projectPaths(dir, settings), ['app/', 'app/src/', 'helper/', '.gitignore', 'app/README.md', 'app/src/main.swift', 'helper/x.mjs']);
  assert.deepEqual(await projectPaths(path.join(dir, 'app'), settings),
    ['../', 'src/', '../helper/', '../.gitignore', 'README.md', 'src/main.swift', '../helper/x.mjs']);
  fs.mkdirSync(path.join(dir, 'new'));
  fs.writeFileSync(path.join(dir, 'new/notes.md'), '');
  assert.deepEqual(await projectPaths(dir, settings),
    ['.gitignore', 'app/README.md', 'app/src/main.swift', 'helper/x.mjs', 'app/', 'app/src/', 'helper/', 'new/notes.md', 'new/']);
  assert.ok((await projectPaths(dir, { ...settings, respectGitignore: false })).includes('secret/key'));
});

test('outside a repository, what ripgrep finds, hidden files too', { skip: !findRipgrep() && 'no ripgrep' }, async t => {
  const dir = folder(t, { 'a/b.txt': '', '.env': '', 'c.md': '' });
  const found = await projectPaths(dir, { respectGitignore: true, ripgrep: findRipgrep() });
  assert.deepEqual(found.slice(0, 1), ['a/']);
  assert.deepEqual(found.slice(1).sort(), ['.env', 'a/b.txt', 'c.md']);
});

test('with nothing typed, the session\'s own folder; a path first, then the project\'s files', async t => {
  const dir = folder(t, { 'src/app.ts': '', 'README.md': '' });
  const find = mentionFinder({ list: async () => ['src/', 'src/app.ts', 'README.md', '../other/x.ts'], gitIndex: () => null });
  assert.deepEqual((await find(dir, '')).map(m => m.path).sort(), ['README.md', 'src/']);
  assert.deepEqual(await find(dir, './'), [{ path: 'src/', kind: 'dir' }, { path: 'README.md', kind: 'file' }]);
  assert.deepEqual((await find(dir, '.')).map(m => m.path).sort(), ['README.md', 'src/']);
  assert.deepEqual(await find(dir, 'app'), [{ path: 'src/app.ts', kind: 'file' }]);
  assert.deepEqual(await find(dir, './app'), [{ path: 'src/app.ts', kind: 'file' }]);
  assert.deepEqual((await find(dir, '../')).length > 0, true);
  assert.deepEqual(await find(dir, '..'), [{ path: '../other/x.ts', kind: 'file' }]);
  assert.equal((await find(dir, 'a', 1)).length, 1);
});

test('a project is looked through again after five seconds, or when git\'s index changes; a slow one outside git is not', async () => {
  let lists = 0;
  let clock = 0;
  let indexTime = 1;
  const settle = () => new Promise(resolve => { setImmediate(resolve); });
  const find = mentionFinder({ list: async () => { lists += 1; clock += 10; return ['a.txt']; }, now: () => clock, gitIndex: () => indexTime });
  await find('/x', 'a');
  await find('/x', 'a');
  assert.equal(lists, 1);
  clock += 5000;
  await find('/x', 'a');
  await settle();
  assert.equal(lists, 2);
  indexTime = 2;
  await find('/x', 'a');
  await settle();
  assert.equal(lists, 3);

  let slow = 0;
  let time = 0;
  const outside = mentionFinder({ list: async () => { slow += 1; time += 2000; return ['a.txt']; }, now: () => time, gitIndex: () => null });
  await outside('/y', 'a');
  time += 60_000;
  await outside('/y', 'a');
  await settle();
  assert.equal(slow, 1);
});
