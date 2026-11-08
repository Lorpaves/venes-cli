import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bestMentions, mentionFinder, mentionables } from '../../src/mentions.mjs';

function folder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-mentions-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test('in a repository, the files git knows, new ones too, and the folders above them; ignored ones aren\'t', async t => {
  const dir = folder(t, { '.gitignore': 'secret/\n', 'src/app.ts': '', 'src/view/list.ts': '', 'README.md': '', 'secret/key': '', 'new.txt': '' });
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'add', 'src', 'README.md', '.gitignore']);
  assert.deepEqual((await mentionables(dir)).sort(), ['.gitignore', 'README.md', 'new.txt', 'src/', 'src/app.ts', 'src/view/', 'src/view/list.ts'].sort());
});

test('elsewhere the folder is looked through, leaving out what\'s hidden and what\'s built', async t => {
  const dir = folder(t, { 'notes.md': '', 'a/b.txt': '', 'node_modules/x/index.js': '', '.cache/y': '', 'build/out.o': '' });
  assert.deepEqual((await mentionables(dir)).sort(), ['a/', 'a/b.txt', 'notes.md']);
});

test('the best match comes first: the path starting with it, its name, anywhere in it, then its letters in order', () => {
  const entries = ['src/', 'src/terminal.mjs', 'src/status.mjs', 'test/', 'test/unit/terminal.test.mjs', 'README.md', 'docs/term-sheet.md', 'stem.txt'];
  assert.deepEqual(bestMentions(entries, 'src/st').map(m => m.path), ['src/status.mjs']);
  assert.deepEqual(bestMentions(entries, 'term').map(m => m.path), ['src/terminal.mjs', 'docs/term-sheet.md', 'test/unit/terminal.test.mjs']);
  assert.deepEqual(bestMentions(entries, 'RDME').map(m => m.path), ['README.md']);
  assert.deepEqual(bestMentions(entries, 'zzz'), []);
});

test('with nothing typed, the top of the folder first, then shorter paths; folders are said to be folders; there\'s a limit', () => {
  const entries = ['src/', 'src/app.ts', 'README.md', 'src/view/', 'src/view/list.ts'];
  assert.deepEqual(bestMentions(entries, '', 3), [{ path: 'src/', kind: 'dir' }, { path: 'README.md', kind: 'file' }, { path: 'src/view/', kind: 'dir' }]);
  assert.equal(bestMentions(entries, '', 2).length, 2);
});

test('a folder is listed once while letters are typed, and again a little later', async () => {
  let lists = 0;
  let clock = 0;
  const find = mentionFinder({ list: async () => { lists += 1; return ['a.txt', 'b.txt']; }, now: () => clock, keepMs: 1000 });
  assert.deepEqual((await find('/x', 'a')).map(m => m.path), ['a.txt']);
  await find('/x', 'b');
  assert.equal(lists, 1);
  clock = 2000;
  await find('/x', 'b');
  assert.equal(lists, 2);
});
