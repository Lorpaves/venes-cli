import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveToRecycleBin, recycleNote } from '../../src/winbin.mjs';

test('the note beside a recycled file says where it was, how big, and when it went, as Windows writes one', () => {
  const note = recycleNote('C:\\Users\\ada\\a b.txt', 1234, Date.UTC(2026, 10, 16, 8, 0, 0));
  assert.equal(note.readBigInt64LE(0), 2n);
  assert.equal(note.readBigInt64LE(8), 1234n);
  // 16 November 2026, 08:00 UTC, in tenths of a microsecond since 1601.
  assert.equal(note.readBigInt64LE(16), 134_392_896_000_000_000n);
  assert.equal(note.readInt32LE(24), 'C:\\Users\\ada\\a b.txt'.length + 1);
  assert.equal(note.subarray(28).toString('utf16le'), 'C:\\Users\\ada\\a b.txt\0');
  assert.equal(note.length, 28 + 2 * ('C:\\Users\\ada\\a b.txt'.length + 1));
});

// The moves are tried with this system's own paths standing in for Windows', in a folder for the drive.
function drive(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-bin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const win = { ...path, parse: () => ({ root }) };
  const bin = path.join(root, '$Recycle.Bin', 'S-1-5-21-7');
  return { root, win, bin, options: { sid: 'S-1-5-21-7', now: 0, name: 'ABC123', win } };
}

test('a file goes to its drive\'s bin under $R, with its note under $I and its ending kept', t => {
  const { root, bin, options } = drive(t);
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(root, 'work', 'notes.md');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, 'hello');
  moveToRecycleBin(file, options);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(fs.readdirSync(bin).sort(), ['$IABC123.md', '$RABC123.md']);
  assert.equal(fs.readFileSync(path.join(bin, '$RABC123.md'), 'utf8'), 'hello');
  const note = fs.readFileSync(path.join(bin, '$IABC123.md'));
  assert.equal(note.readBigInt64LE(8), 5n);
  assert.equal(note.subarray(28).toString('utf16le'), `${file}\0`);
});

test('a folder goes whole, with no ending', t => {
  const { root, bin, options } = drive(t);
  fs.mkdirSync(bin, { recursive: true });
  const folder = path.join(root, 'old.d');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'in.txt'), 'x');
  moveToRecycleBin(folder, options);
  assert.equal(fs.existsSync(folder), false);
  assert.deepEqual(fs.readdirSync(bin).sort(), ['$IABC123', '$RABC123']);
  assert.equal(fs.readFileSync(path.join(bin, '$RABC123', 'in.txt'), 'utf8'), 'x');
});

test('on a drive with no bin for the account, or with no account to name, nothing is deleted', t => {
  const { root, options } = drive(t);
  const file = path.join(root, 'keep.txt');
  fs.writeFileSync(file, 'x');
  assert.throws(() => moveToRecycleBin(file, options), { code: 'no_trash', message: /has no Recycle Bin for this account, so nothing was deleted/ });
  assert.throws(() => moveToRecycleBin(file, { ...options, sid: '' }), { code: 'no_trash', message: /didn't say whose Recycle Bin/ });
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
});

test('a move that fails takes its note back out, and the file stays', t => {
  const { root, bin, options } = drive(t);
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(root, 'keep.txt');
  fs.writeFileSync(file, 'x');
  // Something is already where the file would go.
  fs.mkdirSync(path.join(bin, '$RABC123.txt'));
  fs.writeFileSync(path.join(bin, '$RABC123.txt', 'in the way'), '');
  assert.throws(() => moveToRecycleBin(file, options), { code: 'no_trash', message: /so nothing was deleted/ });
  assert.equal(fs.readFileSync(file, 'utf8'), 'x');
  assert.deepEqual(fs.readdirSync(bin), ['$RABC123.txt']);
});

test('two things with one name are kept apart by their letters, and a name that\'s taken is refused', t => {
  const { root, bin, options } = drive(t);
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(root, 'a.txt');
  fs.writeFileSync(file, '1');
  moveToRecycleBin(file, options);
  fs.writeFileSync(file, '2');
  assert.throws(() => moveToRecycleBin(file, options), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(file, 'utf8'), '2');
  moveToRecycleBin(file, { ...options, name: 'XYZ789' });
  assert.deepEqual(fs.readdirSync(bin).sort(), ['$IABC123.txt', '$IXYZ789.txt', '$RABC123.txt', '$RXYZ789.txt']);
});
