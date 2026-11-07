// Picks a stored session back up when a message comes for it: `claude --resume` in a tmux session
// of its own, with the message as its first prompt. Claude Code's own command line carries the
// message, so nothing has to wait for the terminal to be ready for typing.

import os from 'node:os';
import fs from 'node:fs';
import { HelperError } from './sessions.mjs';

const START_LIMIT_MS = 20_000;
const CHECK_MS = 500;
// tmux refuses a command of about 16 KB, and the first message travels in one. Later ones are
// pasted, so they have no such limit.
const FIRST_MESSAGE_LIMIT_BYTES = 12_000;
const SESSION_PREFIX = 'venes-';
const SHORT_ID_LENGTH = 8;
// A tmux server keeps the environment it started with, which may be older or barer than this one.
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR', 'VENES_HOME', 'DISABLE_UPDATES'];

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function workingDirectory(cwd) {
  return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
}

function resumeCommand(sessionId, text, env, { model, effort } = {}) {
  const chosen = [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])];
  // `--` keeps a message that starts with "-" from being read as a flag.
  return ['claude', ...JSON.parse(env.VENES_RESUME_ARGS ?? '[]'), ...chosen, '--resume', sessionId, '--', text];
}

function heardFrom(store, sessionId) {
  let stopListening;
  const prompted = new Promise(resolve => {
    const listener = event => { if (event.sessionId === sessionId && event.kind === 'message.user') resolve(); };
    store.on('event', listener);
    stopListening = () => store.off('event', listener);
  });
  return { prompted, stopListening };
}

async function waitForPrompt({ prompted, tmux, name, pane, tmuxSocket, limit, check }) {
  let isPrompted = false;
  prompted.then(() => { isPrompted = true; });
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    await delay(check);
    if (isPrompted) return;
    if (!(await tmux.isSessionOpen(name, tmuxSocket))) throw new HelperError('resume_failed', 'Claude Code quit without resuming this session.');
  }
  // Only now: until then the screen shows the end of the old conversation, which could say anything.
  if (await tmux.hasOpenDialog({ pane, tmuxSocket })) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
  throw new HelperError('resume_failed', 'Claude Code took too long to resume this session.');
}

// A session running anywhere else can't be resumed here: the two would write into one transcript.
export async function resumeSession({ store, library, tmux, env = process.env, limit = START_LIMIT_MS, check = CHECK_MS }, sessionId, { clientId, text }, chosen) {
  if (Buffer.byteLength(text) > FIRST_MESSAGE_LIMIT_BYTES) throw new HelperError('message_too_long', 'Send something shorter first, to start this session.');
  const running = await library.running();
  if (running.some(session => session.id === sessionId)) throw new HelperError('no_pane', 'This session is running outside tmux.');
  const info = await library.info(sessionId);
  if (!info) throw new HelperError('unknown_session', `No stored session ${sessionId}`);
  const session = store.reopen(sessionId, { cwd: info.cwd, startedAt: info.createdAt });
  if (clientId) store.expectEcho(session, clientId, text);
  const name = `${SESSION_PREFIX}${sessionId.slice(0, SHORT_ID_LENGTH)}`;
  const tmuxSocket = env.VENES_TMUX_SOCKET;
  const { prompted, stopListening } = heardFrom(store, sessionId);
  try {
    const variables = Object.fromEntries(PASSED_ENV.filter(key => env[key]).map(key => [key, env[key]]));
    const pane = await tmux.startSession({ name, cwd: workingDirectory(info.cwd), command: resumeCommand(sessionId, text, env, chosen), env: variables, tmuxSocket });
    await waitForPrompt({ prompted, tmux, name, pane, tmuxSocket, limit, check });
    return { queued: false, resumed: true };
  } catch (error) {
    if (clientId) store.forgetEcho(session, clientId);
    // The terminal stays open for a dialog: someone at the Mac can still answer it.
    if (error.code !== 'dialog_open') store.abandon(session);
    throw error;
  } finally {
    stopListening();
  }
}
