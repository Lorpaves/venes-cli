import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addPairingLine, allowPhone, pairingLine, pairingParts, phoneCommand, removePhoneKeys } from '../../src/pairing.mjs';
import {
  askedOverSSH, firewallNote, isAdministrator, isAdministratorsFile, isElevated, keepsAdministratorsKeys, networksShutOut, outwardAddress, windowsAuthorizedKeysFile,
  windowsCommand,
} from '../../src/winssh.mjs';

const PHONE = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample0000000000000000000000000000000000000';
const ONE_TIME = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOneTime0000000000000000000000000000000000000';
const LAUNCHER = 'C:\\Users\\Ada Lovelace\\.venes\\venes.cmd';
const env = { ProgramData: 'C:\\ProgramData' };

function tempKeys(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-win-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const file = path.join(dir, 'authorized_keys');
  if (content !== undefined) fs.writeFileSync(file, content);
  return file;
}

// As `whoami /groups /fo csv /nh` prints them: an administrator's terminal that wasn't opened as one
// lists the group to be refused by, and that still says whose account it is.
const ADMIN_GROUPS = '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n'
  + '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"\r\n';
const USER_GROUPS = '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"\r\n'
  + '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"\r\n';

test('an account is an administrator\'s by the group it\'s in, opened as one or not', () => {
  assert.equal(isAdministrator(() => ADMIN_GROUPS), true);
  assert.equal(isAdministrator(() => USER_GROUPS), false);
  assert.equal(isAdministrator(() => { throw new Error('no whoami'); }), false);
});

// The end of the sshd_config Windows installs.
const SHIPPED = '#Match User anoncvs\n#\tForceCommand cvs server\n\nMatch Group administrators\n       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys\n';

test('administrators\' keys are in the one file sshd is installed to read, unless that was taken out', () => {
  assert.equal(keepsAdministratorsKeys(() => SHIPPED), true);
  assert.equal(keepsAdministratorsKeys(() => SHIPPED.replace('Match Group', '#Match Group').replace('       Auth', '#       Auth')), false);
  assert.equal(keepsAdministratorsKeys(() => { throw new Error('not there'); }), true, 'as installed, when it can\'t be read');
});

test('the keys are where sshd looks for this account\'s', () => {
  const home = 'C:\\Users\\Ada Lovelace';
  const where = (administrator, shared) => windowsAuthorizedKeysFile({ administrator: () => administrator, shared: () => shared, env, home });
  assert.equal(where(true, true).replace(/\//g, '\\'), 'C:\\ProgramData\\ssh\\administrators_authorized_keys');
  assert.equal(where(false, true), 'C:\\Users\\Ada Lovelace\\.ssh\\authorized_keys');
  assert.equal(where(true, false), 'C:\\Users\\Ada Lovelace\\.ssh\\authorized_keys');
  assert.equal(isAdministratorsFile('C:\\ProgramData\\ssh\\Administrators_Authorized_Keys'), true);
  assert.equal(isAdministratorsFile('C:\\Users\\Ada Lovelace\\.ssh\\authorized_keys'), false);
});

test('a command for cmd keeps a path with a space whole, and authorized_keys marks its quotes', () => {
  const command = windowsCommand(LAUNCHER, 'enroll', 'n0nce');
  assert.equal(command, '"C:\\Users\\Ada Lovelace\\.venes\\venes.cmd" enroll n0nce');
  assert.equal(pairingLine(ONE_TIME, command, 'n0nce'),
    `command="\\"C:\\Users\\Ada Lovelace\\.venes\\venes.cmd\\" enroll n0nce",restrict ${ONE_TIME} venes-pairing-n0nce`);
});

test('a pairing\'s line says its key and its nonce, and no other line passes for one', () => {
  const line = pairingLine(ONE_TIME, windowsCommand(LAUNCHER, 'enroll', 'n0nce'), 'n0nce');
  assert.deepEqual(pairingParts(line), { publicKey: ONE_TIME, nonce: 'n0nce' });
  assert.equal(pairingParts(`${PHONE} venes-phone`), undefined);
  assert.equal(pairingParts(`${ONE_TIME} venes-pairing-n0nce`), undefined, 'a key that isn\'t tied to a command');
  assert.equal(pairingParts(`${line}\n${PHONE} mine`), undefined, 'two lines');
});

test('on Windows a phone\'s key is tied to the helper, and elsewhere to nothing', t => {
  assert.equal(phoneCommand(LAUNCHER, 'win32'), '"C:\\Users\\Ada Lovelace\\.venes\\venes.cmd" ssh');
  assert.equal(phoneCommand('/Users/ada/.venes/venes', 'darwin'), undefined);
  assert.equal(phoneCommand('/home/ada/.venes/venes', 'linux'), undefined);
  const file = tempKeys(t, 'ssh-ed25519 AAAA mine\r\n');
  allowPhone(file, PHONE, phoneCommand(LAUNCHER, 'win32'));
  allowPhone(file, PHONE, phoneCommand(LAUNCHER, 'win32'));
  assert.equal(fs.readFileSync(file, 'utf8'), `ssh-ed25519 AAAA mine\ncommand="\\"C:\\Users\\Ada Lovelace\\.venes\\venes.cmd\\" ssh" ${PHONE} venes-phone\n`);
});

test('a file saved with Windows\' line endings is read as it would be without', t => {
  const file = tempKeys(t, `ssh-ed25519 AAAA mine\r\n${PHONE} venes-phone\r\n`);
  assert.equal(removePhoneKeys(file), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'ssh-ed25519 AAAA mine\n');
});

test('a new pairing\'s line takes the place of one a pairing left unfinished', t => {
  const stale = pairingLine(ONE_TIME, windowsCommand(LAUNCHER, 'enroll', 'old'), 'old');
  const file = tempKeys(t, `ssh-ed25519 AAAA mine\n${stale}\n${PHONE} venes-phone\n`);
  const line = pairingLine(ONE_TIME, windowsCommand(LAUNCHER, 'enroll', 'new'), 'new');
  addPairingLine(file, line);
  assert.equal(fs.readFileSync(file, 'utf8'), `ssh-ed25519 AAAA mine\n${PHONE} venes-phone\n${line}\n`);
});

test('a phone\'s key does the two things the app asks, as it asks a Mac, and nothing else', () => {
  assert.deepEqual(askedOverSSH('~/.venes/venes attach'), ['attach']);
  assert.deepEqual(askedOverSSH('~/.venes/venes receive'), ['receive']);
  assert.deepEqual(askedOverSSH('  ~/.venes/venes   attach  '), ['attach']);
  for (const other of [undefined, '', 'whoami', 'cmd /c del x', '~/.venes/venes', '~/.venes/venes uninstall', '~/.venes/venes attach --pipe',
    '~/.venes/venes attach & whoami', '~/.venes/venes receive x', 'powershell ~/.venes/venes attach', '~/venes attach']) {
    assert.equal(askedOverSSH(other), undefined, String(other));
  }
});

// What the firewall is asked comes back a line each for the rule and the networks.
const report = (profile, ...networks) => [`rule|True|${profile}`, ...networks.map(([name, category]) => `network|${name}|${category}`)].join('\r\n');

test('a network Windows calls public is one its own rule keeps SSH out of', () => {
  assert.deepEqual(networksShutOut(report('Private', ['Cafe', 'Public'])), [{ name: 'Cafe', category: 'Public' }]);
  assert.deepEqual(networksShutOut(report('Private', ['Home', 'Private'])), []);
  assert.deepEqual(networksShutOut(report('Any', ['Cafe', 'Public'])), []);
  assert.deepEqual(networksShutOut(report('Domain, Private', ['Work', 'DomainAuthenticated'], ['Tailscale', 'Private'])), []);
  assert.deepEqual(networksShutOut(report('Private, Public', ['Cafe', 'Public'])), []);
  assert.deepEqual(networksShutOut(report('Private', ['Home', 'Private'], ['Cafe', 'Public'])), [{ name: 'Cafe', category: 'Public' }]);
});

test('with no rule of Windows\' own to read, or one switched off, nothing is said of the firewall', () => {
  assert.deepEqual(networksShutOut('network|Cafe|Public'), []);
  assert.deepEqual(networksShutOut('rule|False|Private\r\nnetwork|Cafe|Public'), []);
  assert.deepEqual(networksShutOut(''), []);
  assert.equal(firewallNote([]), '');
});

test('the note names the network and both ways out', () => {
  const note = firewallNote([{ name: 'Cafe', category: 'Public' }]);
  assert.match(note, /^Windows calls “Cafe” a public network/);
  assert.match(note, /make it private/);
  assert.match(note, /Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Profile Any/);
});

test('the address this computer goes out from is one of its own, or none where it has no way out', async () => {
  const address = await outwardAddress();
  if (address === undefined) return;
  const mine = Object.values(os.networkInterfaces()).flat().map(each => each.address);
  assert.ok(mine.includes(address), address);
});

test('a process has an administrator\'s full rights by the level it runs at', () => {
  const at = level => `"Mandatory Label\\${level}","Label","${{ High: 'S-1-16-12288', Medium: 'S-1-16-8192', System: 'S-1-16-16384' }[level]}","Mandatory group"\r\n`;
  assert.equal(isElevated(() => ADMIN_GROUPS + at('High')), true, 'an administrator\'s SSH session, or a terminal opened as one');
  assert.equal(isElevated(() => ADMIN_GROUPS + at('Medium')), false, 'an administrator\'s terminal that wasn\'t');
  assert.equal(isElevated(() => USER_GROUPS + at('Medium')), false);
  assert.equal(isElevated(() => at('System')), true);
  assert.equal(isElevated(() => { throw new Error('no whoami'); }), false);
});
