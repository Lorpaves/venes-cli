import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperError } from './sessions.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const PASTE_SETTLE_MS = 150;
const NEW_SESSION_COLUMNS = 120;
const NEW_SESSION_ROWS = 40;

// Pressing Enter while one of these is open picks its highlighted option, which
// for a permission prompt means approving the tool.
const DIALOG_FOOTER = /Esc to cancel|Enter to (select|confirm)|Do you want to proceed/;
const DIALOG_SEARCH_LINES = 14;

export function parseTmuxEnv(value) {
  return value ? value.split(',')[0] : undefined;
}

function tmuxArgs(socket, args) {
  return socket ? ['-S', socket, ...args] : args;
}

async function tmux(socket, args, input) {
  const child = exec('tmux', tmuxArgs(socket, args), { timeout: COMMAND_TIMEOUT_MS });
  if (input !== undefined) child.child.stdin.end(input);
  const { stdout } = await child;
  return stdout;
}

export async function hasOpenDialog({ pane, tmuxSocket }) {
  const screen = await tmux(tmuxSocket, ['capture-pane', '-p', '-t', pane]);
  const lines = screen.trimEnd().split('\n').slice(-DIALOG_SEARCH_LINES);
  return DIALOG_FOOTER.test(lines.join('\n'));
}

async function refuseIfBlocked(session, isBlocked) {
  const pending = isBlocked();
  if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
  if (await hasOpenDialog(session)) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
}

// isBlocked is checked again just before Enter, because a request can open while
// the text is on its way and Enter would then answer it.
export async function sendText(session, text, isBlocked) {
  const { pane, tmuxSocket } = session;
  await refuseIfBlocked(session, isBlocked);
  // Always a paste: as send-keys arguments, a leading "-" or trailing ";" would be
  // read by tmux itself instead of reaching Claude.
  await tmux(tmuxSocket, ['load-buffer', '-b', 'venes', '-'], text);
  await tmux(tmuxSocket, ['paste-buffer', '-p', '-d', '-b', 'venes', '-t', pane]);
  await new Promise(resolve => { setTimeout(resolve, PASTE_SETTLE_MS); });
  await refuseIfBlocked(session, isBlocked);
  await tmux(tmuxSocket, ['send-keys', '-t', pane, 'Enter']);
}

// Runs a command in a new detached session and returns its pane. The session closes with it.
export async function startSession({ name, cwd, command, env, tmuxSocket }) {
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const size = ['-x', String(NEW_SESSION_COLUMNS), '-y', String(NEW_SESSION_ROWS)];
  try {
    const output = await tmux(tmuxSocket, ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, ...size, '-c', cwd, ...variables, '--', ...command]);
    return output.trim();
  } catch (error) {
    if (error.code === 'ENOENT') throw new HelperError('no_tmux', 'Install tmux on your Mac to continue this session.');
    throw error;
  }
}

export async function isSessionOpen(name, tmuxSocket) {
  try {
    await tmux(tmuxSocket, ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

export async function sendEscape({ pane, tmuxSocket }) {
  await tmux(tmuxSocket, ['send-keys', '-t', pane, 'Escape']);
}

function isClaude(command) {
  return path.basename(command) === 'claude';
}

// Panes running Claude that haven't sent an event yet: they join the event stream
// on their next hook, so clients can list them as waiting for activity.
export async function findClaudePanes(sockets) {
  const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,ppid=,comm='], { timeout: COMMAND_TIMEOUT_MS });
  const children = new Map();
  const claudePids = new Set();
  for (const line of stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
    if (isClaude(command)) claudePids.add(pid);
  }
  const runsClaude = pid => claudePids.has(pid) || (children.get(pid) ?? []).some(runsClaude);

  const panes = [];
  for (const socket of sockets) {
    let listing;
    try {
      listing = await tmux(socket, ['list-panes', '-a', '-F', '#{pane_id}\t#{pane_pid}\t#{session_name}\t#{pane_current_path}']);
    } catch {
      continue; // no server on this socket
    }
    for (const line of listing.split('\n').filter(Boolean)) {
      const [pane, pid, sessionName, cwd] = line.split('\t');
      if (runsClaude(pid)) panes.push({ pane, tmuxSocket: socket ?? null, tmuxSession: sessionName, cwd });
    }
  }
  return panes;
}
