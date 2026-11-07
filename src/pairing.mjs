// Pairing a phone without typing a password or a key. `pair` adds a one-time key to
// authorized_keys that can only run `enroll`, and shows it in a QR code. The phone logs in
// with it once, to hand over its own public key, and the one-time key goes.

import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { HelperError } from './errors.mjs';

const PAIRING_COMMENT = 'venes-pairing';
const PHONE_COMMENT = 'venes-phone';
const HOST_KEY_FILE = '/etc/ssh/ssh_host_ed25519_key.pub';
const PHONE_KEY = /^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/;
const ED25519_PREFIX = 'ssh-ed25519';

function sshString(bytes) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function authorizedKeysFile(env = process.env) {
  return env.VENES_AUTHORIZED_KEYS || path.join(os.homedir(), '.ssh', 'authorized_keys');
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.venes`;
  fs.writeFileSync(temporary, lines.map(line => `${line}\n`).join(''), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// A key that signs in and can do nothing but run `command`.
export function makeOneTimeKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  const blob = Buffer.concat([sshString(Buffer.from(ED25519_PREFIX)), sshString(raw)]);
  return { seed, publicKey: `${ED25519_PREFIX} ${blob.toString('base64')}` };
}

export function pairingLine(publicKey, command, nonce) {
  const options = `command="${command}",restrict`;
  return `${options} ${publicKey} ${PAIRING_COMMENT}-${nonce}`;
}

export function addPairingKey(file, publicKey, command, nonce) {
  writeLines(file, [...readLines(file), pairingLine(publicKey, command, nonce)]);
}

export function hasPairingKey(file, nonce) {
  return readLines(file).some(line => line.endsWith(` ${PAIRING_COMMENT}-${nonce}`));
}

export function removePairingKey(file, nonce) {
  const marker = `${PAIRING_COMMENT}-${nonce}`;
  const lines = readLines(file);
  const kept = lines.filter(line => !line.endsWith(` ${marker}`));
  if (kept.length !== lines.length) writeLines(file, kept);
  return kept.length !== lines.length;
}

// Takes the phone's key in exchange for the one-time key, which only works this once.
export function enrollPhone(file, nonce, phoneKey) {
  if (!PHONE_KEY.test(phoneKey)) throw new Error('That is not an Ed25519 public key.');
  if (!removePairingKey(file, nonce)) throw new Error('This pairing has already been used.');
  allowPhone(file, phoneKey);
}

// Lets a phone log in with its own key, once. One that paired through Rex asks for this itself, to
// send files over SSH: whoever reaches the helper can do as much already.
export function allowPhone(file, phoneKey) {
  if (typeof phoneKey !== 'string' || !PHONE_KEY.test(phoneKey)) throw new HelperError('bad_key', 'That is not an Ed25519 public key.');
  const lines = readLines(file);
  if (!lines.some(line => line.startsWith(`${phoneKey} `) || line === phoneKey)) {
    writeLines(file, [...lines, `${phoneKey} ${PHONE_COMMENT}`]);
  }
}

export function makeNonce() {
  return randomBytes(9).toString('base64url');
}

// As `ssh-keygen -l` prints it.
export function hostKeyFingerprint(line) {
  const blob = Buffer.from(line.trim().split(/\s+/)[1], 'base64');
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

export function readHostKeyFingerprint(file = process.env.VENES_HOST_KEY || HOST_KEY_FILE) {
  return hostKeyFingerprint(fs.readFileSync(file, 'utf8'));
}

export function localHostName() {
  try {
    return `${execFileSync('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim()}.local`;
  } catch {
    return os.hostname();
  }
}

// What the phone calls this Mac.
export function macName() {
  return localHostName().replace(/\.local$/, '').replace(/-/g, ' ');
}

// A Mac that has never had Remote Login on has no host key.
export function knownHostKey() {
  try {
    return readHostKeyFingerprint();
  } catch {
    return undefined;
  }
}

export function pairingLink({ host, port = 22, user, hostKey, seed, name }) {
  const query = new URLSearchParams({ h: host, p: String(port), u: user, f: hostKey, k: seed.toString('base64url'), n: name });
  return `venes://pair?${query}`;
}

// The host key isn't checked on this route. It's there so that a Mac the phone knows from SSH stays
// one Mac.
export function rexPairingLink({ address, hostKey, name }) {
  const query = new URLSearchParams({ r: address, n: name });
  if (hostKey) query.set('f', hostKey);
  return `venes://pair?${query}`;
}

export function isPortOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const probe = net.connect(port, host);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

// Core Image draws the code, so nothing has to be bundled for it. It comes back as rows of
// 0s and 1s.
const QR_SCRIPT = `
ObjC.import('CoreImage'); ObjC.import('AppKit');
function run(argv) {
  const data = $.NSString.alloc.initWithUTF8String(argv[0]).dataUsingEncoding($.NSUTF8StringEncoding);
  const filter = $.CIFilter.filterWithName('CIQRCodeGenerator');
  filter.setValueForKey(data, 'inputMessage');
  filter.setValueForKey($('L'), 'inputCorrectionLevel');
  const image = $.NSBitmapImageRep.alloc.initWithCIImage(filter.outputImage);
  const size = image.pixelsWide;
  const rows = [];
  for (let y = 0; y < size; y++) {
    let row = '';
    for (let x = 0; x < size; x++) row += image.colorAtXY(x, y).redComponent < 0.5 ? '1' : '0';
    rows.push(row);
  }
  return rows.join('\\n');
}`;

export function qrModules(text) {
  const output = execFileSync('osascript', ['-l', 'JavaScript', '-e', QR_SCRIPT, text], { encoding: 'utf8' });
  return output.trim().split('\n');
}

// Two rows of modules to a line of text. The colours are fixed, because a code on a dark
// terminal would otherwise come out inverted and many scanners refuse that.
export function renderQR(rows) {
  const width = rows[0].length + 4;
  const blank = '0'.repeat(width);
  const padded = [blank, ...rows.map(row => `00${row}00`), blank];
  if (padded.length % 2) padded.push(blank);
  const lines = [];
  for (let y = 0; y < padded.length; y += 2) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const top = padded[y][x] === '1';
      const bottom = padded[y + 1][x] === '1';
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(`\x1b[30;47m${line}\x1b[0m`);
  }
  return lines.join('\n');
}
