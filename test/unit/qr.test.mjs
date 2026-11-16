import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { qrRows, versionFor } from '../../src/qr.mjs';

const digest = rows => createHash('sha256').update(rows.join('\n')).digest('hex').slice(0, 16);

test('a code is as large as its text needs: 17 bytes fit the smallest, and one more takes the next', () => {
  assert.deepEqual([versionFor(1), versionFor(17), versionFor(18), versionFor(32), versionFor(33)], [1, 1, 2, 2, 3]);
  // From version 10 the count of bytes takes two bytes itself.
  assert.deepEqual([versionFor(230), versionFor(231), versionFor(271), versionFor(272)], [9, 10, 10, 11]);
  assert.equal(qrRows('a'.repeat(17)).length, 21 + 2);
  assert.equal(qrRows('a'.repeat(18)).length, 25 + 2);
  assert.deepEqual([versionFor(2953)], [40]);
  assert.throws(() => versionFor(2954), /too long/);
});

test('every row is as long as the code is tall, with a light module around it all', () => {
  for (const text of ['a', 'venes://pair?r=https%3A%2F%2Fmac.tail.ts.net&n=Mac', 'x'.repeat(400)]) {
    const rows = qrRows(text);
    assert.equal(rows.every(row => row.length === rows.length && /^[01]+$/.test(row)), true);
    assert.equal(rows[0] === '0'.repeat(rows.length) && rows.at(-1) === rows[0], true);
    assert.equal(rows.every(row => row[0] === '0' && row.at(-1) === '0'), true);
  }
});

test('the three corners and the lines between them are where a reader looks for them', () => {
  const rows = qrRows('x'.repeat(100)).slice(1, -1).map(row => row.slice(1, -1));
  const size = rows.length;
  const corner = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111'];
  const at = (x, y) => corner.map((_, i) => rows[y + i].slice(x, x + 7));
  assert.deepEqual(at(0, 0), corner);
  assert.deepEqual(at(size - 7, 0), corner);
  assert.deepEqual(at(0, size - 7), corner);
  // The timing line: dark and light by turns between the corners.
  assert.equal(rows[6].slice(8, size - 8), [...Array(size - 16)].map((_, i) => (i % 2 === 0 ? '1' : '0')).join(''));
  // And the module that's always dark.
  assert.equal(rows[size - 8][8], '1');
});

// These were read back, among forty more of every size, by Core Image's own reader on a Mac.
test('the codes for these texts are the ones that were checked by reading them back', () => {
  assert.equal(digest(qrRows('a')), 'f46eb02854c80804');
  assert.equal(digest(qrRows('venes://pair?r=https%3A%2F%2Fmac.tail.ts.net&n=Linux+Box')), 'f6b3078a2b188214');
  assert.equal(digest(qrRows('汉字 and bytes ✓'.repeat(20))), 'c3bb4e911f9593bd');
});

// Core Image's own code for a text, as the helper asks for it on a Mac.
const QR_SCRIPT = `ObjC.import('CoreImage'); ObjC.import('AppKit');
function run(argv) {
  const data = $.NSString.alloc.initWithUTF8String(argv[0]).dataUsingEncoding($.NSUTF8StringEncoding);
  const filter = $.CIFilter.filterWithName('CIQRCodeGenerator');
  filter.setValueForKey(data, 'inputMessage');
  filter.setValueForKey($('L'), 'inputCorrectionLevel');
  const image = $.NSBitmapImageRep.alloc.initWithCIImage(filter.outputImage);
  const rows = [];
  for (let y = 0; y < image.pixelsHigh; y++) {
    let row = '';
    for (let x = 0; x < image.pixelsWide; x++) row += image.colorAtXY(x, y).redComponent < 0.5 ? '1' : '0';
    rows.push(row);
  }
  return rows.join('\\n');
}`;

test('on a Mac, the code drawn here is the one Core Image draws', { skip: process.platform !== 'darwin' }, () => {
  for (const text of ['a', 'venes://pair?r=https%3A%2F%2Fmac.tail.ts.net&n=Mac', 'x'.repeat(300), 'y'.repeat(700)]) {
    const theirs = execFileSync('osascript', ['-l', 'JavaScript', '-e', QR_SCRIPT, text], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(qrRows(text), theirs, `${text.length} bytes`);
  }
});
