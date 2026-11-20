#!/usr/bin/env node
// End-to-end check against a real interactive Claude Code session, with this
// repository loaded as the plugin through --plugin-dir.
//
//   VENES_E2E_WS=/abs/workspace node test/e2e.mjs [case-prefix ...]
//
// VENES_E2E_CLAUDE_CONFIG_DIR runs the sessions with another Claude Code config, and so another
// account, than this Mac's ~/.claude.
//
// Isolation: a dedicated tmux socket, a Rex server of its own and VENES_HOME, and no user settings loaded.
// Nothing is installed: the plugin exists only for these sessions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { HelperClient } from '../src/client.mjs';
import { CodexLink } from '../src/codexlink.mjs';
import { clockOf, dayOf, hourOf } from '../src/usage.mjs';
import { RexControl, openPipe } from './rex-client.mjs';
import { findClaudePanes } from '../src/tmux.mjs';
import { VERSION } from '../src/version.mjs';
import { findUpload } from '../src/uploads.mjs';
import { makeOneTimeKey } from '../src/pairing.mjs';

const WS = process.env.VENES_E2E_WS;
if (!WS || !path.isAbsolute(WS)) throw new Error('VENES_E2E_WS must be an absolute path');
// Unix socket paths are limited to 104 bytes on macOS, which rules out long temp dirs.
const HOME = process.env.VENES_E2E_HOME || '/tmp/venes-e2e';
const MODEL = process.env.VENES_E2E_MODEL || 'haiku';
// The Claude Code config the sessions run with, and so the account, when not this Mac's own: the
// helpers here read its transcripts too. Left out, it's ~/.claude.
const CLAUDE_CONFIG = process.env.VENES_E2E_CLAUDE_CONFIG_DIR;
if (CLAUDE_CONFIG) process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG;
const configEnv = CLAUDE_CONFIG ? [`CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG}`] : [];
const CLAUDE = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
const SOCK = 'venes-e2e';
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(PLUGIN, 'cli/venes.mjs');
const paths = helperPaths(HOME);
// Where uploads go, and the keys a phone is let in with: this run's own, never this Mac's.
const DOWNLOADS = `${HOME}-downloads`;
const AUTHORIZED_KEYS = `${HOME}-authorized_keys`;
// Where what a case deletes goes: this run's own, and never this Mac's Trash.
const TRASH = `${HOME}-trash`;
// The Claude Code settings the helper stands in for the status line in: this run's own. Every
// session and helper here takes it from the environment, and none ever touches this Mac's.
const CLAUDE_SETTINGS = `${HOME}-claude-settings.json`;
process.env.VENES_CLAUDE_SETTINGS = CLAUDE_SETTINGS;
// Where a helper here looks for Codex's server: nowhere, so that no run ever lists or touches the
// threads of this Mac's own Codex. Every helper gets it, the ones a session's hook starts too. A Codex
// case runs a server of Codex's there for itself: with this Mac's Codex account, which is all a
// thread can be run with, and in the workspace alone.
const CODEX_SOCKET = `${HOME}-codex/s.sock`;
// The model and effort Codex cases run on, to spend as little of that account as a real turn can.
const CODEX_MODEL = process.env.VENES_E2E_CODEX_MODEL || 'gpt-5.6-luna';
const CODEX_EFFORT = 'low';
// Kept between runs, so that a run doesn't download the SDK for each case.
const SDK_DIR = process.env.VENES_E2E_SDK || `${HOME}-sdk`;
const RESUME_ARGS = ['--model', MODEL, '--permission-mode', 'default', '--setting-sources', 'project', '--plugin-dir', PLUGIN];

const delay = ms => new Promise(r => { setTimeout(r, ms); });
const shq = s => `'${s.replace(/'/g, `'\\''`)}'`;
const tmux = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exists = f => fs.existsSync(path.join(WS, f));
const TOUCH = n => `Use the Bash tool to run exactly this command: touch e2e-${n}.txt -- then reply with only the word DONE.`;
const ASK = 'Use the AskUserQuestion tool to ask me one question, "Which color?", with exactly two options: Red and Blue. After I answer, reply with only the color I picked.';
const PLAN = n => `Make a one-step plan to create the file e2e-${n}.txt using touch, then call ExitPlanMode. Do not ask questions.`;
const SLEEP = (s, word) => `Use the Bash tool in the foreground to run exactly this command: python3 -c 'import time; time.sleep(${s})' -- then reply with only the word ${word}.`;

// A Rex server of this run's own, so that nothing shows up in the one on this Mac.
// Where the helper sends notifications for a phone that's away, in place of the relay.
const pushes = [];
const pushServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    pushes.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":200}');
  });
});
await new Promise(resolve => { pushServer.listen(0, '127.0.0.1', resolve); });
const PUSH_URL = `http://127.0.0.1:${pushServer.address().port}/push`;

// Rex, for the cases that run in it: a server of this run's own, with nothing of this Mac's in it.
// The command can't be left to find it. Given a server in REX_SERVER that it can't reach, it quietly
// uses this Mac's own instead, where a case would go on to rename and close the sessions of the
// helper that's really running. So every command names this run's server with -S and may not start
// one, which fails where the other falls back. A helper does the same when it's given the server
// in VENES_REX_SERVER, as every helper here is, and every session, for the helper its hooks start.
const REX_SOCKET = `${HOME}-rex.sock`;
const REX_SERVER = `unix://${REX_SOCKET}`;
const REX_PORT = 18744;
const REX_COMMAND = (() => { try { return execFileSync('sh', ['-c', 'command -v rex'], { encoding: 'utf8' }).trim(); } catch { return undefined; } })();
const hasRex = Boolean(REX_COMMAND);
const ONLY_THIS_RUNS = ['-S', REX_SERVER, '--autostart=false'];
const barerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CLAUDE|REX_)/.test(key)));
const rexEnv = { ...barerEnv, REX_SERVER };
const rex = (...a) => execFileSync(REX_COMMAND, [...ONLY_THIS_RUNS, ...a], { encoding: 'utf8', env: rexEnv, stdio: ['ignore', 'pipe', 'pipe'] });
// Nothing started from here gets what Rex set for the shell this runs from, which names this Mac's
// server and a session in it.
for (const key of Object.keys(process.env)) if (key.startsWith('REX_')) delete process.env[key];
process.env.VENES_REX_SERVER = REX_SERVER;
// And every helper here moves what's deleted to this run's folder, in the Trash's place.
process.env.VENES_TRASH = TRASH;
const REX_KEYS = { Enter: 'enter', Escape: 'escape', Up: 'up', Down: 'down', Left: 'left', Right: 'right' };
// The session a case is running in Rex, if it is.
let inRex;
let rexServerProcess;
const isRunning = child => Boolean(child) && child.exitCode === null && child.signalCode === null;
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A run stopped from outside can leave its server behind. It still holds the port, so the next
// run's can't start. It's known by the socket it was told to listen on, which is no one else's.
async function stopStrayRexServers() {
  let pids = [];
  try {
    pids = execFileSync('lsof', ['-nP', `-iTCP:${REX_PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch { /* no one listens there */ }
  for (const pid of pids) {
    const command = execFileSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    if (!command.includes(`--listen ${REX_SERVER} `)) throw new Error(`port ${REX_PORT} is taken by something other than a server this suite left`);
    process.kill(pid, 'SIGKILL');
  }
  for (let i = 0; i < 60 && pids.some(isAlive); i++) await delay(50);
}
async function startRexServer() {
  if (isRunning(rexServerProcess)) return;
  await stopStrayRexServers();
  fs.rmSync(REX_SOCKET, { force: true });
  const server = spawn(REX_COMMAND, [
    'server', 'run', '--listen', REX_SERVER, '--extra-listen', `http://127.0.0.1:${REX_PORT}`, '--allow-anonymous', '--state-dir', `${HOME}-rex`, '--restore=false',
  ], { env: rexEnv, stdio: 'ignore' });
  rexServerProcess = server;
  for (let i = 0; i < 100 && !fs.existsSync(REX_SOCKET) && isRunning(server); i++) await delay(50);
  await delay(200);
  // Nothing runs in Rex unless the server that answers is the one just started.
  const { pid, endpoint } = JSON.parse(rex('whoami', '--json'));
  if (pid !== server.pid || endpoint !== REX_SERVER) throw new Error(`the Rex server that answers isn't this run's: ${endpoint}`);
}
process.on('exit', () => rexServerProcess?.kill());

// Codex's own server, for one case. It listens where the socket really is, since Codex won't take a
// path through a link, as /tmp is. What Rex set for the shell this runs from stays out of it, so that
// Codex's own hooks don't take a test thread for one of that shell's.
let codexServer;
async function startCodexServer() {
  codexTrustedBefore ??= readCodexConfig().includes(codexTrust());
  const dir = path.dirname(CODEX_SOCKET);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const { REX_SESSION, REX_BLOCK, REX_SERVER: rexServer, ...env } = process.env;
  codexServer = spawn('codex', ['app-server', '--listen', `unix://${path.join(fs.realpathSync(dir), 's.sock')}`], { env, cwd: WS, stdio: 'ignore' });
  for (let i = 0; i < 150 && !fs.existsSync(CODEX_SOCKET); i++) await delay(100);
  if (!fs.existsSync(CODEX_SOCKET)) throw new Error('Codex\'s server did not come up');
}
// What a case's threads leave in Codex's own store goes with the case: every thread whose folder is the workspace.
async function forgetCodexThreads() {
  const link = await CodexLink.connect(CODEX_SOCKET, { name: 'venes-e2e', title: 'Venes e2e', version: VERSION });
  try {
    // A fork goes before the chat it was made from, which Codex keeps while the fork is kept. One that
    // nothing was said in is in no list of Codex's, so the case that makes one names it here.
    for (const threadId of codexForks.splice(0)) await link.request('thread/delete', { threadId }).catch(() => {});
    for (const archived of [true, false]) {
      const { data = [] } = await link.request('thread/list', { limit: 100, archived, cwd: fs.realpathSync(WS), sourceKinds: ['cli', 'vscode', 'appServer', 'exec', 'unknown'] });
      for (const thread of data) await link.request('thread/delete', { threadId: thread.id }).catch(() => {});
    }
  } finally {
    link.close();
  }
}
const codexForks = [];
// Codex's server writes its trust of the workspace into this Mac's own Codex config, once a thread may
// write there. That's taken back out, unless it was there before the run.
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
const codexTrust = () => `[projects.${JSON.stringify(fs.realpathSync(WS))}]\ntrust_level = "trusted"\n`;
const readCodexConfig = () => { try { return fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { return ''; } };
let codexTrustedBefore;
function forgetCodexTrust() {
  const config = readCodexConfig();
  if (codexTrustedBefore || !config.includes(codexTrust())) return;
  const without = config.replace(`${codexTrust()}\n`, '').replace(codexTrust(), '');
  fs.writeFileSync(CODEX_CONFIG, without, { mode: fs.statSync(CODEX_CONFIG).mode });
}
async function stopCodexServer({ forget = true } = {}) {
  if (!codexServer) return;
  if (forget) await forgetCodexThreads().catch(error => console.log(`      codex threads not deleted: ${error.message}`));
  const gone = codexServer.exitCode !== null ? Promise.resolve(true) : new Promise(resolve => { codexServer.once('exit', () => resolve(true)); });
  codexServer.kill();
  // One still there after a few seconds is ended at once: left running, it outlived the run, three on one day.
  if (!(await Promise.race([gone, delay(3000).then(() => false)]))) codexServer.kill('SIGKILL');
  codexServer = undefined;
  fs.rmSync(path.dirname(CODEX_SOCKET), { recursive: true, force: true });
  if (forget) forgetCodexTrust();
}
process.on('exit', () => codexServer?.kill());

function startHelper(cli = CLI, codexStart = undefined, more = {}) {
  // Updates stay off: a test run must never touch the plugins of the Claude it borrows.
  const env = {
    ...process.env, VENES_HOME: HOME, DISABLE_UPDATES: '1', VENES_SDK_DIR: SDK_DIR, VENES_TERMINAL: inRex ? 'rex' : 'tmux',
    VENES_DOWNLOADS: DOWNLOADS, VENES_AUTHORIZED_KEYS: AUTHORIZED_KEYS, VENES_PUSH_URL: PUSH_URL, VENES_CODEX_SOCKET: CODEX_SOCKET,
    // The plugin Antigravity would run goes in the helper's own folder, where no Antigravity looks.
    VENES_AGY_CONFIG: path.join(HOME, 'antigravity'),
    VENES_TMUX_SOCKET: tmux('display-message', '-p', '#{socket_path}').trim(), VENES_RESUME_ARGS: JSON.stringify(RESUME_ARGS),
    ...(inRex && { REX_SERVER }),
    ...(codexStart && { VENES_CODEX_START_ARGS: JSON.stringify(Object.fromEntries(Object.entries(codexStart).filter(([key]) => key !== 'terminal'))) }),
    // Codex's own terminal is opened on a session only in the case that looks for it: it's a real one, of
    // whichever Codex this Mac has, and the other cases have no use for it.
    VENES_CODEX_TERMINAL: codexStart?.terminal ? 'on' : 'off',
    ...more,
  };
  spawn(process.execPath, [cli, 'daemon'], { env, stdio: 'ignore', detached: true }).unref();
}
function helperPid() {
  try { return Number(fs.readFileSync(paths.pidFile, 'utf8')); } catch { return undefined; }
}
// By pid file, because the plugin's SessionStart hook may have started it.
async function stopHelper() {
  const pid = helperPid();
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
}
process.on('exit', () => { try { process.kill(helperPid(), 'SIGTERM'); } catch { /* not running */ } });
// The helper of a run that was killed outright: the one the pid file names, if it still holds this
// suite's socket. The number alone could be anyone's by now.
function stopStrayHelper() {
  const pid = helperPid();
  if (!pid) return;
  try {
    const held = execFileSync('lsof', ['-a', '-p', String(pid), '-U', '-Fn'], { encoding: 'utf8' }).split('\n');
    if (held.includes(`n${paths.clientSocket}`)) process.kill(pid, 'SIGKILL');
  } catch { /* gone already */ }
}
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { return await HelperClient.connect(paths.clientSocket); } catch { await delay(100); }
  }
  throw new Error('helper did not come up');
}

class Run {
  events = [];
  // What a case leaves to be done when it ends, however it ends.
  cleanups = [];
  after(cleanup) { this.cleanups.push(cleanup); }
  constructor(client) {
    this.client = client;
    client.on('message', m => { if (m.type === 'event') this.events.push(m.event); });
  }
  pane() { return inRex ? rex('capture', '-s', inRex.session, '-b', inRex.block, '--trim') : tmux('capture-pane', '-p', '-t', 'run'); }
  key(...k) {
    if (inRex) rex('send-key', '-s', inRex.session, '-b', inRex.block, ...k.map(key => REX_KEYS[key] ?? key));
    else tmux('send-keys', '-t', 'run', ...k);
  }
  async type(text) {
    if (inRex) rex('send', '-s', inRex.session, '-b', inRex.block, text);
    else tmux('send-keys', '-t', 'run', '-l', text);
    await delay(500);
    this.key('Enter');
  }
  async wait(pred, ms = 45000, label = 'event') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await delay(60);
    }
    throw new Error(`timed out waiting for ${label}; saw: ${this.events.map(e => e.kind).join(' ')}`);
  }
  kind(k, ms) { return this.wait(e => e.kind === k, ms, k); }
  async request(kind, ms) { return (await this.wait(e => e.kind === 'request.opened' && e.request.kind === kind, ms, `request ${kind}`)).request; }
  closed(requestId, ms = 15000) { return this.wait(e => e.kind === 'request.closed' && e.requestId === requestId, ms, 'request.closed'); }
  async turnEnd(ms) { return this.kind('turn.end', ms); }
  async session() {
    const { sessions } = await this.client.request('sessions');
    return sessions.find(s => s.status !== 'ended') ?? sessions.at(-1);
  }
  mark() { this.events.length = 0; }
  // A denied model may try again. Assert on what the helper controls, not on the model's wording.
  denyEverything(message) {
    const deny = requestId => this.client.request('respond', { requestId, decision: 'deny', message }).catch(() => {});
    for (const e of this.events) if (e.kind === 'request.opened') deny(e.request.id);
    this.client.on('message', m => { if (m.type === 'event' && m.event.kind === 'request.opened') deny(m.event.request.id); });
  }
  // Every request opened from now on, allowed, whatever Claude reaches for to do the work.
  allowEverything() {
    const allow = requestId => this.client.request('respond', { requestId, decision: 'allow' }).catch(() => {});
    this.client.on('message', m => { if (m.type === 'event' && m.event.kind === 'request.opened') allow(m.event.request.id); });
  }
  async deliveredToClaude(text) {
    const end = await this.wait(e => e.kind === 'tool.end' && e.isError, 12000, 'rejected tool.end');
    assert.match(String(end.response), text);
  }
}

// `settings` are Claude Code's for this session alone, on its command line.
const settingsArgs = settings => (settings ? ['--settings', shq(JSON.stringify(settings))] : []);

// With `shell`, Claude Code is started from a shell, as when someone types `claude` in their terminal, and
// the shell is what's left in the pane once it quits.
function launch({ mode = 'default', sources = 'project', model = MODEL, settings, shell = false } = {}) {
  const env = [
    `HOME=${process.env.HOME}`, `USER=${process.env.USER}`, `PATH=${process.env.PATH}`, `VENES_HOME=${HOME}`, 'DISABLE_UPDATES=1',
    `VENES_DOWNLOADS=${DOWNLOADS}`, `VENES_AUTHORIZED_KEYS=${AUTHORIZED_KEYS}`, `VENES_CLAUDE_SETTINGS=${CLAUDE_SETTINGS}`,
    `VENES_CODEX_SOCKET=${CODEX_SOCKET}`, `VENES_REX_SERVER=${REX_SERVER}`, `VENES_TRASH=${TRASH}`, 'TERM=tmux-256color', 'LANG=en_US.UTF-8', 'LC_ALL=en_US.UTF-8', ...configEnv,
    // The shell left in the pane has this computer's own home, and what's typed into it here isn't its
    // owner's to find in their history.
    'HISTFILE=/dev/null',
  ];
  const claude = ['env', '-i', 'TMUX="$TMUX"', 'TMUX_PANE="$TMUX_PANE"', ...env.map(shq), shq(CLAUDE),
    '--model', model, '--permission-mode', mode, '--setting-sources', sources, ...settingsArgs(settings), '--plugin-dir', shq(PLUGIN)].join(' ');
  const cmd = shell ? `${claude}; exec env -i TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ${env.map(shq).join(' ')} sh` : `exec ${claude}`;
  tmux('new-session', '-d', '-s', 'run', '-x', '110', '-y', '42', '-c', WS, 'sh', '-c', cmd);
}

function launchInRex({ mode = 'default', sources = 'project', model = MODEL, settings } = {}) {
  const env = [
    `HOME=${process.env.HOME}`, `USER=${process.env.USER}`, `PATH=${process.env.PATH}`, `VENES_HOME=${HOME}`, 'DISABLE_UPDATES=1',
    `VENES_DOWNLOADS=${DOWNLOADS}`, `VENES_AUTHORIZED_KEYS=${AUTHORIZED_KEYS}`, `VENES_CLAUDE_SETTINGS=${CLAUDE_SETTINGS}`,
    `VENES_CODEX_SOCKET=${CODEX_SOCKET}`, `VENES_REX_SERVER=${REX_SERVER}`, `VENES_TRASH=${TRASH}`, 'TERM=xterm-256color', 'LANG=en_US.UTF-8', 'LC_ALL=en_US.UTF-8', ...configEnv,
  ];
  const cmd = ['exec', 'env', '-i', 'REX_BLOCK="$REX_BLOCK"', 'REX_SESSION="$REX_SESSION"', 'REX_SERVER="$REX_SERVER"', ...env.map(shq), shq(CLAUDE),
    '--model', model, '--permission-mode', mode, '--setting-sources', sources, ...settingsArgs(settings), '--plugin-dir', shq(PLUGIN)].join(' ');
  const made = JSON.parse(rex('new', 'run', '--json', '--cwd', WS, '--shell=none', '--', 'sh', '-c', cmd));
  inRex.session = made.session_id;
  inRex.block = made.initial_windows[0].block_ids[0];
}

async function ready(run) {
  const end = Date.now() + 40000; let answered = false;
  while (Date.now() < end) {
    const p = run.pane();
    if (/Yes, I accept/.test(p)) { run.key('Down'); await delay(400); run.key('Enter'); await delay(1500); continue; }
    if (!answered && /trust/i.test(p) && /Yes/.test(p)) {
      // A config that hasn't trusted the workspace yet asks, with "No, exit" picked to start with.
      if (/No, exit/.test(p) && !/❯\s*(\d\.\s*)?Yes/.test(p)) { run.key('Down'); await delay(400); }
      run.key('Enter'); answered = true; await delay(1500); continue;
    }
    if (/shortcuts|mode on|\bmanual\b|plan mode|bypass permissions on|accept edits on/i.test(p)) { await delay(1200); return; }
    await delay(200);
  }
  throw new Error(`Claude did not start:\n${run.pane()}`);
}

const cases = {};
const T = (name, opts, fn) => { cases[name] = { opts, fn }; };

T('discovery_and_stream', {}, async r => {
  await r.kind('session.started', 8000);
  const before = await r.session();
  assert.ok(before.pane, 'pane is known from SessionStart');
  assert.equal(before.pane, tmux('display-message', '-p', '-t', 'run', '#{pane_id}').trim());
  const panes = await findClaudePanes([before.tmuxSocket]);
  assert.deepEqual(panes.map(p => p.pane), [before.pane], 'the scan finds Claude in its pane, and nothing else');
  await r.type('Reply with only the word STREAM.');
  const end = await r.turnEnd();
  assert.equal(end.lastMessage.trim(), 'STREAM');
  assert.equal((await r.kind('message.user')).text, 'Reply with only the word STREAM.');
  const delta = await r.kind('message.assistant.delta');
  assert.match(delta.text, /STREAM/);
  assert.equal((await r.session()).status, 'idle');

  // What the reply used is counted from the transcript, for the list of what every agent has used,
  // and costed by the price list the helper came with.
  let usage;
  let today;
  for (const deadline = Date.now() + 20000; Date.now() < deadline && !(today?.tokens.output.at(-1) > 0 && !usage.scanning); await delay(700)) {
    usage = await r.client.request('usage', {});
    today = usage.agents.find(agent => agent.agent === 'claude');
  }
  assert.deepEqual([usage.days.length, usage.days.at(-1), usage.hours.length, usage.scanning], [90, dayOf(Date.now()), 24, false]);
  assert.ok(today.tokens.output.at(-1) > 0 && today.cost.at(-1) > 0, 'today has the reply, and what it would cost');
  assert.ok(today.hourly.tokens.output.slice(-2).some(used => used > 0), 'and so has this hour, or the one before');
  assert.deepEqual([today.tokens.input.length, today.hourly.cost.length], [90, 24]);
  assert.equal(usage.zone, clockOf().name);

  // A reader most of a day from here is told the days and the hours of its own clock.
  const far = clockOf(Math.abs(clockOf().offsetAt(Date.now())) > 6 * 3600_000 ? 'Etc/UTC' : 'Pacific/Kiritimati');
  let there;
  for (const deadline = Date.now() + 20000; Date.now() < deadline && !(there && !there.scanning); await delay(700)) {
    there = await r.client.request('usage', { timeZone: far.name });
  }
  assert.deepEqual(
    [there.zone, there.days.length, there.days.at(-1), there.hours.at(-1), there.scanning],
    [far.name, 90, dayOf(Date.now(), far.offsetAt), hourOf(Date.now(), far.offsetAt), false],
  );
  const reply = there.agents.find(agent => agent.agent === 'claude');
  assert.ok(reply.hourly.tokens.output.slice(-2).some(used => used > 0), 'with the reply in its last hours there');
});

T('approve_from_client', {}, async r => {
  await r.type(TOUCH('allow'));
  const request = await r.request('permission');
  assert.equal(request.toolName, 'Bash');
  assert.ok(request.toolUseId, 'paired with PreToolUse');
  assert.equal((await r.session()).status, 'waiting');
  assert.match(r.pane(), /Do you want to proceed/, 'terminal dialog is visible at the same time');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  assert.equal((await r.closed(request.id)).by, 'client');
  await r.turnEnd();
  assert.ok(exists('e2e-allow.txt'));
  assert.ok(r.events.some(e => e.kind === 'tool.end' && e.name === 'Bash' && !e.isError));
});

T('deny_from_client', {}, async r => {
  await r.type(TOUCH('deny'));
  const request = await r.request('permission');
  r.denyEverything('Denied from the phone.');
  assert.deepEqual((({ decision, by }) => [decision, by])(await r.closed(request.id)), ['deny', 'client']);
  // In the terminal's words, which say it's the user's answer and not a failure to retry.
  await r.deliveredToClaude(/To tell you how to proceed, the user said:\s*Denied from the phone/);
  await r.turnEnd();
  assert.ok(!exists('e2e-deny.txt'));
});

// As Esc does in the terminal.
T('deny_with_nothing_said_stops_the_turn', {}, async r => {
  await r.type(TOUCH('stop'));
  const request = await r.request('permission');
  await r.client.request('respond', { requestId: request.id, decision: 'deny' });
  assert.deepEqual((({ decision, by }) => [decision, by])(await r.closed(request.id)), ['deny', 'client']);
  await r.kind('turn.interrupted', 8000);
  assert.equal((await r.session()).status, 'idle');
  assert.ok(!exists('e2e-stop.txt'));
});

// A permission prompt's rows past Yes and before No are read off the terminal, and one picked on a
// client is pressed there, so Claude Code does what that row does.
T('a_prompt_offers_its_rows_and_a_row_is_pressed_there', {}, async r => {
  await r.type('Use the Write tool to create e2e-rows.txt containing the word rows, then reply with only the word DONE.');
  const request = await r.request('permission');
  const { request: updated } = await r.wait(e => e.kind === 'request.updated' && e.request.id === request.id, 5000, 'request.updated');
  console.log(`      rows: ${updated.options.map(o => o.label).join(' | ')}`);
  assert.ok(updated.options.length > 0, 'a write offers more than Yes and No');
  const [row] = updated.options;
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', option: '9' }), { code: 'bad_option' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow', option: row.id });
  assert.deepEqual((({ decision, by }) => [decision, by])(await r.closed(request.id)), ['allow', 'client']);
  await r.turnEnd(60000);
  assert.ok(exists('e2e-rows.txt'));
  if (/edits/i.test(row.label)) assert.equal((await r.session()).permissionMode, 'acceptEdits', row.label);
});

// A row that quotes the whole command, with a path too long for a line: the break inside the path
// isn't read as a space. Claude Code offers a command whole when it finds no prefix in it, as for one
// that starts with a quoted path.
T('a_prompt_row_quoting_a_long_path_reads_it_whole', {}, async r => {
  const folder = `wrap-${'0123456789abcdef-'.repeat(7)}end`;
  await r.type(`Use the Bash tool to run exactly this command: "${WS}/${folder}/bin/python" -m pytest -q 2>&1 | tail -5; ls -a -- then reply with only the word DONE.`);
  const request = await r.request('permission');
  const { request: updated } = await r.wait(e => e.kind === 'request.updated' && e.request.id === request.id, 5000, 'request.updated')
    .catch(() => ({ request: { options: [] } }));
  const quoting = updated.options.find(o => o.label.includes('wrap-'));
  console.log(`      rows: ${updated.options.map(o => o.label.slice(0, 70)).join(' | ') || 'none'}`);
  await r.client.request('respond', { requestId: request.id, decision: 'deny', message: 'Not needed. Just reply.' });
  await r.turnEnd();
  if (!quoting) return;
  assert.ok(quoting.label.includes(folder), quoting.label);
});

T('in_rex_a_prompt_row_is_pressed_there', { rex: true }, async r => {
  await r.type('Use the Write tool to create e2e-rexrows.txt containing the word rows, then reply with only the word DONE.');
  const request = await r.request('permission');
  const { request: updated } = await r.wait(e => e.kind === 'request.updated' && e.request.id === request.id, 5000, 'request.updated');
  const [row] = updated.options;
  await r.client.request('respond', { requestId: request.id, decision: 'allow', option: row.id });
  assert.deepEqual((({ decision, by }) => [decision, by])(await r.closed(request.id)), ['allow', 'client']);
  await r.turnEnd(60000);
  assert.ok(exists('e2e-rexrows.txt'));
});

// The row that switches to auto mode, where the account has it: Claude Code switches as its own
// prompt would, and nothing more is asked.
T('a_prompt_row_switches_to_auto_mode', {}, async r => {
  await r.type(TOUCH('auto'));
  const request = await r.request('permission');
  const { request: updated } = await r.wait(e => e.kind === 'request.updated' && e.request.id === request.id, 5000, 'request.updated')
    .catch(() => ({ request: { options: [] } }));
  const auto = updated.options.find(o => /auto mode/i.test(o.label));
  if (!auto) {
    console.log(`      this account's prompt has no auto mode row: ${updated.options.map(o => o.label).join(' | ') || 'none'}`);
    await r.client.request('respond', { requestId: request.id, decision: 'allow' });
    await r.turnEnd();
    return;
  }
  await r.client.request('respond', { requestId: request.id, decision: 'allow', option: auto.id });
  await r.closed(request.id);
  await r.turnEnd(60000);
  assert.ok(exists('e2e-auto.txt'));
  assert.equal((await r.session()).permissionMode, 'auto');
});

T('terminal_approves_first', {}, async r => {
  await r.type(TOUCH('term'));
  const request = await r.request('permission');
  await delay(1000);
  r.key('1');
  const closed = await r.closed(request.id);
  assert.deepEqual([closed.decision, closed.by], ['allow', 'terminal']);
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'deny' }), { code: 'request_closed' });
  await r.turnEnd();
  assert.ok(exists('e2e-term.txt'));
});

T('terminal_rejects', {}, async r => {
  await r.type(TOUCH('rej'));
  const request = await r.request('permission');
  await delay(1000);
  const pressed = Date.now();
  r.key('Escape');
  const closed = await r.closed(request.id, 8000);
  console.log(`      terminal rejection detected after ${closed.at - pressed}ms`);
  assert.deepEqual([closed.decision, closed.by], ['deny', 'terminal']);
  await r.kind('turn.interrupted', 5000);
  assert.equal((await r.session()).status, 'idle');
  assert.ok(!exists('e2e-rej.txt'));
});

T('interrupt_running_tool', {}, async r => {
  await r.type(`Use the Bash tool in the foreground to run exactly this command: python3 -c 'import time; time.sleep(30)' -- then reply with only the word FINISHED.`);
  const request = await r.request('permission');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await delay(2500);
  const { id } = await r.session();
  const pressed = Date.now();
  await r.client.request('interrupt', { sessionId: id });
  const seen = await r.kind('turn.interrupted', 8000);
  console.log(`      interrupt detected after ${seen.at - pressed}ms`);
  assert.ok(r.events.some(e => e.kind === 'tool.end' && e.isError), 'the running tool is closed');
  assert.equal((await r.session()).status, 'idle');
  await assert.rejects(r.client.request('interrupt', { sessionId: id }), { code: 'not_running' });
});

T('interrupt_generation', {}, async r => {
  await r.type('Write the numbers 1 to 2000, one per line, with no tools.');
  await r.kind('message.assistant.delta', 20000);
  const { id } = await r.session();
  await r.client.request('interrupt', { sessionId: id });
  await r.kind('turn.interrupted', 8000);
  assert.equal((await r.session()).status, 'idle');
});

// Stopped before Claude has answered, a turn is taken back: Claude Code puts the message back in its box
// and writes nothing of it. The turn is over all the same, and the next message is a turn of its own,
// shown as it starts. Once it showed only as its turn ended, and each message after it a turn late.
T('a_turn_stopped_before_claude_answers_is_over', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  await r.client.request('send', { sessionId: id, text: 'Think it over with care, then reply with only the word SLOW.', clientId: 'stopped' });
  await r.wait(e => e.kind === 'message.user' && e.clientId === 'stopped', 12000, 'the message stopped');
  await r.client.request('interrupt', { sessionId: id });
  await r.kind('turn.interrupted', 8000);
  assert.equal((await r.session()).status, 'idle');
  const written = fs.readFileSync((await r.session()).transcriptPath, 'utf8');
  console.log(`      ${/\[Request interrupted by user/.test(written) ? 'Claude had begun, so the stop was written' : 'taken back, with nothing written'}`);
  r.mark();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word PLUM.', clientId: 'next' });
  const echo = await r.wait(e => e.kind === 'message.user' && e.clientId === 'next', 12000, 'the next message, as its turn starts');
  const end = await r.turnEnd(40000);
  assert.ok(r.events.indexOf(echo) < r.events.indexOf(end), 'shown before its turn ends');
  assert.match(end.lastMessage, /PLUM/);
  assert.equal((await r.session()).status, 'idle');
  assert.deepEqual((await r.client.request('join', { sessionId: id, limit: 1 })).queued, [], 'nothing is left queued');
});

T('question_from_client', {}, async r => {
  await r.type(ASK);
  const request = await r.request('question');
  assert.equal(request.input.questions[0].question, 'Which color?');
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', answers: {} }), { code: 'missing_answers' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers: { 'Which color?': 'Blue' } });
  assert.match((await r.turnEnd()).lastMessage, /Blue/);
});

T('question_in_bypass_mode', { mode: 'bypassPermissions' }, async r => {
  await r.type(TOUCH('bypass'));
  await r.turnEnd();
  assert.ok(exists('e2e-bypass.txt'));
  assert.ok(!r.events.some(e => e.kind === 'request.opened'), 'no approval in bypass mode');
  r.mark();
  await r.type(ASK);
  const request = await r.request('question');
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers: { 'Which color?': 'Red' } });
  assert.match((await r.turnEnd()).lastMessage, /Red/);
});

// A file given with an answer follows the option picked, as a reference Claude reads. In bypass mode, so
// reading it out of Downloads asks nothing.
T('question_with_a_file', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the AskUserQuestion tool to ask me one question, "Which color?", with exactly two options: Red and Blue. '
    + 'After I answer, read any file my answer names, then reply with only the color I picked and the marker word in the file.');
  const request = await r.request('question');
  const { id } = await r.session();
  const notes = await r.client.request('upload', { sessionId: id, name: 'answer notes.txt', mediaType: 'text/plain', data: base64('The marker word is FIG.\n') });
  const answers = { 'Which color?': 'Red' };
  await assert.rejects(
    r.client.request('respond', { requestId: request.id, decision: 'allow', answers, attachments: { 'Which color?': ['f'.repeat(32)] } }),
    { code: 'bad_attachment' },
  );
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers, attachments: { 'Which color?': [notes.uploadId] } });
  const end = await r.turnEnd(90000);
  // The answer reached Claude with the file attached to it: the question's own result says so. The reply
  // shows the file was read; that it names the colour too is the model's to choose, and haiku sometimes
  // leaves it out, as it did on 0.28.3 as well.
  const asked = r.events.find(event => event.kind === 'tool.end' && event.name === 'AskUserQuestion');
  const told = JSON.stringify(asked?.response ?? null);
  assert.match(told, /Red/, 'the answer reached Claude');
  assert.match(told, /answer notes\.txt/, 'with the file attached to it');
  assert.match(end.lastMessage, /FIG/i);
});

// A note the reader adds beside an option goes to Claude with the answer, as Claude Code's AskUserQuestion takes
// one, and a Claude Code session says it can take one.
T('question_with_a_note', { mode: 'bypassPermissions' }, async r => {
  await r.type(ASK);
  const request = await r.request('question');
  const { id } = await r.session();
  assert.equal((await r.client.request('capabilities', { sessionId: id })).answerNotes, true);
  const note = 'the darker one, please';
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers: { 'Which color?': 'Blue' }, annotations: { 'Which color?': { notes: note } } });
  await r.turnEnd(90000);
  const asked = r.events.find(event => event.kind === 'tool.end' && event.name === 'AskUserQuestion');
  const told = JSON.stringify(asked?.response ?? null);
  assert.match(told, /Blue/, 'the answer reached Claude');
  assert.ok(told.includes(note), 'with the note beside it');
});

T('plan_approve', { mode: 'plan' }, async r => {
  await r.type(PLAN('plan'));
  const request = await r.request('plan', 60000);
  assert.match(request.input.plan, /e2e-plan/);
  r.mark();
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  const tool = await r.request('permission', 30000);
  await r.client.request('respond', { requestId: tool.id, decision: 'allow' });
  await r.turnEnd();
  assert.ok(exists('e2e-plan.txt'));
  assert.ok(r.events.some(e => e.kind === 'session.mode' && e.permissionMode === 'default'), 'mode change is reported');
});

// A session that worked in default and was cycled to plan mode with Shift+Tab, through acceptEdits, is
// back in default once its plan is approved: Claude Code, left to pick, would keep acceptEdits.
T('plan_approve_returns_to_its_mode', {}, async r => {
  const seen = [];
  r.client.on('message', m => { if (m.type === 'event' && m.event.kind === 'session.mode') seen.push(m.event.permissionMode); });
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  for (let i = 0; i < 5 && !/plan mode on/i.test(r.pane()); i += 1) { r.key('BTab'); await delay(700); }
  assert.match(r.pane(), /plan mode on/i, 'Shift+Tab reaches plan mode');
  await r.type(PLAN('planback'));
  const request = await r.request('plan', 60000);
  assert.match(request.input.plan, /e2e-planback/);
  r.mark();
  // acceptEdits lets a lone touch through, but not one Claude chains with more.
  r.allowEverything();
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd(90000);
  assert.ok(exists('e2e-planback.txt'));
  assert.equal((await r.session()).permissionMode, 'default', `back in the mode it planned from; saw ${seen.join(' → ')}`);
});

// The same from bypassing permissions, which a hook can only switch back to in a session launched in it.
T('plan_approve_returns_to_bypass', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  for (let i = 0; i < 6 && !/plan mode on/i.test(r.pane()); i += 1) { r.key('BTab'); await delay(700); }
  assert.match(r.pane(), /plan mode on/i, 'Shift+Tab reaches plan mode');
  await r.type(PLAN('planbypass'));
  const request = await r.request('plan', 60000);
  assert.equal(request.modeBeforePlan, 'bypassPermissions');
  assert.equal(request.options[0].id, 'bypassPermissions');
  r.mark();
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd(90000);
  assert.ok(exists('e2e-planbypass.txt'));
  assert.equal((await r.session()).permissionMode, 'bypassPermissions');
  assert.match(r.pane(), /bypass permissions on/i);
});

// A plan offers the terminal's ways on, and picking one switches to its mode. Left to pick, Claude Code
// puts a session that started in plan mode in default, as plan_approve shows.
T('plan_approve_with_option', { mode: 'plan' }, async r => {
  await r.type(PLAN('planoption'));
  const request = await r.request('plan', 60000);
  assert.deepEqual(request.options.map(o => o.id), ['acceptEdits', 'default']);
  r.mark();
  r.allowEverything();
  await r.client.request('respond', { requestId: request.id, decision: 'allow', option: 'acceptEdits' });
  await r.turnEnd(90000);
  assert.ok(exists('e2e-planoption.txt'));
  assert.equal((await r.session()).permissionMode, 'acceptEdits');
});

T('plan_reject', { mode: 'plan' }, async r => {
  await r.type(PLAN('planno'));
  const request = await r.request('plan', 60000);
  r.denyEverything('Rejected from the phone.');
  await r.deliveredToClaude(/To tell you how to proceed, the user said:\s*Rejected from the phone/);
  await r.turnEnd(60000);
  assert.ok(!exists('e2e-planno.txt'));
});

T('send_messages', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const long = `Reply with only the word LONG. Ignore the padding: ${'x'.repeat(3000)}`;
  for (const text of ['请只回复 中文收到', '第一行：只回复 多行收到\n第二行：不要解释', '-- reply with only the word DASH;', long]) {
    r.mark();
    await r.client.request('send', { sessionId: id, text });
    assert.equal((await r.kind('message.user', 12000)).text, text);
    await r.turnEnd(30000);
  }
});

T('send_is_held_during_a_request', {}, async r => {
  await r.type(TOUCH('guard'));
  const request = await r.request('permission');
  const { id } = await r.session();
  assert.equal((await r.client.request('send', { sessionId: id, text: 'stray message' })).queued, true);
  await delay(1500);
  assert.ok(!exists('e2e-guard.txt'), 'the held send must not approve the tool');
  r.denyEverything('Denied from the phone.');
  await r.closed(request.id);
  await r.turnEnd();
  assert.ok(!exists('e2e-guard.txt'));
});

T('send_is_blocked_by_an_unknown_dialog', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await r.type('/model');
  await delay(1500);
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'stray message' }), { code: 'dialog_open' });
  r.key('Escape');
});

T('background_agent', {}, async r => {
  r.denyEverything('Not needed. Just reply.'); // the subagent may reach for a tool that needs approval
  await r.type('Use the Agent tool with subagent_type general-purpose and the prompt "Reply with the number 4". Then reply with only the word DONE.');
  await r.kind('agent.start', 30000);
  await r.wait(e => e.kind === 'agent.stop', 45000, 'agent.stop');
  await r.kind('turn.end', 30000);
  await delay(2500);
  const fake = r.events.filter(e => e.kind === 'message.user' && e.text.includes('task-notification'));
  assert.equal(fake.length, 0, 'task notifications are not user messages');
});

T('history', {}, async r => {
  await r.type(TOUCH('hist'));
  const request = await r.request('permission');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd();
  await delay(1500);
  const { id } = await r.session();
  const { items } = await r.client.request('history', { sessionId: id });
  for (const role of ['assistant', 'tool', 'turn_end', 'user']) assert.ok(items.some(i => i.role === role), role);
  assert.equal(items.find(i => i.role === 'tool').name, 'Bash');
});

function solidPng(size, rgb = [0x80, 0x80, 0x80]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from(rgb)))]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

T('a_task_claude_stops_is_over', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Bash tool with run_in_background set to true to run exactly: sleep 300 -- then use the TaskStop tool to stop that task, then reply with only the word STOPPED.');
  await r.wait(e => e.kind === 'turn.end' && /STOPPED/.test(e.lastMessage ?? ''), 60000, 'turn.end STOPPED');
  const tasks = r.events.filter(e => e.kind === 'background.task').map(e => e.task);
  assert.ok(tasks.some(task => task.status === 'running'), 'it was running');
  assert.equal(tasks.at(-1).status, 'killed');
  assert.deepEqual(r.events.findLast(e => e.kind === 'turn.end').tasks, [], 'nothing is left running');
});

T('the_macs_login_picture_comes_small_or_not_at_all', { noHelper: false }, async r => {
  const picture = await r.client.request('avatar');
  if (!picture.data) return;
  const bytes = Buffer.from(picture.data, 'base64');
  assert.equal(picture.mediaType, 'image/jpeg');
  assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8]);
  assert.ok(bytes.length < 200_000, 'small enough to send at every connection');
});

T('an_image_claude_reads_can_be_fetched_and_stays_out_of_events', { mode: 'bypassPermissions' }, async r => {
  const png = solidPng(64);
  fs.writeFileSync(path.join(WS, 'e2e-solid.png'), png);
  await r.type('Use the Read tool on the file e2e-solid.png in this folder, then reply with only the word SEEN.');
  const shown = await r.kind('tool.images', 40000);
  assert.equal(shown.images[0].mediaType, 'image/png');
  const end = await r.kind('tool.end', 20000);
  assert.equal(end.response.file.base64, undefined);
  assert.equal(end.response.file.type, 'image/png', 'what describes it stays');
  await r.turnEnd(40000);
  const { id } = await r.session();
  const image = await r.client.request('image', { sessionId: id, imageId: shown.images[0].id });
  assert.equal(image.mediaType, 'image/png');
  assert.ok(Buffer.from(image.data, 'base64').equals(png), 'the bytes it read');
  await delay(1000);
  const { items } = await r.client.request('history', { sessionId: id });
  assert.deepEqual(items.find(item => item.role === 'tool').images.map(ref => ref.id), [shown.images[0].id], 'a page has the same id');
  await assert.rejects(r.client.request('image', { sessionId: id, imageId: '0:99' }), { code: 'unknown_image' });
});

const base64 = text => Buffer.from(text).toString('base64');
// The file a session's transcript is in, which says how Claude Code took what it was given.
const transcriptOf = id => path.join(sessionFolder(), `${id}.jsonl`);
const fileAttachmentsIn = id => fs.readFileSync(transcriptOf(id), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  .filter(record => record.type === 'attachment' && record.attachment?.type === 'file').map(record => path.basename(record.attachment.filename));

// A picture is pasted as its path, which Claude Code turns into an image, and a file is an @
// reference, which puts its contents in the message: neither needs a tool, or a permission.
async function sendsAPictureAndAFile(r) {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  const picture = await r.client.request('upload', { sessionId: id, name: 'red square.png', mediaType: 'image/png', data: solidPng(64, [230, 20, 20]).toString('base64') });
  assert.deepEqual([picture.kind, picture.name], ['image', 'red-square.png']);
  const notes = await r.client.request('upload', { sessionId: id, name: 'my notes.txt', mediaType: 'text/plain', data: base64('The marker word is PLUM.\n') });
  assert.deepEqual([notes.kind, notes.name, notes.size], ['file', 'my notes.txt', 25]);
  // In Downloads, numbered as Finder would if an earlier case left one of the same name.
  const saved = findUpload(paths.uploads, id, notes.uploadId).path;
  assert.equal(path.dirname(saved), DOWNLOADS, 'it went in Downloads');
  const text = 'What colour is the picture, and what is the marker word in the file? Reply with only those two words.';
  await r.client.request('send', { sessionId: id, text, clientId: 'c2', attachments: [picture.uploadId, notes.uploadId] });
  const echo = await r.kind('message.user', 20000);
  assert.equal(echo.clientId, 'c2');
  assert.equal(echo.text, text, 'what was typed for the attachments is not part of the text');
  assert.deepEqual(echo.attachments, [{ uploadId: notes.uploadId, name: 'my notes.txt', mediaType: 'text/plain', size: 25 }]);
  assert.equal((await r.kind('message.images', 20000)).images.length, 1, 'the picture is an image');
  const end = await r.turnEnd(60000);
  assert.match(end.lastMessage, /red/i);
  assert.match(end.lastMessage, /PLUM/i);
  assert.ok(!r.events.some(e => e.kind === 'request.opened'), 'no permission was asked for');
  assert.deepEqual(fileAttachmentsIn(id), [path.basename(saved)], 'Claude Code took the file in itself');
  await delay(1000);
  const { items } = await r.client.request('history', { sessionId: id });
  const sent = items.findLast(item => item.role === 'user');
  assert.deepEqual([sent.text, sent.attachments, sent.images.length], [text, echo.attachments, 1]);
  assert.deepEqual([sent.images[0].width, sent.images[0].height], [64, 64], 'a picture says how big it is');
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'x', attachments: ['f'.repeat(32)] }), { code: 'bad_attachment' });
  const file = await r.client.request('file', { sessionId: id, uploadId: notes.uploadId });
  assert.deepEqual([file.name, file.mediaType, Buffer.from(file.data, 'base64').toString()], ['my notes.txt', 'text/plain', 'The marker word is PLUM.\n']);
  await assert.rejects(r.client.request('file', { sessionId: id, uploadId: 'f'.repeat(32) }), { code: 'unknown_file' });
  // Taken back out of the composer: its file goes from Downloads, unless a message has it.
  assert.equal((await r.client.request('discard', { sessionId: id, uploadId: notes.uploadId })).discarded, false);
  assert.ok(fs.existsSync(saved), 'a file a message has stays');
  const left = await r.client.request('upload', { sessionId: id, name: 'left out.txt', mediaType: 'text/plain', data: base64('Never sent.\n') });
  const leftAt = findUpload(paths.uploads, id, left.uploadId).path;
  assert.equal((await r.client.request('discard', { sessionId: id, uploadId: left.uploadId })).discarded, true);
  assert.equal(fs.existsSync(leftAt), false, 'one taken back out goes from Downloads');
  await assert.rejects(r.client.request('discard', { sessionId: id, uploadId: '../x' }), { code: 'bad_upload' });
}

T('an_attached_picture_and_file_reach_claude', {}, sendsAPictureAndAFile);

// What the phone runs over SSH to send a file, with this run's helper in place of ~/.venes/venes.
function receive(fields, bytes) {
  const env = {
    ...process.env, VENES_HOME: HOME, VENES_DOWNLOADS: DOWNLOADS, VENES_AUTHORIZED_KEYS: AUTHORIZED_KEYS, DISABLE_UPDATES: '1', VENES_SDK_DIR: SDK_DIR,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'receive'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let printed = '';
    child.stdout.on('data', chunk => { printed += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      try { resolve({ code, reply: JSON.parse(printed) }); } catch { reject(new Error(`receive printed ${JSON.stringify(printed)}`)); }
    });
    child.stdin.on('error', () => {}); // it may stop reading once it has turned a file away
    child.stdin.end(Buffer.concat([Buffer.from(`${JSON.stringify({ size: bytes.length, ...fields })}\n`), bytes]));
  });
}

// Claude can't watch a video, so it gets the path, which a tool can open. It comes as the phone
// sends files over SSH: through `receive`, into Downloads.
T('a_video_comes_through_receive_and_goes_in_by_its_path', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  const { code, reply: video } = await receive({ sessionId: id, name: 'screen recording.mov', mediaType: 'video/quicktime' }, Buffer.from('not really a movie'));
  assert.equal(code, 0);
  assert.deepEqual([video.ok, video.kind, video.name, video.size], [true, 'video', 'screen-recording.mov', 18]);
  const where = findUpload(paths.uploads, id, video.uploadId).path;
  assert.equal(path.dirname(where), DOWNLOADS);
  assert.equal(fs.readFileSync(where, 'utf8'), 'not really a movie');
  const text = 'Reply with only the word GOT.';
  await r.client.request('send', { sessionId: id, text, clientId: 'v1', attachments: [video.uploadId] });
  const echo = await r.kind('message.user', 20000);
  assert.deepEqual([echo.clientId, echo.text, echo.attachments.map(file => [file.name, file.mediaType])], ['v1', text, [['screen-recording.mov', 'video/quicktime']]]);
  await r.turnEnd(60000);
  const said = fs.readFileSync(transcriptOf(id), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(record => record.type === 'user' && !record.isMeta).map(record => JSON.stringify(record.message.content)).join(' ');
  assert.ok(said.includes(where), 'its path is in what Claude read');
  assert.ok(!said.includes(`@\\"${where}`), 'and not as a reference');
  const { items } = await r.client.request('history', { sessionId: id });
  assert.deepEqual(items.findLast(item => item.role === 'user').attachments?.map(file => file.uploadId), [video.uploadId]);
  const big = await receive({ sessionId: id, name: 'big.mov', mediaType: 'video/quicktime', size: 31 * 1024 * 1024 }, Buffer.alloc(0));
  assert.deepEqual([big.code, big.reply.ok, big.reply.error?.code], [1, false, 'too_large']);
});

// A phone asks where this Mac's Screen Sharing is, to reach it straight over the tailnet: whatever this
// Mac's Tailscale and Screen Sharing are doing, the reply says so in its own shape.
T('the_screen_says_where_it_is', {}, async r => {
  const access = await r.client.request('screen', {});
  assert.deepEqual([access.user, access.port, typeof access.on, Array.isArray(access.hosts)], [os.userInfo().username, 5900, 'boolean', true]);
  assert.ok(access.hosts.every(host => /^100\./.test(host)), `tailnet addresses only: ${access.hosts}`);
  // Each display, from the top left of them all, as this Mac has at least one while someone's logged in.
  assert.ok(access.displays.length >= 1, 'a display');
  for (const display of access.displays) {
    assert.ok(['x', 'y', 'width', 'height'].every(key => Number.isFinite(display[key])), JSON.stringify(display));
    assert.ok(display.x >= 0 && display.y >= 0 && display.width > 0 && display.height > 0, JSON.stringify(display));
    assert.ok(Number.isInteger(display.id) && display.id > 0, `a CGDirectDisplayID: ${JSON.stringify(display)}`);
  }
});

// A phone that paired through Rex lets its own key in, to send files over SSH. Here that key goes in
// this run's authorized_keys, never this Mac's.
T('a_phone_lets_its_key_in_for_ssh', {}, async r => {
  const { publicKey } = makeOneTimeKey();
  const real = path.join(os.homedir(), '.ssh', 'authorized_keys');
  try {
    const access = await r.client.request('ssh', { publicKey });
    assert.deepEqual([access.user, access.port, Array.isArray(access.hosts)], [os.userInfo().username, 22, true]);
    assert.ok(fs.readFileSync(AUTHORIZED_KEYS, 'utf8').includes(`${publicKey} venes-phone`));
    await assert.rejects(r.client.request('ssh', { publicKey: 'ssh-rsa AAAA' }), { code: 'bad_key' });
  } finally {
    // Never left in this Mac's own, should something have put it there.
    if (fs.existsSync(real) && fs.readFileSync(real, 'utf8').includes(publicKey)) {
      fs.writeFileSync(real, fs.readFileSync(real, 'utf8').split('\n').filter(line => !line.includes(publicKey)).join('\n'));
      assert.fail('the key reached this Mac\'s own authorized_keys');
    }
  }
});

// The session runs the helper as its status line, as setup sets it up in Claude Code's settings,
// and after a reply the phone has what Claude Code told it.
const STAND_IN = { statusLine: { type: 'command', command: `'${HOME}/venes' statusline` } };
async function readsTheStatus(r) {
  const { id } = await r.session();
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  let status;
  for (const deadline = Date.now() + 15000; Date.now() < deadline && !status?.context?.used; await delay(250)) {
    ({ status } = await r.client.request('statusLine', { sessionId: id }));
  }
  assert.ok(status?.model, JSON.stringify(status));
  assert.equal(status.project, path.basename(WS));
  assert.ok(status.context.used > 0 && status.context.size >= 200000, JSON.stringify(status.context));
  assert.ok(typeof status.updatedAt === 'number');
  // A plan's limits, or an API's cost, and one of the two.
  assert.ok(status.fiveHour || status.sevenDay || typeof status.cost === 'number', JSON.stringify(status));
  // A week's limit for one model is there for an account that has one, and says whose it is.
  for (const limit of status.modelLimits ?? []) assert.ok(typeof limit.name === 'string' && limit.name && typeof limit.percent === 'number', JSON.stringify(limit));
  // Setup stood in for the status line in this run's settings, and in nobody else's.
  assert.equal(JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')).statusLine.command, STAND_IN.statusLine.command);
}

T('the_status_line_is_kept_for_the_phone', { settings: STAND_IN }, readsTheStatus);


T('history_pages_and_keeps_messages_sent_during_a_turn', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(5, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: 'Also say the word QUEUED.', clientId: 'queued-1' });
  // Until Claude reads it, a page opened now still has it, as waiting. Its hook can take a moment.
  let waiting = [];
  for (let tries = 0; tries < 20 && !waiting.length; tries += 1) {
    waiting = (await r.client.request('join', { sessionId: id })).queued;
    if (!waiting.length) await delay(200);
  }
  assert.deepEqual(waiting, [{ text: 'Also say the word QUEUED.', clientId: 'queued-1' }]);
  await r.turnEnd(40000);
  assert.deepEqual((await r.client.request('join', { sessionId: id })).queued, [], 'read by now');
  await delay(1500);
  const all = await r.client.request('history', { sessionId: id, limit: 1000 });
  assert.equal(all.hasMore, false);
  assert.ok(all.items.some(i => i.role === 'user' && i.text === 'Also say the word QUEUED.'), 'a message sent during a turn is kept');
  const page = await r.client.request('history', { sessionId: id, limit: 2 });
  const older = await r.client.request('history', { sessionId: id, limit: 2, before: page.before });
  assert.equal(page.hasMore, true);
  assert.deepEqual([...older.items, ...page.items], all.items.slice(older.before), 'pages join up with no overlap');
});

T('join_replays_the_running_turn_and_nothing_twice', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  await delay(2500);
  const { id } = await r.session();
  const before = await r.client.request('join', { sessionId: id });
  assert.deepEqual(before.turn, [], 'a finished turn comes from the transcript alone');
  assert.ok(before.items.some(i => i.role === 'assistant' && /READY/.test(i.text)));
  assert.match(before.sessions[0].lastMessage, /READY/);
  assert.equal(before.sessions[0].lastPrompt, 'Reply with only the word READY.');

  r.mark();
  const prompt = SLEEP(5, 'SECOND');
  await r.type(prompt);
  const start = await r.kind('tool.start', 30000);
  await delay(800); // long enough for the transcript to have the call
  const during = await r.client.request('join', { sessionId: id });
  assert.equal(during.sessions[0].status, 'running');
  assert.ok(!during.items.some(i => i.role === 'user' && i.text === prompt), 'the prompt is in the turn, not the page');
  assert.ok(!during.items.some(i => i.toolUseId === start.toolUseId), 'nor is the running call');
  assert.ok(during.items.some(i => i.text === 'Reply with only the word READY.'), 'the page keeps the turn before');
  assert.equal(during.turn[0].kind, 'message.user');
  assert.equal(during.turn[0].text, prompt);
  assert.ok(during.turn.some(e => e.kind === 'tool.start' && e.toolUseId === start.toolUseId));
  assert.ok(!during.turn.some(e => e.kind === 'tool.end'), 'the call is still running');
  assert.equal(during.turn.at(-1).seq, during.seq, 'nothing newer is left out');

  await r.turnEnd(40000);
  await delay(2500);
  const after = await r.client.request('join', { sessionId: id });
  assert.deepEqual(after.turn, []);
  const tool = after.items.find(i => i.toolUseId === start.toolUseId);
  assert.ok(tool && 'result' in tool, 'once it is over the transcript has it all');
  assert.equal(after.items.filter(i => i.role === 'user' && i.text === prompt).length, 1);
});

T('send_carries_a_client_id', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  const { queued } = await r.client.request('send', { sessionId: id, text: 'Reply with only the word ECHO.', clientId: 'c1', lane: 'later' });
  assert.equal(queued, false, 'an idle session takes it right away');
  assert.equal((await r.kind('message.user', 12000)).clientId, 'c1');
  await r.turnEnd(30000);
});

T('send_during_a_turn', { mode: 'bypassPermissions' }, async r => {
  const echoed = clientId => r.wait(e => e.kind === 'message.user' && e.clientId === clientId, 12000, `echo of ${clientId}`);
  await r.type(SLEEP(10, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();

  assert.equal((await r.client.request('send', { sessionId: id, text: 'Also say the word NEXT.', clientId: 'next', lane: 'next' })).queued, false);
  await delay(1500);
  assert.ok(!r.events.some(e => e.clientId === 'next'), 'it waits in Claude Code\'s queue while the tool runs');

  const later = { sessionId: id, lane: 'later' };
  assert.equal((await r.client.request('send', { ...later, text: 'Reply with only the word LATER.', clientId: 'later' })).queued, true);
  const dropped = await r.client.request('upload', { sessionId: id, name: 'dropped.txt', mediaType: 'text/plain', data: base64('Never read.\n') });
  const droppedAt = findUpload(paths.uploads, id, dropped.uploadId).path;
  const drop = { ...later, text: 'Reply with only the word DROPPED.', clientId: 'drop', attachments: [dropped.uploadId] };
  assert.equal((await r.client.request('send', drop)).queued, true);
  assert.equal((await r.client.request('discard', { sessionId: id, uploadId: dropped.uploadId })).discarded, false, 'a message has it');
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'drop' })).cancelled, true);
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'drop' })).cancelled, false);
  // Taken back, its file is the composer's again, to take out.
  assert.equal((await r.client.request('discard', { sessionId: id, uploadId: dropped.uploadId })).discarded, true);
  assert.equal(fs.existsSync(droppedAt), false, 'taken out, it goes from Downloads');

  await r.kind('tool.end', 20000);
  await echoed('next');
  assert.ok(!r.events.some(e => e.kind === 'turn.end'), 'the next lane is read in the same turn, once the tool is done');

  await r.turnEnd(40000);
  assert.ok(!r.events.some(e => e.clientId === 'later'), 'a held message waits for the turn to end');
  await echoed('later');
  await r.wait(e => e.kind === 'turn.end' && /LATER/.test(e.lastMessage), 30000, 'the held turn');
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'later' })).cancelled, false, 'too late to cancel');
  assert.ok(!r.events.some(e => e.kind === 'message.user' && /DROPPED/.test(e.text)), 'a cancelled message never reaches Claude');
});

T('a_message_with_no_tool_to_wait_for_starts_the_next_turn', { mode: 'bypassPermissions' }, async r => {
  await r.type('Write a 400 word story about a lighthouse. Use no tools.');
  await r.kind('session.status', 30000);
  const { id } = await r.session();
  await delay(800);
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word QUEUED.', clientId: 'q', lane: 'next' });
  await r.wait(e => e.clientId === 'q', 40000, 'the echo');
  assert.ok(r.events.some(e => e.kind === 'turn.end'), 'it comes after the turn it waited for');
  assert.equal((await r.session()).status, 'running', 'and the session is at work on it');
  await r.wait(e => e.kind === 'turn.end' && /QUEUED/.test(e.lastMessage ?? ''), 30000, 'the turn it started');
});

T('a_message_taken_back_at_the_terminal_never_joins_the_conversation', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(8, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word GONE.', clientId: 'q', lane: 'next' });
  await delay(1000);
  r.key('Up');
  const failed = await r.wait(e => e.kind === 'send.failed' && e.clientId === 'q', 8000, 'send.failed');
  assert.equal(failed.code, 'taken_back');
  await r.turnEnd(40000);
  assert.ok(!r.events.some(e => e.kind === 'message.user' && /GONE/.test(e.text)));
});

T('a_message_during_a_request_waits_for_the_answer', {}, async r => {
  await r.type(TOUCH('during'));
  const request = await r.request('permission');
  const { id } = await r.session();
  const { queued } = await r.client.request('send', { sessionId: id, text: 'Also say the word WAITED.', clientId: 'q', lane: 'next' });
  assert.equal(queued, true, 'Enter would have answered the request');
  await delay(1500);
  assert.ok(r.events.some(e => e.kind === 'request.opened') && !r.events.some(e => e.kind === 'request.closed'), 'the request is still open');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.wait(e => e.clientId === 'q', 30000, 'the echo');
});

T('held_message_follows_an_interrupt', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(20, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.', clientId: 'after', lane: 'later' });
  await r.client.request('interrupt', { sessionId: id });
  await r.kind('turn.interrupted', 8000);
  await r.wait(e => e.kind === 'message.user' && e.clientId === 'after', 12000, 'held message');
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'the held turn');
});

T('held_messages_get_past_a_local_command', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(5, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  const later = { sessionId: id, lane: 'later' };
  await r.client.request('send', { ...later, text: '/compact', clientId: 'compact' });
  await r.client.request('send', { ...later, text: 'Reply with only the word AFTER.', clientId: 'after' });
  const compacted = await r.kind('compact.end', 120000);
  const echo = await r.wait(e => e.kind === 'message.user' && e.clientId === 'after', 15000, 'the message behind the command');
  assert.ok(echo.seq > compacted.seq, 'it waits for the compaction to finish');
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'its turn');
});

T('a_compaction_that_fails_ends', {}, async r => {
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: '/compact' });
  const failed = await r.kind('compact.failed', 15000);
  assert.match(failed.message, /Not enough messages/);
  assert.ok(!r.events.some(e => e.kind === 'compact.end'));
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word STILL.', lane: 'later', clientId: 'still' });
  await r.wait(e => e.kind === 'turn.end' && /STILL/.test(e.lastMessage), 30000, 'a message after it');
});

T('always_allow', { sources: 'project,local' }, async r => {
  const prompt = `Use the Bash tool to run exactly this command: python3 -c 'print(40 + 2)' -- then reply with only the word DONE.`;
  try {
    await r.type(prompt);
    const request = await r.request('permission');
    assert.deepEqual(request.permissionSuggestions.map(s => s.type), ['addRules'], 'a rule for this command, nothing wider');
    await r.client.request('respond', { requestId: request.id, decision: 'allow', always: true });
    await r.turnEnd();
    r.mark();
    await r.type(prompt);
    await r.turnEnd();
    assert.ok(r.events.some(e => e.kind === 'tool.end' && /42/.test(e.response?.stdout)), 'the tool ran again');
    assert.ok(!r.events.some(e => e.kind === 'request.opened'), 'without asking');
    assert.equal((await r.session()).permissionMode, 'default', 'the mode is left alone');
    const { permissions } = JSON.parse(fs.readFileSync(path.join(WS, '.claude/settings.local.json'), 'utf8'));
    console.log(`      remembered: ${JSON.stringify(permissions.allow)}`);
    assert.ok(permissions.allow.some(rule => rule.startsWith('Bash(python3')), 'as a rule in the project\'s local settings');
  } finally {
    fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true }); // the rule must not reach other cases
  }
});

T('always_is_not_offered_for_a_mode_switch', {}, async r => {
  await r.type(TOUCH('widen'));
  const request = await r.request('permission');
  assert.deepEqual(request.permissionSuggestions, [], 'touch only gets a mode suggestion, which is withheld');
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', always: true }), { code: 'nothing_to_remember' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd();
  assert.equal((await r.session()).permissionMode, 'default');
});

T('background_command', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Bash tool with run_in_background set to true to run exactly: sleep 3; echo BGDONE -- then reply with only the word STARTED and stop.');
  const { task } = await r.wait(e => e.kind === 'background.task' && e.task.type === 'shell', 30000, 'launch');
  assert.equal(task.status, 'running');
  assert.ok(task.toolUseId);
  const end = await r.turnEnd();
  assert.deepEqual(end.tasks.map(t => t.id), [task.id]);
  const finished = await r.wait(e => e.kind === 'background.task' && e.task.id === task.id && e.task.status !== 'running', 20000, 'finish');
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.task.hasOutput, true);
  const { id, tasks } = await r.session();
  assert.equal(tasks.find(t => t.id === task.id).status, 'completed');
  assert.match((await r.client.request('taskOutput', { sessionId: id, taskId: task.id })).output, /BGDONE/);
});

T('subagent_calls_name_their_parent', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Agent tool with subagent_type general-purpose and this prompt: "Use the Bash tool to run: echo hi. Then reply DONE." Then reply with only the word OK.');
  const parent = await r.wait(e => e.kind === 'tool.start' && e.name === 'Agent', 30000, 'Agent call');
  const inner = await r.wait(e => e.kind === 'tool.start' && e.agentId, 45000, 'subagent call');
  assert.equal(inner.parentToolUseId, parent.toolUseId);
  const { task } = await r.wait(e => e.kind === 'background.task' && e.task.type === 'subagent' && e.task.status !== 'running', 60000, 'finish');
  assert.ok(task.tokens > 0);
  assert.ok(task.toolUses >= 1);
  const { id } = await r.session();
  assert.match((await r.client.request('taskOutput', { sessionId: id, taskId: task.id })).output, /DONE/);
  const { items } = await r.client.request('history', { sessionId: id });
  assert.ok(items.some(i => i.parentToolUseId === parent.toolUseId && i.name === 'Bash'), 'history nests it too');
});

T('compaction_reports_its_size', {}, async r => {
  const started = await r.kind('session.started', 8000);
  assert.equal(started.cwd, fs.realpathSync(WS));
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  await r.client.request('send', { sessionId: id, text: '/compact' });
  const end = await r.kind('compact.end', 120000);
  assert.ok(end.preTokens > 0 && end.postTokens > 0, 'the sizes reach the event');
  await delay(500);
  const { items } = await r.client.request('history', { sessionId: id });
  assert.ok(items.some(i => i.role === 'compact' && i.preTokens === end.preTokens));
  assert.ok(!items.some(i => i.role === 'user' && /being continued/.test(i.text)), 'the summary is not shown as a user message');
});

T('clear_replaces_the_session', {}, async r => {
  await r.type('Reply with only the word FIRST.');
  await r.turnEnd();
  const first = (await r.session()).id;
  r.mark();
  await r.client.request('send', { sessionId: first, text: '/clear' });
  await r.wait(e => e.kind === 'session.ended' && e.sessionId === first, 10000, 'old session ended');
  await r.wait(e => e.kind === 'session.started' && e.sessionId !== first, 10000, 'new session started');
  const { sessions } = await r.client.request('sessions');
  const live = sessions.filter(s => s.status !== 'ended');
  assert.equal(live.length, 1);
  assert.notEqual(live[0].id, first);
  assert.ok(live[0].pane);
});

T('reconnect_replays_events', {}, async r => {
  await r.type('Reply with only the word ONE.');
  await r.turnEnd();
  const { seq } = await new Promise(resolve => {
    r.client.once('message', resolve);
    r.client.request('subscribe').catch(() => {});
  });
  await r.type('Reply with only the word TWO.');
  await delay(100);
  await r.wait(e => e.kind === 'turn.end' && /TWO/.test(e.lastMessage), 30000, 'second turn');
  const late = await HelperClient.connect(paths.clientSocket);
  const replay = [];
  late.on('message', m => { if (m.type === 'event') replay.push(m.event); });
  const { gap } = await late.request('subscribe', { since: seq });
  await delay(200);
  late.close();
  assert.equal(gap, false);
  assert.ok(replay.some(e => e.kind === 'turn.end' && /TWO/.test(e.lastMessage)));
  assert.ok(replay.every(e => e.seq > seq));

  const other = await HelperClient.connect(paths.clientSocket);
  const fromAnotherBoot = await other.request('subscribe', { since: seq, bootId: 'an-earlier-boot' });
  other.close();
  assert.equal(fromAnotherBoot.gap, true, 'a helper restart is reported as a gap');
});

T('plugin_starts_the_helper', { noHelper: true }, async r => {
  const client = await connect();
  const run = new Run(client);
  await client.request('subscribe');
  assert.ok(fs.statSync(paths.launcher).mode & 0o100, 'launcher written');
  assert.match(fs.readFileSync(paths.launcher, 'utf8'), /cli\/venes\.mjs/);
  await r.type('Reply with only the word AUTO.');
  assert.match((await run.turnEnd(30000)).lastMessage, /AUTO/);
  assert.equal(execFileSync(paths.launcher, ['status'], { encoding: 'utf8' }).trim(), 'running');
  client.close();
});

// A copy of this plugin that says it's older, as an install from before an update would be.
function startOlderHelper() {
  const dir = `${HOME}-older`;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const part of ['src', 'cli', '.claude-plugin', 'package.json']) fs.cpSync(path.join(PLUGIN, part), path.join(dir, part), { recursive: true });
  const manifest = path.join(dir, '.claude-plugin/plugin.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '0.0.1' }));
  startHelper(path.join(dir, 'cli/venes.mjs'));
}

T('a_new_session_replaces_an_older_helper', { noHelper: true, before: startOlderHelper }, async r => {
  const client = await connect();
  assert.equal((await client.request('ping')).version, VERSION, 'the plugin\'s session start swapped it');
  const run = new Run(client);
  await client.request('subscribe');
  const { sessions } = await client.request('sessions');
  assert.equal(sessions.length, 1, 'and its own SessionStart reached the new helper');
  assert.ok(sessions[0].pane);
  assert.match(fs.readFileSync(paths.launcher, 'utf8'), new RegExp(CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await r.type('Reply with only the word SWAPPED.');
  assert.match((await run.turnEnd(30000)).lastMessage, /SWAPPED/);
  client.close();
  fs.rmSync(`${HOME}-older`, { recursive: true, force: true });
});

T('helper_down_is_silent', { noHelper: true }, async r => {
  (await connect()).close();
  await stopHelper();
  await r.type(TOUCH('down'));
  await r.waitForPane(/Do you want to proceed/, 25000);
  r.key('1');
  await r.waitForPane(/⏺ DONE/, 20000);
  await delay(800);
  const screen = r.pane();
  assert.doesNotMatch(screen, /hook error|ECONNREFUSED|failed/i, 'no hook noise in the terminal');
  assert.ok(exists('e2e-down.txt'));
  startHelper();
  const client = await connect();
  const run = new Run(client);
  await client.request('subscribe');
  await r.type('Reply with only the word BACK.');
  await run.wait(e => e.kind === 'turn.end' && /BACK/.test(e.lastMessage), 30000, 'turn.end BACK');
  assert.ok((await run.session()).pane, 'the session re-attaches on its next event');
  client.close();
});

T('a_restart_keeps_idle_sessions', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STAYS.');
  await r.turnEnd();
  const before = await r.session();
  await stopHelper();
  startHelper();
  const client = await connect();
  const { sessions } = await client.request('sessions');
  const session = sessions.find(s => s.id === before.id);
  assert.ok(session, 'an idle session is back without having done anything');
  assert.deepEqual([session.pane, session.status], [before.pane, 'idle']);
  assert.match(session.lastMessage, /STAYS/);
  const joined = await client.request('join', { sessionId: before.id });
  assert.ok(joined.items.some(i => i.role === 'assistant' && /STAYS/.test(i.text)));

  const run = new Run(client);
  await client.request('subscribe');
  await client.request('send', { sessionId: before.id, text: 'Reply with only the word AGAIN.' });
  await run.wait(e => e.kind === 'turn.end' && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');
  client.close();
});

// sessions.json outlives a start, so one bad record mustn't keep the helper down for good.
T('a_restart_survives_a_damaged_record', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STAYS.');
  await r.turnEnd();
  const before = await r.session();
  await stopHelper();
  const records = JSON.parse(fs.readFileSync(paths.sessionsFile, 'utf8'));
  fs.writeFileSync(paths.sessionsFile, JSON.stringify(records.map(record => ({ ...record, transcriptPath: HOME }))));
  startHelper();
  const client = await connect();
  const { sessions } = await client.request('sessions');
  assert.ok(sessions.some(s => s.id === before.id), 'still listed, with no last words to show');
  client.close();
});

// The helper forgets a session when it restarts, which leaves it as Claude Code stored it.
async function forgetSessions() {
  await stopHelper();
  fs.rmSync(paths.sessionsFile, { force: true });
  startHelper();
  const client = await connect();
  const run = new Run(client);
  await client.request('subscribe');
  return { client, run };
}

// Claude Code asks about Code Mode at every start of whoever has turned it on, with
// CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1, and not yet said yes to it at a terminal. These two run only
// with that variable set, by themselves: the cases around them have the helper start and resume
// sessions with nobody to answer, and are run without it.
const ASKS_CODE_MODE = process.env.CLAUDE_CODE_EXPERIMENTAL_CODE_MODE === '1';
const NO_CODE_MODE = 'No, start without it';

if (ASKS_CODE_MODE) T('a_question_before_a_resumed_session_is_asked_of_the_reader', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id } = await r.session();
  tmux('kill-session', '-t', 'run');
  await delay(1500);
  const { client, run } = await forgetSessions();
  try {
    const reply = await client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.', clientId: 'first' });
    assert.equal(reply.resumed, true, 'the message is taken');
    const { request } = await run.wait(e => e.kind === 'request.opened' && e.sessionId === id, 20000, 'request.opened');
    const [question] = request.input.questions;
    assert.deepEqual([request.kind, request.toolName, question.header, question.options.map(option => option.label)],
      ['question', 'AskUserQuestion', 'Code Mode (experimental)', [NO_CODE_MODE, 'Yes, turn on Code Mode']]);
    assert.match(question.question, /^In Code Mode, Claude works by writing and running JavaScript/);
    // Nothing is answered for the reader: the session isn't back, and another message is told why.
    await delay(3000);
    assert.equal((await client.request('sessions')).sessions.find(s => s.id === id).pane, null);
    await assert.rejects(client.request('send', { sessionId: id, text: 'and this' }), { code: 'dialog_open' });
    await client.request('respond', { requestId: request.id, decision: 'allow', answers: { [question.question]: NO_CODE_MODE } });
    const said = await run.wait(e => e.kind === 'message.user' && e.sessionId === id, 20000, 'message.user');
    assert.equal(said.clientId, 'first');
    await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');
    assert.ok((await client.request('sessions')).sessions.find(s => s.id === id).pane, 'back in a terminal of its own');
  } finally {
    try { tmux('kill-session', '-t', `venes-${id.slice(0, 8)}`); } catch { /* never started */ }
    client.close();
  }
});

if (ASKS_CODE_MODE) T('a_question_before_a_new_session_is_given_to_the_client_to_ask', {}, async r => {
  const workspace = fs.realpathSync(WS);
  const asked = await r.client.request('start', { cwd: workspace }).then(() => undefined, error => error);
  assert.equal(asked?.code, 'needs_choice', `start said: ${asked?.message}`);
  assert.deepEqual([asked.details.title, asked.details.options], ['Code Mode (experimental)', [NO_CODE_MODE, 'Yes, turn on Code Mode']]);
  // Asked again with no answer, it's the same question in the same terminal, with nothing started.
  const again = await r.client.request('start', { cwd: workspace }).then(() => undefined, error => error);
  assert.equal(again?.code, 'needs_choice');
  const { sessionId } = await r.client.request('start', { cwd: workspace, choice: NO_CODE_MODE });
  try {
    const { sessions } = await r.client.request('sessions');
    assert.ok(sessions.find(s => s.id === sessionId)?.pane, 'the session is there, in the terminal that asked');
  } finally {
    for (const name of tmux('ls', '-F', '#{session_name}').split('\n').filter(name => name.startsWith('venes-new-'))) tmux('kill-session', '-t', name);
  }
});

T('a_stored_session_can_be_listed_read_and_continued', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id } = await r.session();
  tmux('kill-session', '-t', 'run');
  await delay(1500);
  const { client, run } = await forgetSessions();

  const { items } = await client.request('library', { limit: 20 });
  const entry = items.find(item => item.id === id);
  assert.ok(entry, 'it is listed with nothing running');
  assert.equal(entry.status, null);
  assert.ok(entry.title && entry.cwd && entry.lastActiveAt);

  const joined = await client.request('join', { sessionId: id, limit: 20 });
  assert.ok(joined.items.some(item => item.role === 'assistant' && /STORED/.test(item.text)));
  assert.deepEqual([joined.turn, joined.requests, joined.sessions[0].status], [[], [], 'ended']);

  // A leading "-" would be a flag on the command line, were it not kept apart from them.
  const reply = await client.request('send', { sessionId: id, text: '- Reply with only the word AGAIN.', clientId: 'first' });
  assert.equal(reply.resumed, true);
  const said = await run.wait(e => e.kind === 'message.user' && e.sessionId === id, 5000, 'message.user');
  assert.equal(said.clientId, 'first');
  await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');

  const { sessions } = await client.request('sessions');
  assert.ok(sessions.find(s => s.id === id).pane, 'it keeps its id, and now has a pane to type into');
  await client.request('send', { sessionId: id, text: 'Reply with only the word THIRD.' });
  await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /THIRD/.test(e.lastMessage), 30000, 'turn.end THIRD');
  const older = await client.request('history', { sessionId: id, limit: 50 });
  assert.ok(older.items.some(item => item.role === 'assistant' && /STORED/.test(item.text)), 'the conversation carried on from where it was');
  tmux('kill-session', '-t', `venes-${id.slice(0, 8)}`);
  client.close();
});

T('a_new_session_starts_in_a_folder_from_the_list_and_can_be_typed_into', {}, async r => {
  const home = await r.client.request('folders');
  assert.equal(home.home, os.homedir());
  for (const folder of home.recent) assert.deepEqual(Object.keys(folder).sort(), ['name', 'path', 'running', 'trusted']);
  const workspace = fs.realpathSync(WS);
  const level = await r.client.request('folders', { path: path.dirname(workspace) });
  const listed = level.entries.find(entry => entry.path === workspace);
  assert.equal(listed?.name, path.basename(workspace), 'a folder lists the folders in it');
  assert.equal(level.entries.some(entry => entry.name.startsWith('.')), false);
  await assert.rejects(r.client.request('start', { cwd: path.join(workspace, 'e2e-none') }), { code: 'no_folder' });
  // A new folder is made where the reader is looking, for a session to start in, and is listed there after.
  const fresh = path.join(workspace, 'e2e-fresh');
  try {
    const made = await r.client.request('folderCreate', { path: workspace, name: 'e2e-fresh' });
    assert.deepEqual([made.name, made.path, typeof made.trusted, fs.statSync(fresh).isDirectory()], ['e2e-fresh', fresh, 'boolean', true]);
    assert.ok((await r.client.request('folders', { path: workspace })).entries.some(entry => entry.path === fresh));
    await assert.rejects(r.client.request('folderCreate', { path: workspace, name: 'e2e-fresh' }), { code: 'name_taken' });
    await assert.rejects(r.client.request('folderCreate', { path: workspace, name: '../e2e-up' }), { code: 'bad_name' });
    await assert.rejects(r.client.request('folderCreate', { path: path.join(workspace, 'e2e-none'), name: 'x' }), { code: 'no_folder' });
    // And an empty file in it, for the session that starts there to find.
    const file = await r.client.request('folderFileCreate', { path: fresh, name: 'notes.md' });
    assert.deepEqual([file.name, file.path, file.kind, file.size, fs.readFileSync(path.join(fresh, 'notes.md'), 'utf8')],
      ['notes.md', path.join(fresh, 'notes.md'), 'file', 0, '']);
    await assert.rejects(r.client.request('folderFileCreate', { path: fresh, name: 'notes.md' }), { code: 'name_taken' });
    await assert.rejects(r.client.request('folderFileCreate', { path: fresh, name: 'a/b' }), { code: 'bad_name' });
    await assert.rejects(r.client.request('folderFileCreate', { path: 'e2e-fresh', name: 'x' }), { code: 'bad_folder' });
    // With no session named, the folder is looked at as a session's is: its files too, what Claude Code
    // thinks of it, and nothing whose name starts with a dot unless that's asked for.
    fs.writeFileSync(path.join(fresh, '.hidden'), 'h');
    const looked = await r.client.request('files', { path: fresh });
    assert.deepEqual([looked.path, typeof looked.trusted, looked.entries.map(entry => [entry.name, entry.kind])], [fresh, 'boolean', [['notes.md', 'file']]]);
    assert.deepEqual((await r.client.request('files', { path: fresh, hidden: true })).entries.map(entry => entry.name), ['.hidden', 'notes.md']);
    // And a file in it is read, written and deleted by its whole path.
    const where = path.join(fresh, 'notes.md');
    const read = await r.client.request('fileRead', { path: where });
    const wrote = await r.client.request('fileWrite', { path: where, text: '# notes\n', was: { size: read.size, modifiedAt: read.modifiedAt } });
    assert.deepEqual([read.text, wrote.size, fs.readFileSync(where, 'utf8')], ['', 8, '# notes\n']);
    assert.equal(Buffer.from((await r.client.request('fileChunk', { path: where, offset: 0 })).data, 'base64').toString(), '# notes\n');
    await r.client.request('fileDelete', { path: where });
    assert.deepEqual([fs.existsSync(where), fs.readdirSync(TRASH).some(name => name.endsWith('-notes.md'))], [false, true]);
    // A path that isn't whole has nothing to be from.
    await assert.rejects(r.client.request('files', { path: 'e2e-fresh' }), { code: 'bad_path' });
    await assert.rejects(r.client.request('fileRead', {}), { code: 'bad_path' });
    await assert.rejects(r.client.request('fileDelete', { path: 'notes.md' }), { code: 'bad_path' });
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }

  const { sessionId } = await r.client.request('start', { cwd: workspace });
  try {
    const { sessions } = await r.client.request('sessions');
    const started = sessions.find(s => s.id === sessionId);
    assert.ok(started?.pane, 'it can be typed into');
    assert.equal(fs.realpathSync(started.cwd), workspace);
    await r.client.request('send', { sessionId, text: 'Reply with only the word FRESH.', clientId: 'fresh' });
    const said = await r.wait(e => e.kind === 'message.user' && e.sessionId === sessionId, 10000, 'message.user');
    assert.equal(said.clientId, 'fresh');
    await r.wait(e => e.kind === 'turn.end' && e.sessionId === sessionId && /FRESH/.test(e.lastMessage), 30000, 'turn.end FRESH');
    const again = await r.client.request('folders');
    assert.ok(again.recent.find(folder => folder.path === workspace)?.running >= 2, 'its folder is a recent one, with both sessions going');
  } finally {
    for (const name of tmux('ls', '-F', '#{session_name}').split('\n').filter(name => name.startsWith('venes-new-'))) tmux('kill-session', '-t', name);
  }
});

T('a_phone_that_is_away_hears_a_turn_end_sealed_and_one_that_is_here_does_not', {}, async r => {
  const key = crypto.randomBytes(32).toString('base64');
  const token = 'ab'.repeat(32);
  const open = sealed => {
    const text = Buffer.from(sealed.c, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(sealed.n, 'base64'));
    decipher.setAuthTag(text.subarray(text.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(text.subarray(0, text.length - 16)), decipher.final()]).toString('utf8'));
  };
  // Another connection stands for the phone. It registers, so it's here.
  const phone = await connect();
  await phone.request('pushRegister', { deviceId: 'phone-1', token, key, sandbox: true, mac: 'mac-1' });
  pushes.length = 0;
  await r.type('Reply with only the word HERE.');
  await r.turnEnd();
  await delay(1000);
  assert.equal(pushes.length, 0, 'a phone that is connected shows its own');

  phone.close();
  await delay(500);
  r.mark();
  await r.type('Reply with only the word AWAY.');
  await r.turnEnd();
  for (const end = Date.now() + 10000; !pushes.length && Date.now() < end;) await delay(100);
  const [push] = pushes;
  assert.ok(push, 'the phone away heard');
  assert.equal(push.token, token);
  assert.equal(push.sandbox, true);
  assert.match(push.collapseId, /\.finished$/);
  assert.equal(push.payload.aps['mutable-content'], 1);
  const notice = open(push.payload.v);
  assert.equal(notice.kind, 'finished');
  assert.match(notice.body, /AWAY/);
  assert.equal(notice.mac, 'mac-1');
  assert.ok(notice.title, 'with the session\'s name');
  await r.client.request('pushUnregister', { deviceId: 'phone-1' });
});

// /model and /effort save themselves as the defaults for new sessions, in the real settings
// of the Claude this suite borrows. Those three keys go back afterwards, and nothing else moves.
const USER_SETTINGS = path.join(process.env.HOME, '.claude/settings.json');
const SAVED_DEFAULTS = ['model', 'effortLevel', 'modelSettings'];
const readSettings = () => JSON.parse(fs.readFileSync(USER_SETTINGS, 'utf8'));
const readDefaults = () => Object.fromEntries(Object.entries(readSettings()).filter(([key]) => SAVED_DEFAULTS.includes(key)));
function keepingDefaults(fn) {
  return async r => {
    const original = readSettings();
    const before = readDefaults();
    // Built on the original, so that the keys stay in the order they were.
    const putBack = () => {
      const now = readSettings();
      const others = Object.keys({ ...original, ...now }).filter(key => !SAVED_DEFAULTS.includes(key));
      const settings = { ...original };
      for (const key of others) {
        if (key in now) settings[key] = now[key];
        else delete settings[key];
      }
      fs.writeFileSync(USER_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`);
    };
    process.once('exit', putBack);
    try {
      await fn(r, before);
    } finally {
      process.off('exit', putBack);
      putBack();
    }
  };
}

T('a_reader_can_change_the_model_and_effort', {}, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id, model } = await r.session();

  const { commands, models } = await r.client.request('capabilities', { sessionId: id });
  assert.ok(commands.some(command => command.name === 'compact' && command.description), 'it lists commands');
  assert.ok(!commands.some(command => command.name.startsWith('__')));
  assert.ok(models.some(option => option.resolvedModel === model), 'what a session reports is a name clients can look up');
  const sonnet = models.find(option => option.value === 'sonnet');
  assert.ok(sonnet.displayName && sonnet.effortLevels.includes('low'));
  assert.ok(!(await r.client.request('sessions')).sessions.some(session => session.id !== id && session.status !== 'ended'), 'asking leaves no session behind');

  await assert.rejects(r.client.request('configure', { sessionId: id, model: 'two words' }), { code: 'bad_model' });
  await assert.rejects(r.client.request('configure', { sessionId: id, model: 'not-on-offer' }), { code: 'bad_model' });
  await assert.rejects(r.client.request('configure', { sessionId: id, effort: 'extreme' }), { code: 'bad_effort' });

  r.mark();
  await r.client.request('configure', { sessionId: id, model: 'sonnet' });
  assert.equal((await r.kind('session.model', 5000)).model, sonnet.resolvedModel);
  await r.waitForPane(/for this session only/, 5000);

  await r.client.request('configure', { sessionId: id, effort: 'low' });
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
  await r.wait(e => e.kind === 'session.effort' && e.effort === 'low', 30000, 'session.effort low');
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'turn.end AFTER');

  r.mark();
  await r.client.request('configure', { sessionId: id, model: 'haiku', effort: 'high' });
  await r.wait(e => e.kind === 'session.model' && e.model === models.find(option => option.value === 'haiku').resolvedModel, 5000, 'session.model haiku');
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word THIRD.' });
  await r.wait(e => e.kind === 'session.effort' && e.effort === 'high', 30000, 'session.effort high');
  await r.wait(e => e.kind === 'turn.end' && /THIRD/.test(e.lastMessage), 30000, 'turn.end THIRD');

  assert.deepEqual(readDefaults(), before, 'all of it for this session alone');
  assert.deepEqual(r.events.filter(e => e.kind === 'message.user').map(e => e.text), ['Reply with only the word THIRD.'], 'none of it shows as a message');
  const { items } = await r.client.request('history', { sessionId: id, limit: 50 });
  assert.ok(!items.some(item => /^\/(model|effort)/.test(item.text ?? '')), 'or in the history');
}));

T('a_row_that_starts_out_of_sight_can_be_chosen', {}, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const { models } = await r.client.request('capabilities', { sessionId: id });
  r.mark();
  await r.client.request('configure', { sessionId: id, model: models.at(-1).value });
  assert.equal((await r.kind('session.model', 5000)).model, models.at(-1).resolvedModel);
  r.mark();
  await r.client.request('configure', { sessionId: id, model: 'sonnet' });
  assert.equal((await r.kind('session.model', 5000)).model, models.find(option => option.value === 'sonnet').resolvedModel);
  assert.deepEqual(readDefaults(), before);
}));

T('a_change_during_a_turn_applies_at_once', { mode: 'bypassPermissions' }, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  await r.type(SLEEP(8, 'SLEPT'));
  await r.kind('tool.start', 20000);
  await r.client.request('configure', { sessionId: id, model: 'sonnet' });
  await r.kind('session.model', 5000);
  assert.equal((await r.session()).status, 'running', 'without waiting for the turn to end');
  await r.wait(e => e.kind === 'turn.end' && /SLEPT/.test(e.lastMessage), 45000, 'turn.end SLEPT');
  assert.deepEqual(readDefaults(), before);
}));

T('a_warm_cache_doesnt_stop_a_change', { model: 'claude-sonnet-5' }, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await r.client.request('configure', { sessionId: id, effort: 'low' });
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
  await r.wait(e => e.kind === 'session.effort' && e.effort === 'low', 30000, 'session.effort low');
  assert.deepEqual(readDefaults(), before);
}));

T('a_message_sent_with_a_change_waits_for_it', {}, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await Promise.all([
    r.client.request('configure', { sessionId: id, model: 'sonnet', effort: 'low' }),
    r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' }),
  ]);
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'turn.end AFTER');
  assert.deepEqual(readDefaults(), before, 'its Enter never reached the picker');
}));

T('a_draft_at_the_terminal_survives_a_change', {}, keepingDefaults(async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  tmux('send-keys', '-t', 'run', '-l', 'half a thought');
  await delay(300);
  await r.client.request('configure', { sessionId: id, effort: 'low' });
  await r.waitForPane(/half a thought/, 3000);
  r.key('C-u');
}));

T('a_page_opened_from_here_is_closed_again', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const before = fs.readFileSync(USER_SETTINGS, 'utf8');
  for (const text of ['/usage', '/config']) {
    await assert.rejects(r.client.request('send', { sessionId: id, text }), { code: 'terminal_only' }, text);
    assert.doesNotMatch(r.pane(), /Esc to (cancel|clear|close)/, text);
  }
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'turn.end AFTER');
  assert.equal(fs.readFileSync(USER_SETTINGS, 'utf8'), before, 'what was typed next reached Claude, and no setting');
});

// What an @ can name comes from the session's folder, best match first.
T('an_at_offers_the_files_of_the_sessions_folder', {}, async r => {
  await r.kind('session.started', 8000);
  const { id } = await r.session();
  fs.writeFileSync(path.join(WS, 'mention-target.md'), 'here\n');
  try {
    const { items } = await r.client.request('mentions', { sessionId: id, query: '@mention-tar' });
    assert.deepEqual(items[0], { path: 'mention-target.md', kind: 'file' });
    assert.deepEqual((await r.client.request('mentions', { sessionId: id, query: 'zzzzzz-nothing' })).items, []);
    await assert.rejects(r.client.request('mentions', { sessionId: id, query: 3 }), { code: 'bad_query' });
  } finally {
    fs.rmSync(path.join(WS, 'mention-target.md'), { force: true });
  }
});

// What follows an @ that's a path lists the folder it points into, written the way it was typed.
T('an_at_path_lists_the_folder_it_points_into', {}, async r => {
  await r.kind('session.started', 8000);
  const { id } = await r.session();
  const folder = path.join(WS, 'mention-dir');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'inner.txt'), 'here\n');
  const mentions = async query => (await r.client.request('mentions', { sessionId: id, query })).items;
  try {
    assert.deepEqual(await mentions('./mention-d'), [{ path: 'mention-dir/', kind: 'dir' }]);
    assert.deepEqual(await mentions('@./mention-dir/'), [{ path: 'mention-dir/inner.txt', kind: 'file' }]);
    const here = path.basename(WS);
    assert.deepEqual(await mentions(`../${here}/mention-d`), [{ path: `../${here}/mention-dir/`, kind: 'dir' }]);
    assert.deepEqual((await mentions('inner')).map(item => item.path), ['mention-dir/inner.txt']);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

// A line for the shell sent from here runs in the terminal, echoes with its send, and prints; Claude
// then answers it, unless it's been told not to.
const runsAShellLine = async r => {
  await r.kind('session.started', 8000);
  const { id } = await r.session();
  const text = '!printf "a<b & c>d\\n"; echo VENES_SHELL_$((40+2)) >&2';
  await r.client.request('send', { sessionId: id, text, clientId: 'shell-1' });
  const user = await r.wait(e => e.kind === 'message.user' && e.shell, 30000, 'message.user for the line');
  assert.deepEqual([user.text, user.clientId], [text, 'shell-1']);
  const output = await r.wait(e => e.kind === 'message.output', 30000, 'message.output');
  assert.match(`${output.stdout}${output.stderr}`, /a<b & c>d\n[\s\S]*VENES_SHELL_42/);
  assert.equal(output.clientId, 'shell-1');
  return { id, user, output };
};

T('a_line_for_the_shell_prints_and_claude_answers_it', {}, async r => {
  const { id, output } = await runsAShellLine(r);
  assert.equal(output.replies, true);
  await r.turnEnd(60000);
  await delay(2500);
  const { items, turn } = await r.client.request('join', { sessionId: id });
  assert.deepEqual(turn, []);
  const at = items.findIndex(item => item.role === 'user' && item.shell);
  assert.ok(at >= 0, JSON.stringify(items));
  assert.equal(items[at + 1].role, 'output');
  assert.match(`${items[at + 1].stdout}${items[at + 1].stderr}`, /VENES_SHELL_42/);
  assert.equal(items[at + 1].replies, true);
  assert.ok(items.slice(at + 2).some(item => item.role === 'assistant'), 'Claude answered it');
});

T('a_line_for_the_shell_that_claude_wont_answer_is_over_once_it_has_printed', { settings: { respondToBashCommands: false } }, async r => {
  const { id, output } = await runsAShellLine(r);
  assert.equal(output.replies, false);
  await delay(4000);
  assert.ok(!r.events.some(e => e.kind === 'turn.end' || (e.kind === 'session.status' && e.status === 'running')), 'no turn');
  assert.equal((await r.session()).status, 'idle');
  const { items, turn } = await r.client.request('join', { sessionId: id });
  assert.deepEqual(turn, [], 'nothing left open');
  assert.deepEqual(items.slice(-2).map(item => [item.role, item.replies]), [['user', undefined], ['output', false]]);
});

// An app that shows pages says so, and has one a command opens left open to see and work: its keys
// reach it, and closing it lets the next message through.
T('a_page_opened_from_an_app_that_shows_pages_stays_for_it', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const before = fs.readFileSync(USER_SETTINGS, 'utf8');
  const sent = await r.client.request('send', { sessionId: id, text: '/mcp', pages: true });
  assert.equal(sent.page, true);
  const { page } = await r.client.request('page', { sessionId: id });
  const lines = page.lines.map(runs => runs.map(run => run.text).join(''));
  assert.ok(lines.some(line => /MCP/.test(line)), JSON.stringify(lines));
  assert.ok(lines.some(line => /Esc to \w+/.test(line)), 'down to its footer');
  await r.client.request('pageKey', { sessionId: id, key: 'Down' });
  await assert.rejects(r.client.request('pageKey', { sessionId: id, key: 'C-c' }), { code: 'bad_key' });
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'Reply with only the word BLOCKED.' }), { code: 'dialog_open' });
  await r.client.request('pageClose', { sessionId: id });
  assert.deepEqual((await r.client.request('page', { sessionId: id })).page, null);
  await assert.rejects(r.client.request('pageKey', { sessionId: id, key: 'Escape' }), { code: 'no_page' }, 'no Esc for a turn');
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'turn.end AFTER');
  assert.equal(fs.readFileSync(USER_SETTINGS, 'utf8'), before, 'no setting changed');
});

T('a_change_typed_as_a_message_is_for_this_session_too', {}, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: '/model sonnet' });
  await r.wait(e => e.kind === 'session.model', 5000, 'session.model');
  await r.client.request('send', { sessionId: id, text: '/effort low' });
  await assert.rejects(r.client.request('send', { sessionId: id, text: '/model not-on-offer' }), { code: 'bad_model' });
  assert.deepEqual(readDefaults(), before);
}));

T('a_switch_made_at_the_terminal_still_asks_there', {}, keepingDefaults(async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await r.type('/model sonnet');
  await r.waitForPane(/Yes, switch to/, 5000);
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'stray message' }), { code: 'dialog_open' });
  await assert.rejects(r.client.request('configure', { sessionId: id, effort: 'low' }), { code: 'dialog_open' });
  r.key('Escape');
  await r.waitForPane(/Kept model as/, 5000);
  assert.ok(!r.events.some(e => e.kind === 'session.model'), 'and nothing changed');
}));

T('a_choice_for_a_stopped_session_waits_for_its_resume', { mode: 'bypassPermissions' }, keepingDefaults(async (r, before) => {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id } = await r.session();
  tmux('kill-session', '-t', 'run');
  await delay(1500);
  const { client, run } = await forgetSessions();

  const { models } = await client.request('capabilities', { sessionId: id });
  const named = value => models.find(option => option.value === value).resolvedModel;
  const joined = await client.request('join', { sessionId: id, limit: 20 });
  assert.equal(joined.sessions[0].model, named('haiku'), 'it can say what a stopped session last ran on');

  await client.request('configure', { sessionId: id, model: 'sonnet' });
  await client.request('configure', { sessionId: id, effort: 'low' });
  await client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' });
  await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');
  await run.wait(e => e.kind === 'session.model' && e.sessionId === id && e.model === named('sonnet'), 5000, 'session.model');
  assert.equal((await client.request('sessions')).sessions.find(s => s.id === id).effort, 'low');
  assert.deepEqual(readDefaults(), before, 'a resume\'s choice lasts for that session alone');
  tmux('kill-session', '-t', `venes-${id.slice(0, 8)}`);
  client.close();
}));

// The first message's attachments are on the command line Claude Code is resumed with, as references.
T('a_stopped_session_resumes_with_its_attachments', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id } = await r.session();
  tmux('kill-session', '-t', 'run');
  await delay(1500);
  const { client, run } = await forgetSessions();
  const notes = await client.request('upload', { sessionId: id, name: 'notes.txt', mediaType: 'text/plain', data: base64('The marker word is FIG.\n') });
  const text = 'What is the marker word in the file? Reply with only that word.';
  const reply = await client.request('send', { sessionId: id, text, clientId: 'r1', attachments: [notes.uploadId] });
  assert.equal(reply.resumed, true);
  const echo = await run.wait(e => e.kind === 'message.user' && e.sessionId === id, 30000, 'message.user');
  assert.deepEqual([echo.clientId, echo.text, echo.attachments.map(file => file.name)], ['r1', text, ['notes.txt']]);
  await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /FIG/.test(e.lastMessage), 40000, 'turn.end FIG');
  console.log(`    (a reference on the command line ${fileAttachmentsIn(id).includes('notes.txt') ? 'is' : 'is not'} taken in by Claude Code)`);
  await client.request('delete', { sessionId: id });
  assert.equal(fs.existsSync(path.join(paths.uploads, id)), false, 'a session\'s uploads go with it');
  client.close();
});

T('a_shell_left_running_elsewhere_isnt_a_turn', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Bash tool with run_in_background set to true to run exactly this command: sleep 45 -- then reply with only the word STARTED.');
  await r.wait(e => e.kind === 'turn.end' && /STARTED/.test(e.lastMessage), 30000, 'turn.end STARTED');
  const { id } = await r.session();
  const { client } = await forgetSessions();
  const { items } = await client.request('library', { limit: 20 });
  assert.equal(items.find(item => item.id === id)?.status, 'running', 'Claude Code still calls it busy');
  const joined = await client.request('join', { sessionId: id, limit: 20 });
  assert.equal(joined.sessions[0].status, 'idle', 'but its turn is over');
  client.close();
});

// A plain address here, since a tailnet is only another way of reaching the same listener.
const REX_URL = `ws://127.0.0.1:${REX_PORT}`;
const awaitLine = (pipe, test, ms = 5000) => new Promise((resolve, reject) => {
  const found = pipe.stream.lines.find(test);
  if (found) { resolve(found); return; }
  const timer = setTimeout(() => reject(new Error(`no such line; saw ${pipe.stream.lines.length}`)), ms);
  pipe.stream.onLine = line => { if (test(line)) { clearTimeout(timer); resolve(line); } };
});
// What the app runs, with this test's helper in place of ~/.venes/venes.
const pipeCommand = () => [
  '/bin/bash', '-c', `read -t 60 _ && env VENES_HOME='${HOME}' VENES_REX_SERVER='${REX_SERVER}' VENES_DOWNLOADS='${DOWNLOADS}' VENES_AUTHORIZED_KEYS='${AUTHORIZED_KEYS}' DISABLE_UPDATES=1 VENES_SDK_DIR='${SDK_DIR}' '${process.execPath}' '${CLI}' attach --pipe`,
];

if (hasRex) {
  T('over_rex_a_client_reaches_the_helper_with_no_ssh', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const { id } = await r.session();
    const pipe = await openPipe(REX_URL, 'Venes', pipeCommand());
    const hello = JSON.parse(await awaitLine(pipe, line => line.includes('"hello"')));
    assert.equal(hello.version, VERSION);

    await pipe.write(`${JSON.stringify({ id: 1, cmd: 'subscribe' })}\n`);
    const snapshot = JSON.parse(await awaitLine(pipe, line => line.includes('"snapshot"')));
    assert.ok(snapshot.sessions.some(session => session.id === id));

    const long = 'x'.repeat(200_000);
    await pipe.write(`${JSON.stringify({ id: 2, cmd: 'send', sessionId: '00000000-0000-4000-8000-000000000000', text: long })}\n`);
    const reply = JSON.parse(await awaitLine(pipe, line => line.includes('"id":2')));
    assert.equal(reply.error.code, 'message_too_long', 'a long line arrives whole');

    await pipe.write(`${JSON.stringify({ id: 3, cmd: 'send', sessionId: id, text: 'Reply with only the word PIPED.' })}\n`);
    await r.wait(e => e.kind === 'turn.end' && /PIPED/.test(e.lastMessage), 30000, 'turn.end PIPED');
    await awaitLine(pipe, line => line.includes('"turn.end"') && line.includes('PIPED'));

    const page = JSON.parse(await (async () => {
      await pipe.write(`${JSON.stringify({ id: 4, cmd: 'history', sessionId: id, limit: 50 })}\n`);
      return awaitLine(pipe, line => line.includes('"id":4'));
    })());
    assert.ok(page.items.some(item => /PIPED/.test(item.text ?? '')), 'everything comes through, whatever its size');

    const { blocks } = await pipe.control.request('session.list_blocks', { session_id: pipe.sessionId });
    assert.equal(blocks.find(block => block.block_id === pipe.blockId).placement, 'detached', 'no window shows it');
    await pipe.close();
  });

  T('over_rex_a_client_that_vanishes_leaves_no_terminal_behind', { rex: true, mode: 'bypassPermissions' }, async () => {
    const pipe = await openPipe(REX_URL, 'Venes', pipeCommand());
    await awaitLine(pipe, line => line.includes('"hello"'));
    const watcher = await RexControl.connect(REX_URL);
    await watcher.request('session.attach', { session_id: pipe.sessionId });
    const blocks = async () => (await watcher.request('session.list_blocks', { session_id: pipe.sessionId })).blocks ?? [];
    assert.ok((await blocks()).some(block => block.block_id === pipe.blockId));
    pipe.vanish();
    const deadline = Date.now() + 75_000;
    while ((await blocks()).some(block => block.block_id === pipe.blockId)) {
      assert.ok(Date.now() < deadline, 'the terminal stayed');
      await delay(1000);
    }
    watcher.close();
  });

  T('over_rex_a_terminal_nobody_came_for_ends_by_itself', { rex: true, mode: 'bypassPermissions' }, async () => {
    const control = await RexControl.connect(REX_URL);
    const { sessions } = await control.request('session.list');
    const session = sessions.find(entry => entry.label === 'Venes') ?? await control.request('session.create', { label: 'Venes' });
    await control.request('session.attach', { session_id: session.session_id });
    const { block_id: blockId } = await control.request('session.new_block', {
      session_id: session.session_id, flavor: 'com.superlogical.terminal.shell', label: 'venes-attach',
      options: { shell: 'none', login: false, command: ['/bin/bash', '-c', 'read -t 2 _ && sleep 300'] },
    });
    await delay(4000);
    const { blocks } = await control.request('session.list_blocks', { session_id: session.session_id });
    assert.ok(!blocks?.some(block => block.block_id === blockId), 'it stayed');
    control.close();
  });

  T('in_rex_a_session_can_be_typed_into_and_stopped_with_no_tmux', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const { id, pane } = await r.session();
    assert.match(pane, /^block:/, 'the session said where it is');

    r.mark();
    await r.client.request('send', { sessionId: id, text: '- Reply with only the word TYPED.', clientId: 'c1' });
    assert.equal((await r.kind('message.user', 12000)).clientId, 'c1');
    await r.wait(e => e.kind === 'turn.end' && /TYPED/.test(e.lastMessage), 30000, 'turn.end TYPED');

    r.mark();
    await r.client.request('send', { sessionId: id, text: SLEEP(20, 'SLEPT') });
    await r.kind('tool.start', 20000);
    await r.client.request('interrupt', { sessionId: id });
    await r.kind('turn.interrupted', 15000);
  });

  T('in_rex_an_attached_picture_and_file_reach_claude', { rex: true }, sendsAPictureAndAFile);
  T('in_rex_the_status_line_is_kept_for_the_phone', { rex: true, settings: STAND_IN }, readsTheStatus);
  T('in_rex_a_line_for_the_shell_prints', { rex: true }, async r => {
    const { output } = await runsAShellLine(r);
    assert.equal(output.replies, true);
    await r.turnEnd(60000);
  });

  // Rex can have Claude Code name the session it's in after its task, and Claude Code resumed in
  // the helper's session does that too. The helper keeps it by id, and names it back.
  T('in_rex_the_helpers_session_is_found_again_after_something_renames_it', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type('Reply with only the word STORED.');
    await r.turnEnd();
    const { id } = await r.session();
    rex('kill', inRex.session);
    await delay(1500);
    const { client, run } = await forgetSessions();
    const named = label => JSON.parse(rex('session', 'ls', '--json')).sessions.filter(session => session.label === label);
    await client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' });
    await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');
    const [own] = named('Venes');
    rex('session', 'rename', own.session_id, 'fix-login-redirect');
    const first = (await client.request('sessions')).sessions.find(s => s.id === id).pane;
    rex('block', 'close', '-s', own.session_id, first);
    await run.wait(e => e.kind === 'session.ended' && e.sessionId === id, 20000, 'session.ended');
    run.mark();
    await client.request('send', { sessionId: id, text: 'Reply with only the word THIRD.' });
    await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /THIRD/.test(e.lastMessage), 30000, 'turn.end THIRD');
    const { pane } = (await client.request('sessions')).sessions.find(s => s.id === id);
    const { blocks } = JSON.parse(rex('block', 'ls', '-s', own.session_id, '--json'));
    assert.ok(blocks.some(block => block.block_id === pane), 'it opened in the same session');
    assert.deepEqual(named('Venes').map(session => session.session_id), [own.session_id], 'with its name back, and no other');
    rex('kill', own.session_id);
    client.close();
  });

  T('in_rex_a_prompt_on_the_screen_holds_a_message', { rex: true }, async r => {
    await r.type(TOUCH('rex'));
    const request = await r.request('permission');
    const { id } = await r.session();
    assert.equal((await r.client.request('send', { sessionId: id, text: 'stray message' })).queued, true);
    await r.client.request('respond', { requestId: request.id, decision: 'allow' });
    await r.turnEnd();
    assert.ok(exists('e2e-rex.txt'), 'answered from here, in a session in Rex');
  });

  T('in_rex_the_model_and_effort_change_for_this_session', { rex: true }, keepingDefaults(async (r, before) => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const { id } = await r.session();
    r.mark();
    await r.client.request('configure', { sessionId: id, model: 'sonnet', effort: 'low' });
    await r.kind('session.model', 5000);
    await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
    await r.wait(e => e.kind === 'session.effort' && e.effort === 'low', 30000, 'session.effort low');
    assert.deepEqual(readDefaults(), before);
  }));

  // /config is the tallest page there is, and fills the screen.
  T('in_rex_config_opened_from_an_app_that_shows_pages_can_be_read', { rex: true }, async r => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const { id } = await r.session();
    assert.equal((await r.client.request('send', { sessionId: id, text: '/config', pages: true })).page, true);
    const { page } = await r.client.request('page', { sessionId: id });
    const lines = page.lines.map(runs => runs.map(run => run.text).join(''));
    assert.ok(lines.some(line => /Settings/.test(line)) && lines.some(line => /Auto-compact/.test(line)), JSON.stringify(lines));
    await r.client.request('pageClose', { sessionId: id });
    assert.deepEqual((await r.client.request('page', { sessionId: id })).page, null);
  });

  T('in_rex_a_page_opened_from_here_is_closed_again', { rex: true }, async r => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const { id } = await r.session();
    await assert.rejects(r.client.request('send', { sessionId: id, text: '/usage' }), { code: 'terminal_only' });
    await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.' });
    await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'turn.end AFTER');
  });

  T('in_rex_a_stopped_session_resumes_with_no_tmux', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type('Reply with only the word STORED.');
    await r.turnEnd();
    const { id } = await r.session();
    rex('kill', inRex.session);
    await delay(1500);
    const { client, run } = await forgetSessions();

    const reply = await client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.', clientId: 'first' });
    assert.equal(reply.resumed, true);
    await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 30000, 'turn.end AGAIN');
    const { sessions } = await client.request('sessions');
    const { pane } = sessions.find(s => s.id === id);
    assert.match(pane, /^block:/);
    const { blocks } = JSON.parse(rex('block', 'ls', '-s', 'Venes', '--json'));
    assert.equal(blocks.find(block => block.block_id === pane).label, `venes-${id.slice(0, 8)}`, 'it has a window in the session the helper keeps');
    await client.request('send', { sessionId: id, text: 'Reply with only the word THIRD.' });
    await run.wait(e => e.kind === 'turn.end' && e.sessionId === id && /THIRD/.test(e.lastMessage), 30000, 'turn.end THIRD');
    rex('kill', 'Venes');
    client.close();
  });

  T('in_rex_a_restart_keeps_the_session', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type('Reply with only the word READY.');
    await r.turnEnd();
    const before = await r.session();
    await delay(2500);
    await stopHelper();
    startHelper();
    const client = await connect();
    const run = new Run(client);
    await client.request('subscribe');
    const session = (await client.request('sessions')).sessions.find(s => s.id === before.id);
    assert.equal(session?.pane, before.pane, 'it came back with its block');
    await client.request('send', { sessionId: before.id, text: 'Reply with only the word BACK.' });
    await run.wait(e => e.kind === 'turn.end' && /BACK/.test(e.lastMessage), 30000, 'turn.end BACK');
    client.close();
  });

  T('in_rex_a_running_session_ends_before_it_is_deleted', { rex: true, mode: 'bypassPermissions' }, async r => {
    await r.type(SLEEP(20, 'SLEPT'));
    await r.kind('tool.start', 20000);
    const { id, transcriptPath } = await r.session();
    await r.client.request('delete', { sessionId: id });
    await r.kind('session.deleted', 2000);
    await delay(1000);
    assert.ok(!fs.existsSync(transcriptPath));
  });
}

// The command line a session's agent runs here, as its status sheet shows it.
T('a_sessions_cli_is_the_claude_code_it_runs', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const cli = await r.client.request('cli', { sessionId: id });
  const installed = execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).match(/\d+\.\d+\.\d+/)[0];
  assert.deepEqual([cli.agent, cli.installed, cli.running, cli.restart], ['claude', installed, installed, null]);
  assert.ok(['available', 'none', 'manual'].includes(cli.update), cli.update);
});

// What a restart brings: the session back, or first a question Claude Code asks as it starts, as it asks
// someone starting it in Bypass Permissions mode for the first time. That's the reader's to answer, here with yes.
async function backAfterRestart(r) {
  const first = await r.wait(e => e.kind === 'session.started' || e.kind === 'request.opened', 40000, 'session.started or a question');
  if (first.kind !== 'request.opened') return first;
  const question = first.request.input.questions[0];
  const yes = question.options.find(option => /^Yes/.test(option.label)).label;
  await r.client.request('respond', { requestId: first.request.id, decision: 'allow', answers: { [question.question]: yes } });
  return r.kind('session.started', 40000);
}

// A restart quits Claude Code and picks the session up again where it was, which then answers as before.
// A session resumed in a terminal of its own has one the case doesn't: it goes with the case.
const closeResumed = id => { try { tmux('kill-session', '-t', `venes-${id.slice(0, 8)}`); } catch { /* none, or it's in Rex */ } };

// The session in this case's own terminal. A helper can also know of one an earlier case left.
async function ownSession(r) {
  const pane = inRex ? inRex.block : tmux('display-message', '-p', '-t', 'run', '#{pane_id}').trim();
  const { sessions } = await r.client.request('sessions');
  return sessions.find(session => session.pane === pane);
}

// A restarted session is quit as the case ends, so that no later case's helper finds it still going.
async function quitRestarted(r, id) {
  await r.client.request('send', { sessionId: id, text: '/exit' }).catch(() => {});
  await r.wait(e => e.kind === 'session.ended' && e.sessionId === id, 15000, 'its end').catch(() => {});
  closeResumed(id);
}

async function restartsAndAnswers(r) {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await ownSession(r);
  r.after(() => quitRestarted(r, id));
  r.mark();
  assert.equal((await r.client.request('restart', { sessionId: id })).restart, 'now');
  await r.kind('session.ended', 20000);
  assert.equal((await backAfterRestart(r)).source, 'resume');
  r.mark();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' });
  assert.match((await r.turnEnd(60000)).lastMessage ?? '', /AGAIN/);
  return id;
}

T('an_idle_session_restarts_and_answers_again', { mode: 'bypassPermissions' }, restartsAndAnswers);
T('in_rex_an_idle_session_restarts_and_answers_again', { rex: true, mode: 'bypassPermissions' }, restartsAndAnswers);

T('a_session_started_from_a_shell_restarts_in_that_shell', { mode: 'bypassPermissions', shell: true }, async r => {
  const pane = tmux('display-message', '-p', '-t', 'run', '#{pane_id}').trim();
  const id = await restartsAndAnswers(r);
  const { sessions } = await r.client.request('sessions');
  assert.equal(sessions.find(session => session.id === id).pane, pane, 'in the terminal it was in');
});

T('a_restart_asked_during_a_turn_waits_for_its_end', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(12, 'SLEPT'));
  await r.kind('tool.start', 20000);
  const { id } = await ownSession(r);
  r.after(() => quitRestarted(r, id));
  r.mark();
  assert.equal((await r.client.request('restart', { sessionId: id })).restart, 'pending');
  assert.equal((await r.client.request('cli', { sessionId: id })).restart, 'pending');
  await r.turnEnd(60000);
  await r.kind('session.ended', 20000);
  assert.equal((await backAfterRestart(r)).source, 'resume');
});

// Closing quits the session's Claude Code on the computer and keeps the conversation, which a message
// opens again.
async function closesAndOpensAgain(r) {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await ownSession(r);
  r.after(() => quitRestarted(r, id));
  assert.equal((await r.client.request('cli', { sessionId: id })).closable, true);
  r.mark();
  assert.equal((await r.client.request('close', { sessionId: id })).close, 'now');
  await r.kind('session.ended', 20000);
  const cli = await r.client.request('cli', { sessionId: id });
  assert.deepEqual([cli.closable, cli.close, cli.closeError], [false, null, undefined]);
  await assert.rejects(r.client.request('close', { sessionId: id }), { code: 'not_open' });
  r.mark();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' });
  assert.match((await r.turnEnd(60000)).lastMessage ?? '', /AGAIN/);
}

T('an_idle_session_closes_and_a_message_opens_it_again', {}, closesAndOpensAgain);
T('in_rex_an_idle_session_closes_and_a_message_opens_it_again', { rex: true }, closesAndOpensAgain);

T('a_close_asked_during_a_turn_waits_for_its_end', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(8, 'SLEPT'));
  await r.kind('tool.start', 20000);
  const { id } = await ownSession(r);
  r.mark();
  assert.equal((await r.client.request('close', { sessionId: id })).close, 'pending');
  assert.equal((await r.client.request('cli', { sessionId: id })).close, 'pending');
  const end = await r.turnEnd(60000);
  assert.match(end.lastMessage ?? '', /SLEPT/, 'the turn was let finish');
  await r.kind('session.ended', 20000);
});

// Claude Code killed outright says nothing, and its terminal goes with it. The helper finds the terminal
// gone, which ends the session, and a message picks it up again. (A terminal closed in Rex can end the
// same way: Rex gives Claude Code a second before it kills it, which is about what Claude Code takes to end.)
const claudePid = () => (inRex
  ? JSON.parse(rex('block', 'call', '-s', inRex.session, '-b', inRex.block, 'process', '{}')).foreground.pid
  : Number(tmux('display-message', '-p', '-t', 'run', '#{pane_pid}').trim()));
async function killedOutright(r) {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id } = await ownSession(r);
  r.after(() => quitRestarted(r, id));
  r.mark();
  process.kill(claudePid(), 'SIGKILL');
  return id;
}
const answersAgain = (r, id) => r.wait(e => e.kind === 'turn.end' && e.sessionId === id && /AGAIN/.test(e.lastMessage), 40000, 'turn.end AGAIN');

async function aSessionKilledOutrightIsOver(r) {
  const id = await killedOutright(r);
  const ended = await r.wait(e => e.kind === 'session.ended' && e.sessionId === id, 20000, 'session.ended');
  assert.equal(ended.reason, 'terminal_closed');
  assert.equal((await r.client.request('sessions')).sessions.find(s => s.id === id).status, 'ended');
  assert.equal((await r.client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' })).resumed, true);
  await answersAgain(r, id);
}
T('a_session_killed_outright_is_over', { mode: 'bypassPermissions' }, aSessionKilledOutrightIsOver);
T('in_rex_a_session_killed_outright_is_over', { rex: true, mode: 'bypassPermissions' }, aSessionKilledOutrightIsOver);

// A message that gets there before the helper has looked finds the terminal gone itself.
async function aMessageRightAfterResumesIt(r) {
  const id = await killedOutright(r);
  // Its terminal closes a moment after it.
  await delay(1500);
  assert.equal((await r.client.request('send', { sessionId: id, text: 'Reply with only the word AGAIN.' })).resumed, true);
  await answersAgain(r, id);
  assert.ok(r.events.some(e => e.kind === 'session.ended' && e.sessionId === id && e.reason === 'terminal_closed'), 'and the session was said to be over first');
}
T('a_message_for_a_session_killed_outright_resumes_it', { mode: 'bypassPermissions' }, aMessageRightAfterResumesIt);
T('in_rex_a_message_for_a_session_killed_outright_resumes_it', { rex: true, mode: 'bypassPermissions' }, aMessageRightAfterResumesIt);

T('a_stopped_session_can_be_deleted_for_good', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word STORED.');
  await r.turnEnd();
  const { id, transcriptPath } = await r.session();
  assert.ok(fs.existsSync(transcriptPath));
  tmux('kill-session', '-t', 'run');
  await delay(1500);
  const { client, run } = await forgetSessions();

  await client.request('delete', { sessionId: id });
  assert.equal((await run.kind('session.deleted', 2000)).sessionId, id);
  assert.ok(!fs.existsSync(transcriptPath), 'its transcript has gone from this Mac');
  const { items } = await client.request('library', { limit: 50 });
  assert.ok(!items.some(item => item.id === id), 'and Claude Code no longer lists it');
  await assert.rejects(client.request('join', { sessionId: id, limit: 20 }), { code: 'unknown_session' });
  await assert.rejects(client.request('delete', { sessionId: id }), { code: 'unknown_session' });
  await assert.rejects(client.request('send', { sessionId: id, text: 'hello' }), { code: 'unknown_session' });
  client.close();
});

T('a_running_session_ends_before_it_is_deleted', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  r.mark();
  await r.type(SLEEP(20, 'SLEPT'));
  await r.kind('tool.start', 20000);
  const { id, transcriptPath } = await r.session();

  await r.client.request('delete', { sessionId: id });
  await r.kind('session.deleted', 2000);
  await delay(1500);
  assert.ok(!fs.existsSync(transcriptPath), 'and nothing wrote it back');
  const { sessions } = await r.client.request('sessions');
  assert.ok(!sessions.some(session => session.id === id), 'nor did its last hooks bring it back');
});

// Claude Code lists every process of its own among the sessions that are running, the ones the helper
// starts itself to read the account's limits and what a folder offers too, each named for its folder.
// Those aren't sessions, so the list leaves them out, while Claude Code's own list has them.
// Each of the helper's own runs is held open a few seconds after it has answered, so that the list is asked
// while it's there.
T('the_helpers_own_runs_of_claude_code_arent_listed', { helperEnv: { VENES_HOLD_OWN_RUNS_MS: '4000' } }, async r => {
  const { id } = await r.session();
  const registry = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'sessions');
  // Claude Code writes down each process of its own as it starts, and takes it away as it ends.
  const running = () => fs.readdirSync(registry).filter(name => /^\d+\.json$/.test(name)).flatMap(name => {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(registry, name), 'utf8'));
      return entry.sessionId ? [entry.sessionId] : [];
    } catch {
      return []; // being written, or gone
    }
  });
  const before = new Set([id, ...running(), ...(await r.client.request('library', { limit: 50 })).items.map(item => item.id)]);
  const seen = new Set();
  const listed = new Set();
  let isLooking = true;
  const watchClaudeCode = (async () => {
    while (isLooking) {
      for (const found of running()) if (!before.has(found)) seen.add(found);
      await delay(20);
    }
  })();
  // Asked of the list several at once, so that one is asked while a run lasts.
  const watchList = Array.from({ length: 2 }, () => (async () => {
    while (isLooking) for (const item of (await r.client.request('library', { limit: 50 })).items) if (!before.has(item.id)) listed.add(item.id);
  })());
  // Two of them: one in the home folder for the account's limits, and one in the session's folder for what it offers.
  await Promise.all([r.client.request('usage', {}), r.client.request('capabilities', { sessionId: id })]);
  // A run can outlast its reply: looked at until they've gone.
  for (const end = Date.now() + 15000; Date.now() < end && !(seen.size >= 2 && !running().some(found => seen.has(found))); await delay(100));
  await delay(500);
  isLooking = false;
  await Promise.all([watchClaudeCode, ...watchList]);
  assert.ok(seen.size >= 2, `Claude Code wrote down the helper's runs, as it does every process of its own (${seen.size})`);
  assert.deepEqual([...listed], [], 'and the helper left them out of the list');
});

T('a_session_running_elsewhere_is_listed_but_not_resumed', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word ELSEWHERE.');
  await r.turnEnd();
  const { id } = await r.session();
  const { client } = await forgetSessions();
  const { items } = await client.request('library', { limit: 20 });
  assert.equal(items.find(item => item.id === id)?.status, 'idle', 'claude agents knows it even though the helper doesn\'t');
  const joined = await client.request('join', { sessionId: id, limit: 20 });
  assert.equal(joined.sessions[0].status, 'idle');
  await assert.rejects(client.request('send', { sessionId: id, text: 'hello' }), { code: 'no_pane' });
  await assert.rejects(client.request('configure', { sessionId: id, model: 'sonnet' }), { code: 'no_pane' });
  client.close();
});

// Opt-in, because it needs key login to this Mac. Starts nothing locally: the
// helper comes up through the same SSH command the app runs, with SSH's minimal PATH.
if (process.env.VENES_E2E_SSH) T('over_real_ssh', { noHelper: true }, async r => {
  (await connect()).close();
  await stopHelper();
  const connectSsh = () => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', `${process.env.USER}@localhost`, paths.launcher, 'attach'], { stdio: ['pipe', 'pipe', 'inherit'] });
    return { child, client: HelperClient.over(child.stdout, child.stdin) };
  };
  try {
    const first = connectSsh();
    const run = new Run(first.client);
    await first.client.request('subscribe');

    await r.type(TOUCH('ssh'));
    const request = await run.request('permission');
    await first.client.request('respond', { requestId: request.id, decision: 'allow' });
    await run.turnEnd();
    assert.ok(exists('e2e-ssh.txt'), 'approved over SSH');

    run.mark();
    const { id } = await run.session();
    await first.client.request('send', { sessionId: id, text: 'Reply with only the word SSHOK.' });
    assert.equal((await run.kind('message.user', 12000)).text, 'Reply with only the word SSHOK.');
    await run.turnEnd(30000);

    const gone = new Promise(resolve => { first.child.once('exit', resolve); });
    first.child.stdin.end();
    await gone;
    await delay(500);

    const second = connectSsh();
    const { sessions } = await second.client.request('sessions');
    assert.ok(sessions.some(s => s.id === id), 'the helper outlives the SSH connection');
    second.child.kill();
  } finally {
    await stopHelper();
  }
});

// Codex sessions, through a server of Codex's own that the case runs. `codex` is what its threads start
// with: sandboxed, so that nothing here depends on this Mac's Codex settings, or writes to them.
async function startCodex(r) {
  const cwd = fs.realpathSync(WS);
  assert.equal((await r.client.request('folders')).codex, true, 'the folders say Codex is here');
  // Codex's server would trust the folder without a word, so the helper asks first.
  await assert.rejects(r.client.request('start', { cwd, agent: 'codex' }), { code: 'needs_trust' });
  const { sessionId } = await r.client.request('start', { cwd, agent: 'codex', trust: true });
  const { models, commands } = await r.client.request('capabilities', { sessionId });
  assert.deepEqual(commands.map(command => command.name), ['compact', 'review', 'init', 'rename', 'fork', 'archive']);
  // Whatever skills this Mac's Codex has on, each says its name and what it's for.
  const { skills } = await r.client.request('capabilities', { sessionId });
  assert.ok(Array.isArray(skills) && skills.every(skill => skill.name && typeof skill.description === 'string' && !('path' in skill)), JSON.stringify(skills).slice(0, 300));
  assert.ok(models.length > 0, 'Codex lists its models');
  const model = models.find(offer => offer.value === CODEX_MODEL) ?? models.find(offer => offer.isDefault) ?? models[0];
  await r.client.request('configure', { sessionId, model: model.value, effort: model.effortLevels.includes(CODEX_EFFORT) ? CODEX_EFFORT : model.effortLevels[0] });
  return { sessionId, model: model.value };
}

T('codex_session_replies_runs_a_line_and_is_kept', { codex: { sandbox: 'read-only', approvalPolicy: 'on-request', terminal: true } }, async r => {
  const { sessionId, model } = await startCodex(r);
  const listed = (await r.client.request('sessions')).sessions.find(session => session.id === sessionId);
  assert.deepEqual([listed.agent, listed.status, listed.model, listed.pane], ['codex', 'idle', model, null]);
  // What it may do without asking is one of Codex's three choices, here the one this run starts its threads with,
  // and it can be switched to planning.
  assert.deepEqual([listed.permissionMode, listed.permissionModes], ['readOnly', ['readOnly', 'workspace', 'fullAccess', 'plan']]);
  await assert.rejects(r.client.request('setMode', { sessionId, mode: 'bypassPermissions' }), { code: 'bad_mode' });
  // Chosen again, it goes to Codex with the turn below, which Codex has to take as it's put.
  await r.client.request('setMode', { sessionId, mode: 'readOnly' });
  // A client that doesn't say it can show Codex sessions, as an app from before them, is told of none.
  const older = await connect();
  const heard = [];
  older.on('message', message => heard.push(message));
  await older.request('subscribe');
  assert.deepEqual(heard.find(message => message.type === 'snapshot').sessions, []);
  assert.deepEqual((await older.request('sessions')).sessions, []);
  assert.equal((await r.kind('session.discovered')).agent, 'codex');
  assert.equal((await r.kind('session.started')).source, 'startup');

  r.mark();
  assert.deepEqual({ ...(await r.client.request('send', { sessionId, text: 'Reply with exactly: OK', clientId: 'c1' })), id: 0 }, { type: 'result', id: 0, ok: true, queued: false });
  const sent = await r.kind('message.user', 30000);
  assert.deepEqual([sent.text, sent.clientId, sent.shell], ['Reply with exactly: OK', 'c1', undefined]);
  const end = await r.turnEnd(90000);
  assert.match(end.lastMessage, /OK/);
  const deltas = r.events.filter(event => event.kind === 'message.assistant.delta');
  assert.match(deltas.map(event => event.text).join(''), /OK/, 'the reply came as it was written');
  assert.equal(deltas.at(-1).final, true);
  assert.deepEqual(r.events.filter(event => event.kind === 'session.status').map(event => event.status), ['running', 'idle']);

  assert.equal((await r.client.request('sessions')).sessions.find(session => session.id === sessionId).permissionMode, 'readOnly');
  const { status } = await r.client.request('statusLine', { sessionId });
  assert.equal(status.model, model);
  assert.equal(status.effort, CODEX_EFFORT);
  assert.ok(status.context.percent > 0 && status.context.used > 0 && status.context.size > status.context.used, 'the context after a reply');

  // With its first turn it was opened in Codex's own terminal at the Mac, as another client of the same thread.
  // The terminal is only looked for: whatever it asks when it starts is for a person, and nothing is pressed in it.
  const terminalName = `venes-codex-${sessionId.slice(0, 8)}`;
  try {
    let started = '';
    for (const deadline = Date.now() + 10000; Date.now() < deadline && !started; await delay(200)) {
      try { started = tmux('list-panes', '-t', terminalName, '-F', '#{pane_start_command}').trim(); } catch { /* not opened yet */ }
    }
    assert.match(started, new RegExp(`codex --remote unix://\\S+ resume ${sessionId}`), started);
    // Closed from here, Codex's own terminal goes and the thread is let go, while Codex's server goes on.
    // The commands below load it again.
    assert.equal((await r.client.request('cli', { sessionId })).closable, true);
    r.mark();
    assert.equal((await r.client.request('close', { sessionId })).close, 'now');
    await r.wait(e => e.kind === 'session.ended' && e.sessionId === sessionId, 15000, 'its end');
    assert.equal((await r.client.request('cli', { sessionId })).closable, false);
    let left = null;
    try { left = tmux('display-message', '-p', '-t', terminalName, '#{pane_current_command}').trim(); } catch { /* the terminal went with it */ }
    assert.ok(!left || /^-?(zsh|bash|sh|fish)$/.test(left), `Codex has gone from its terminal (${left})`);
    // Codex's server keeps the thread loaded, as it does every thread until it's deleted. Here it stays closed.
    await delay(1500);
    assert.equal((await r.client.request('cli', { sessionId })).closable, false, 'still closed a moment later');
  } finally {
    try { tmux('kill-session', '-t', terminalName); } catch { /* it had gone by itself */ }
  }

  // One of the commands the helper carries out. A name costs Codex nothing to take.
  await r.client.request('send', { sessionId, text: '/rename E2E renamed', clientId: 'c-rename' });
  let title;
  // Codex can take seconds over its list, where a lot is stored, and the library doesn't wait for it: the
  // name is there once a list has come.
  for (const deadline = Date.now() + 20000; Date.now() < deadline && title !== 'E2E renamed'; await delay(200)) {
    title = (await r.client.request('library', { limit: 100 })).items.find(item => item.id === sessionId)?.title;
  }
  assert.equal(title, 'E2E renamed');
  await assert.rejects(r.client.request('send', { sessionId, text: '/rename' }), { code: 'command_failed' });

  // Two more of them, which cost nothing either: the chat forked is another in the list, and put away, it
  // leaves it.
  const sessionsBefore = (await r.client.request('sessions')).sessions.map(session => session.id);
  await r.client.request('send', { sessionId, text: '/fork', clientId: 'c-fork' });
  let forked;
  for (const deadline = Date.now() + 8000; Date.now() < deadline && !forked; await delay(300)) {
    forked = (await r.client.request('sessions')).sessions.find(session => session.agent === 'codex' && !sessionsBefore.includes(session.id));
  }
  assert.ok(forked, 'the fork is in the list');
  codexForks.push(forked.id);
  await r.client.request('send', { sessionId: forked.id, text: '/archive', clientId: 'c-archive' });
  let isListed = true;
  for (const deadline = Date.now() + 20000; Date.now() < deadline && isListed; await delay(300)) {
    isListed = (await r.client.request('sessions')).sessions.some(session => session.id === forked.id && session.status !== 'ended')
      || (await r.client.request('library', { limit: 100 })).items.some(item => item.id === forked.id);
  }
  assert.equal(isListed, false, 'the fork that was put away has left the list');

  // A line run with ! is the reader's own, and Codex has nothing to say to it. The turn before it has
  // been over long enough by then to be history.
  await delay(2200);
  r.mark();
  await r.client.request('send', { sessionId, text: '!echo venes-e2e', clientId: 'c2' });
  const line = await r.kind('message.user', 15000);
  assert.deepEqual([line.text, line.clientId, line.shell], ['!echo venes-e2e', 'c2', true]);
  const printed = await r.kind('message.output', 15000);
  assert.deepEqual([printed.stdout, printed.stderr, printed.replies, printed.clientId], ['venes-e2e\n', '', false, 'c2']);
  // To a client that joins in the next two seconds, the line is what's going on now.
  const during = await r.client.request('join', { sessionId });
  assert.deepEqual(during.turn.map(event => event.kind), ['message.user', 'message.output']);
  assert.deepEqual(during.items.map(item => item.role), ['user', 'assistant', 'turn_end']);
  await delay(2500);
  const stray = r.events.filter(event => event.kind === 'turn.end' || event.kind === 'session.status');
  assert.deepEqual(stray.map(event => `${event.kind} of ${event.sessionId === sessionId ? 'the session' : 'another'}: ${event.status ?? event.reason ?? ''}`), [], 'no turn, and nothing at work');

  const joined = await r.client.request('join', { sessionId });
  assert.deepEqual(joined.turn, []);
  assert.deepEqual(joined.items.map(item => item.role), ['user', 'assistant', 'turn_end', 'user', 'output']);
  assert.deepEqual([joined.items[0].text, joined.items[0].clientId], ['Reply with exactly: OK', 'c1']);
  assert.match(joined.items[1].text, /OK/);
  assert.deepEqual([joined.items[3].text, joined.items[3].shell, joined.items[4].stdout, joined.items[4].replies], ['!echo venes-e2e', true, 'venes-e2e\n', false]);
  assert.equal(joined.sessions[0].agent, 'codex');
  const { items } = await r.client.request('library', { limit: 5 });
  const stored = items.find(item => item.id === sessionId);
  assert.deepEqual([stored.agent, stored.status, stored.cwd], ['codex', 'idle', fs.realpathSync(WS)]);
  assert.ok(!(await older.request('library', { limit: 5 })).items.some(item => item.agent), 'the older client\'s library has no Codex in it');
  assert.deepEqual(heard.filter(message => message.type === 'event'), [], 'and it heard nothing of the session');
  older.close();

  // Codex's server gone and back, the thread is stored and no longer going on. A message loads it again.
  r.mark();
  await stopCodexServer({ forget: false });
  assert.equal((await r.kind('session.ended', 15000)).sessionId, sessionId);
  await startCodexServer();
  const again = await r.client.request('join', { sessionId });
  assert.deepEqual([again.sessions[0].status, again.items.length, again.turn.length], ['ended', 5, 0]);
  r.mark();
  await r.client.request('send', { sessionId, text: 'Reply with exactly: AGAIN', clientId: 'c3' });
  assert.equal((await r.kind('session.started', 30000)).source, 'resume');
  assert.match((await r.turnEnd(90000)).lastMessage, /AGAIN/);

  // Codex keeps a chat while a fork of it is kept, as the one put away above still is, and the helper
  // says so in words a reader can act on. Asked, Codex has closed the chat all the same.
  await assert.rejects(r.client.request('delete', { sessionId }), { code: 'session_forked' });
  {
    const link = await CodexLink.connect(CODEX_SOCKET, { name: 'venes-e2e', title: 'Venes e2e', version: VERSION });
    try { await link.request('thread/delete', { threadId: forked.id }); } finally { link.close(); }
  }
  r.mark();
  await r.client.request('delete', { sessionId });
  await r.kind('session.deleted', 10000);
  assert.ok(!(await r.client.request('library', { limit: 5 })).items.some(item => item.id === sessionId), 'gone from Codex too');
});

T('codex_asks_before_it_runs_a_command_and_can_be_stopped', { codex: { sandbox: 'workspace-write', approvalPolicy: 'untrusted' } }, async r => {
  const { sessionId } = await startCodex(r);
  const touch = name => `Run the shell command \`touch ${name}\` and nothing else, then reply with exactly: DONE`;

  r.mark();
  await r.client.request('send', { sessionId, text: touch('e2e-codex-1.txt'), clientId: 'c1' });
  const request = await r.request('permission', 90000);
  assert.deepEqual([request.agent, request.toolName, request.sessionId], ['codex', 'commandExecution', sessionId]);
  assert.match(request.input.command, /touch e2e-codex-1\.txt/);
  assert.ok(Array.isArray(request.options) && request.options.every(option => option.id && /^Yes, /.test(option.label)), 'its other ways of saying yes, in Codex\'s words');
  assert.equal((await r.client.request('sessions')).sessions.find(session => session.id === sessionId).status, 'waiting');
  const started = r.events.find(event => event.kind === 'tool.start' && event.toolUseId === request.toolUseId);
  assert.equal(started.name, 'commandExecution');
  assert.ok(!exists('e2e-codex-1.txt'), 'nothing ran before the answer');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  assert.equal((await r.closed(request.id)).by, 'client');
  const ran = await r.wait(event => event.kind === 'tool.end' && event.toolUseId === request.toolUseId, 60000, 'the command\'s end');
  assert.deepEqual([ran.name, ran.isError, ran.response.status, ran.response.exitCode], ['commandExecution', false, 'completed', 0]);
  await r.turnEnd(90000);
  assert.ok(exists('e2e-codex-1.txt'), 'the command ran once allowed');

  // A no stops the turn, as Codex's terminal does, and what to do instead is the next thing it hears.
  r.mark();
  await r.client.request('send', { sessionId, text: touch('e2e-codex-2.txt'), clientId: 'c2' });
  const second = await r.request('permission', 90000);
  await r.client.request('respond', { requestId: second.id, decision: 'deny', message: 'Reply with exactly: STOPPED' });
  await r.kind('turn.interrupted', 30000);
  const next = await r.wait(event => event.kind === 'message.user' && event.text === 'Reply with exactly: STOPPED', 30000, 'what to do instead');
  assert.equal(next.clientId, undefined);
  assert.match((await r.turnEnd(90000)).lastMessage, /STOPPED/);
  assert.ok(!exists('e2e-codex-2.txt'), 'what was turned down never ran');

  // A turn going on is stopped from here.
  r.mark();
  await r.client.request('send', { sessionId, text: 'Count from 1 to 400, one number on each line, with nothing else.', clientId: 'c3' });
  await r.kind('message.assistant.delta', 60000);
  await r.client.request('interrupt', { sessionId });
  await r.kind('turn.interrupted', 30000);
  assert.equal((await r.client.request('sessions')).sessions.find(session => session.id === sessionId).status, 'idle');
  await assert.rejects(r.client.request('interrupt', { sessionId }), { code: 'not_running' });
  await r.client.request('delete', { sessionId });
});

// Codex's Plan mode: a turn in it writes a plan and changes nothing, the plan is asked about once the turn is
// over, as Codex's terminal asks, and a yes ends the planning and tells Codex to carry it out.
T('codex_plans_and_a_yes_to_its_plan_carries_it_out', { codex: { sandbox: 'read-only', approvalPolicy: 'on-request' } }, async r => {
  const { sessionId } = await startCodex(r);
  const view = async () => (await r.client.request('sessions')).sessions.find(session => session.id === sessionId);

  // It starts at once, with no turn, and Codex says so itself.
  r.mark();
  await r.client.request('setMode', { sessionId, mode: 'plan' });
  assert.equal((await r.kind('session.mode', 10000)).permissionMode, 'plan');
  await delay(500);
  assert.deepEqual([(await view()).permissionMode, r.events.filter(event => event.kind === 'session.mode').length], ['plan', 1]);

  r.mark();
  const ask = 'Without asking me anything and without running anything, give your proposed plan, two short steps, for adding a file named e2e-codex-plan.txt.';
  await r.client.request('send', { sessionId, text: ask, clientId: 'c1' });
  const call = await r.wait(event => event.kind === 'tool.start' && event.name === 'ExitPlanMode', 150000, 'the plan');
  assert.ok(call.input.plan.trim().length > 0, 'the plan, whole');
  await r.turnEnd(60000);
  const request = await r.request('plan', 15000);
  assert.deepEqual([request.agent, request.toolName, request.toolUseId, request.input.plan, request.options],
    ['codex', 'ExitPlanMode', call.toolUseId, call.input.plan, [{ id: 'implement', label: 'Yes, implement this plan' }]]);
  assert.ok(r.events.findIndex(event => event.kind === 'turn.end') < r.events.findIndex(event => event.kind === 'request.opened'), 'asked once the turn is over');
  assert.deepEqual([(await view()).status, (await view()).permissionMode], ['waiting', 'plan']);
  assert.ok(!exists('e2e-codex-plan.txt'), 'planning changed nothing');

  // What Codex stored of the turn has the plan as the same call, and the request is there for a client that joins.
  await delay(2200);
  const joined = await r.client.request('join', { sessionId });
  const kept = joined.items.find(item => item.role === 'tool');
  assert.deepEqual([kept?.name, kept?.toolUseId, kept?.input, kept?.isError], ['ExitPlanMode', call.toolUseId, { plan: call.input.plan }, false]);
  assert.deepEqual(joined.requests.map(open => [open.id, open.kind]), [[request.id, 'plan']]);

  // Yes ends the planning first, then tells Codex in its terminal's words. The turn is stopped as it starts.
  r.mark();
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', option: 'session' }), { code: 'bad_option' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow', option: 'implement' });
  assert.deepEqual([(await r.closed(request.id)).decision, (await r.closed(request.id)).by], ['allow', 'client']);
  const told = await r.wait(event => event.kind === 'message.user' && event.text === 'Implement the plan.', 30000, 'the word to carry it out');
  assert.equal(told.clientId, undefined);
  assert.deepEqual([(await r.kind('session.mode', 10000)).permissionMode, (await view()).permissionMode], ['readOnly', 'readOnly']);
  assert.ok(r.events.findIndex(event => event.kind === 'session.mode') < r.events.indexOf(told), 'out of planning before it\'s told');
  await r.client.request('interrupt', { sessionId }).catch(() => {});
  await r.wait(event => event.kind === 'turn.interrupted' || event.kind === 'turn.end', 90000, 'the turn\'s end');
  await delay(300);
  // Out of planning, a turn's end has no plan to ask about.
  assert.deepEqual([(await view()).status, r.events.filter(event => event.kind === 'request.opened' && event.request.kind === 'plan').length], ['idle', 0]);
  await r.client.request('delete', { sessionId });
});

// A session's folder is looked at from a client: what's in it, one of its files, and what git says of it.
T('the_sessions_folder_and_its_files_can_be_looked_at', { mode: 'bypassPermissions' }, async r => {
  const { id: sessionId } = await r.session();
  const root = fs.realpathSync(WS);
  fs.writeFileSync(path.join(WS, 'e2e-look.txt'), 'first line\nsecond line\n');
  fs.writeFileSync(path.join(WS, 'e2e-look.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const listed = await r.client.request('files', { sessionId });
  assert.deepEqual([fs.realpathSync(listed.root), fs.realpathSync(listed.path)], [root, root]);
  const text = listed.entries.find(entry => entry.name === 'e2e-look.txt');
  assert.deepEqual([text.kind, text.size, fs.realpathSync(text.path)], ['file', 23, path.join(root, 'e2e-look.txt')]);
  assert.ok(!listed.entries.some(entry => entry.name === '.git'), 'git\'s own folder isn\'t listed');
  const folders = listed.entries.filter(entry => entry.kind === 'dir').length;
  assert.ok(listed.entries.slice(0, folders).every(entry => entry.kind === 'dir'), 'folders come first');

  const read = await r.client.request('fileRead', { sessionId, path: 'e2e-look.txt' });
  assert.deepEqual([read.name, read.size, read.text, read.data], ['e2e-look.txt', 23, 'first line\nsecond line\n', undefined]);
  const picture = await r.client.request('fileRead', { sessionId, path: text.path.replace('e2e-look.txt', 'e2e-look.png') });
  assert.deepEqual([picture.mediaType, picture.text, Buffer.from(picture.data, 'base64').length], ['image/png', undefined, 8]);
  // A file of any size comes whole, a piece at a time: here one a little over two pieces long.
  const big = Buffer.alloc(2 * 1024 * 1024 + 3);
  for (let index = 0; index < big.length; index++) big[index] = (index * 31 + 7) % 256;
  fs.writeFileSync(path.join(WS, 'e2e-big.bin'), big);
  const pieces = [];
  for (let offset = 0; offset < big.length;) {
    const piece = await r.client.request('fileChunk', { sessionId, path: 'e2e-big.bin', offset });
    assert.deepEqual([piece.size, piece.offset, typeof piece.modifiedAt], [big.length, offset, 'number']);
    pieces.push(Buffer.from(piece.data, 'base64'));
    offset += pieces.at(-1).length;
  }
  assert.deepEqual([pieces.map(piece => piece.length), Buffer.concat(pieces).equals(big)], [[1024 * 1024, 1024 * 1024, 3], true]);
  await assert.rejects(r.client.request('fileChunk', { sessionId, path: 'e2e-big.bin', offset: big.length + 1 }), { code: 'bad_range' });
  await assert.rejects(r.client.request('fileChunk', { sessionId, path: '/etc/hosts' }), { code: 'bad_path' });
  await assert.rejects(r.client.request('files', { sessionId, path: '..' }), { code: 'bad_path' });
  await assert.rejects(r.client.request('fileRead', { sessionId, path: '/etc/hosts' }), { code: 'bad_path' });
  await assert.rejects(r.client.request('fileRead', { sessionId, path: 'e2e-not-there.txt' }), { code: 'no_file' });
  await assert.rejects(r.client.request('files', { sessionId: 'no-such-session' }), { code: 'unknown_session' });

  // Something new in the folder: an empty file, and a folder with a file in it. A folder isn't one of the files
  // every case clears away, so it goes when this is done with it.
  const made = path.join(WS, 'e2e-made');
  try {
    const file = await r.client.request('fileCreate', { sessionId, name: 'e2e-new.txt' });
    assert.deepEqual([file.name, file.kind, file.size, fs.readFileSync(path.join(WS, 'e2e-new.txt'), 'utf8')], ['e2e-new.txt', 'file', 0, '']);
    const dir = await r.client.request('fileCreate', { sessionId, name: 'e2e-made', folder: true });
    assert.deepEqual([dir.name, dir.kind, fs.statSync(made).isDirectory()], ['e2e-made', 'dir', true]);
    await r.client.request('fileCreate', { sessionId, path: 'e2e-made', name: 'inside.md' });
    const inside = await r.client.request('files', { sessionId, path: 'e2e-made' });
    assert.deepEqual(inside.entries.map(entry => [entry.name, entry.kind, entry.size]), [['inside.md', 'file', 0]]);
    // What's there is left as it is, and a name is one name.
    await assert.rejects(r.client.request('fileCreate', { sessionId, name: 'e2e-look.txt' }), { code: 'name_taken' });
    await assert.rejects(r.client.request('fileCreate', { sessionId, name: 'e2e-made', folder: true }), { code: 'name_taken' });
    await assert.rejects(r.client.request('fileCreate', { sessionId, name: 'a/b' }), { code: 'bad_name' });
    await assert.rejects(r.client.request('fileCreate', { sessionId, path: '..', name: 'e2e-out.txt' }), { code: 'bad_path' });
    assert.equal(fs.readFileSync(path.join(WS, 'e2e-look.txt'), 'utf8'), 'first line\nsecond line\n');

    // The new file takes text, as someone edited it from afar, while it's still the file that was read.
    const blank = await r.client.request('fileRead', { sessionId, path: 'e2e-new.txt' });
    assert.deepEqual([blank.text, blank.size, Number.isSafeInteger(blank.modifiedAt)], ['', 0, true]);
    const wrote = await r.client.request('fileWrite', { sessionId, path: 'e2e-new.txt', text: 'edited\n二\n', was: { size: blank.size, modifiedAt: blank.modifiedAt } });
    assert.deepEqual([wrote.name, wrote.size, fs.readFileSync(path.join(WS, 'e2e-new.txt'), 'utf8')], ['e2e-new.txt', 11, 'edited\n二\n']);
    assert.equal((await r.client.request('fileRead', { sessionId, path: 'e2e-new.txt' })).modifiedAt, wrote.modifiedAt);
    // What was read before that write is an older file now, and isn't written over unless that's asked for.
    await assert.rejects(r.client.request('fileWrite', { sessionId, path: 'e2e-new.txt', text: 'late\n', was: { size: blank.size, modifiedAt: blank.modifiedAt } }),
      { code: 'file_changed' });
    await assert.rejects(r.client.request('fileWrite', { sessionId, path: 'e2e-new.txt', text: 'late\n' }), { code: 'file_changed' });
    assert.equal(fs.readFileSync(path.join(WS, 'e2e-new.txt'), 'utf8'), 'edited\n二\n');
    await r.client.request('fileWrite', { sessionId, path: 'e2e-new.txt', text: 'over\n', overwrite: true });
    assert.equal(fs.readFileSync(path.join(WS, 'e2e-new.txt'), 'utf8'), 'over\n');
    // A line separator in a file's text is part of the text. Sent as it is, which is how the app's JSON has
    // it, it ends no line of what the helper reads, and the file has it.
    const parted = 'one\u2028two\u2029three\n';
    const sent = `${JSON.stringify({ id: 1, cmd: 'fileWrite', sessionId, path: 'e2e-new.txt', text: parted, overwrite: true })}\n`;
    assert.ok(sent.includes('\u2028'), 'the line has the separator itself in it');
    const answer = await new Promise((resolve, reject) => {
      const plain = net.connect(paths.clientSocket);
      let heard = '';
      plain.on('error', reject);
      plain.on('data', piece => {
        heard += piece;
        const reply = heard.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.type === 'result');
        if (reply) { plain.destroy(); resolve(reply); }
      });
      plain.on('connect', () => plain.write(sent));
    });
    assert.deepEqual([answer.ok, answer.size, fs.readFileSync(path.join(WS, 'e2e-new.txt'), 'utf8')], [true, Buffer.byteLength(parted), parted]);
    // And read back through a client, it comes whole.
    assert.equal((await r.client.request('fileRead', { sessionId, path: 'e2e-new.txt' })).text, parted);
    // A picture isn't text to write, and nothing outside, or not there, is written.
    await assert.rejects(r.client.request('fileWrite', { sessionId, path: 'e2e-look.png', text: 'x', overwrite: true }), { code: 'not_text' });
    await assert.rejects(r.client.request('fileWrite', { sessionId, path: '../e2e-out.txt', text: 'x', overwrite: true }), { code: 'bad_path' });
    await assert.rejects(r.client.request('fileWrite', { sessionId, path: 'e2e-none.txt', text: 'x', overwrite: true }), { code: 'no_file' });
    assert.equal(fs.existsSync(path.join(WS, 'e2e-none.txt')), false);

    // And out of it again: a file, then a folder with what's in it, each to the Trash, which here is this
    // run's own folder. Neither is in the list after.
    // Another case's are there too, under names of their own.
    const trashed = () => fs.readdirSync(TRASH).map(name => name.replace(/^\d+-/, '')).filter(name => name.startsWith('e2e-')).sort();
    const gone = await r.client.request('fileDelete', { sessionId, path: 'e2e-new.txt' });
    assert.deepEqual([gone.name, gone.path, fs.existsSync(path.join(WS, 'e2e-new.txt'))], ['e2e-new.txt', path.join(WS, 'e2e-new.txt'), false]);
    await r.client.request('fileDelete', { sessionId, path: made });
    assert.equal(fs.existsSync(made), false);
    assert.deepEqual(trashed(), ['e2e-made', 'e2e-new.txt']);
    assert.equal(fs.existsSync(path.join(TRASH, fs.readdirSync(TRASH).find(name => name.endsWith('e2e-made')), 'inside.md')), true, 'a folder goes with what\'s in it');
    const after = await r.client.request('files', { sessionId });
    assert.equal(after.entries.some(entry => entry.name === 'e2e-new.txt' || entry.name === 'e2e-made'), false);
    // What isn't there, what's outside, and the folder itself stay as they are.
    await assert.rejects(r.client.request('fileDelete', { sessionId, path: 'e2e-new.txt' }), { code: 'no_file' });
    await assert.rejects(r.client.request('fileDelete', { sessionId, path: '..' }), { code: 'bad_path' });
    await assert.rejects(r.client.request('fileDelete', { sessionId, path: WS }), { code: 'bad_path' });
    await assert.rejects(r.client.request('fileDelete', { sessionId }), { code: 'bad_path' });
    assert.equal(fs.existsSync(path.join(WS, 'e2e-look.txt')), true);
  } finally {
    fs.rmSync(made, { recursive: true, force: true });
  }

  // The workspace is in no repository, unless whoever runs this put it in one: either way git has an answer.
  const { git } = await r.client.request('git', { sessionId });
  if (git === null) {
    await assert.rejects(r.client.request('gitLog', { sessionId }), { code: 'no_repository' });
  } else {
    assert.ok(typeof git.root === 'string' && Array.isArray(git.changes) && Array.isArray(git.staged));
    assert.ok(Array.isArray((await r.client.request('gitLog', { sessionId, limit: 3 })).commits));
  }
});

T('a_change_is_staged_committed_and_the_branch_switched', { mode: 'bypassPermissions' }, async r => {
  const { id: sessionId } = await r.session();
  // The workspace is made a repository for as long as this takes. One that's a repository already is
  // whoever's it is, and isn't committed to.
  if (fs.existsSync(path.join(WS, '.git'))) throw new Error(`${WS} is a repository of its own, which this would commit to`);
  const git = (...args) => execFileSync('git', ['-C', WS, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'e2e-main');
    for (const [key, value] of [['user.name', 'E2E'], ['user.email', 'e2e@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git('config', key, value);
    // Only this case's own files are git's to see, so that none of the workspace's others is committed, or
    // taken away by a switch to a branch without it.
    fs.writeFileSync(path.join(WS, '.git', 'info', 'exclude'), '/*\n!/e2e-*\n');
    fs.writeFileSync(path.join(WS, 'e2e-stage.txt'), 'one\n');
    fs.writeFileSync(path.join(WS, 'e2e-left.txt'), 'left\n');
    const paths = async () => {
      const { git: state } = await r.client.request('git', { sessionId });
      return [state.staged.map(file => file.path).sort(), state.changes.map(file => file.path).sort()];
    };
    assert.deepEqual(await paths(), [[], ['e2e-left.txt', 'e2e-stage.txt']]);
    // How much has changed comes with the session when it's asked for, counted as the status lists it.
    const changes = async () => (await r.client.request('join', { sessionId, limit: 1 })).sessions[0].changes;
    assert.deepEqual(await changes(), { files: 2, added: 2, removed: 0 });
    await r.client.request('gitStage', { sessionId, paths: ['e2e-stage.txt'] });
    assert.deepEqual(await paths(), [['e2e-stage.txt'], ['e2e-left.txt']]);
    // Before the first commit, and after it.
    await r.client.request('gitUnstage', { sessionId, paths: ['e2e-stage.txt'] });
    assert.deepEqual((await paths())[0], []);
    await assert.rejects(r.client.request('gitCommitStaged', { sessionId, message: 'Nothing' }), { code: 'nothing_staged' });
    await r.client.request('gitStage', { sessionId, paths: ['e2e-stage.txt'] });
    await assert.rejects(r.client.request('gitCommitStaged', { sessionId, message: ' ' }), { code: 'bad_message' });
    const first = await r.client.request('gitCommitStaged', { sessionId, message: 'E2E: the first' });
    fs.writeFileSync(path.join(WS, 'e2e-stage.txt'), 'one\ntwo\n');
    await r.client.request('gitStage', { sessionId, all: true });
    assert.deepEqual(await paths(), [['e2e-left.txt', 'e2e-stage.txt'], []]);
    await r.client.request('gitUnstage', { sessionId, paths: ['e2e-left.txt'] });
    const second = await r.client.request('gitCommitStaged', { sessionId, message: 'E2E: the second\n\nWith a body.' });
    const { commits, hasMore } = await r.client.request('gitLog', { sessionId, limit: 5, all: true });
    assert.deepEqual([commits.map(entry => entry.hash), hasMore], [[second.commit.hash, first.commit.hash], false]);
    assert.deepEqual([commits[0].subject, commits[0].parents, commits[0].refs, commits[1].parents], ['E2E: the second', [first.commit.hash], [{ name: 'e2e-main', kind: 'head' }], []]);
    assert.deepEqual(await paths(), [[], ['e2e-left.txt']]);
    // A commit takes its files out of the count, which is told of without being asked for.
    const told = await r.wait(e => e.kind === 'session.changes' && e.sessionId === sessionId && e.files === 1, 8000, 'session.changes after the commit');
    assert.deepEqual([told.added, told.removed], [1, 0]);
    assert.deepEqual(await changes(), { files: 1, added: 1, removed: 0 });

    git('branch', 'e2e-other', first.commit.hash);
    assert.deepEqual((await r.client.request('gitSwitch', { sessionId, branch: 'e2e-other' })).branch, 'e2e-other');
    assert.equal((await r.client.request('git', { sessionId })).git.branch, 'e2e-other');
    assert.equal(fs.readFileSync(path.join(WS, 'e2e-stage.txt'), 'utf8'), 'one\n');
    await assert.rejects(r.client.request('gitSwitch', { sessionId, branch: 'e2e-no-such' }), { code: 'no_branch' });
    await assert.rejects(r.client.request('gitStage', { sessionId, paths: ['../outside'] }), { code: 'bad_path' });
  } finally {
    fs.rmSync(path.join(WS, '.git'), { recursive: true, force: true });
  }
});

// A branch made from afar, pushed to a remote and pulled from it, and what has changed thrown away. The
// remote is a folder of the test's own, so nothing goes over the network.
T('a_branch_is_made_pushed_and_pulled_and_changes_are_thrown_away', { mode: 'bypassPermissions' }, async r => {
  const { id: sessionId } = await r.session();
  if (fs.existsSync(path.join(WS, '.git'))) throw new Error(`${WS} is a repository of its own, which this would commit to`);
  const folder = prefix => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const [remote, other] = [folder('venes-e2e-remote-'), folder('venes-e2e-other-')];
  const run = (...args) => execFileSync('git', ['-c', 'user.name=E2E', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  const git = (...args) => run('-C', WS, ...args);
  const theirs = (name, text) => {
    fs.writeFileSync(path.join(other, name), text);
    run('-C', other, 'add', '-A');
    run('-C', other, 'commit', '-q', '-m', `E2E: theirs, ${name}`);
    run('-C', other, 'push', '-q');
  };
  const kept = path.join(WS, 'e2e-kept.txt');
  const state = async () => (await r.client.request('git', { sessionId })).git;
  try {
    run('init', '-q', '--bare', '-b', 'e2e-main', remote);
    git('init', '-q', '-b', 'e2e-main');
    for (const [key, value] of [
      ['user.name', 'E2E'], ['user.email', 'e2e@example.com'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null'], ['pull.rebase', 'false'],
      ['push.default', 'simple'],
    ]) git('config', key, value);
    fs.writeFileSync(path.join(WS, '.git', 'info', 'exclude'), '/*\n!/e2e-*\n');
    fs.writeFileSync(kept, 'one\n');
    git('add', 'e2e-kept.txt');
    git('commit', '-q', '-m', 'E2E: the first');

    // With no remote there's nowhere to push, and once there's one the branch is made on it.
    assert.equal((await state()).remote, undefined);
    await assert.rejects(r.client.request('gitPush', { sessionId }), { code: 'no_remote' });
    await assert.rejects(r.client.request('gitPull', { sessionId }), { code: 'no_upstream' });
    git('remote', 'add', 'origin', remote);
    assert.deepEqual([(await state()).remote, (await state()).upstream], ['origin', undefined]);
    const pushed = await r.client.request('gitPush', { sessionId });
    assert.deepEqual([pushed.branch, pushed.upToDate], ['e2e-main', false]);
    assert.deepEqual([(await state()).upstream, (await state()).ahead], ['origin/e2e-main', 0]);
    assert.equal((await r.client.request('gitPush', { sessionId })).upToDate, true);

    // A new branch, which the folder moves to, and which a push makes on the remote too.
    assert.equal((await r.client.request('gitBranchCreate', { sessionId, name: 'e2e-topic' })).branch, 'e2e-topic');
    assert.equal((await state()).branch, 'e2e-topic');
    await assert.rejects(r.client.request('gitBranchCreate', { sessionId, name: 'e2e-topic' }), { code: 'branch_exists' });
    await assert.rejects(r.client.request('gitBranchCreate', { sessionId, name: 'not a name' }), { code: 'bad_branch' });
    assert.equal((await r.client.request('gitPush', { sessionId })).upToDate, false);
    assert.equal((await state()).upstream, 'origin/e2e-topic');

    // What has changed is thrown away: a changed file is as it was committed, a new one is gone, and
    // both are in the Trash, which is a folder of the test's own.
    const before = new Set(fs.readdirSync(TRASH));
    fs.writeFileSync(kept, 'changed\n');
    fs.writeFileSync(path.join(WS, 'e2e-new.txt'), 'new\n');
    assert.deepEqual((await state()).changes.map(file => file.path).sort(), ['e2e-kept.txt', 'e2e-new.txt']);
    await r.client.request('gitDiscard', { sessionId, paths: ['e2e-kept.txt'] });
    assert.equal(fs.readFileSync(kept, 'utf8'), 'one\n');
    await r.client.request('gitDiscard', { sessionId, all: true });
    assert.equal(fs.existsSync(path.join(WS, 'e2e-new.txt')), false);
    assert.deepEqual((await state()).changes, []);
    const trashed = fs.readdirSync(TRASH).filter(name => !before.has(name)).map(name => name.replace(/^\d+-/, '')).sort();
    assert.deepEqual(trashed, ['e2e-kept.txt', 'e2e-new.txt']);
    await assert.rejects(r.client.request('gitDiscard', { sessionId, paths: ['../outside'] }), { code: 'bad_path' });

    // Someone else pushes to the branch, and a pull brings it in.
    run('clone', '-q', '-b', 'e2e-topic', remote, other);
    theirs('e2e-theirs.txt', 'theirs\n');
    assert.equal((await r.client.request('gitPull', { sessionId })).upToDate, false);
    assert.equal(fs.readFileSync(path.join(WS, 'e2e-theirs.txt'), 'utf8'), 'theirs\n');
    assert.equal((await r.client.request('gitPull', { sessionId })).upToDate, true);

    // A pull that would stop on a conflict is taken back, and the folder is as it was.
    theirs('e2e-kept.txt', 'theirs\n');
    fs.writeFileSync(kept, 'mine\n');
    git('commit', '-q', '-am', 'E2E: mine');
    const head = git('rev-parse', 'HEAD');
    await assert.rejects(r.client.request('gitPull', { sessionId }), error => {
      assert.equal(error.code, 'pull_conflict');
      assert.deepEqual(error.details, { paths: ['e2e-kept.txt'] });
      return true;
    });
    assert.deepEqual([git('rev-parse', 'HEAD'), fs.readFileSync(kept, 'utf8'), fs.existsSync(path.join(WS, '.git', 'MERGE_HEAD'))], [head, 'mine\n', false]);
    // And a push the remote has moved on from is refused, in git's words.
    await assert.rejects(r.client.request('gitPush', { sessionId }), { code: 'git_failed' });
  } finally {
    for (const gone of [path.join(WS, '.git'), remote, other]) fs.rmSync(gone, { recursive: true, force: true });
  }
});

// A page published with the Artifact tool is private to its account on claude.ai, so a phone has it from the
// file it was made from. Nothing is published here: the call is written into the session's own transcript the
// way Claude Code writes one, which is all the helper goes by.
T('a_page_a_session_published_is_read_from_its_file', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word PAGE.');
  await r.turnEnd();
  const { id: sessionId } = await r.session();
  const { transcriptPath } = (await r.client.request('sessions')).sessions.find(s => s.id === sessionId);
  const page = path.join(WS, 'e2e-page.html');
  fs.writeFileSync(page, '<title>E2E</title>\n<p>页</p>\n');
  const call = (id, name, kept) => [
    { type: 'assistant', timestamp: new Date().toISOString(), sessionId, message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { file_path: page } }] } },
    {
      type: 'user', timestamp: new Date().toISOString(), sessionId,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: `Published ${page}` }] }, ...(kept && { toolUseResult: kept }),
    },
  ];
  const kept = { url: 'https://claude.ai/artifact/e2e', path: page, title: 'E2E page', artifact_id: 'e2e', seq: 1 };
  fs.appendFileSync(transcriptPath, [...call('toolu_e2e_page', 'Artifact', kept), ...call('toolu_e2e_write', 'Write')].map(record => `${JSON.stringify(record)}\n`).join(''));
  assert.equal((await r.client.request('artifact', { sessionId, toolUseId: 'toolu_e2e_page' })).text, '<title>E2E</title>\n<p>页</p>\n');
  // Only an Artifact call's file, and only by the call: another tool's call names a file too, and a path from a
  // client names nothing.
  for (const asked of [{ toolUseId: 'toolu_e2e_write' }, { toolUseId: 'toolu_nobody' }, { path: page }, { toolUseId: page }]) {
    await assert.rejects(r.client.request('artifact', { sessionId, ...asked }), { code: 'unknown_artifact' });
  }
  // In the session's history the call has its page: where it is, its file and its title.
  const { items } = await r.client.request('history', { sessionId, limit: 20 });
  assert.deepEqual(items.find(item => item.toolUseId === 'toolu_e2e_page')?.page, { url: kept.url, path: page, title: kept.title });
  assert.equal(items.find(item => item.toolUseId === 'toolu_e2e_write')?.page, undefined);
  fs.rmSync(page);
  await assert.rejects(r.client.request('artifact', { sessionId, toolUseId: 'toolu_e2e_page' }), { code: 'artifact_gone' });
});

T('a_session_has_the_repositories_inside_where_it_started', { mode: 'bypassPermissions' }, async r => {
  const { id: sessionId } = await r.session();
  if (fs.existsSync(path.join(WS, '.git'))) throw new Error(`${WS} is a repository of its own, so nothing inside it is looked for`);
  const [one, two] = ['e2e-repo-one', 'e2e-repo-two'].map(name => path.join(fs.realpathSync(WS), name));
  try {
    for (const folder of [one, two]) {
      fs.mkdirSync(folder);
      execFileSync('git', ['init', '-q', '-b', path.basename(folder), folder]);
    }
    fs.writeFileSync(path.join(two, 'new.txt'), 'new\n');
    // The session is in no repository, and has those right inside where it started, the first of them told of.
    const first = await r.client.request('git', { sessionId });
    assert.deepEqual(first.repositories, [{ root: one, name: 'e2e-repo-one' }, { root: two, name: 'e2e-repo-two' }]);
    assert.deepEqual([first.git.root, first.git.branch, first.git.changes], [one, 'e2e-repo-one', []]);
    const second = await r.client.request('git', { sessionId, root: two });
    assert.deepEqual([second.git.root, second.git.branch, second.git.changes.map(file => file.path)], [two, 'e2e-repo-two', ['new.txt']]);
    // Every git command goes to the repository it names.
    await r.client.request('gitStage', { sessionId, root: two, all: true });
    assert.deepEqual((await r.client.request('git', { sessionId, root: two })).git.staged.map(file => file.path), ['new.txt']);
    assert.deepEqual((await r.client.request('git', { sessionId, root: one })).git.staged, []);
    assert.equal((await r.client.request('gitDiff', { sessionId, root: two, path: 'new.txt', staged: true })).diff, '@@ -0,0 +1 @@\n+new\n');
    const none = await r.client.request('gitLog', { sessionId, root: two });
    assert.deepEqual([none.commits, none.hasMore], [[], false]);
    await assert.rejects(r.client.request('git', { sessionId, root: fs.realpathSync(WS) }), { code: 'bad_repository' });
    await assert.rejects(r.client.request('gitLog', { sessionId, root: '/' }), { code: 'bad_repository' });
  } finally {
    for (const folder of [one, two]) fs.rmSync(folder, { recursive: true, force: true });
  }
});

T('a_sessions_mode_is_switched_in_its_terminal', { mode: 'bypassPermissions' }, async r => {
  const { id: sessionId } = await r.session();
  const view = async () => (await r.client.request('sessions')).sessions.find(session => session.id === sessionId);
  // Started skipping permissions, it has that mode to come round to. No hook has said so yet, so it's
  // read off the terminal when the session is opened.
  await r.client.request('join', { sessionId });
  const first = await view();
  assert.equal(first.permissionMode, 'bypassPermissions');
  assert.deepEqual(first.permissionModes.slice(0, 4), ['default', 'acceptEdits', 'plan', 'bypassPermissions']);
  r.mark();
  await r.client.request('setMode', { sessionId, mode: 'plan' });
  await r.waitForPane(/plan mode on/, 5000);
  const told = await r.kind('session.mode', 5000);
  assert.deepEqual([told.permissionMode, told.permissionModes.includes('bypassPermissions'), (await view()).permissionMode], ['plan', true, 'plan']);
  await r.client.request('setMode', { sessionId, mode: 'bypassPermissions' });
  await r.waitForPane(/bypass permissions on/, 5000);
  assert.equal((await view()).permissionMode, 'bypassPermissions');
  // The same mode again presses nothing, and a mode that's only ever started in isn't one to switch to.
  await r.client.request('setMode', { sessionId, mode: 'bypassPermissions' });
  await assert.rejects(r.client.request('setMode', { sessionId, mode: 'dontAsk' }), { code: 'bad_mode' });
  await r.waitForPane(/bypass permissions on/, 5000);
  // Claude Code's own word for the mode, with its next hook, is the one it was put in.
  await r.client.request('setMode', { sessionId, mode: 'acceptEdits' });
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  assert.equal((await view()).permissionMode, 'acceptEdits');
});

T('a_session_cant_be_switched_to_a_mode_it_wasnt_started_with', {}, async r => {
  const { id: sessionId } = await r.session();
  const view = async () => (await r.client.request('sessions')).sessions.find(session => session.id === sessionId);
  assert.ok(!(await view()).permissionModes.includes('bypassPermissions'));
  // It goes all the way round without coming to it, and is left where it was.
  await assert.rejects(r.client.request('setMode', { sessionId, mode: 'bypassPermissions' }), { code: 'mode_unavailable' });
  await r.waitForPane(/manual mode on/, 5000);
  assert.equal((await view()).permissionMode ?? 'default', 'default');
  await r.client.request('setMode', { sessionId, mode: 'acceptEdits' });
  await r.waitForPane(/accept edits on/, 5000);
  assert.equal((await view()).permissionMode, 'acceptEdits');
});

Run.prototype.waitForPane = async function waitForPane(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(this.pane())) return; await delay(150); }
  throw new Error(`pane never matched ${re}:\n${this.pane()}`);
};

// --- Terminal sessions: a shell the helper runs itself, with no agent in it ---
//
// The shell is zsh with nobody's setup, so that what a command prints is all there is, and nothing a
// case types lands in the history of whoever runs this.
const SHELL_HOME = `${HOME}-zsh`;
const TERMINAL = { noClaude: true, helperEnv: { SHELL: '/bin/zsh', ZDOTDIR: SHELL_HOME } };
const printed = (r, clientId) => r.events.findLast(e => e.kind === 'message.output' && e.clientId === clientId);
const printedAll = (r, clientId, ms = 20000) => r.wait(e => e.kind === 'message.output' && e.clientId === clientId && e.running === false, ms, `the end of ${clientId}`);
const untilPrinted = async (r, clientId, text, ms = 20000) => {
  for (const end = Date.now() + ms; printed(r, clientId)?.stdout !== text; await delay(60)) {
    if (Date.now() > end) throw new Error(`${clientId} never printed ${JSON.stringify(text)}: ${JSON.stringify(printed(r, clientId)?.stdout)}`);
  }
};
const untilStatus = (r, sessionId, status, ms = 20000) => r.wait(e => e.kind === 'session.status' && e.sessionId === sessionId && e.status === status, ms, `status ${status}`);

async function startTerminal(r, size = { columns: 60, rows: 20 }) {
  fs.mkdirSync(SHELL_HOME, { recursive: true });
  const { sessionId } = await r.client.request('start', { agent: 'terminal', cwd: WS, ...size });
  // Whatever became of the case and of its own connection, the shell goes.
  r.after(async () => {
    const client = await HelperClient.connect(paths.clientSocket).catch(() => undefined);
    if (!client) return;
    await Promise.race([client.request('delete', { sessionId }).catch(() => {}), delay(8000)]);
    client.close();
  });
  return sessionId;
}

async function terminalRunsCommands(r) {
  assert.equal((await r.client.request('folders', {})).terminal, true);
  const sessionId = await startTerminal(r);
  const { sessions } = await r.client.request('sessions');
  assert.deepEqual(sessions.map(s => [s.id, s.agent, s.status]), [[sessionId, 'terminal', 'idle']]);

  const sent = await r.client.request('send', { sessionId, text: 'echo e2e-$((6*7)); pwd', clientId: 'c1' });
  assert.deepEqual(sent.queued, false);
  const first = await printedAll(r, 'c1');
  assert.deepEqual([first.stdout, first.exitCode, first.columns, first.replies], [`e2e-42\n${fs.realpathSync(WS)}`, 0, 60, false]);
  const line = r.events.find(e => e.kind === 'message.user');
  assert.deepEqual([line.text, line.clientId, line.shell], ['echo e2e-$((6*7)); pwd', 'c1', true]);

  // A line being typed goes on to what was run here, and an empty one to nothing.
  assert.equal((await r.client.request('suggest', { sessionId, text: 'echo e2e' })).suggestions[0], 'echo e2e-$((6*7)); pwd');
  assert.deepEqual((await r.client.request('suggest', { sessionId, text: ' ' })).suggestions, []);

  // Its status is the folder its shell is in, with the branch checked out there once it's a repository's,
  // and what git says of the folder is the session's as any other's is.
  assert.deepEqual(Object.keys((await r.client.request('statusLine', { sessionId })).status).sort(), ['project', 'updatedAt']);
  assert.equal((await r.client.request('git', { sessionId })).git, null);
  r.mark();
  const repo = path.join(WS, 'terminal-repo');
  // Taken away here, and not when the case is over: the next case clears the folder of files only.
  fs.rmSync(repo, { recursive: true, force: true });
  await r.client.request('send', { sessionId, text: 'mkdir terminal-repo && cd terminal-repo && git init -q && git symbolic-ref HEAD refs/heads/trunk && touch new.txt && echo made', clientId: 'c0' });
  try {
    assert.equal((await printedAll(r, 'c0')).stdout, 'made');
    const { status } = await r.client.request('statusLine', { sessionId });
    assert.deepEqual([status.project, status.branch], ['terminal-repo', 'trunk']);
    const { git } = await r.client.request('git', { sessionId });
    assert.deepEqual([git.branch, git.changes.map(file => file.path)], ['trunk', ['new.txt']]);
    await r.wait(e => e.kind === 'session.changes' && e.files === 1, 8000, 'the change was counted');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }

  // Where the shell goes, the session goes, and a failure is said with nothing printed.
  r.mark();
  await r.client.request('send', { sessionId, text: 'cd /usr && false', clientId: 'c2' });
  const failed = await printedAll(r, 'c2');
  assert.deepEqual([failed.stdout, failed.exitCode], ['', 1]);
  assert.equal((await r.wait(e => e.kind === 'session.cwd', 5000, 'the folder')).cwd, '/usr');
  assert.equal((await r.session()).cwd, '/usr');

  // As wide as the page that sends: columns are the terminal's, and a table is laid out for them.
  r.mark();
  await r.client.request('send', { sessionId, text: 'tput cols; printf "\\033[31mred\\033[0m\\n"', clientId: 'c3', columns: 47, rows: 30 });
  const sized = await printedAll(r, 'c3');
  assert.deepEqual([sized.stdout, sized.columns], ['47\n\u001b[0;31mred\u001b[0m', 47]);

  const joined = await r.client.request('join', { sessionId, limit: 50 });
  assert.deepEqual(joined.items.map(item => [item.role, item.clientId]), [
    ['user', 'c1'], ['output', 'c1'], ['user', 'c0'], ['output', 'c0'], ['user', 'c2'], ['output', 'c2'], ['user', 'c3'], ['output', 'c3'],
  ]);
  assert.deepEqual(joined.sessions.map(s => [s.agent, s.status]), [['terminal', 'idle']]);
  const capabilities = await r.client.request('capabilities', { sessionId });
  assert.deepEqual([capabilities.commands, capabilities.models, capabilities.skills], [[], [], []]);
  const cli = await r.client.request('cli', { sessionId });
  assert.deepEqual([cli.agent, cli.closable, cli.update], ['terminal', true, 'none']);

  // A client that hasn't said it shows terminal sessions isn't told of one.
  const other = await HelperClient.connect(paths.clientSocket);
  r.after(() => other.close());
  assert.deepEqual((await other.request('sessions')).sessions, []);
}
// The library is one list, the newest first, a page at a time: two sessions made here are its first two,
// the one last worked in first, and a page of one has one.
T('the_library_comes_a_page_at_a_time_the_newest_first', TERMINAL, async r => {
  const older = await startTerminal(r);
  await r.client.request('send', { sessionId: older, text: 'echo one', clientId: 'c1' });
  await printedAll(r, 'c1');
  await delay(1100);
  const newer = await startTerminal(r);
  await r.client.request('send', { sessionId: newer, text: 'echo two', clientId: 'c2' });
  await printedAll(r, 'c2');
  const first = await r.client.request('library', { limit: 1 });
  assert.deepEqual([first.items.map(item => item.id), first.offset, first.hasMore], [[newer], 1, true]);
  const second = await r.client.request('library', { limit: 1, offset: first.offset });
  assert.deepEqual([second.items.map(item => item.id), second.offset], [[older], 2]);
  const both = await r.client.request('library', { limit: 2 });
  assert.deepEqual(both.items.map(item => [item.id, item.agent]), [[newer, 'terminal'], [older, 'terminal']]);
  const times = (await r.client.request('library', { limit: 30 })).items.filter(item => item.status === null).map(item => item.lastActiveAt ?? 0);
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'what isn\'t going on is by when it was last active');
});
T('terminal_runs_commands', TERMINAL, terminalRunsCommands);
T('in_rex_terminal_runs_commands', { ...TERMINAL, rex: true }, terminalRunsCommands);

async function terminalTakesLinesAndKeys(r) {
  const sessionId = await startTerminal(r, { columns: 40, rows: 10 });
  await r.client.request('send', { sessionId, text: 'echo first; cat', clientId: 'c1' });
  await untilPrinted(r, 'c1', 'first');
  assert.equal(printed(r, 'c1').running, true);
  assert.equal((await r.session()).status, 'running');

  // A line for the program, which says it back.
  await r.client.request('send', { sessionId, text: 'hello', clientId: 'c2' });
  await untilPrinted(r, 'c2', 'hello\nhello');
  const typed = r.events.findLast(e => e.kind === 'message.user');
  assert.deepEqual([typed.text, typed.clientId, typed.input], ['hello', 'c2', true]);
  assert.deepEqual([printed(r, 'c1').stdout, printed(r, 'c1').running], ['first', false]);

  // Keys reach it too: Ctrl-D ends it.
  await r.client.request('key', { sessionId, key: 'C-d' });
  await untilStatus(r, sessionId, 'idle');
  assert.deepEqual([printed(r, 'c2').running, printed(r, 'c2').exitCode], [false, 0]);
  await assert.rejects(r.client.request('key', { sessionId, key: 'F13' }), /isn't a key/);

  // A program with the screen to itself shows its screen, and what it leaves once it gives it back.
  r.mark();
  await r.client.request('send', { sessionId, text: `printf '\\e[?1049h\\e[HTOP\\e[10;1H\\e[7mBAR\\e[0m'; read -k1 key; printf '\\e[?1049l'; echo left`, clientId: 'c3' });
  const screen = await r.wait(e => e.kind === 'message.output' && e.clientId === 'c3' && e.screen, 20000, 'the screen');
  assert.deepEqual([screen.stdout, screen.rows, screen.running], [`TOP${'\n'.repeat(9)}\u001b[0;7mBAR\u001b[0m`, 10, true]);
  // It only waits there, so the session is running and not at work, and no page says it's working.
  await r.wait(e => e.kind === 'session.status' && e.sessionId === sessionId && e.status === 'running' && e.working === false, 20000, 'the session waits');
  await r.client.request('key', { sessionId, key: 'Enter' });
  assert.equal((await printedAll(r, 'c3')).stdout, 'left');

  // And one that won't end is stopped.
  r.mark();
  await r.client.request('send', { sessionId, text: 'sleep 60', clientId: 'c4' });
  await untilStatus(r, sessionId, 'running');
  await r.client.request('interrupt', { sessionId });
  assert.equal((await printedAll(r, 'c4')).exitCode, 130);
}
T('terminal_takes_lines_and_keys', TERMINAL, terminalTakesLinesAndKeys);
T('in_rex_terminal_takes_lines_and_keys', { ...TERMINAL, rex: true }, terminalTakesLinesAndKeys);

async function terminalComesBack(r) {
  const sessionId = await startTerminal(r);
  await r.client.request('send', { sessionId, text: 'echo before', clientId: 'c1' });
  await printedAll(r, 'c1');
  await r.client.request('send', { sessionId, text: 'echo going; cat', clientId: 'c2' });
  await untilPrinted(r, 'c2', 'going');
  await r.client.request('send', { sessionId, text: 'kept', clientId: 'c3' });
  await untilPrinted(r, 'c3', 'kept\nkept');

  // The helper goes, and the shell goes on.
  r.client.close();
  await stopHelper();
  startHelper(CLI, undefined, TERMINAL.helperEnv);
  const client = await connect();
  r.after(() => client.close());
  const again = new Run(client);
  await client.request('subscribe', { agents: ['terminal'] });
  const joined = await client.request('join', { sessionId });
  assert.deepEqual(joined.sessions.map(s => [s.agent, s.status]), [['terminal', 'running']]);
  assert.deepEqual(joined.items.map(item => [item.role, item.clientId, item.stdout ?? item.text, ...(item.running ? ['running'] : [])]), [
    ['user', 'c1', 'echo before'], ['output', 'c1', 'before'], ['user', 'c2', 'echo going; cat'], ['output', 'c2', 'going'],
    ['user', 'c3', 'kept'], ['output', 'c3', 'kept\nkept', 'running'],
  ]);
  await client.request('send', { sessionId, text: 'more', clientId: 'c4' });
  await untilPrinted(again, 'c4', 'more\nmore');
  await client.request('key', { sessionId, key: 'C-d' });
  await untilStatus(again, sessionId, 'idle');

  // Closed, it's still listed, with what was run in it, and a message opens it again.
  assert.equal((await client.request('close', { sessionId })).close, 'now');
  await again.wait(e => e.kind === 'session.ended' && e.sessionId === sessionId, 15000, 'the session ended');
  const library = await client.request('library', {});
  assert.deepEqual(library.items.filter(item => item.agent === 'terminal').map(item => [item.id, item.status]), [[sessionId, null]]);
  again.mark();
  await client.request('send', { sessionId, text: 'echo back', clientId: 'c5' });
  assert.equal((await printedAll(again, 'c5')).stdout, 'back');
  assert.deepEqual((await client.request('join', { sessionId })).items.map(item => item.clientId), ['c1', 'c1', 'c2', 'c2', 'c3', 'c3', 'c4', 'c4', 'c5', 'c5']);

  await client.request('delete', { sessionId });
  await again.wait(e => e.kind === 'session.deleted' && e.sessionId === sessionId, 5000, 'the session deleted');
  assert.equal(fs.existsSync(path.join(HOME, 'terminals', sessionId)), false);
}
T('terminal_comes_back_after_a_restart', TERMINAL, terminalComesBack);
T('in_rex_terminal_comes_back_after_a_restart', { ...TERMINAL, rex: true }, terminalComesBack);

async function runCase(name) {
  const { opts, fn } = cases[name];
  for (const f of fs.readdirSync(WS)) if (f.startsWith('e2e-')) fs.rmSync(path.join(WS, f));
  let client; let run;
  const started = Date.now();
  try {
    if (opts.rex) {
      await startRexServer();
      inRex = {};
    }
    if (opts.noHelper) {
      opts.before?.();
      if (opts.before) (await connect()).close();
      run = new Run({ on() {} });
    } else {
      if (opts.codex) await startCodexServer();
      startHelper(CLI, opts.codex, opts.helperEnv);
      client = await connect();
      run = new Run(client);
      // A Codex case's client is one that can show Codex sessions, and says so.
      // And a terminal case's is one that can show terminal sessions.
      await client.request('subscribe', opts.codex ? { agents: ['codex'] } : opts.noClaude ? { agents: ['terminal'] } : {});
    }
    // A Codex case has no Claude Code session to wait for, and nor has a terminal's.
    const hasClaude = !opts.codex && !opts.noClaude;
    if (opts.rex && hasClaude) launchInRex(opts);
    else if (hasClaude) launch(opts);
    if (hasClaude) await ready(run);
    await fn(run);
    console.log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    try { console.log(run.pane().trimEnd().split('\n').slice(-14).join('\n')); } catch { /* no pane */ }
    return false;
  } finally {
    for (const cleanup of run?.cleanups ?? []) { try { await cleanup(); } catch { /* left as it was */ } }
    try { tmux('kill-session', '-t', 'run'); } catch { /* already gone */ }
    try { if (inRex?.session) rex('kill', inRex.session); } catch { /* already gone */ }
    await delay(500);
    client?.close();
    await stopHelper();
    await stopCodexServer();
    inRex = undefined;
  }
}

// Every case starts a real Claude Code session, which Claude Code keeps with everyone else's, so
// the reader's list would fill up with them. What a run adds goes when it's done.
const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const sessionFolder = () => path.join(CLAUDE_HOME, 'projects', fs.realpathSync(WS).replace(/[^a-zA-Z0-9]/g, '-'));
const storedSessions = () => {
  try { return fs.readdirSync(sessionFolder()).filter(name => name.endsWith('.jsonl')); } catch { return []; }
};
function forgetSessionsSince(before) {
  for (const name of storedSessions().filter(stored => !before.includes(stored))) {
    const id = name.slice(0, -'.jsonl'.length);
    fs.rmSync(path.join(sessionFolder(), name), { force: true });
    fs.rmSync(path.join(sessionFolder(), id), { recursive: true, force: true });
    fs.rmSync(path.join(CLAUDE_HOME, 'file-history', id), { recursive: true, force: true });
  }
}

fs.mkdirSync(WS, { recursive: true });
const sessionsBefore = storedSessions();
// Stopped from outside, a run still takes down what it started and forgets its sessions. The
// handlers for 'exit' do that, and a signal on its own would end the run without them.
let stopped = false;
process.on('exit', () => {
  try { tmux('kill-server'); } catch { /* not running */ }
  forgetSessionsSince(sessionsBefore);
  if (!stopped) return;
  // A session cut short still writes its last lines down, after it was forgotten. Whoever stopped
  // the run may not wait this long, which is why it's the second time round.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  forgetSessionsSince(sessionsBefore);
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { stopped = true; process.exit(1); });
stopStrayHelper();
fs.rmSync(HOME, { recursive: true, force: true });
for (const own of [DOWNLOADS, AUTHORIZED_KEYS, CLAUDE_SETTINGS, TRASH]) fs.rmSync(own, { recursive: true, force: true });
fs.mkdirSync(TRASH, { recursive: true });
fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true });
try { tmux('kill-server'); } catch { /* not running */ }
tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keep', 'sleep', '86400');
tmux('set-option', '-g', 'remain-on-exit', 'off');

const wanted = process.argv.slice(2);
const names = Object.keys(cases).filter(n => !wanted.length || wanted.some(w => n.startsWith(w)));
console.log(`e2e: ${names.length} cases, model=${MODEL}`);
let failed = 0;
for (const name of names) if (!(await runCase(name))) failed++;
try { tmux('kill-server'); } catch { /* already gone */ }
fs.rmSync(HOME, { recursive: true, force: true });
for (const own of [DOWNLOADS, AUTHORIZED_KEYS, CLAUDE_SETTINGS, TRASH]) fs.rmSync(own, { recursive: true, force: true });
forgetSessionsSince(sessionsBefore);
pushServer.close();
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
