import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { makeOneTimeKey } from '../../src/pairing.mjs';
import { displaysFrom, pairingHost, readUpload, screenAccess, sshAccess, tailnetAddressOf } from '../../src/ssh.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function keysFile(t, lines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'authorized_keys');
  if (lines.length) fs.writeFileSync(file, lines.map(line => `${line}\n`).join(''));
  return file;
}

const running = { BackendState: 'Running', Self: { TailscaleIPs: ['fd7a:115c:a1e0::1', '100.96.228.46'] } };

test('this Mac\'s tailnet address is its IPv4 one, while its Tailscale is on', () => {
  assert.equal(tailnetAddressOf(running), '100.96.228.46');
  assert.equal(tailnetAddressOf({ ...running, BackendState: 'Stopped' }), undefined);
  assert.equal(tailnetAddressOf({ BackendState: 'Running', Self: { TailscaleIPs: ['fd7a:115c:a1e0::1'] } }), undefined);
  assert.equal(tailnetAddressOf({ BackendState: 'Running' }), undefined);
  assert.equal(tailnetAddressOf(undefined), undefined);
});

test('a phone\'s key is let in once, and it hears where to log in: by tailnet first', async t => {
  const { publicKey } = makeOneTimeKey();
  const keys = keysFile(t, ['ssh-ed25519 AAAAothers someone']);
  const access = await sshAccess(publicKey, { keys, sshOpen: async () => true, status: async () => running });
  assert.equal(access.user, os.userInfo().username);
  assert.equal(access.port, 22);
  assert.equal(access.hosts[0], '100.96.228.46');
  assert.equal(access.hosts.length, 2);
  assert.match(access.hosts[1], /\.local$|\w/);
  await sshAccess(publicKey, { keys, sshOpen: async () => true, status: async () => running });
  assert.deepEqual(fs.readFileSync(keys, 'utf8').trim().split('\n'), ['ssh-ed25519 AAAAothers someone', `${publicKey} venes-phone`]);
});

test('with its Tailscale off a Mac is only reached by name, and with Remote Login off not at all', async t => {
  const { publicKey } = makeOneTimeKey();
  const keys = keysFile(t);
  const off = await sshAccess(publicKey, { keys, sshOpen: async () => true, status: async () => ({ BackendState: 'Stopped' }) });
  assert.equal(off.hosts.length, 1);
  assert.equal((await sshAccess(publicKey, { keys, sshOpen: async () => true, status: async () => undefined })).hosts.length, 1);
  assert.deepEqual((await sshAccess(publicKey, { keys, sshOpen: async () => false, status: async () => running })).hosts, []);
});

test('the screen is found by tailnet, with Remote Login off too, and says whether Screen Sharing answers', async () => {
  const displays = async () => [{ x: 0, y: 0, width: 1440, height: 900 }];
  const access = await screenAccess({ sharingOpen: async () => true, status: async () => running, displays });
  assert.deepEqual(access, { user: os.userInfo().username, port: 5900, on: true, hosts: ['100.96.228.46'], displays: await displays() });
  const off = await screenAccess({ sharingOpen: async () => false, status: async () => running, displays });
  assert.equal(off.on, false);
  assert.deepEqual(off.hosts, ['100.96.228.46']);
  // With the Mac's own Tailscale off, there's nowhere on the tailnet to go straight to.
  assert.deepEqual((await screenAccess({ sharingOpen: async () => true, status: async () => ({ BackendState: 'Stopped' }), displays })).hosts, []);
  assert.deepEqual((await screenAccess({ sharingOpen: async () => true, status: async () => undefined, displays })).hosts, []);
});

test('displays are placed from the top left of all of them, left to right', () => {
  // A main display, a portrait one standing higher and lower to its right, and one more past that.
  const frames = [[4000, 176, 1920, 1080, 5], [0, 0, 2560, 1440, 2], [2560, -1032, 1440, 2560, 3]];
  assert.deepEqual(displaysFrom(frames), [
    { x: 0, y: 88, width: 2560, height: 1440, id: 2 },
    { x: 2560, y: 0, width: 1440, height: 2560, id: 3 },
    { x: 4000, y: 272, width: 1920, height: 1080, id: 5 },
  ]);
  // A display without a number of its own is still placed.
  assert.deepEqual(displaysFrom([[0, 0, 1440, 900, 'x']]), [{ x: 0, y: 0, width: 1440, height: 900 }]);
  // One to the left of the main display moves the rest right.
  assert.deepEqual(displaysFrom([[0, 0, 1440, 900], [-1920, 0, 1920, 1080]]), [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 180, width: 1440, height: 900 },
  ]);
  for (const bad of [undefined, 'x', [], [[0, 0, 0, 900]], [[0, 0, 'a', 900]], [[0, 0, 1440]]]) {
    assert.deepEqual(displaysFrom(bad), []);
  }
});

test('only an Ed25519 key is let in', async t => {
  const keys = keysFile(t);
  for (const bad of ['', 'ssh-rsa AAAA', 'ssh-ed25519 AAAA\ncommand="sh" ssh-ed25519 AAAA', undefined, 3]) {
    await assert.rejects(sshAccess(bad, { keys, sshOpen: async () => true, status: async () => running }), { code: 'bad_key' }, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(keys), false);
});

const about = fields => `${JSON.stringify({ sessionId: SESSION_ID, name: 'clip.mov', mediaType: 'video/quicktime', ...fields })}\n`;

test('a file comes as a line about it, then its bytes, in whatever pieces', async () => {
  const input = new PassThrough();
  const read = readUpload(input);
  const bytes = Buffer.from([0, 1, 2, 10, 13, 255, 254, 10]);
  const sent = Buffer.concat([Buffer.from(about({ size: bytes.length })), bytes, Buffer.from('more after')]);
  for (const piece of [sent.subarray(0, 5), sent.subarray(5, 70), sent.subarray(70)]) input.write(piece);
  assert.deepEqual(await read, { sessionId: SESSION_ID, name: 'clip.mov', mediaType: 'video/quicktime', bytes: bytes.subarray(0) });
});

test('a file that says it\'s too big, empty, or nothing at all is turned away at once', async () => {
  const send = (text, options) => {
    const input = new PassThrough();
    const read = readUpload(input, options);
    input.write(text);
    return read;
  };
  await assert.rejects(send(about({ size: 11 }), { maxBytes: 10 }), { code: 'too_large' });
  await assert.rejects(send(about({ size: 0 })), { code: 'bad_upload' });
  await assert.rejects(send(about({ size: '3' })), { code: 'bad_upload' });
  await assert.rejects(send('not json\n'), { code: 'bad_upload' });
  await assert.rejects(send('x'.repeat(5000)), { code: 'bad_upload' });
});

test('a file that ends early or stops coming is turned away', async () => {
  const short = new PassThrough();
  const ended = readUpload(short);
  short.end(`${about({ size: 10 })}abc`);
  await assert.rejects(ended, { code: 'bad_upload' });
  const stalled = new PassThrough();
  const waited = readUpload(stalled, { idleMs: 30 });
  stalled.write(`${about({ size: 10 })}abc`);
  await assert.rejects(waited, { code: 'bad_upload' });
});

test('a pairing code over SSH sends the phone to the tailnet while this Mac is on it', () => {
  assert.equal(pairingHost(running, 'Mini.local'), '100.96.228.46');
  assert.equal(pairingHost({ ...running, BackendState: 'Stopped' }, 'Mini.local'), 'Mini.local');
  assert.equal(pairingHost(undefined, 'Mini.local'), 'Mini.local');
});
