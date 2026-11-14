import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { insideFolder, isText, listFolder, mediaTypeOf, readFile } from '../../src/files.mjs';

function folder(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-files-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, contents) => {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  };
  return { root, write };
}

const noGit = async () => undefined;

test('a path is the folder itself, or inside it, and never out of it', () => {
  assert.equal(insideFolder('/w/app'), '/w/app');
  assert.equal(insideFolder('/w/app', ''), '/w/app');
  assert.equal(insideFolder('/w/app', 'src/a.js'), '/w/app/src/a.js');
  assert.equal(insideFolder('/w/app', '/w/app/src'), '/w/app/src');
  assert.equal(insideFolder('/w/app', 'src/../README.md'), '/w/app/README.md');
  for (const out of ['..', '../other', '/w/application', '/etc/passwd', 'src/../../x']) {
    assert.throws(() => insideFolder('/w/app', out), error => error.code === 'bad_path', out);
  }
  assert.throws(() => insideFolder('/w/app', 7), error => error.code === 'bad_path');
});

test('a folder lists its folders first, then its files, each by name as Finder sorts them', async t => {
  const { root, write } = folder(t);
  write('src/app.js', 'x');
  write('Docs/readme.txt', 'x');
  write('file10.txt', 'ten');
  write('file2.txt', 'two!');
  write('.gitignore', 'node_modules\n');
  write('.git/HEAD', 'ref');
  write('.DS_Store', 'x');
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link to src'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'broken'));
  const listed = await listFolder(root, undefined, { changes: noGit });
  assert.deepEqual([listed.root, listed.path, listed.name, listed.truncated], [root, root, path.basename(root), false]);
  assert.deepEqual(listed.entries.map(entry => [entry.name, entry.kind, entry.size]), [
    ['Docs', 'dir', undefined], ['link to src', 'dir', undefined], ['src', 'dir', undefined],
    ['.gitignore', 'file', 13], ['file2.txt', 'file', 4], ['file10.txt', 'file', 3],
  ]);
  assert.equal(listed.entries[0].path, path.join(root, 'Docs'));
  const inner = await listFolder(root, 'src', { changes: noGit });
  assert.deepEqual([inner.path, inner.name, inner.entries.map(entry => entry.name)], [path.join(root, 'src'), 'src', ['app.js']]);
});

test('a long folder lists its first entries and says there are more', async t => {
  const { root, write } = folder(t);
  for (const name of ['a', 'b', 'c', 'd']) write(`${name}.txt`, name);
  const listed = await listFolder(root, undefined, { limit: 3, changes: noGit });
  assert.deepEqual([listed.entries.map(entry => entry.name), listed.truncated], [['a.txt', 'b.txt', 'c.txt'], true]);
});

test('a folder that isn\'t there, or is a file, or is outside, is refused', async t => {
  const { root, write } = folder(t);
  write('a.txt', 'x');
  await assert.rejects(listFolder(root, 'gone', { changes: noGit }), error => error.code === 'no_folder');
  await assert.rejects(listFolder(root, 'a.txt', { changes: noGit }), error => error.code === 'no_folder');
  await assert.rejects(listFolder(root, '..', { changes: noGit }), error => error.code === 'bad_path');
});

test('what git says has changed marks a file by its change, and a folder by having one inside', async t => {
  const { root, write } = folder(t);
  write('src/deep/app.js', 'x');
  write('src/other.js', 'x');
  write('README.md', 'x');
  write('docs/guide.md', 'x');
  const changes = async () => ({ root, changed: new Map([['src/deep/app.js', 'modified'], ['README.md', 'untracked']]) });
  const top = await listFolder(root, undefined, { changes });
  assert.deepEqual(top.entries.map(entry => [entry.name, entry.change]), [['docs', undefined], ['src', 'changed'], ['README.md', 'untracked']]);
  const inner = await listFolder(root, 'src', { changes });
  assert.deepEqual(inner.entries.map(entry => [entry.name, entry.change]), [['deep', 'changed'], ['other.js', undefined]]);
  // A repository whose top is above the session's folder names its paths from there.
  const above = async () => ({ root: path.dirname(root), changed: new Map([[`${path.basename(root)}/README.md`, 'modified']]) });
  assert.equal((await listFolder(root, undefined, { changes: above })).entries.find(entry => entry.name === 'README.md').change, 'modified');
  // And a status that can't be read leaves the list unmarked.
  const failing = async () => { throw new Error('git is gone'); };
  assert.ok((await listFolder(root, undefined, { changes: failing })).entries.every(entry => entry.change === undefined));
});

test('text is told from what isn\'t by how a file starts', () => {
  assert.equal(isText(Buffer.from('const a = "名字";\n')), true);
  assert.equal(isText(Buffer.alloc(0)), true);
  assert.equal(isText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), false);
  assert.equal(isText(Buffer.from([0xff, 0xfe, 0x41, 0x42])), false);
  // A read that ends part way through a character is still text.
  assert.equal(isText(Buffer.from('名字').subarray(0, 4)), true);
});

test('a file\'s kind goes by its name', () => {
  assert.equal(mediaTypeOf('/w/a.PNG'), 'image/png');
  assert.equal(mediaTypeOf('/w/report.pdf'), 'application/pdf');
  assert.equal(mediaTypeOf('/w/Makefile'), 'application/octet-stream');
});

test('a text file is read as its text, and a long one up to a line\'s end', t => {
  const { root, write } = folder(t);
  write('src/app.js', 'const 名 = 1;\n');
  assert.deepEqual(readFile(root, 'src/app.js'), { path: path.join(root, 'src/app.js'), name: 'app.js', size: 15, text: 'const 名 = 1;\n' });
  write('long.txt', 'one\ntwo\nthree\nfour\n');
  assert.deepEqual(readFile(root, 'long.txt', { textLimit: 10 }), { path: path.join(root, 'long.txt'), name: 'long.txt', size: 19, text: 'one\ntwo\n', truncated: true });
  write('empty.txt', '');
  assert.equal(readFile(root, 'empty.txt').text, '');
});

test('anything else comes as its bytes, for what shows it, unless it\'s too big', t => {
  const { root, write } = folder(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  write('logo.png', bytes);
  assert.deepEqual(readFile(root, 'logo.png'), { path: path.join(root, 'logo.png'), name: 'logo.png', size: 8, mediaType: 'image/png', data: bytes.toString('base64') });
  assert.deepEqual(readFile(root, 'logo.png', { binaryLimit: 4 }), { path: path.join(root, 'logo.png'), name: 'logo.png', size: 8, mediaType: 'image/png', tooLarge: true });
});

test('a file that isn\'t there, a folder, or one outside is refused', t => {
  const { root, write } = folder(t);
  write('src/app.js', 'x');
  assert.throws(() => readFile(root, 'gone.txt'), error => error.code === 'no_file');
  assert.throws(() => readFile(root, 'src'), error => error.code === 'no_file');
  assert.throws(() => readFile(root, '../x'), error => error.code === 'bad_path');
});
