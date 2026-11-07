import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperError } from './sessions.mjs';

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5000;
const PASTE_SETTLE_MS = 150;
const NEW_SESSION_COLUMNS = 120;
const NEW_SESSION_ROWS = 40;

// Pressing Enter while one of these is open picks its highlighted option, which for a permission
// prompt means approving the tool, and on a page like /config changes a setting. Footers end in
// "Esc to cancel", "clear", "close" or "dismiss". The status line's "esc" is in lower case.
const DIALOG_FOOTER = /Esc to \w+|Enter to (select|confirm)|Do you want to proceed/;
// Stricter, because Esc gets pressed on it: a footer, and not a sentence in a reply.
const PAGE_FOOTER = /(^|[·│])\s*Esc to \w+/m;
// Asked before a new model or effort level gives up a warm prompt cache. It has no footer.
const SWITCH_QUESTION = /❯ 1\. Yes, switch to /;
const DIALOG_SEARCH_LINES = 14;
// What a command opens took under 100ms to appear when measured, so this allows for a busy Mac.
const COMMAND_SETTLE_LIMIT_MS = 1500;
const COMMAND_SETTLE_CHECK_MS = 50;
// A request's hook can land just after its prompt shows, and Esc would then refuse it.
const REQUEST_SETTLE_MS = 250;
// /config takes two: one for its filter, and one for itself.
const PAGE_CLOSE_PRESSES = 3;
const PAGE_CLOSE_SETTLE_MS = 300;

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

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const bottomOf = screen => screen.trimEnd().split('\n').slice(-DIALOG_SEARCH_LINES).join('\n');
const readScreen = ({ pane, tmuxSocket }) => tmux(tmuxSocket, ['capture-pane', '-p', '-t', pane]);

export function showsDialog(screen) {
  const bottom = bottomOf(screen);
  return DIALOG_FOOTER.test(bottom) || SWITCH_QUESTION.test(bottom);
}

export async function hasOpenDialog(session) {
  return showsDialog(await readScreen(session));
}

function refuseIfRequested(isBlocked) {
  const pending = isBlocked();
  if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
}

async function refuseIfBlocked(session, isBlocked) {
  refuseIfRequested(isBlocked);
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
  await pause(PASTE_SETTLE_MS);
  await refuseIfBlocked(session, isBlocked);
  await tmux(tmuxSocket, ['send-keys', '-t', pane, 'Enter']);
}

async function closePage(session, settle) {
  for (let press = 0; press < PAGE_CLOSE_PRESSES; press++) {
    await sendEscape(session);
    await pause(settle);
    if (!PAGE_FOOTER.test(bottomOf(await readScreen(session)))) return;
  }
}

// What a reader's slash command leaves on the screen, which nobody with the reader can see. A
// question about the cache is one they answered by asking. A page goes, because the next
// message would act on it.
export async function settleCommand(session, isBlocked, {
  limit = COMMAND_SETTLE_LIMIT_MS, check = COMMAND_SETTLE_CHECK_MS, requestSettle = REQUEST_SETTLE_MS, pageSettle = PAGE_CLOSE_SETTLE_MS,
} = {}) {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    // A command like /exit takes its pane with it.
    const screen = await readScreen(session).catch(() => undefined);
    if (screen === undefined) return;
    const bottom = bottomOf(screen);
    const isQuestion = SWITCH_QUESTION.test(bottom);
    if (isQuestion || PAGE_FOOTER.test(bottom)) {
      await pause(requestSettle);
      if (isBlocked()) return;
      if (isQuestion) {
        await tmux(session.tmuxSocket, ['send-keys', '-t', session.pane, 'Enter']);
        return;
      }
      await closePage(session, pageSettle);
      throw new HelperError('terminal_only', 'That command only works at the terminal.');
    }
    await pause(check);
  }
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
