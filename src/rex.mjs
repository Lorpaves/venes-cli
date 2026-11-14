// A session in Rex needs no tmux. Its hooks say which block it's in, and the rex command does the
// typing and reading through the server's API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { helperPaths } from './paths.mjs';
import { HelperError } from './sessions.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const OUTPUT_BYTES = 8 * 1024 * 1024;
// A terminal can hold 64 MiB of scrollback, and only the end of it is the screen.
const SCREEN_BYTES = 32 * 1024;
// A read can come back with less than it asked for, which is more reads to the end.
const SCREEN_READS = 8;
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

// The end of what the terminal holds, up to `bytes` of it, and whether there was more before that.
async function readFormatted(session, format, { bytes = SCREEN_BYTES, unwrap = false } = {}) {
  const start = await callBlock(session, 'format', { format, trim: true, unwrap, max_bytes: bytes });
  if (start.id === undefined) return { content: start.content, cut: false };
  const first = Math.max(0, start.total - bytes);
  let offset = first;
  let screen = '';
  for (let reads = 0; reads < SCREEN_READS && offset < start.total; reads++) {
    const { data = '', eof } = await callBlock(session, 'blob_read', { id: start.id, offset, max_bytes: start.total - offset });
    screen += data;
    offset += Buffer.byteLength(data);
    if (eof || !data) break;
  }
  return { content: screen, cut: first > 0 };
}

export const readScreen = async session => (await readFormatted(session, 'text')).content;
// With the escape sequences that colour it.
export const readStyledScreen = async session => (await readFormatted(session, 'vt')).content;

// Everything a terminal session's shell has printed since its screen was last cleared, coloured, with
// the lines the terminal wrapped joined again. `cut` when the start didn't fit.
export async function readOutput(session) {
  const { content, cut } = await readFormatted(session, 'vt', { bytes: OUTPUT_READ_BYTES, unwrap: true });
  return { text: content, cut };
}

// Whether a program has the screen to itself, as an editor or a pager does.
export async function isFullScreen(session) {
  return (await callBlock(session, 'modes', {})).screen === 'alternate';
}

// A program reading a line without showing it, as a password prompt does. A shell or a program that
// edits its own line reads keys one at a time, and shows them itself.
export async function hidesInput(session) {
  const mode = await callBlock(session, 'input_mode', {});
  return mode.canonical === true && mode.echo === false;
}

// It applies once no one at the Mac is looking at the terminal in a window of their own size.
export async function resize(session, { columns, rows }) {
  await callBlock(session, 'resize', { columns, rows });
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
