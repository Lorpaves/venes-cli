// Windows' Recycle Bin, written to as Windows itself keeps it. The call Windows has for this only puts a
// file in the bin for a program in the session of someone signed in at the screen: for any other, as the
// helper is when an SSH session started it, the same call deletes the file for good and says nothing.
// So the file is moved by hand to where the bin is on its drive, `<drive>\$Recycle.Bin\<the account's
// SID>`, as `$R` and six letters, beside a note of the same letters after `$I` that says where it was,
// how big, and when it went. Explorer shows what's there and puts it back. What can't be moved there
// stays where it is.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HelperError } from './errors.mjs';

// The note's layout since Windows 10: 2, the size, the time as Windows counts it, then the path's
// length in letters with the one that ends it, and the path.
const NOTE_VERSION = 2n;
// Between Windows' first day, in 1601, and 1970, in milliseconds. Windows counts in tenths of a microsecond.
const TO_WINDOWS_MS = 11_644_473_600_000n;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

export function recycleNote(original, size, when) {
  const text = Buffer.from(`${original}\0`, 'utf16le');
  const head = Buffer.alloc(28);
  head.writeBigInt64LE(NOTE_VERSION, 0);
  head.writeBigInt64LE(BigInt(size), 8);
  head.writeBigInt64LE((BigInt(when) + TO_WINDOWS_MS) * 10_000n, 16);
  head.writeInt32LE(original.length + 1, 24);
  return Buffer.concat([head, text]);
}

let known;
// This account's SID, which names its part of each drive's bin.
function accountSid() {
  try {
    known ??= execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).match(/S-1-[0-9-]+/)?.[0];
  } catch (error) {
    // Not said: nothing is moved without it.
    console.error(`recycle bin: whoami: ${String(error.message).split('\n')[0]}`);
  }
  return known;
}

const sixLetters = () => Array.from(randomBytes(6), byte => LETTERS[byte % LETTERS.length]).join('');
const noBin = why => new HelperError('no_trash', why);

// Moves what's at `target` to the Recycle Bin of the drive it's on. The note goes first, under a name
// nothing has, and comes out again if the move doesn't happen.
export function moveToRecycleBin(target, { sid = accountSid(), now = Date.now(), name = sixLetters(), win = path.win32 } = {}) {
  const whole = win.resolve(target);
  if (!sid) throw noBin('Windows didn\'t say whose Recycle Bin to use, so nothing was deleted.');
  const bin = win.join(win.parse(whole).root, '$Recycle.Bin', sid);
  if (!fs.existsSync(bin)) throw noBin(`${win.parse(whole).root} has no Recycle Bin for this account, so nothing was deleted.`);
  const about = fs.lstatSync(whole);
  // A folder keeps no ending, as Windows has it.
  const ending = about.isDirectory() ? '' : win.extname(whole);
  const note = win.join(bin, `$I${name}${ending}`);
  fs.writeFileSync(note, recycleNote(whole, about.isDirectory() ? 0 : about.size, now), { flag: 'wx' });
  try {
    fs.renameSync(whole, win.join(bin, `$R${name}${ending}`));
  } catch (error) {
    fs.rmSync(note, { force: true });
    throw noBin(`Windows didn't let it be moved to the Recycle Bin (${error.code ?? error.message}), so nothing was deleted.`);
  }
}
