// The picture this Mac's account shows at login, for a client to put beside the Mac's name.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

// `run` stands in for execFile in tests. The answer is a JPEG at most SIDE on its long side, or
// undefined if the account has no picture.
export async function readAvatar({ user = os.userInfo().username, run = exec } = {}) {
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
