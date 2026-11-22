#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readlinePromises from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { computer, isMac, isWindows } from '../src/platform.mjs';
import { writeLauncher } from '../src/setup.mjs';
import { installStatusLine, removeStatusLine, runStatusLine, switchOnStatusLine } from '../src/status.mjs';
import { MARKETPLACE, claudeConfigDir, isPluginInstalled, pluginIdAt, uninstall as uninstallVenes } from '../src/uninstall.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { HelperClient } from '../src/client.mjs';
import {
  START_SSH, WAY_STEPS, addPairingKey, addPairingLine, authorizedKeysFile, defaultWay, enrollPhone, findTmux, hasPairingKey, isPortOpen, knownHostKey, macName,
  pairingLine, pairingParts, phoneCommand,
  makeNonce, makeOneTimeKey, pairingLink, pairingWays, qrModules, readHostKeyFingerprint, removePairingKey, renderQR, rexPairingLink, wayNote,
} from '../src/pairing.mjs';
import { choose } from '../src/choice.mjs';
import { INSTALL_FOLDER as REX_FOLDER, isInstalled as isRexInstalled, tailnetAccount, tailnetAddress } from '../src/rex.mjs';
import { localName, pairingHost, readUpload, tailnetAddressOf, tailscaleStatus } from '../src/ssh.mjs';
import { askedOverSSH, firewallNote, isElevated, networksShutOut, windowsCommand } from '../src/winssh.mjs';
import { autoUpdateEnabled } from '../src/update.mjs';
import { VERSION, isNewer } from '../src/version.mjs';

const START_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 3000;
const PAIRING_LIMIT_MS = 5 * 60_000;
const PAIRING_CHECK_MS = 300;
// How often a setting someone is turning on is looked at again.
const SETTING_CHECK_MS = 2000;
// Well past the client's keep-alive, which is every 15 seconds.
const PIPE_IDLE_MS = 60_000;
const USAGE = `venes <command>

Helper
  start | stop | status         Manage the background helper
  daemon                        Run the helper in the foreground
  setup                         Refresh the launcher and start the helper (run by the plugin)
  version                       Print this version and the running helper's
  update                        Check for a new version now
  auto-update [on|off]          Show or change automatic updates
  pair [--rex|--ssh]            Show a QR code that pairs the Venes app, asking whether through Rex or tmux over SSH
  statusline [on|off]           Run as Claude Code's status line (set up by setup), or stop or start doing so
  uninstall [--yes]             Take Venes off this ${computer}: the plugin, the helper, ~/.venes, and phones' SSH keys

Control
  sessions                      List sessions
  library                       List every session Claude Code has stored
  watch                         Print live events
  history SESSION [LIMIT] [BEFORE]  Print a page of a session's conversation
  send SESSION TEXT             Send a message to a session
  interrupt SESSION             Interrupt the running turn
  allow REQUEST                 Approve a permission request or plan
  always REQUEST                Approve, and don't ask again for the same thing
  deny REQUEST [MESSAGE]        Reject a request
  answer REQUEST JSON           Answer a question: '{"Which color?":"Blue"}'
  output SESSION TASK           Print a background task's output

App transport
  attach [--pipe]               Bridge stdin/stdout to the helper (used over SSH, or Rex with --pipe)
  receive                       Take a file for a message, over SSH: a line of JSON about it, then its bytes
`;

const paths = helperPaths();
// This copy of the plugin, which Claude Code may have uninstalled while sessions still run its hooks.
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url));

function isRunning() {
  return new Promise(resolve => {
    const probe = net.connect(paths.clientSocket);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

// Starts the helper to run on its own, writing to its log.
function letHelperGo() {
  const cli = fileURLToPath(import.meta.url);
  // On Windows a helper started the usual way belongs to whatever started it, in two ways that end it or
  // hang its starter. It's handed every handle this process was given, which Node always asks for there,
  // so one started in an SSH session held that session's pipes and the session never ended. And sshd ends
  // everything a session started when the session closes, so a helper started by a phone's connection
  // went when the phone did, and with it what it knew of the sessions at the computer. Windows' own
  // management service is asked to start it instead: what that starts is no one's child, is handed
  // nothing, and has only the environment it's given, which is this one's. It has nowhere to write, so
  // it's told to open the log itself. Where that's refused, PowerShell starts it, which at least hands
  // it no handles.
  if (isWindows) {
    const line = `"${process.execPath}" "${cli}" daemon --log`;
    const asked = `$variables = [string[]]@([Environment]::GetEnvironmentVariables().GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }); `
      + '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ EnvironmentVariables = $variables; ShowWindow = [uint16]0 }; '
      + '$made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments '
      + '@{ CommandLine = $env:VENES_DAEMON_LINE; CurrentDirectory = $env:USERPROFILE; ProcessStartupInformation = $startup }; '
      + 'if ($made.ReturnValue -ne 0) { exit 1 }';
    const quoted = value => `'${value.replace(/'/g, "''")}'`;
    const plain = `Start-Process -WindowStyle Hidden -FilePath ${quoted(process.execPath)} -ArgumentList ${quoted(`"${cli}" daemon --log`)}`;
    for (const script of [asked, plain]) {
      const started = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: 'ignore', windowsHide: true, env: { ...process.env, VENES_DAEMON_LINE: line } });
      if (started.status === 0) return;
    }
  }
  const log = fs.openSync(paths.logFile, 'a');
  // On Windows a process that's let go would open a window of its own, which this keeps shut.
  spawn(process.execPath, [cli, 'daemon'], { detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
}

// What the helper says goes to its log, for one started with nothing to write to. A crash is written
// there too, before it ends.
function writeToLog() {
  const log = fs.openSync(paths.logFile, 'a');
  const write = (chunk, encoding, done) => {
    fs.writeSync(log, chunk);
    (typeof encoding === 'function' ? encoding : done)?.();
    return true;
  };
  process.stdout.write = write;
  process.stderr.write = write;
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, error => {
      write(`${error?.stack ?? error}\n`);
      process.exit(1);
    });
  }
}

async function ensureRunning() {
  if (await isRunning()) return;
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  letHelperGo();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isRunning()) return;
    await new Promise(resolve => { setTimeout(resolve, 100); });
  }
  throw new Error(`The helper did not start. See ${paths.logFile}`);
}

async function runningHelper() {
  if (!(await isRunning())) return undefined;
  const client = await HelperClient.connect(paths.clientSocket);
  try { return await client.request('ping'); } finally { client.close(); }
}

// Until the helper's process has gone, not only its socket, so nothing it started writes to
// ~/.venes after.
async function stopRunningHelper() {
  const pid = Number(fs.readFileSync(paths.pidFile, 'utf8'));
  process.kill(pid, 'SIGTERM');
  const alive = () => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && (await isRunning() || alive())) {
    await new Promise(resolve => { setTimeout(resolve, 50); });
  }
}

async function withClient(run) {
  await ensureRunning();
  const client = await HelperClient.connect(paths.clientSocket);
  try { await run(client); } finally { client.close(); }
}

const print = value => console.log(JSON.stringify(value, null, 2));

async function readLine(stream) {
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
    if (text.includes('\n')) break;
  }
  return text.split('\n')[0].trim();
}

const statusLineOptions = () => ({ settingsFile: paths.claudeSettings, stateFile: paths.statusLineState, launcher: paths.launcher });

const commands = {
  // Runs at every session start, and from the old helper when it finds a new version.
  async setup() {
    // A session open when the plugin was uninstalled still runs its hooks, and mustn't put it back.
    if (!isPluginInstalled({ configDir: claudeConfigDir(), pluginRoot: PLUGIN_ROOT })) return;
    const running = await runningHelper();
    // A session that's still on an older version must not take the helper back with it.
    if (isNewer(running?.version, VERSION)) return;
    writeLauncher(paths);
    try {
      installStatusLine(statusLineOptions());
    } catch {
      // The phone shows less of a session, and nothing else changes.
    }
    if (running && isNewer(VERSION, running.version) && running.quiet !== false) await stopRunningHelper();
    await ensureRunning();
  },
  async daemon(args = []) {
    if (args.includes('--log')) writeToLog();
    const daemon = await startDaemon(paths);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        // Leaves once an SDK install or a read of what was used going on has ended, or soon whatever happens.
        setTimeout(() => process.exit(0), STOP_TIMEOUT_MS - 1000).unref();
        daemon.stop().finally(() => process.exit(0));
      });
    }
    console.log(`venes helper running (pid ${process.pid})`);
  },
  async start() {
    await ensureRunning();
    console.log('running');
  },
  async stop() {
    if (!(await isRunning())) { console.log('not running'); return; }
    await stopRunningHelper();
    console.log('stopped');
  },
  // Claude Code runs this as the status line, with what it knows of the session on stdin.
  async statusline([toggle]) {
    if (toggle === 'off') {
      removeStatusLine(statusLineOptions());
      console.log('The status line is back as it was.');
    } else if (toggle === 'on') {
      console.log(switchOnStatusLine(statusLineOptions()) === 'installed' ? 'The helper reads the status line again.' : `Claude Code's settings at ${paths.claudeSettings} couldn't be read.`);
    } else {
      process.exitCode = await runStatusLine({ stdin: process.stdin, dir: paths.statusDir, stateFile: paths.statusLineState });
    }
  },
  async status() {
    console.log((await isRunning()) ? 'running' : 'not running');
  },
  async uninstall(args) {
    if (!args.includes('--yes') && !args.includes('-y')) {
      if (!process.stdin.isTTY) throw new Error('Run it with --yes to uninstall without being asked.');
      const prompt = readlinePromises.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await prompt.question(`This takes Venes off this ${computer}: its Claude Code plugin, the helper, ${paths.home}, and the SSH keys phones were let in with. Uninstall? [y/N] `);
      prompt.close();
      if (!/^y(es)?$/i.test(answer.trim())) { console.log('Nothing was changed.'); return; }
    }
    const keys = authorizedKeysFile();
    const steps = await uninstallVenes({
      paths, authorizedKeys: keys,
      stopHelper: async () => { if (await isRunning()) await stopRunningHelper(); },
    });
    const done = {
      plugin: 'Removed the plugin from Claude Code.',
      marketplace: 'Removed its marketplace.',
      statusLine: 'Put your status line back.',
      antigravity: had => (had ? 'Removed the plugin from Antigravity.' : 'Antigravity had no plugin to remove.'),
      helper: 'Stopped the helper.',
      keys: count => `Took ${count} phone key${count === 1 ? '' : 's'} out of ${keys}.`,
      folder: `Deleted ${paths.home}.`,
    };
    const failed = {
      plugin: `Run \`claude plugin uninstall ${pluginIdAt(PLUGIN_ROOT)}\` yourself, or a new session sets the helper up again.`,
      marketplace: `Run \`claude plugin marketplace remove ${MARKETPLACE}\` yourself.`,
    };
    for (const { name, ok, detail } of steps) {
      if (ok) console.log(typeof done[name] === 'function' ? done[name](detail) : done[name]);
      else console.log(`${name}: ${detail}. ${failed[name] ?? ''}`.trim());
    }
    console.log(`\nRestart sessions that are open, or run /reload-plugins in them. What the app sent stays in Downloads. Forget this ${computer} in the app.`);
    if (steps.some(s => !s.ok)) process.exitCode = 1;
  },
  async version() {
    const running = await runningHelper();
    console.log(`${VERSION}${running ? ` (running: ${running.version ?? 'unknown'})` : ''}`);
  },
  update: () => withClient(async client => {
    const { version, available } = await client.request('update');
    console.log(available ? `${version} -> ${available}, once nothing is in progress` : `${version} is the latest`);
  }),
  'auto-update': async ([state]) => {
    if (state === 'off') {
      fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
      fs.writeFileSync(paths.noAutoUpdate, '');
    } else if (state === 'on') {
      fs.rmSync(paths.noAutoUpdate, { force: true });
    }
    console.log(autoUpdateEnabled(paths) ? 'on' : 'off');
  },
  // In a terminal it asks which way the phone comes in, starting on one that works now. Elsewhere it
  // takes Rex when that works, and SSH otherwise, as `--rex` and `--ssh` pick one outright.
  async pair(args) {
    writeLauncher(paths);
    const port = Number(process.env.VENES_SSH_PORT || 22);
    // On Windows there's one way in so far, over SSH, and no terminal the app could type into.
    if (isWindows) {
      await pairOverSSH({ id: 'ssh', state: 'ready' }, port, { isTerminal: !!(process.stdin.isTTY && process.stdout.isTTY), needsTmux: false });
      return;
    }
    process.env.PATH = `${process.env.PATH}:${REX_FOLDER}`;
    const asked = args.includes('--ssh') ? 'ssh' : args.includes('--rex') ? 'rex' : undefined;
    const rexInstalled = isRexInstalled();
    const ways = pairingWays({
      rexInstalled, rexAddress: asked !== 'ssh' && rexInstalled ? await tailnetAddress() : undefined,
      tmuxInstalled: !!findTmux(), remoteLogin: await isPortOpen(port),
    });
    const isTerminal = !!(process.stdin.isTTY && process.stdout.isTTY);
    const [rex, ssh] = ways;
    let way;
    if (asked) way = ways.find(each => each.id === asked);
    else if (isTerminal) way = await askWay(ways);
    else way = rex.state === 'ready' ? rex : ssh;
    if (!way) process.exit(130);
    if (way.id === 'rex') await pairThroughRex(way, isTerminal);
    else await pairOverSSH(way, port, { isTerminal, needsTmux: isTerminal && !asked });
  },
  // What the one-time key in authorized_keys runs. It takes one line, the phone's public key.
  async enroll([nonce]) {
    // On Windows the one-time key can outlast its five minutes, where taking it out needs an
    // administrator, so what says the pairing is still open is kept beside the helper.
    if (isWindows && !takePairing(nonce)) throw new Error('This code has expired. Run pair again for a new one.');
    enrollPhone(authorizedKeysFile(), nonce, await readLine(process.stdin), phoneCommand(paths.launcher));
    console.log('ok');
  },
  // What a phone's key runs on Windows, whatever the phone asked for, which sshd leaves in the
  // environment: the two things the app asks, and nothing else.
  async ssh() {
    const asked = askedOverSSH(process.env.SSH_ORIGINAL_COMMAND);
    if (!asked) throw new Error('This key only reaches Venes.');
    // A phone doesn't start the helper from an administrator's SSH session, which has an administrator's
    // full rights: so would the helper, and Claude Code at the computer, which doesn't, could neither
    // reach that helper nor start its own. It's Claude Code that starts it there.
    if (!(await isRunning()) && isElevated()) {
      throw new Error('Venes isn\'t running on this computer yet. Start Claude Code there, and it starts with it.');
    }
    await commands[asked[0]]([]);
  },
  // Run as administrator by `pair`, when it couldn't itself write where Windows keeps administrators'
  // keys. It adds one line, and only one that is a pairing's: a key that can do nothing but enroll a
  // phone with this helper.
  async 'add-key'([encoded]) {
    const line = Buffer.from(encoded ?? '', 'base64url').toString();
    const parts = pairingParts(line);
    if (!parts || line !== pairingLine(parts.publicKey, windowsCommand(paths.launcher, 'enroll', parts.nonce), parts.nonce)) throw new Error('Not a pairing\'s key.');
    addPairingLine(authorizedKeysFile(), line);
  },
  library: () => withClient(async client => {
    print(await client.request('library'));
  }),
  sessions: () => withClient(async client => {
    const { sessions, unattached } = await client.request('sessions');
    print({ sessions, unattached });
  }),
  watch: async () => {
    await ensureRunning();
    const client = await HelperClient.connect(paths.clientSocket);
    client.on('message', message => console.log(JSON.stringify(message)));
    await client.request('subscribe');
    await new Promise(() => {});
  },
  history: ([sessionId, limit, before]) => withClient(async client => {
    const toNumber = value => (value ? Number(value) : undefined);
    print(await client.request('history', { sessionId, limit: toNumber(limit), before: toNumber(before) }));
  }),
  send: ([sessionId, ...text]) => withClient(client => client.request('send', { sessionId, text: text.join(' ') })),
  interrupt: ([sessionId]) => withClient(client => client.request('interrupt', { sessionId })),
  allow: ([requestId]) => withClient(client => client.request('respond', { requestId, decision: 'allow' })),
  always: ([requestId]) => withClient(client => client.request('respond', { requestId, decision: 'allow', always: true })),
  deny: ([requestId, ...message]) => withClient(client => client.request('respond', { requestId, decision: 'deny', message: message.join(' ') })),
  answer: ([requestId, answers]) => withClient(client => client.request('respond', { requestId, decision: 'allow', answers: JSON.parse(answers) })),
  output: ([sessionId, taskId]) => withClient(async client => {
    console.log((await client.request('taskOutput', { sessionId, taskId })).output ?? '');
  }),
  // Replies as the helper would to `upload`, on one line. The file is written here as it comes, which
  // takes one of any size, and the helper moves it to Downloads: over SSH this may not be let in there.
  async receive() {
    let reply;
    let taken;
    try {
      fs.mkdirSync(paths.incoming, { recursive: true, mode: 0o700 });
      taken = await readUpload(process.stdin, { into: paths.incoming });
      const { sessionId, name, mediaType, file } = taken;
      await withClient(async client => {
        reply = await client.request('upload', { sessionId, name, mediaType, file });
      });
    } catch (error) {
      reply = { type: 'result', ok: false, error: { code: error.code ?? 'internal', message: error.message } };
    }
    // Moved by now if the helper took it, and no one's if it didn't.
    if (taken) fs.rmSync(taken.file, { force: true });
    process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(reply.ok ? 0 : 1));
  },
  async attach([mode]) {
    await ensureRunning();
    if (mode === '--pipe') openPipe(process.stdin);
    const socket = net.connect(paths.clientSocket);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on('close', () => process.exit(0));
    process.stdin.on('end', () => socket.end());
  },
};

// A client that comes through Rex has a terminal for a pipe, which has to leave long lines alone.
// And a terminal ends when someone closes it, which a client that has gone can't do.
function openPipe(input) {
  input.setRawMode(true);
  let idle;
  const stay = () => {
    clearTimeout(idle);
    idle = setTimeout(() => process.exit(0), PIPE_IDLE_MS);
  };
  stay();
  input.on('data', stay);
}

// Asks which way the phone comes in, starting on one that works now. Undefined when it's stopped.
async function askWay(ways) {
  const question = ways.every(way => way.state === 'missing')
    ? `Neither Rex nor tmux is on this ${computer} yet. Pick one to see how to set it up.`
    : `How will the Venes app reach this ${computer}?`;
  console.log(`\n${question}\n\x1b[2m↑/↓ to choose · Enter to go on · Esc to stop\x1b[22m\n`);
  const index = await choose({ options: ways.map(way => ({ label: way.label, note: wayNote(way) })), start: ways.indexOf(defaultWay(ways)) });
  console.log('');
  return index === undefined ? undefined : ways[index];
}

// What to do first, for a way that can't be used yet. It isn't a failure, but nothing was paired.
function guide(steps) {
  console.log(`${steps}\n`);
  process.exitCode = 1;
}

// Checks every few seconds until `check` finds something, for as long as a pairing code lasts.
async function waitFor(check) {
  const deadline = Date.now() + PAIRING_LIMIT_MS;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await new Promise(resolve => { setTimeout(resolve, SETTING_CHECK_MS); });
  }
  return undefined;
}

// System Settings, at General > Sharing.
function openSharingSettings() {
  try {
    spawn('open', ['x-apple.systempreferences:com.apple.Sharing-Settings.extension'], { stdio: 'ignore', detached: true }).unref();
  } catch { /* the words say where it is */ }
}

// Rex reaches this Mac over its own Tailscale, once Serve over Tailscale is on in it.
async function pairThroughRex(way, isTerminal) {
  if (way.state === 'missing') return guide(WAY_STEPS.rex.missing);
  let address = way.address ?? await tailnetAddress();
  if (!address) {
    if (!isTerminal) throw new Error(`Rex isn't on a tailnet. ${WAY_STEPS.rex.off}`);
    console.log(`${WAY_STEPS.rex.off} Waiting for it to be on…\n`);
    address = await waitFor(tailnetAddress);
    if (!address) throw new Error('Serve over Tailscale is still off in Rex. Run this again once it\'s on.');
  }
  showRexCode(address, await tailnetAccount());
  return undefined;
}

// A pairing that's open, on Windows: a file beside the helper that says until when. The one-time key
// can stay in an administrator's keys past its time there, and does nothing once this is gone.
const pairingMarker = nonce => path.join(paths.home, 'pairings', nonce);

function openPairing(nonce) {
  const folder = path.dirname(pairingMarker(nonce));
  // One pairing at a time: whatever an earlier one left is done with.
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(pairingMarker(nonce), String(Date.now() + PAIRING_LIMIT_MS));
}

function closePairing(nonce) {
  for (const file of [pairingMarker(nonce), `${pairingMarker(nonce)}.done`]) fs.rmSync(file, { force: true });
}

// Whether the pairing is still open, which asking closes: a code works once. What's left says it was used.
function takePairing(nonce) {
  if (!/^[A-Za-z0-9_-]+$/.test(nonce ?? '')) return false;
  let until = 0;
  try {
    until = Number(fs.readFileSync(pairingMarker(nonce), 'utf8'));
    fs.rmSync(pairingMarker(nonce), { force: true });
  } catch {
    return false;
  }
  if (!(Date.now() < until)) return false;
  fs.writeFileSync(`${pairingMarker(nonce)}.done`, '');
  return true;
}

// Has Windows ask the person to let one line be added to the administrators' keys, by a copy of this
// run as administrator. Whether it was added.
function addKeyAsAdministrator(line) {
  const quoted = value => `'${value.replace(/'/g, "''")}'`;
  const list = `"${fileURLToPath(import.meta.url)}" add-key ${Buffer.from(line).toString('base64url')}`;
  const script = `try { $run = Start-Process -Verb RunAs -Wait -PassThru -WindowStyle Hidden -FilePath ${quoted(process.execPath)} -ArgumentList ${quoted(list)}; exit $run.ExitCode } catch { exit 1 }`;
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true }).status === 0;
}

// Where OpenSSH Server is added, in Windows' Settings.
function openOptionalFeatures() {
  spawn('cmd.exe', ['/c', 'start', 'ms-settings:optionalfeatures'], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
}

// A Mac without Rex is reached over SSH, which needs Remote Login. In a terminal, that is waited for
// while the person turns it on. `needsTmux` is for a way picked as tmux, which can't be used without it.
async function pairOverSSH(way, port, { isTerminal, needsTmux }) {
  if (needsTmux && way.state === 'missing') return guide(WAY_STEPS.ssh.missing);
  if (!(await isPortOpen(port))) {
    const first = isMac ? 'Turn on Remote Login first, in System Settings > General > Sharing.' : START_SSH;
    if (!isTerminal) throw new Error(`${first}${isRexInstalled() ? ' Or turn on Serve over Tailscale in Rex.' : ''}`);
    console.log(`${WAY_STEPS.ssh.off} Waiting for it to be on…\n`);
    if (isMac) openSharingSettings();
    if (isWindows) openOptionalFeatures();
    if (!(await waitFor(() => isPortOpen(port)))) throw new Error(`${isMac ? 'Remote Login is still off' : 'The SSH server still isn\'t answering'}. Run this again once it's on.`);
  }
  const file = authorizedKeysFile();
  const nonce = makeNonce();
  const { seed, publicKey } = makeOneTimeKey();
  const tailscale = await tailscaleStatus();
  const host = pairingHost(tailscale, await localName());
  // All of this can fail, so it comes before anything is added to authorized_keys.
  const link = pairingLink({
    host, port, user: os.userInfo().username, hostKey: readHostKeyFingerprint(), seed, name: macName(),
  });
  const code = renderQR(qrModules(link));
  // An override has to reach the command too, since sshd runs it with a clean environment.
  const prefix = process.env.VENES_AUTHORIZED_KEYS ? `VENES_AUTHORIZED_KEYS='${file}' ` : '';
  const command = isWindows ? windowsCommand(paths.launcher, 'enroll', nonce) : `${prefix}'${paths.launcher}' enroll ${nonce}`;
  if (isWindows) openPairing(nonce);
  try {
    // On Windows a pairing that never finished can have left its key behind, which goes now.
    if (isWindows) addPairingLine(file, pairingLine(publicKey, command, nonce));
    else addPairingKey(file, publicKey, command, nonce);
  } catch (error) {
    // An administrator's keys are in a file that a terminal not opened as administrator can't touch.
    if (!isWindows || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    console.log('Windows keeps an administrator\'s SSH keys in a file only an administrator can change. It will ask to let Node.js make changes '
      + 'to this computer: that is this, adding a key for the phone to that file.\n');
    if (!addKeyAsAdministrator(pairingLine(publicKey, command, nonce))) {
      closePairing(nonce);
      throw new Error('The key wasn\'t added. Run this again and answer Yes when Windows asks, or run it in a terminal opened as administrator.');
    }
  }
  const cleanUp = () => {
    if (isWindows) closePairing(nonce);
    try {
      removePairingKey(file, nonce);
    } catch {
      // Left where it is, on Windows, where it can do nothing once the pairing is closed.
    }
  };
  // Windows says a phone is enrolled beside the helper, since the keys may not be this terminal's to read.
  const isPaired = () => (isWindows ? fs.existsSync(`${pairingMarker(nonce)}.done`) : !hasPairingKey(file, nonce));
  // SIGHUP is what closing the terminal window sends.
  for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
    process.on(signal, () => { cleanUp(); process.exit(130); });
  }
  // On the tailnet, the phone signs in to Tailscale in the app first, as any account that reaches this Mac.
  const reach = host === tailnetAddressOf(tailscale)
    ? `The phone reaches this ${computer} on your tailnet: sign in to Tailscale in the app when it asks.`
    : `Tailscale is off on this ${computer}, so the phone can only reach it on this network. Turn Tailscale on to reach it from anywhere.`;
  const tmux = needsTmux ? '\n\nRun Claude Code inside tmux, so the app can type into it: tmux new -A -s cc' : '';
  const windows = isWindows ? '\n\nOn Windows the app follows a session and answers what it asks. It can\'t type into one yet.' : '';
  const shut = isWindows ? firewallNote(networksShutOut()) : '';
  console.log(`\n${code}\n\nScan this in the Venes app, or paste this into it:\n\n${link}\n\nIt works once, for five minutes. ${reach}${tmux}${windows}${shut ? `\n\n${shut}` : ''}\n`);
  const deadline = Date.now() + PAIRING_LIMIT_MS;
  while (Date.now() < deadline) {
    if (isPaired()) {
      if (isWindows) closePairing(nonce);
      console.log('Paired.');
      return;
    }
    await new Promise(resolve => { setTimeout(resolve, PAIRING_CHECK_MS); });
  }
  cleanUp();
  throw new Error('That code has expired. Run this again for a new one.');
}

// Nothing to hand over: Rex asks Tailscale who's calling, so the code is only where to call.
function showRexCode(address, account) {
  const link = rexPairingLink({ address, hostKey: knownHostKey(), name: macName(), account });
  const code = renderQR(qrModules(link));
  console.log(`\n${code}\n\nScan this in the Venes app, or paste this into it:\n\n${link}\n\nThe phone needs Tailscale, signed in as you are in Rex.\n`);
}

const [name, ...args] = process.argv.slice(2);
if (!commands[name]) {
  console.log(USAGE);
  process.exit(name ? 1 : 0);
}
try {
  await commands[name](args);
} catch (error) {
  console.error(error.code ? `${error.code}: ${error.message}` : error.message);
  process.exit(1);
}
