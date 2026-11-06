#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { writeLauncher } from '../src/setup.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { HelperClient } from '../src/client.mjs';
import { autoUpdateEnabled } from '../src/update.mjs';
import { VERSION, isNewer } from '../src/version.mjs';

const START_TIMEOUT_MS = 4000;
const STOP_TIMEOUT_MS = 3000;
const USAGE = `venes <command>

Helper
  start | stop | status         Manage the background helper
  daemon                        Run the helper in the foreground
  setup                         Refresh the launcher and start the helper (run by the plugin)
  version                       Print this version and the running helper's
  update                        Check for a new version now
  auto-update [on|off]          Show or change automatic updates

Control
  sessions                      List sessions
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
  attach                        Bridge stdin/stdout to the helper (used over SSH)
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
  async attach() {
    await ensureRunning();
    const socket = net.connect(paths.clientSocket);
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
    socket.on('close', () => process.exit(0));
    process.stdin.on('end', () => socket.end());
  },
};

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
