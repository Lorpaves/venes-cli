import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addPairingKey, enrollPhone, hasPairingKey, hostKeyFingerprint, makeNonce, makeOneTimeKey, pairingLine, pairingLink, removePairingKey, renderQR, rexPairingLink,
} from '../../src/pairing.mjs';

function tempKeys(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-pair-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, '.ssh', 'authorized_keys');
  if (content !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return file;
}

const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample0000000000000000000000000000000000000';
const CLI = fileURLToPath(new URL('../../cli/venes.mjs', import.meta.url));
const MINE = 'ssh-ed25519 AAAA mine\n';

// `pair` as a person runs it, against a pretend sshd and a throwaway home.
async function startPair(t, file, hostKey, { args = ['--ssh'], path: searchPath = process.env.PATH } = {}) {
  const sshd = net.createServer().listen(0, '127.0.0.1');
  await once(sshd, 'listening');
  t.after(() => sshd.close());
  const pair = spawn(process.execPath, [CLI, 'pair', ...args], {
    env: {
      ...process.env,
      PATH: searchPath,
      VENES_HOME: path.join(path.dirname(file), 'home'),
      VENES_AUTHORIZED_KEYS: file,
      VENES_HOST_KEY: hostKey,
      VENES_SSH_PORT: String(sshd.address().port),
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => pair.kill('SIGKILL'));
  return pair;
}

function codeShown(pair, ending = 'It works once') {
  return new Promise(resolve => {
    let text = '';
    pair.stdout.on('data', chunk => {
      text += chunk;
      if (text.includes(ending)) resolve(text);
    });
  });
}

// A `rex` that answers `server tailscale pair` with `output`, or fails if there's none.
function fakeRex(t, output) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-rex-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const answer = output ? `echo '${output}'` : 'exit 1';
  fs.writeFileSync(path.join(dir, 'rex'), `#!/bin/sh\ncase "$*" in *"server tailscale pair --json"*) ${answer} ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
  return `${dir}:${process.env.PATH}`;
}

const linkIn = text => new URL(text.match(/venes:\/\/pair\S+/)[0]);

test('a one-time key is a real Ed25519 key that ssh-keygen accepts', t => {
  const file = tempKeys(t, '');
  const { publicKey, seed } = makeOneTimeKey();
  assert.equal(seed.length, 32);
  const pub = `${file}.pub`;
  fs.writeFileSync(pub, `${publicKey} test\n`);
  assert.match(execFileSync('ssh-keygen', ['-lf', pub], { encoding: 'utf8' }), /256 SHA256:\S+ test \(ED25519\)/);
});

test('a fingerprint comes out as ssh-keygen prints it', t => {
  const file = tempKeys(t, '');
  const { publicKey } = makeOneTimeKey();
  const pub = `${file}.pub`;
  fs.writeFileSync(pub, `${publicKey}\n`);
  const printed = execFileSync('ssh-keygen', ['-lf', pub], { encoding: 'utf8' }).split(' ')[1];
  assert.equal(hostKeyFingerprint(publicKey), printed);
});

test('the pairing line can only run its command', () => {
  const line = pairingLine('ssh-ed25519 AAAA', '/x/venes enroll abc', 'abc');
  assert.match(line, /^command="\/x\/venes enroll abc",restrict ssh-ed25519 AAAA venes-pairing-abc$/);
});

test('adding a pairing key leaves other keys alone and makes the folder if it has to', t => {
  const file = tempKeys(t);
  addPairingKey(file, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const other = tempKeys(t, 'ssh-rsa BBBB me@mac\n');
  addPairingKey(other, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  assert.deepEqual(fs.readFileSync(other, 'utf8').trim().split('\n').map(l => l.split(' ').at(-1)), ['me@mac', 'venes-pairing-n1']);
});

test('a phone is enrolled once and the one-time key goes with it', t => {
  const file = tempKeys(t, 'ssh-rsa BBBB me@mac\n');
  addPairingKey(file, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  enrollPhone(file, 'n1', PHONE);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['ssh-rsa BBBB me@mac', `${PHONE} venes-phone`]);
  assert.throws(() => enrollPhone(file, 'n1', PHONE), /already been used/);
});

test('a phone paired twice is listed once', t => {
  const file = tempKeys(t);
  addPairingKey(file, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  enrollPhone(file, 'n1', PHONE);
  addPairingKey(file, 'ssh-ed25519 CCCC', 'cmd', 'n2');
  enrollPhone(file, 'n2', PHONE);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
});

test('only a plain Ed25519 key is taken, so a line cannot smuggle in options', t => {
  const file = tempKeys(t);
  addPairingKey(file, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  for (const bad of ['', 'ssh-rsa AAAA', 'command="sh" ssh-ed25519 AAAA', `${PHONE} extra`, `${PHONE}\nssh-ed25519 BBBB`, 'ssh-ed25519 AA AA']) {
    assert.throws(() => enrollPhone(file, 'n1', bad), /not an Ed25519/, JSON.stringify(bad));
  }
  assert.match(fs.readFileSync(file, 'utf8'), /venes-pairing-n1/, 'a refused key leaves the one-time key in place');
});

test('a pairing that timed out takes its key away and nothing else', t => {
  const file = tempKeys(t, 'ssh-rsa BBBB me@mac\n');
  addPairingKey(file, 'ssh-ed25519 AAAA', 'cmd', 'n1');
  assert.equal(hasPairingKey(file, 'n1'), true);
  assert.equal(removePairingKey(file, 'n1'), true);
  assert.equal(hasPairingKey(file, 'n1'), false);
  assert.equal(removePairingKey(file, 'n1'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ssh-rsa BBBB me@mac\n');
});

test('nonces are safe to put in a command line and differ', () => {
  const nonce = makeNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(nonce, makeNonce());
});

test('a link for Rex says only where to call, and which Mac it is if that\'s known', () => {
  const url = new URL(rexPairingLink({ address: 'https://mac.tail.ts.net', hostKey: 'SHA256:abc+/', name: 'My Mac' }));
  assert.equal(url.protocol, 'venes:');
  assert.equal(url.host, 'pair');
  assert.deepEqual(Object.fromEntries(url.searchParams), { r: 'https://mac.tail.ts.net', n: 'My Mac', f: 'SHA256:abc+/' });
  assert.equal(new URL(rexPairingLink({ address: 'https://a', name: 'b' })).searchParams.has('f'), false);
});

test('a Rex link names the Tailscale account Rex is signed in with, when it knows', () => {
  const url = new URL(rexPairingLink({ address: 'https://mac.tail.ts.net', name: 'My Mac', account: 'me+mac@example.com' }));
  assert.equal(url.searchParams.get('t'), 'me+mac@example.com');
  assert.equal(new URL(rexPairingLink({ address: 'https://a', name: 'b' })).searchParams.has('t'), false);
});

test('the link carries what the phone needs', () => {
  const url = new URL(pairingLink({ host: 'mac.local', user: 'me', hostKey: 'SHA256:abc+/', seed: Buffer.alloc(32, 1), name: 'My Mac' }));
  assert.equal(url.protocol, 'venes:');
  assert.equal(url.host, 'pair');
  const fields = Object.fromEntries(url.searchParams);
  assert.deepEqual([fields.h, fields.p, fields.u, fields.f, fields.n], ['mac.local', '22', 'me', 'SHA256:abc+/', 'My Mac']);
  assert.equal(Buffer.from(fields.k, 'base64url').length, 32);
});

test('a QR code is drawn with a quiet zone in fixed colours', () => {
  const lines = renderQR(['101', '010', '111']).split('\n');
  assert.ok(lines.every(line => line.startsWith('\x1b[30;47m') && line.endsWith('\x1b[0m')));
  const clean = lines.map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.equal(clean[0], '  ▄ ▄  ', 'a blank row above the code\'s first');
  assert.equal(clean.length, 3);
});

for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
  test(`${signal} takes the one-time key back`, async t => {
    const file = tempKeys(t, MINE);
    fs.writeFileSync(`${file}.host`, `${PHONE} host\n`);
    const pair = await startPair(t, file, `${file}.host`);
    await codeShown(pair);
    assert.match(fs.readFileSync(file, 'utf8'), /venes-pairing-/);
    pair.kill(signal);
    await once(pair, 'exit');
    assert.equal(fs.readFileSync(file, 'utf8'), MINE);
  });
}

test('a pairing that cannot start leaves no key behind', async t => {
  const file = tempKeys(t, MINE);
  const pair = await startPair(t, file, `${file}.missing`);
  const [code] = await once(pair, 'exit');
  assert.equal(code, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), MINE);
});

test('with Tailscale on in Rex, the code is for Rex and nothing goes in authorized_keys', async t => {
  const file = tempKeys(t, MINE);
  fs.writeFileSync(`${file}.host`, `${PHONE} host\n`);
  const pair = await startPair(t, file, `${file}.host`, { args: [], path: fakeRex(t, '{"url":"https://mac.tail.ts.net"}') });
  const url = linkIn(await codeShown(pair, 'Tailscale'));
  assert.equal(url.searchParams.get('r'), 'https://mac.tail.ts.net');
  assert.match(url.searchParams.get('f'), /^SHA256:/, 'so a Mac the phone knows from SSH stays one Mac');
  assert.equal(url.searchParams.has('k'), false);
  const [code] = await once(pair, 'exit');
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), MINE);
});

test('a Mac that has never had Remote Login on can still pair through Rex', async t => {
  const file = tempKeys(t, MINE);
  const pair = await startPair(t, file, `${file}.missing`, { args: [], path: fakeRex(t, '{"url":"https://mac.tail.ts.net"}') });
  assert.equal(linkIn(await codeShown(pair, 'Tailscale')).searchParams.has('f'), false);
});

test('with Tailscale off in Rex, the code is for SSH', async t => {
  const file = tempKeys(t, MINE);
  fs.writeFileSync(`${file}.host`, `${PHONE} host\n`);
  const pair = await startPair(t, file, `${file}.host`, { args: [], path: fakeRex(t) });
  assert.equal(linkIn(await codeShown(pair)).searchParams.get('u'), os.userInfo().username);
});

test('--ssh keeps to SSH even with Tailscale on in Rex', async t => {
  const file = tempKeys(t, MINE);
  fs.writeFileSync(`${file}.host`, `${PHONE} host\n`);
  const pair = await startPair(t, file, `${file}.host`, { path: fakeRex(t, '{"url":"https://mac.tail.ts.net"}') });
  assert.equal(linkIn(await codeShown(pair)).searchParams.has('r'), false);
});
