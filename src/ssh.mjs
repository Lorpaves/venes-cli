// Files from the phone over SSH, straight into Downloads, instead of in the lines of the connection
// it controls sessions on. The phone runs `venes receive`, which hands what it reads to the helper.

import { execFile } from 'node:child_process';
import os from 'node:os';
import { HelperError } from './errors.mjs';
import { allowPhone, authorizedKeysFile, isPortOpen, knownHostKey, localHostName } from './pairing.mjs';
import { MAX_UPLOAD_BYTES, tooLarge } from './uploads.mjs';

const SSH_PORT = 22;
// macOS's own Screen Sharing, a VNC server.
const SCREEN_SHARING_PORT = 5900;
const TAILSCALE_COMMANDS = ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
const TAILSCALE_LIMIT_MS = 3000;
// A phone that stops sending for this long has gone.
const RECEIVE_IDLE_MS = 60_000;
// Far more than a name and a type take.
const MAX_ABOUT_BYTES = 4096;

// This Mac's own address on its tailnet, from `tailscale status --json`, while its Tailscale is on.
// Rex's Tailscale is no use for this: it's a node of Rex's own, and only Rex answers there.
export function tailnetAddressOf(status) {
  if (status?.BackendState !== 'Running') return undefined;
  return status.Self?.TailscaleIPs?.find(ip => !ip.includes(':'));
}

function runJson(command, args) {
  return new Promise(resolve => {
    execFile(command, args, { timeout: TAILSCALE_LIMIT_MS, encoding: 'utf8' }, (error, stdout) => {
      try { resolve(error ? undefined : JSON.parse(stdout)); } catch { resolve(undefined); }
    });
  });
}

export async function tailscaleStatus() {
  for (const command of TAILSCALE_COMMANDS) {
    const status = await runJson(command, ['status', '--json']);
    if (status) return status;
  }
  return undefined;
}

// Where a pairing code over SSH sends the phone: this Mac's address on its tailnet while its
// Tailscale is on, which reaches it from anywhere, or else its name on the local network.
export const pairingHost = (status, localName) => tailnetAddressOf(status) ?? localName;

// Where this Mac's own Screen Sharing is, for a phone to reach straight over the tailnet with no SSH,
// so with Remote Login off too: this Mac's address there while its Tailscale is on, whether Screen
// Sharing answers, and the account it signs in.
export async function screenAccess({ sharingOpen = () => isPortOpen(SCREEN_SHARING_PORT), status = tailscaleStatus } = {}) {
  const [on, current] = await Promise.all([sharingOpen(), status()]);
  return { user: os.userInfo().username, port: SCREEN_SHARING_PORT, on, hosts: [tailnetAddressOf(current)].filter(Boolean) };
}

// Lets the phone's key in, and says where to log in with it: by tailnet first, which works from
// anywhere, then by name on the local network. None while Remote Login is off.
export async function sshAccess(publicKey, {
  keys = authorizedKeysFile(), sshOpen = () => isPortOpen(SSH_PORT), status = tailscaleStatus,
} = {}) {
  allowPhone(keys, publicKey);
  const hosts = (await sshOpen()) ? [tailnetAddressOf(await status()), localHostName()].filter(Boolean) : [];
  return { user: os.userInfo().username, port: SSH_PORT, hostKey: knownHostKey(), hosts };
}

const badUpload = message => new HelperError('bad_upload', message);

// What a phone sends `receive`: a line of JSON with `sessionId`, `name`, `mediaType` and `size`,
// then exactly that many bytes.
export function readUpload(input, { idleMs = RECEIVE_IDLE_MS, maxBytes = MAX_UPLOAD_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let head = Buffer.alloc(0);
    let about;
    const body = [];
    let size = 0;
    let idle;
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      input.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const readAbout = chunk => {
      head = Buffer.concat([head, chunk]);
      const newline = head.indexOf(0x0a);
      if (newline < 0) {
        if (head.length > MAX_ABOUT_BYTES) finish(badUpload('This file came without a name.'));
        return undefined;
      }
      try {
        about = JSON.parse(head.subarray(0, newline).toString('utf8'));
      } catch {
        finish(badUpload('This file came without a name.'));
        return undefined;
      }
      if (!Number.isSafeInteger(about?.size) || about.size <= 0) finish(badUpload('This file is empty.'));
      else if (about.size > maxBytes) finish(tooLarge());
      return head.subarray(newline + 1);
    };
    const onData = chunk => {
      clearTimeout(idle);
      idle = setTimeout(() => finish(badUpload('This file stopped coming.')), idleMs);
      const bytes = about ? chunk : readAbout(chunk);
      if (done || !bytes) return;
      body.push(bytes);
      size += bytes.length;
      if (size >= about.size) {
        const { sessionId, name, mediaType } = about;
        finish(undefined, { sessionId, name, mediaType, bytes: Buffer.concat(body).subarray(0, about.size) });
      }
    };
    const onEnd = () => finish(badUpload('This file came to an end too soon.'));
    const onError = error => finish(error);
    input.on('data', onData);
    input.on('end', onEnd);
    input.on('error', onError);
    idle = setTimeout(() => finish(badUpload('This file stopped coming.')), idleMs);
  });
}
