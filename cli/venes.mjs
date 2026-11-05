#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { writeLauncher } from '../src/setup.mjs';
import { startDaemon } from '../src/daemon.mjs';
import { HelperClient } from '../src/client.mjs';

const START_TIMEOUT_MS = 4000;
const USAGE = `venes <command>

Helper
  start | stop | status         Manage the background helper
  daemon                        Run the helper in the foreground
  setup                         Refresh the launcher and start the helper (run by the plugin)

Control
  sessions                      List sessions
  watch                         Print live events
  history SESSION [LIMIT]       Print a session's conversation
  send SESSION TEXT             Send a message to a session
  interrupt SESSION             Interrupt the running turn
  allow REQUEST                 Approve a permission request or plan
  deny REQUEST [MESSAGE]        Reject a request
  answer REQUEST JSON           Answer a question: '{"Which color?":"Blue"}'

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

async function withClient(run) {
  await ensureRunning();
  const client = await HelperClient.connect(paths.clientSocket);
  try { await run(client); } finally { client.close(); }
}

const print = value => console.log(JSON.stringify(value, null, 2));

const commands = {
  async setup() {
    writeLauncher(paths);
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
    process.kill(Number(fs.readFileSync(paths.pidFile, 'utf8')), 'SIGTERM');
    console.log('stopped');
  },
  async status() {
    console.log((await isRunning()) ? 'running' : 'not running');
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
  history: ([sessionId, limit]) => withClient(async client => {
    print((await client.request('history', { sessionId, limit: limit ? Number(limit) : undefined })).items);
  }),
  send: ([sessionId, ...text]) => withClient(client => client.request('send', { sessionId, text: text.join(' ') })),
  interrupt: ([sessionId]) => withClient(client => client.request('interrupt', { sessionId })),
  allow: ([requestId]) => withClient(client => client.request('respond', { requestId, decision: 'allow' })),
  deny: ([requestId, ...message]) => withClient(client => client.request('respond', { requestId, decision: 'deny', message: message.join(' ') })),
  answer: ([requestId, answers]) => withClient(client => client.request('respond', { requestId, decision: 'allow', answers: JSON.parse(answers) })),
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
