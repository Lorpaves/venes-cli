import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CHUNK_BYTES, checkedName, createEntry, insideFolder, isText, listFolder, mediaTypeOf, moveToTrash, readChunk, readFile, trashEntry, writeFile } from '../../src/files.mjs';
import { createFile, createFolder } from '../../src/folders.mjs';

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
  const changed = file => Math.floor(fs.statSync(path.join(root, file)).mtimeMs);
  assert.deepEqual(readFile(root, 'src/app.js'),
    { path: path.join(root, 'src/app.js'), name: 'app.js', size: 15, modifiedAt: changed('src/app.js'), text: 'const 名 = 1;\n' });
  write('long.txt', 'one\ntwo\nthree\nfour\n');
  assert.deepEqual(readFile(root, 'long.txt', { textLimit: 10 }),
    { path: path.join(root, 'long.txt'), name: 'long.txt', size: 19, modifiedAt: changed('long.txt'), text: 'one\ntwo\n', truncated: true });
  write('empty.txt', '');
  assert.equal(readFile(root, 'empty.txt').text, '');
});

test('anything else comes as its bytes, for what shows it, unless it\'s too big', t => {
  const { root, write } = folder(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  write('logo.png', bytes);
  const modifiedAt = Math.floor(fs.statSync(path.join(root, 'logo.png')).mtimeMs);
  assert.deepEqual(readFile(root, 'logo.png'),
    { path: path.join(root, 'logo.png'), name: 'logo.png', size: 8, modifiedAt, mediaType: 'image/png', data: bytes.toString('base64') });
  assert.deepEqual(readFile(root, 'logo.png', { binaryLimit: 4 }),
    { path: path.join(root, 'logo.png'), name: 'logo.png', size: 8, modifiedAt, mediaType: 'image/png', tooLarge: true });
});

test('a file that isn\'t there, a folder, or one outside is refused', t => {
  const { root, write } = folder(t);
  write('src/app.js', 'x');
  assert.throws(() => readFile(root, 'gone.txt'), error => error.code === 'no_file');
  assert.throws(() => readFile(root, 'src'), error => error.code === 'no_file');
  assert.throws(() => readFile(root, '../x'), error => error.code === 'bad_path');
});

test('a file of any size and any kind goes a piece at a time, each saying how big the file is and when it changed', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-chunks-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.alloc(CHUNK_BYTES * 2 + 5);
  for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 7) % 256;
  fs.writeFileSync(path.join(root, 'big.bin'), bytes);
  const modifiedAt = Math.floor(fs.statSync(path.join(root, 'big.bin')).mtimeMs);

  const whole = [];
  for (let offset = 0; ; ) {
    const piece = readChunk(root, 'big.bin', { offset });
    assert.deepEqual([piece.name, piece.size, piece.modifiedAt, piece.offset, piece.mediaType], ['big.bin', bytes.length, modifiedAt, offset, 'application/octet-stream']);
    const data = Buffer.from(piece.data, 'base64');
    whole.push(data);
    offset += data.length;
    if (offset >= piece.size) break;
    assert.equal(data.length, CHUNK_BYTES);
  }
  assert.deepEqual(whole.map(data => data.length), [CHUNK_BYTES, CHUNK_BYTES, 5]);
  assert.ok(Buffer.concat(whole).equals(bytes));

  // A shorter piece when that's asked for, never a longer one than the helper sends, and nothing at the end.
  assert.ok(Buffer.from(readChunk(root, 'big.bin', { offset: 3, length: 4 }).data, 'base64').equals(bytes.subarray(3, 7)));
  assert.equal(Buffer.from(readChunk(root, 'big.bin', { offset: 1, length: CHUNK_BYTES * 9 }).data, 'base64').length, CHUNK_BYTES);
  assert.equal(readChunk(root, 'big.bin', { offset: bytes.length }).data, '');
  // Text is bytes like any other, and an empty file is one empty piece.
  fs.writeFileSync(path.join(root, 'words.txt'), 'héllo\n');
  fs.writeFileSync(path.join(root, 'empty'), '');
  assert.equal(Buffer.from(readChunk(root, 'words.txt').data, 'base64').toString(), 'héllo\n');
  assert.deepEqual([readChunk(root, 'empty').size, readChunk(root, 'empty').data], [0, '']);

  for (const range of [{ offset: -1 }, { offset: 1.5 }, { offset: '0' }, { length: 0 }, { length: -3 }, { offset: bytes.length + 1 }]) {
    assert.throws(() => readChunk(root, 'big.bin', range), error => error.code === 'bad_range', JSON.stringify(range));
  }
  assert.throws(() => readChunk(root, '../outside'), error => error.code === 'bad_path');
  assert.throws(() => readChunk(root, 'gone.bin'), error => error.code === 'no_file');
  assert.throws(() => readChunk(root, '.'), error => error.code === 'no_file');
});

test('a name for something new is one name, and not a path', () => {
  assert.equal(checkedName('notes.md'), 'notes.md');
  assert.equal(checkedName('  新建文件夹  '), '新建文件夹');
  assert.equal(checkedName('.gitignore'), '.gitignore');
  for (const bad of ['', '   ', '.', '..', 'a/b', '/a', 'a:b', 'a\0b', 'x'.repeat(256), undefined, 7, null]) {
    assert.throws(() => checkedName(bad), { code: 'bad_name' }, String(bad).slice(0, 12));
  }
  // The limit is the disk's, in bytes.
  assert.equal(checkedName('x'.repeat(255)).length, 255);
  assert.throws(() => checkedName('字'.repeat(86)), { code: 'bad_name' });
});

test('a new file or folder is made empty in a folder of the session\'s, under a name that isn\'t taken', t => {
  const { root, write } = folder(t);
  write('src/a.js', 'a');
  assert.deepEqual(createEntry(root, undefined, { name: 'notes.md' }), { name: 'notes.md', path: path.join(root, 'notes.md'), kind: 'file', size: 0 });
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '');
  assert.deepEqual(createEntry(root, 'src', { name: 'lib', folder: true }), { name: 'lib', path: path.join(root, 'src/lib'), kind: 'dir' });
  assert.ok(fs.statSync(path.join(root, 'src/lib')).isDirectory());
  // What's there stays as it is, a file or a folder, whichever was asked for.
  for (const taken of [{ name: 'notes.md' }, { name: 'notes.md', folder: true }, { name: 'src' }]) {
    assert.throws(() => createEntry(root, undefined, taken), { code: 'name_taken' });
  }
  assert.equal(fs.readFileSync(path.join(root, 'src/a.js'), 'utf8'), 'a');
  assert.throws(() => createEntry(root, undefined, { name: 'a/b' }), { code: 'bad_name' });
  // In a folder that isn't there, or in a file, nothing is made.
  assert.throws(() => createEntry(root, 'gone', { name: 'x' }), { code: 'no_folder' });
  assert.throws(() => createEntry(root, 'src/a.js', { name: 'x' }), { code: 'no_folder' });
});

test('nothing is made outside the session\'s folder, by a path or through a link', t => {
  const { root } = folder(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => createEntry(root, '..', { name: 'x' }), { code: 'bad_path' });
  assert.throws(() => createEntry(root, outside, { name: 'x' }), { code: 'bad_path' });
  fs.symlinkSync(outside, path.join(root, 'out'));
  assert.throws(() => createEntry(root, 'out', { name: 'x', folder: true }), { code: 'bad_path' });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a new folder for a session to start in is made in the folder the reader is looking at', t => {
  const { root } = folder(t);
  assert.deepEqual(createFolder(root, 'project'), { name: 'project', path: path.join(root, 'project') });
  assert.ok(fs.statSync(path.join(root, 'project')).isDirectory());
  assert.throws(() => createFolder(root, 'project'), { code: 'name_taken' });
  assert.throws(() => createFolder(root, '../up'), { code: 'bad_name' });
  assert.throws(() => createFolder(path.join(root, 'gone'), 'x'), { code: 'no_folder' });
  assert.throws(() => createFolder('relative', 'x'), { code: 'bad_folder' });
});

test('an empty file is made in the folder the reader is looking at, for a session that starts there', t => {
  const { root } = folder(t);
  assert.deepEqual(createFile(root, ' notes.md '), { name: 'notes.md', path: path.join(root, 'notes.md'), kind: 'file', size: 0 });
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '');
  assert.throws(() => createFile(root, 'notes.md'), { code: 'name_taken' });
  assert.throws(() => createFile(root, 'a/b'), { code: 'bad_name' });
  assert.throws(() => createFile(path.join(root, 'gone'), 'x'), { code: 'no_folder' });
  assert.throws(() => createFile('relative', 'x'), { code: 'bad_folder' });
});

// What stands in for the Trash: it takes what it's given away, and keeps where it was.
function bin() {
  const taken = [];
  return { taken, trash: async target => { taken.push(target); fs.rmSync(target, { recursive: true }); } };
}

test('a file or a folder of the session\'s goes to the Trash, by where it really is', async t => {
  const { root, write } = folder(t);
  write('a.txt', 'a');
  write('src/deep/b.js', 'b');
  const { taken, trash } = bin();
  assert.deepEqual(await trashEntry(root, 'a.txt', { trash }), { name: 'a.txt', path: path.join(root, 'a.txt') });
  assert.deepEqual(await trashEntry(root, path.join(root, 'src/deep'), { trash }), { name: 'deep', path: path.join(root, 'src/deep') });
  assert.deepEqual(taken, [path.join(root, 'a.txt'), path.join(root, 'src/deep')]);
  assert.deepEqual(fs.readdirSync(root), ['src']);
  await assert.rejects(trashEntry(root, 'a.txt', { trash }), { code: 'no_file' });
  await assert.rejects(trashEntry(root, 'gone/x', { trash }), { code: 'no_file' });
  assert.equal(taken.length, 2);
});

test('a link goes to the Trash as the link it is, and what it leads to stays', async t => {
  const { root, write } = folder(t);
  write('kept/target.txt', 'kept');
  fs.symlinkSync(path.join(root, 'kept'), path.join(root, 'way'));
  fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, 'dangling'));
  const { taken, trash } = bin();
  await trashEntry(root, 'way', { trash });
  await trashEntry(root, 'dangling', { trash });
  assert.deepEqual(taken, [path.join(root, 'way'), path.join(root, 'dangling')]);
  assert.equal(fs.readFileSync(path.join(root, 'kept/target.txt'), 'utf8'), 'kept');
});

test('the session\'s own folder, what a list leaves out, and anything outside stay where they are', async t => {
  const { root, write } = folder(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'theirs.txt'), 'theirs');
  write('.git/HEAD', 'ref');
  write('src/.git/HEAD', 'ref');
  write('.DS_Store', '');
  fs.symlinkSync(outside, path.join(root, 'out'));
  const { taken, trash } = bin();
  for (const named of [undefined, '', 7, '.', root, `${root}/`, 'src/..', '..', '../other', outside, path.join(outside, 'theirs.txt'), 'out/theirs.txt',
    '.git', '.GIT', 'src/.git', '.DS_Store']) {
    await assert.rejects(trashEntry(root, named, { trash }), { code: 'bad_path' }, String(named));
  }
  assert.deepEqual(taken, []);
  assert.equal(fs.readFileSync(path.join(outside, 'theirs.txt'), 'utf8'), 'theirs');
  // The link itself is the session's, and goes without what it leads to.
  await trashEntry(root, 'out', { trash });
  assert.deepEqual([taken, fs.existsSync(path.join(outside, 'theirs.txt'))], [[path.join(root, 'out')], true]);
});

test('something the Trash wouldn\'t take is said, and stays', async t => {
  const { root, write } = folder(t);
  write('a.txt', 'a');
  await assert.rejects(trashEntry(root, 'a.txt', { trash: async () => { throw new Error('exit 5'); } }), { code: 'trash_failed' });
  await assert.rejects(trashEntry(root, 'a.txt', { trash: async () => {} }), { code: 'trash_failed' });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a');
});

test('a test run\'s own folder takes what\'s moved in the Trash\'s place, and a Mac with no trash command says so', async t => {
  const { root, write } = folder(t);
  const instead = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-trash-')));
  t.after(() => fs.rmSync(instead, { recursive: true, force: true }));
  write('a.txt', 'a');
  write('dir/b.txt', 'b');
  await moveToTrash(path.join(root, 'a.txt'), { instead });
  await moveToTrash(path.join(root, 'dir'), { instead });
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(fs.readdirSync(instead).map(name => name.replace(/^\d+-/, '')).sort(), ['a.txt', 'dir']);
  write('c.txt', 'c');
  await assert.rejects(moveToTrash(path.join(root, 'c.txt'), { command: path.join(root, 'no-such-command'), instead: undefined }), { code: 'no_trash' });
  assert.equal(fs.existsSync(path.join(root, 'c.txt')), true);
});

test('a text file takes the text it was edited to, when it\'s still the file that was read', t => {
  const { root, write } = folder(t);
  write('notes.md', 'one\n');
  fs.chmodSync(path.join(root, 'notes.md'), 0o640);
  const read = readFile(root, 'notes.md');
  const was = { size: read.size, modifiedAt: read.modifiedAt };
  const written = writeFile(root, 'notes.md', { text: 'one\n二\r\n', was });
  assert.deepEqual(written, { path: path.join(root, 'notes.md'), name: 'notes.md', size: 9, modifiedAt: Math.floor(fs.statSync(path.join(root, 'notes.md')).mtimeMs) });
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), 'one\n二\r\n');
  assert.equal(fs.statSync(path.join(root, 'notes.md')).mode & 0o777, 0o640, 'it stays the file it was');
  // What it says of the file now is what the next write goes by, and an empty file can be given text.
  writeFile(root, 'notes.md', { text: '', was: { size: written.size, modifiedAt: written.modifiedAt } });
  assert.equal(fs.readFileSync(path.join(root, 'notes.md'), 'utf8'), '');
});

test('a file that has changed since it was read is left as it is, unless it\'s to be written over', t => {
  const { root, write } = folder(t);
  write('a.txt', 'read\n');
  const read = readFile(root, 'a.txt');
  const was = { size: read.size, modifiedAt: read.modifiedAt };
  write('a.txt', 'theirs, and longer\n');
  for (const stale of [was, undefined, {}, { size: 19 }, { size: '19', modifiedAt: 'now' }]) {
    assert.throws(() => writeFile(root, 'a.txt', { text: 'mine\n', was: stale }), { code: 'file_changed' });
  }
  // The same size at another time is another file too.
  write('b.txt', 'aaaa\n');
  const before = readFile(root, 'b.txt');
  fs.utimesSync(path.join(root, 'b.txt'), new Date(), new Date(before.modifiedAt + 5000));
  assert.throws(() => writeFile(root, 'b.txt', { text: 'mine\n', was: { size: before.size, modifiedAt: before.modifiedAt } }), { code: 'file_changed' });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'theirs, and longer\n');
  writeFile(root, 'a.txt', { text: 'mine\n', was, overwrite: true });
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'mine\n');
});

test('only a text file that\'s there, inside the session\'s folder, is written, and no more than fits', t => {
  const { root, write } = folder(t);
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'theirs.txt'), 'theirs');
  write('a.txt', 'a');
  write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  write('.git/config', '[core]');
  write('src/x.js', 'x');
  fs.symlinkSync(path.join(outside, 'theirs.txt'), path.join(root, 'out.txt'));
  fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'same.txt'));
  const anyway = { text: 'mine', overwrite: true };
  for (const named of [undefined, '', '..', '../x', path.join(outside, 'theirs.txt'), 'out.txt', '.git/config', '.GIT/config']) {
    assert.throws(() => writeFile(root, named, anyway), { code: 'bad_path' }, String(named));
  }
  for (const named of ['gone.txt', 'src', 'src/gone/x.js']) assert.throws(() => writeFile(root, named, anyway), { code: 'no_file' }, named);
  assert.throws(() => writeFile(root, 'logo.png', anyway), { code: 'not_text' });
  assert.throws(() => writeFile(root, 'a.txt', { text: 7, overwrite: true }), { code: 'bad_text' });
  assert.throws(() => writeFile(root, 'a.txt', { text: 'abcdef', overwrite: true, limit: 5 }), { code: 'too_big' });
  assert.deepEqual([fs.readFileSync(path.join(outside, 'theirs.txt'), 'utf8'), fs.readFileSync(path.join(root, '.git/config'), 'utf8'), fs.readFileSync(path.join(root, 'a.txt'), 'utf8')],
    ['theirs', '[core]', 'a']);
  // A link to a file of the session's own is that file.
  writeFile(root, 'same.txt', anyway);
  assert.deepEqual([fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), fs.lstatSync(path.join(root, 'same.txt')).isSymbolicLink()], ['mine', true]);
});

