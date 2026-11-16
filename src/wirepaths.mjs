// How a path is said to a client from Windows: as a Mac's or a Linux system's would be. The app takes a
// path apart at its slashes, tells a whole one by the slash it starts with, and writes one under the
// home folder with a ~, and it reaches a Windows computer with no change to it. So `C:\Users\ada\work`
// goes out as `/C:/Users/ada/work` and comes back as it was, and `/` is where the drives are.
import fs from 'node:fs';
import path from 'node:path';

// The top of everything, as a client means it.
export const WIRE_ROOT = '/';
// The fields that hold a path, in what's sent and in what's asked.
const PATH_KEYS = new Set(['cwd', 'path', 'home', 'root']);
// What a session said or was told, where a path is part of what was said and stays as it was written.
const AS_IS = new Set(['input', 'output', 'content', 'text', 'answers', 'data']);
const DRIVE = /^[A-Za-z]:(?:[\\/]|$)/;

// A path of this computer's, as it's said to a client. One that starts at a drive gets the slash a
// whole path starts with, and one that doesn't only has its separators turned.
export function wirePath(native) {
  if (typeof native !== 'string' || native === '') return native;
  const slashed = native.replace(/\\/g, '/');
  return DRIVE.test(native) ? `/${slashed.replace(/\/+$/, '')}` : slashed;
}

// A path a client said, as this computer writes it. Only one said as above is turned back: anything
// else is this computer's own way already, or is under a folder, where either separator does.
export function nativePath(wire) {
  if (typeof wire !== 'string') return wire;
  const found = wire.match(/^\/([A-Za-z]:)(\/.*)?$/);
  return found ? path.win32.normalize(`${found[1]}${found[2] ?? '\\'}`) : wire;
}

const isPlain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

function turned(value, turn) {
  if (Array.isArray(value)) return value.map(each => turned(each, turn));
  if (!isPlain(value)) return value;
  const out = {};
  for (const [key, each] of Object.entries(value)) {
    out[key] = AS_IS.has(key) ? each : PATH_KEYS.has(key) && typeof each === 'string' ? turn(each) : turned(each, turn);
  }
  return out;
}

// A whole message, on its way out to a client and on its way in from one.
export const toWire = message => turned(message, wirePath);
export const fromWire = message => turned(message, nativePath);

// The drives this computer has, as the folders at the top.
export function windowsDrives(isThere = drive => fs.existsSync(drive)) {
  const letters = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));
  return letters.map(letter => `${letter}:\\`).filter(isThere).map(drive => ({ name: drive.slice(0, 2), path: drive }));
}
