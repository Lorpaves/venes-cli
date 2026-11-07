// A session in Rex needs no tmux. Its hooks say which block it's in, and the rex command does the
// typing and reading through the server's API.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperError } from './sessions.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const OUTPUT_BYTES = 8 * 1024 * 1024;
// A terminal can hold 64 MiB of scrollback, and only the end of it is the screen.
const SCREEN_BYTES = 32 * 1024;
const KEYS = { Enter: 'enter', Escape: 'escape', Up: 'up', Down: 'down', Left: 'left', Right: 'right', 'M-p': 'alt+p' };
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

export async function readScreen(session) {
  const start = await callBlock(session, 'format', { format: 'text', trim: true, max_bytes: SCREEN_BYTES });
  if (start.id === undefined) return start.content;
  const end = await callBlock(session, 'blob_read', { id: start.id, offset: Math.max(0, start.total - SCREEN_BYTES), max_bytes: SCREEN_BYTES });
  return end.data;
}

export async function pressKey(session, key) {
  await rex(session, ['--autostart=false', 'send-key', ...blockTarget(session), KEYS[key] ?? key]);
}

// On stdin, because a message can be longer than an argument can.
export async function paste(session, text) {
  const event = { session_id: session.rexSession, block_id: session.pane, event: { type: 'paste', payload: { text } } };
  await rex(session, ['--autostart=false', 'api', 'call', 'block.event', '-'], JSON.stringify(event));
}

async function ownSession() {
  const { sessions } = JSON.parse(await rex({}, ['session', 'ls', '--json']));
  const known = sessions.find(session => session.label === SESSION_LABEL);
  if (known) return known.session_id;
  return JSON.parse(await rex({}, ['api', 'call', 'session.create', JSON.stringify({ label: SESSION_LABEL })])).session_id;
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
