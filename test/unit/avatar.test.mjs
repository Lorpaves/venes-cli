import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { avatarSource, jpegFrom, picturePathFrom, readAvatar } from '../../src/avatar.mjs';

const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const dscl = bytes => `JPEGPhoto:\n ${bytes.toString('hex').match(/.{1,8}/g).join(' ')}\n`;

test('the picture comes out of dscl\'s hex words', () => {
  assert.deepEqual(jpegFrom(dscl(JPEG)), JPEG);
});

test('anything that isn\'t a JPEG in hex is no picture', () => {
  for (const output of ['', 'JPEGPhoto:', 'No such key: JPEGPhoto', 'JPEGPhoto:\n 89504e47', 'JPEGPhoto:\n ffd8f', 'JPEGPhoto:\n ffd8zz00']) {
    assert.equal(jpegFrom(output), undefined, output);
  }
});

test('where the picture came from is read whether it\'s on the line or under it', () => {
  assert.equal(picturePathFrom('Picture:\n /Library/User Pictures/Animals/Eagle.heic\n'), '/Library/User Pictures/Animals/Eagle.heic');
  assert.equal(picturePathFrom('Picture: /a.tif'), '/a.tif');
  assert.equal(picturePathFrom('No such key: Picture'), undefined);
});

// A pretend dscl and sips. sips copies its input, so the test can see which one it was given.
function fakeRun(answers, calls = []) {
  return async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'sips') {
      if (answers.sips === 'fail') throw new Error('sips failed');
      fs.copyFileSync(args.at(-3), args.at(-1));
      return { stdout: '' };
    }
    const answer = answers[args.at(-1)];
    if (answer === undefined) throw new Error('No such key');
    return { stdout: answer };
  };
}

test('the account\'s own copy is made small and handed over as a JPEG', async () => {
  const calls = [];
  const picture = await readAvatar({ user: 'me', run: fakeRun({ JPEGPhoto: dscl(JPEG) }, calls) });
  assert.deepEqual(picture, { mediaType: 'image/jpeg', data: JPEG.toString('base64') });
  assert.deepEqual(calls[0], ['dscl', '.', '-read', '/Users/me', 'JPEGPhoto']);
  assert.deepEqual(calls[1].slice(0, 6), ['sips', '-s', 'format', 'jpeg', '-Z', '256']);
});

test('with no copy in the account, the picture it was chosen from will do', async t => {
  const file = `${fs.mkdtempSync('/tmp/venes-avatar-test-')}/Eagle.heic`;
  t.after(() => fs.rmSync(file, { force: true }));
  fs.writeFileSync(file, 'HEIC');
  const calls = [];
  const picture = await readAvatar({ user: 'me', run: fakeRun({ Picture: `Picture:\n ${file}\n` }, calls) });
  assert.equal(Buffer.from(picture.data, 'base64').toString(), 'HEIC');
  assert.equal(calls.find(call => call[0] === 'sips').at(-3), file);
});

test('if it can\'t be made small, the account\'s own copy goes as it is', async () => {
  const picture = await readAvatar({ run: fakeRun({ JPEGPhoto: dscl(JPEG), sips: 'fail' }) });
  assert.equal(picture.data, JPEG.toString('base64'));
});

test('an account with no picture has none to give', async () => {
  assert.equal(await readAvatar({ run: fakeRun({}) }), undefined);
});

test('the picture is read once', async () => {
  let reads = 0;
  const avatar = avatarSource(async () => { reads += 1; return { data: 'x' }; });
  await Promise.all([avatar(), avatar()]);
  await avatar();
  assert.equal(reads, 1);
});

test('a read that fails counts as no picture', async () => {
  const avatar = avatarSource(async () => { throw new Error('no'); });
  assert.equal(await avatar(), undefined);
});
