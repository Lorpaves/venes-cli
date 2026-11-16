// What pairing over SSH has to know of Windows' own OpenSSH Server: where it keeps an account's keys,
// what it runs a command with, and what its firewall lets in.
import { execFileSync, spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The group every administrator is in, and Windows itself, by the names that are the same in any language.
const ADMINISTRATORS = 'S-1-5-32-544';
const SYSTEM = 'S-1-5-18';
const FIREWALL_RULE = 'OpenSSH-Server-In-TCP';
const POWERSHELL_LIMIT_MS = 15_000;

const sshFolder = (env = process.env) => path.join(env.ProgramData || 'C:\\ProgramData', 'ssh');
export const windowsHostKeyFile = env => path.join(sshFolder(env), 'ssh_host_ed25519_key.pub');
const administratorsKeys = env => path.join(sshFolder(env), 'administrators_authorized_keys');
export const isAdministratorsFile = file => path.win32.basename(file).toLowerCase() === 'administrators_authorized_keys';

// Whether this account is an administrator's. `whoami` lists the group for a terminal that wasn't
// opened as administrator too, where it's there to be refused by.
export function isAdministrator(groups = () => execFileSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' })) {
  try {
    return groups().includes(ADMINISTRATORS);
  } catch {
    return false;
  }
}

// Whether this process has an administrator's full rights, as everything in an administrator's SSH
// session has: `whoami` lists the level it runs at, high for those, or the system's own.
export function isElevated(groups = () => execFileSync('whoami', ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8' })) {
  try {
    return /S-1-16-(?:12288|16384)\b/.test(groups());
  } catch {
    return false;
  }
}

// Whether sshd reads administrators' keys from the one file it has for them all, as it's set to when
// installed. Someone who took that out of sshd_config has their keys in their own folder.
export function keepsAdministratorsKeys(config = () => fs.readFileSync(path.join(sshFolder(), 'sshd_config'), 'utf8')) {
  try {
    return /^[ \t]*Match[ \t]+Group[ \t]+administrators\b/im.test(config());
  } catch {
    return true;
  }
}

// Where sshd looks for this account's keys.
export function windowsAuthorizedKeysFile({ administrator = isAdministrator, shared = keepsAdministratorsKeys, env = process.env, home = os.homedir() } = {}) {
  return administrator() && shared() ? administratorsKeys(env) : path.win32.join(home, '.ssh', 'authorized_keys');
}

// The server's own key, as it shows it to whoever connects: `ssh-ed25519` and the key. Its file is an
// administrator's to read, and a terminal that wasn't opened as one can still ask the server, with a
// tool that Windows has beside `ssh`.
export function scanHostKey(port = Number(process.env.VENES_SSH_PORT || 22)) {
  try {
    const shown = execFileSync('ssh-keyscan', ['-T', '5', '-p', String(port), '-t', 'ed25519', '127.0.0.1'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: POWERSHELL_LIMIT_MS, windowsHide: true });
    return shown.split(/\r?\n/).find(line => line && !line.startsWith('#'))?.split(/\s+/).slice(1).join(' ');
  } catch {
    return undefined;
  }
}

// sshd reads no keys from a file that anyone but administrators and Windows can change, and a new file
// takes its folder's rules, which let others read it. This leaves it to those two.
export function keepToAdministrators(file) {
  execFileSync('icacls', [file, '/inheritance:r', '/grant', `*${ADMINISTRATORS}:F`, '/grant', `*${SYSTEM}:F`], { stdio: 'ignore' });
}

// A command line for cmd, which is what sshd on Windows gives a command to.
export const windowsCommand = (program, ...rest) => [`"${program}"`, ...rest].join(' ');

// What a phone asked sshd for, when it's one of the two things the app asks: `attach` or `receive`,
// each written as it is for a Mac, `~/.venes/venes attach`. Its words, or nothing for anything else.
export function askedOverSSH(original) {
  const [program, name, ...rest] = (original ?? '').trim().split(/\s+/);
  if (!/^~?[\\/]?(?:.*[\\/])?\.venes[\\/]venes(?:\.cmd)?$/.test(program ?? '')) return undefined;
  if (name === 'attach' && rest.length === 0) return [name];
  if (name === 'receive' && rest.length === 0) return [name];
  return undefined;
}

// What the firewall's rule for sshd and the networks this computer is on say, in one line each way.
function readFirewall() {
  const script = `$rule = Get-NetFirewallRule -Name '${FIREWALL_RULE}' -ErrorAction SilentlyContinue; `
    + 'if ($rule) { "rule|$($rule.Enabled)|$($rule.Profile)" }; '
    + 'Get-NetConnectionProfile -ErrorAction SilentlyContinue | ForEach-Object { "network|$($_.Name)|$($_.NetworkCategory)" }';
  const ran = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: POWERSHELL_LIMIT_MS, windowsHide: true });
  return ran.status === 0 ? ran.stdout : '';
}

// The networks sshd can't be reached on because of what Windows calls them: its own rule lets SSH in
// on a private network alone, and a network is public until it's said to be private. None when the
// rule isn't there to read, since then something else decides.
export function networksShutOut(report = readFirewall()) {
  const lines = report.split(/\r?\n/).map(line => line.split('|'));
  const rule = lines.find(fields => fields[0] === 'rule');
  if (!rule || rule[1] !== 'True') return [];
  const profiles = rule[2].split(',').map(each => each.trim());
  if (profiles.includes('Any')) return [];
  // The rule says Domain where a network says DomainAuthenticated.
  const covered = category => profiles.includes(category.replace('Authenticated', ''));
  return lines.filter(fields => fields[0] === 'network' && fields[2] && !covered(fields[2])).map(fields => ({ name: fields[1], category: fields[2] }));
}

export const firewallNote = shut => (shut.length === 0 ? '' : `Windows calls ${shut.map(each => `“${each.name}”`).join(' and ')} a ${shut[0].category.toLowerCase()} network, `
  + 'and its firewall lets SSH in only on a private one, so the phone won\'t get through there. Either make it private, in Settings > Network & internet, '
  + `under the network's properties, or let SSH in on any network: in a terminal opened as administrator, \`Set-NetFirewallRule -Name ${FIREWALL_RULE} -Profile Any\`.`);

// The address this computer goes out to the internet from, which is the one on the network a phone
// would be on. Nothing is sent to find it out.
export function outwardAddress() {
  return new Promise(resolve => {
    const socket = dgram.createSocket('udp4');
    const done = address => {
      socket.close();
      resolve(address);
    };
    socket.once('error', () => done(undefined));
    socket.connect(53, '192.0.2.1', () => {
      const { address } = socket.address();
      done(address && address !== '0.0.0.0' ? address : undefined);
    });
  });
}

// How to turn on the SSH server, which Windows has but doesn't install by itself.
export const WINDOWS_START_SSH = 'Add OpenSSH Server, in Settings > System > Optional features. Then, in a terminal opened as administrator: '
  + '`Start-Service sshd; Set-Service sshd -StartupType Automatic`.';
