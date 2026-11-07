#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { writeLauncher } from '../src/setup.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { HelperClient } from '../src/client.mjs';
import {
  addPairingKey, authorizedKeysFile, enrollPhone, hasPairingKey, isPortOpen, knownHostKey, localHostName, macName, makeNonce, makeOneTimeKey,
  pairingLink, qrModules, readHostKeyFingerprint, removePairingKey, renderQR, rexPairingLink,
} from '../src/pairing.mjs';
import { INSTALL_FOLDER as REX_FOLDER, isInstalled as isRexInstalled, tailnetAccount, tailnetAddress } from '../src/rex.mjs';
import { readUpload } from '../src/ssh.mjs';
import { autoUpdateEnabled } from '../src/update.mjs';
import { VERSION, isNewer } from '../src/version.mjs';

const START_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 3000;
const PAIRING_LIMIT_MS = 5 * 60_000;
const PAIRING_CHECK_MS = 300;
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
  pair [--ssh]                  Show a QR code that pairs the Venes app, through Rex if it's on a tailnet

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

function isRunning() {
  return new Promise(resolve => {
    const probe = net.connect(paths.clientSocket);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

async function ensureRunning() {
  if (await isRunning()) return;
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const log = fs.openSync(paths.logFile, 'a');
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: ['ignore', log, log] }).unref();
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

async function stopRunningHelper() {
  process.kill(Number(fs.readFileSync(paths.pidFile, 'utf8')), 'SIGTERM');
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline && await isRunning()) {
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

const commands = {
  // Runs at every session start, and from the old helper when it finds a new version.
  async setup() {
    const running = await runningHelper();
    // A session that's still on an older version must not take the helper back with it.
    if (isNewer(running?.version, VERSION)) return;
    writeLauncher(paths);
    if (running && isNewer(VERSION, running.version) && running.quiet !== false) await stopRunningHelper();
    await ensureRunning();
  },
  async daemon() {
    const daemon = await startDaemon(paths);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => { daemon.stop(); process.exit(0); });
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
  async status() {
    console.log((await isRunning()) ? 'running' : 'not running');
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
  async pair([route]) {
    writeLauncher(paths);
    process.env.PATH = `${process.env.PATH}:${REX_FOLDER}`;
    const address = route === '--ssh' ? undefined : await tailnetAddress();
    if (address) {
      showRexCode(address, await tailnetAccount());
      return;
    }
    const port = Number(process.env.VENES_SSH_PORT || 22);
    if (!(await isPortOpen(port))) {
      const other = isRexInstalled() ? ' Or turn on Tailscale in Rex.' : '';
      throw new Error(`Turn on Remote Login first, in System Settings > General > Sharing.${other}`);
    }
    const file = authorizedKeysFile();
    const nonce = makeNonce();
    const { seed, publicKey } = makeOneTimeKey();
    // All of this can fail, so it comes before anything is added to authorized_keys.
    const link = pairingLink({
      host: localHostName(), port, user: os.userInfo().username, hostKey: readHostKeyFingerprint(), seed, name: macName(),
    });
    const code = renderQR(qrModules(link));
    // An override has to reach the command too, since sshd runs it with a clean environment.
    const prefix = process.env.VENES_AUTHORIZED_KEYS ? `VENES_AUTHORIZED_KEYS='${file}' ` : '';
    addPairingKey(file, publicKey, `${prefix}'${paths.launcher}' enroll ${nonce}`, nonce);
    const cleanUp = () => removePairingKey(file, nonce);
    // SIGHUP is what closing the terminal window sends.
    for (const signal of ['SIGHUP', 'SIGINT', 'SIGTERM']) {
      process.on(signal, () => { cleanUp(); process.exit(130); });
    }
    console.log(`\n${code}\n\nScan this in the Venes app, or paste this into it:\n\n${link}\n\nIt works once, for five minutes.\n`);
    const deadline = Date.now() + PAIRING_LIMIT_MS;
    while (Date.now() < deadline) {
      if (!hasPairingKey(file, nonce)) {
        console.log('Paired.');
        return;
      }
      await new Promise(resolve => { setTimeout(resolve, PAIRING_CHECK_MS); });
    }
    cleanUp();
    throw new Error('That code has expired. Run this again for a new one.');
  },
  // What the one-time key in authorized_keys runs. It takes one line, the phone's public key.
  async enroll([nonce]) {
    enrollPhone(authorizedKeysFile(), nonce, await readLine(process.stdin));
    console.log('ok');
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
  // Replies as the helper would to `upload`, on one line.
  async receive() {
    let reply;
    try {
      const { sessionId, name, mediaType, bytes } = await readUpload(process.stdin);
      await withClient(async client => {
        reply = await client.request('upload', { sessionId, name, mediaType, data: bytes.toString('base64') });
      });
    } catch (error) {
      reply = { type: 'result', ok: false, error: { code: error.code ?? 'internal', message: error.message } };
    }
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
