// The picture this Mac's account shows at login, for a client to put beside the Mac's name.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isMac } from './platform.mjs';

const exec = promisify(execFile);
// Plenty for a small circle at three times its size.
const SIDE = 256;
const OUTPUT_BYTES = 32 * 1024 * 1024;

// `dscl` prints the picture as hex words under its name.
export function jpegFrom(output) {
  const hex = output.replace(/^JPEGPhoto:/, '').replace(/\s+/g, '');
  if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return undefined;
  const bytes = Buffer.from(hex, 'hex');
  return bytes[0] === 0xff && bytes[1] === 0xd8 ? bytes : undefined;
}

// Where the picture came from, when there's no copy of it in the account itself.
export function picturePathFrom(output) {
  const file = output.replace(/^Picture:/, '').trim();
  return path.isAbsolute(file) ? file : undefined;
}

// As large a picture as is sent as it is, where there's nothing to make it smaller with.
const PICTURE_BYTES = 1024 * 1024;

// What a Linux desktop shows for an account: the picture the person put in their home folder, or the
// one the system keeps for them. It's sent as it is, if it's a JPEG or a PNG of a modest size.
export function readLinuxAvatar({ user = os.userInfo().username, home = os.homedir() } = {}) {
  for (const file of [path.join(home, '.face'), path.join(home, '.face.icon'), `/var/lib/AccountsService/icons/${user}`]) {
    try {
      if (fs.statSync(file).size > PICTURE_BYTES) continue;
      const bytes = fs.readFileSync(file);
      if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mediaType: 'image/jpeg', data: bytes.toString('base64') };
      if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mediaType: 'image/png', data: bytes.toString('base64') };
    } catch {
      // Not there, or not to be read: the next place is looked in.
    }
  }
  return undefined;
}

// `run` stands in for execFile in tests. The answer is a JPEG at most SIDE on its long side, or
// undefined if the account has no picture.
export async function readAvatar({ user = os.userInfo().username, run = exec, mac = isMac } = {}) {
  if (!mac) return readLinuxAvatar({ user });
  const read = async attribute => {
    try {
      return (await run('dscl', ['.', '-read', `/Users/${user}`, attribute], { maxBuffer: OUTPUT_BYTES })).stdout;
    } catch {
      return '';
    }
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-avatar-'));
  try {
    const original = path.join(dir, 'original.jpg');
    const jpeg = jpegFrom(await read('JPEGPhoto'));
    const source = jpeg ? (fs.writeFileSync(original, jpeg), original) : picturePathFrom(await read('Picture'));
    if (!source) return undefined;
    const small = path.join(dir, 'small.jpg');
    try {
      await run('sips', ['-s', 'format', 'jpeg', '-Z', String(SIDE), source, '--out', small]);
      return { mediaType: 'image/jpeg', data: fs.readFileSync(small).toString('base64') };
    } catch {
      return jpeg ? { mediaType: 'image/jpeg', data: jpeg.toString('base64') } : undefined;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One read for the helper's life: a picture changes rarely, and a restart picks up a new one.
export function avatarSource(read = readAvatar) {
  let picture;
  return () => {
    picture ??= read().catch(() => undefined);
    return picture;
  };
}
