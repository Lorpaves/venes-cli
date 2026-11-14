// A session in Rex needs no tmux. Its hooks say which block it's in, and the rex command does the
// typing and reading through the server's API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { helperPaths } from './paths.mjs';
import { RexLink } from './rexlink.mjs';
import { HelperError } from './sessions.mjs';
import { VERSION } from './version.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const OUTPUT_BYTES = 8 * 1024 * 1024;
// A terminal can hold 64 MiB of scrollback, and only the end of it is the screen.
const SCREEN_BYTES = 32 * 1024;
// A read can come back with less than it asked for, which is more reads to the end.
const SCREEN_READS = 16;
// The most Rex gives in one reply. It measures a reply as the JSON it sends, where an escape sequence
// or a line's end takes more room than in the text, so asking for just what's left gets less than that
// each time, and the last few characters never come.
const BLOB_READ_BYTES = 960 * 1024;
const KEYS = {
  Enter: 'enter', Escape: 'escape', Up: 'up', Down: 'down', Left: 'left', Right: 'right', 'M-p': 'alt+p', Tab: 'tab', BTab: 'shift+tab',
  Space: 'space', BSpace: 'backspace', 'C-c': 'ctrl+c',
};
// The most of a terminal session's output that's read back at once, from its end.
const OUTPUT_READ_BYTES = 512 * 1024;
const PROGRAM_NAME = 'claude';
// Sessions the helper starts share this one, a window each, because Rex keeps a session in its
// sidebar after its last window closes.
const SESSION_LABEL = 'Venes';

// Where the app keeps the command, which a helper started over SSH has no PATH to.
export const INSTALL_FOLDER = path.join(os.homedir(), 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS');

export function isInstalled() {
  return process.env.PATH.split(':').some(dir => fs.existsSync(path.join(dir, 'rex')));
}

async function rex({ rexServer } = {}, args, input) {
  const env = rexServer ? { ...process.env, REX_SERVER: rexServer } : process.env;
  const child = exec('rex', args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: OUTPUT_BYTES, env });
  if (input !== undefined) child.child.stdin.end(input);
  const { stdout } = await child;
  return stdout;
}

const blockTarget = ({ pane, rexSession }) => ['-s', rexSession, '-b', pane];

async function callBlock(session, method, args) {
  return JSON.parse(await rex(session, ['--autostart=false', 'block', 'call', ...blockTarget(session), method, JSON.stringify(args)]));
}

// The same, for a terminal session, which is read several times a second while it's followed: over the
// helper's own connection when it's open, with no command to start each time, and by the command otherwise.
async function callTerminal(session, method, args) {
  const open = session.rexServer ? undefined : await linking?.catch(() => undefined);
  if (open?.isOpen) {
    try {
      return await open.call(session, method, args);
    } catch (error) {
      if (error.code) throw error; // Rex's own answer, which the command would get too
    }
  }
  return callBlock(session, method, args);
}

// The end of what the terminal holds, up to `bytes` of it, and whether there was more before that.
// `end` is where what was read ends, in bytes from the start of all the terminal holds.
async function readFormatted(session, format, { bytes = SCREEN_BYTES, unwrap = false, call = callBlock } = {}) {
  const start = await call(session, 'format', { format, trim: true, unwrap, max_bytes: bytes });
  if (start.id === undefined) return { content: start.content, cut: false, end: start.total };
  const first = Math.max(0, start.total - bytes);
  let offset = first;
  let screen = '';
  for (let reads = 0; reads < SCREEN_READS && offset < start.total; reads++) {
    const { data = '', eof } = await call(session, 'blob_read', { id: start.id, offset, max_bytes: BLOB_READ_BYTES });
    screen += data;
    // A read that starts in the middle of a character has a replacement character, of three bytes,
    // for each byte of it that was left.
    const broken = reads === 0 ? /^\uFFFD*/.exec(data)[0].length : 0;
    offset += Buffer.byteLength(data) - 2 * broken;
    if (eof || !data) break;
  }
  return { content: screen, cut: first > 0, end: offset };
}

export const readScreen = async session => (await readFormatted(session, 'text')).content;
// With the escape sequences that colour it.
export const readStyledScreen = async session => (await readFormatted(session, 'vt')).content;

// Everything a terminal session's shell has printed since its screen was last cleared, coloured, with
// the lines the terminal wrapped joined again. `cut` when the start didn't fit. `end` is where it ends,
// in bytes from the start of all the terminal holds: a line is as far from that start however much is
// printed under it, which is how one is found again in a later read.
export async function readOutput(session) {
  const { content, cut, end } = await readFormatted(session, 'vt', { bytes: OUTPUT_READ_BYTES, unwrap: true, call: callTerminal });
  return { text: content, cut, end };
}

// What's in front in one terminal now, by name, and the folder it's in: the shell at its prompt, or
// the command it's running.
export async function front(session) {
  const running = await callTerminal(session, 'process', {});
  const process = running.foreground ?? running.child;
  const status = await callTerminal(session, 'program_status', {}).catch(() => undefined);
  return { program: process?.name, cwd: process?.cwd, working: workingOf(status?.records, process) };
}

// Whether the program in front says it's at work. A program can tell its terminal what it's doing, as
// codex and Claude Code do: at work, or at rest, waiting for someone, done. Undefined for one that
// says nothing, as most don't, and for what an earlier program left said, which isn't this one's.
export function workingOf(records, process) {
  const own = (records ?? []).filter(record => process?.pid !== undefined && record.owner?.pid === process.pid);
  return own.length ? own.some(record => record.state === 'working') : undefined;
}

// Whether a program has the screen to itself, as an editor or a pager does.
export async function isFullScreen(session) {
  return (await callTerminal(session, 'modes', {})).screen === 'alternate';
}

// A program reading a line without showing it, as a password prompt does. A shell or a program that
// edits its own line reads keys one at a time, and shows them itself.
export async function hidesInput(session) {
  const mode = await callTerminal(session, 'input_mode', {});
  return mode.canonical === true && mode.echo === false;
}

// It applies when no client owns the terminal. One in a window that Rex's app has open is that window's
// size, whatever is asked here.
export async function resize(session, { columns, rows }) {
  await callBlock(session, 'resize', { columns, rows });
}

// The size the terminal really has, whoever asked for what.
export async function size(session) {
  const { columns, rows } = await callTerminal(session, 'size', {});
  return { columns, rows };
}

// Where this Mac's Rex server listens, as its own command says, when nothing has told the helper.
async function serverEndpoint() {
  if (process.env.REX_SERVER) return process.env.REX_SERVER;
  const status = await rex({}, ['--autostart=false', 'server', 'status']);
  const endpoint = /^endpoint:\s*(\S+)/m.exec(status)?.[1];
  if (!endpoint) throw new Error('Rex didn\'t say where its server is.');
  return endpoint;
}

// The helper's own connection to Rex, which stays open: made when it's first wanted, and again after it
// drops. `attached` is the sessions it has joined, which Rex asks for before it lets a client claim a
// terminal there. It hears of everything on the server, so that `watchTerminals` can say when the
// terminals open in Rex have changed.
let linking;
let terminalsChanged;

// What makes the list of terminals, or what one of them is doing, different.
const SESSION_CHANGES = new Set(['block_created', 'block_closed', 'session_view_changed', 'window_created', 'window_closed']);
const BLOCK_CHANGES = new Set(['process_changed', 'pwd_changed', 'program_status_changed', 'program_status_removed']);

export function changesTerminals(event) {
  if (event?.type === 'session_created' || event?.type === 'session_destroyed') return true;
  if (event?.type !== 'session_event') return false;
  const inner = event.payload?.event;
  if (inner?.type === 'block_event') return BLOCK_CHANGES.has(inner.payload?.name);
  return SESSION_CHANGES.has(inner?.type);
}

export async function link({ connect = RexLink.connect } = {}) {
  const current = await linking?.catch(() => undefined);
  if (current?.isOpen) return current;
  linking = (async () => {
    const made = await connect(await serverEndpoint(), { name: 'venes', version: VERSION });
    made.attached = new Set();
    made.on('event', event => { if (changesTerminals(event)) terminalsChanged?.(); });
    // A connection that drops takes what it knew with it, so the terminals are looked at again.
    made.on('close', () => terminalsChanged?.());
    await made.request('session.attach_all', { event_scope: 'all' });
    return made;
  })();
  return linking;
}

// `listener` is told whenever the terminals open in Rex may have changed: one opened or closed, moved
// in or out of a window, or its program or folder changed.
export function watchTerminals(listener) {
  terminalsChanged = listener;
}

const TERMINAL_CREATOR = 'com.superlogical.terminal';

// Every terminal in a window of Rex's, on this Mac's server: its block and session, its label, the
// program in front, the folder that program is in, and whether it says it's at work.
export async function listTerminals() {
  const open = await link();
  const { sessions } = await open.request('session.list');
  const found = [];
  for (const { session_id: rexSession } of sessions ?? []) {
    const { blocks } = await open.request('session.list_blocks', { session_id: rexSession }).catch(() => ({ blocks: [] }));
    for (const block of blocks ?? []) {
      if (block.creator_name !== TERMINAL_CREATOR || block.placement !== 'placed') continue;
      const target = { pane: block.block_id, rexSession };
      const running = await open.call(target, 'process', {}).catch(() => undefined);
      if (!running) continue;
      const front = running.foreground ?? running.child;
      const status = await open.call(target, 'program_status', {}).catch(() => undefined);
      found.push({ ...target, label: block.label, program: front?.name, cwd: front?.cwd, working: workingOf(status?.records, front) });
    }
  }
  return found;
}

// Closes it, as when the helper stops: Rex gives back what it had claimed.
export async function closeLink() {
  const current = await linking?.catch(() => undefined);
  linking = undefined;
  current?.close();
}

async function joined(target) {
  const open = await link();
  if (!open.attached.has(target.rexSession)) {
    await open.request('session.attach', { session_id: target.rexSession });
    open.attached.add(target.rexSession);
  }
  return open;
}

// Makes the terminal this size whoever else has it open: Rex has a terminal follow the client that owns
// it, and its app owns every terminal in a window it shows. The helper's connection takes it, and has
// it until `giveBack`, or until the helper goes.
export async function takeSize(target, { columns, rows }) {
  const open = await joined(target);
  await open.request('session.own_block', { session_id: target.rexSession, block_ids: [target.pane], mode: 'take' });
  await open.call(target, 'resize', { columns, rows });
}

// Lets it go, to whoever had it before, which is then the size they want it.
export async function giveBack(target) {
  const open = await linking?.catch(() => undefined);
  if (!open?.isOpen || !open.attached.has(target.rexSession)) return;
  await open.request('session.disown_block', { session_id: target.rexSession, block_ids: [target.pane] });
}

export async function closeSession(_, target) {
  await rex(target, ['--autostart=false', 'api', 'call', 'block.close', JSON.stringify({ session_id: target.rexSession, block_id: target.pane })]);
}

export async function pressKey(session, key) {
  await rex(session, ['--autostart=false', 'send-key', ...blockTarget(session), KEYS[key] ?? key]);
}

// On stdin, because a message can be longer than an argument can.
export async function paste(session, text) {
  const event = { session_id: session.rexSession, block_id: session.pane, event: { type: 'paste', payload: { text } } };
  await rex(session, ['--autostart=false', 'api', 'call', 'block.event', '-'], JSON.stringify(event));
}

// Where a phone can reach this server, if Tailscale is on in it.
export async function tailnetAddress() {
  try {
    return JSON.parse(await rex({}, ['--autostart=false', 'server', 'tailscale', 'pair', '--json'])).url;
  } catch {
    return undefined;
  }
}

// The Tailscale account Rex is signed in with, which is the one a phone has to use: Rex only lets
// in the account it's signed in as.
export const tailnetAccountOf = whoami => whoami?.tailscale?.account?.login_name || undefined;

export async function tailnetAccount() {
  try {
    return tailnetAccountOf(JSON.parse(await rex({}, ['--autostart=false', 'whoami', '--json'])));
  } catch {
    return undefined;
  }
}

// Asked of Rex at most once a minute, since a client pings far more often than that.
const ACCOUNT_REFRESH_MS = 60_000;

// The account, as it was when last asked, with a fresh ask in the background when that's old.
export function cachedAccount({ fetch = tailnetAccount, refreshMs = ACCOUNT_REFRESH_MS, now = Date.now } = {}) {
  let account;
  let fetchedAt = -Infinity;
  let fetching;
  const refresh = () => {
    // One that couldn't be asked is asked again after the same while.
    fetching ??= fetch()
      .then(found => { account = found; }, () => {})
      .finally(() => { fetchedAt = now(); fetching = undefined; });
    return fetching;
  };
  return {
    get current() {
      if (now() - fetchedAt > refreshMs) refresh();
      return account;
    },
    refresh,
  };
}

function keptSession() {
  try { return fs.readFileSync(helperPaths().rexSession, 'utf8').trim(); } catch { return undefined; }
}

// Not knowing it next time costs one more session, which is no reason to stop this one.
function keepSession(id) {
  try { fs.writeFileSync(helperPaths().rexSession, `${id}\n`, { mode: 0o600 }); } catch { /* found by its label instead */ }
}

// The helper's session goes by its id, because its label changes: Rex can ask every Claude Code it
// starts to name the session it's in after its task. The label is put back, so it's still the one
// to look for, which is how a client finds it, and how the first helper to use it did.
async function ownSession() {
  const { sessions } = JSON.parse(await rex({}, ['session', 'ls', '--json']));
  const kept = keptSession();
  const own = sessions.find(session => kept && session.session_id === kept)
    ?? sessions.find(session => session.label === SESSION_LABEL);
  if (!own) {
    const created = JSON.parse(await rex({}, ['api', 'call', 'session.create', JSON.stringify({ label: SESSION_LABEL })])).session_id;
    keepSession(created);
    return created;
  }
  if (own.session_id !== kept) keepSession(own.session_id);
  if (own.label !== SESSION_LABEL) await rex({}, ['session', 'rename', own.session_id, SESSION_LABEL]).catch(() => {});
  return own.session_id;
}

// Runs a command in a window of its own, and returns its block. The window closes with it.
export async function startSession({ name, cwd, command, env }) {
  const variables = Object.entries(env).map(([key, value]) => `${key}=${value}`);
  const rexSession = await ownSession();
  const output = await rex({}, ['run', '-s', rexSession, '--label', name, '--focus=false', '--json', '--cwd', cwd, '--shell=none', '--', 'env', ...variables, ...command]);
  const pane = JSON.parse(output).block_ids?.[0];
  if (!pane) throw new HelperError('resume_failed', 'Rex didn\'t start a terminal for this session.');
  return { pane, rexSession };
}

export async function isSessionOpen(_, target) {
  try {
    const { blocks } = JSON.parse(await rex(target, ['--autostart=false', 'block', 'ls', '-s', target.rexSession, '--json']));
    return blocks.some(block => block.block_id === target.pane);
  } catch {
    return false; // the session has gone, or Rex has
  }
}

// Whether a block from before a restart still has Claude in it.
export async function runsClaude(session) {
  try {
    return (await callBlock(session, 'process', {})).foreground?.name === PROGRAM_NAME;
  } catch {
    return false; // the block, or Rex itself, has gone
  }
}
