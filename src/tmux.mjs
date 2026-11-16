import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperError } from './sessions.mjs';
import { computer } from './platform.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const NEW_SESSION_COLUMNS = 120;
const NEW_SESSION_ROWS = 40;

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

export const readScreen = ({ pane, tmuxSocket }) => tmux(tmuxSocket, ['capture-pane', '-p', '-t', pane]);
export const readStyledScreen = ({ pane, tmuxSocket }) => tmux(tmuxSocket, ['capture-pane', '-p', '-e', '-t', pane]);
export const pressKey = ({ pane, tmuxSocket }, key) => tmux(tmuxSocket, ['send-keys', '-t', pane, key]);

// The pane of a session started with `startSession`, by the name it was given, or nothing when it has gone.
export async function findSession(name, env) {
  const tmuxSocket = env.VENES_TMUX_SOCKET;
  try {
    const pane = (await tmux(tmuxSocket, ['list-panes', '-t', `=${name}`, '-F', '#{pane_id}'])).split('\n')[0].trim();
    return pane ? { pane, tmuxSocket } : undefined;
  } catch {
    return undefined;
  }
}

// The process of the program a pane is running now: the one of that name at the pane's own process or
// under it, as a program started from a shell there is.
export async function processOf({ pane, tmuxSocket }) {
  const [name, root] = (await tmux(tmuxSocket, ['display-message', '-p', '-t', pane, '#{pane_current_command}\t#{pane_pid}'])).trim().split('\t');
  const { stdout } = await exec('ps', ['-axww', '-o', 'pid=,ppid=,comm='], { timeout: COMMAND_TIMEOUT_MS });
  const rows = stdout.split('\n').map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean).map(([, pid, ppid, command]) => ({ pid, ppid, command }));
  const under = [root];
  for (let at = 0; at < under.length; at++) under.push(...rows.filter(row => row.ppid === under[at]).map(row => row.pid));
  const found = rows.find(row => under.includes(row.pid) && path.basename(row.command) === name);
  return { name, pid: found ? Number(found.pid) : undefined };
}

// The program a pane is running now, by its name.
export const foreground = async ({ pane, tmuxSocket }) => (await tmux(tmuxSocket, ['display-message', '-p', '-t', pane, '#{pane_current_command}'])).trim();

// Always a paste: as send-keys arguments, a leading "-" or trailing ";" would be read by tmux
// itself instead of reaching Claude.
export async function paste({ pane, tmuxSocket }, text) {
  await tmux(tmuxSocket, ['load-buffer', '-b', 'venes', '-'], text);
  await tmux(tmuxSocket, ['paste-buffer', '-p', '-d', '-b', 'venes', '-t', pane]);
}

// Runs a command in a new detached session and returns its pane. The session closes with it.
export async function startSession({ name, cwd, command, env }) {
  const tmuxSocket = env.VENES_TMUX_SOCKET;
  const variables = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  const size = ['-x', String(NEW_SESSION_COLUMNS), '-y', String(NEW_SESSION_ROWS)];
  try {
    const output = await tmux(tmuxSocket, ['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, ...size, '-c', cwd, ...variables, '--', ...command]);
    return { pane: output.trim(), tmuxSocket };
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new HelperError('no_tmux', process.platform === 'win32'
        ? 'Venes can\'t start or continue a session on Windows yet. Start Claude Code at the computer, and it shows up here.'
        : `Install tmux or Rex on your ${computer} to continue this session.`);
    }
    throw error;
  }
}

export async function isSessionOpen(name, { tmuxSocket }) {
  try {
    await tmux(tmuxSocket, ['has-session', '-t', `=${name}`]);
    return true;
  } catch {
    return false;
  }
}

function isClaude(command) {
  return path.basename(command) === 'claude';
}

// Panes running Claude that haven't sent an event yet: they join the event stream
// on their next hook, so clients can list them as waiting for activity.
export async function findClaudePanes(sockets) {
  // There's no tmux on Windows itself, and its `ps` is another program.
  if (process.platform === 'win32') return [];
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
