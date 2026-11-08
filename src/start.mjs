// A new session in the folder the reader picked: Claude Code in a terminal session of its own, as a
// resumed one gets. Claude Code asks first about a folder it doesn't trust, and holds back every hook,
// the helper's too, until that's answered. The reader's word, given in the app, answers it here, as
// pressing the keys at the Mac would. Without it, nothing is answered and nothing is left running.

import crypto from 'node:crypto';
import { checkedFolder } from './folders.mjs';
import { HelperError } from './sessions.mjs';
import { isTrusted } from './trust.mjs';

// Claude Code was up in under 5s when measured. Answering it and a busy Mac take longer.
const START_LIMIT_MS = 30_000;
const CHECK_MS = 300;
const KEY_SETTLE_MS = 300;
const SESSION_PREFIX = 'venes-new-';
// As a resumed session gets them.
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR', 'VENES_HOME', 'VENES_CLAUDE_SETTINGS', 'VENES_TMUX_SOCKET', 'DISABLE_UPDATES'];
// Claude Code's question, and its answer picked. "No, exit" comes first, and is the one picked to start with.
const TRUST_QUESTION = /Yes, I trust this folder/;
const TRUST_PICKED = /❯\s*Yes, I trust this folder/;
// Two options, so the other one is a press away, and one more gives up.
const TRUST_PRESSES = 2;

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

const needsTrust = () => new HelperError('needs_trust', 'Claude Code asks whether to trust this folder first.');

// The sessions that start from now on, by the terminal the hook came from.
function startsFrom(store) {
  const started = [];
  const listener = event => { if (event.kind === 'session.started') started.push(event.sessionId); };
  store.on('event', listener);
  return {
    sessionIn: target => started.find(id => store.find(id)?.pane === target.pane),
    stopListening: () => store.off('event', listener),
  };
}

async function answerTrust(terminal, target, settle) {
  for (let press = 0; press < TRUST_PRESSES; press++) {
    await terminal.pressKey(target, 'Down');
    await pause(settle);
    if (TRUST_PICKED.test(await terminal.readScreen(target))) {
      await terminal.pressKey(target, 'Enter');
      return;
    }
  }
  throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
}

export async function startNewSession(
  { store, terminal, env = process.env, trusts = isTrusted, limit = START_LIMIT_MS, check = CHECK_MS, settle = KEY_SETTLE_MS },
  { cwd, trust = false },
) {
  const folder = checkedFolder(cwd);
  if (trust !== true && !trusts(folder)) throw needsTrust();
  const name = `${SESSION_PREFIX}${crypto.randomBytes(4).toString('hex')}`;
  const variables = Object.fromEntries(PASSED_ENV.filter(key => env[key]).map(key => [key, env[key]]));
  const command = ['claude', ...JSON.parse(env.VENES_RESUME_ARGS ?? '[]')];
  const { sessionIn, stopListening } = startsFrom(store);
  try {
    const target = await terminal.startSession({ name, cwd: folder, command, env: variables });
    let isAnswered = false;
    for (const deadline = Date.now() + limit; Date.now() < deadline; await pause(check)) {
      const sessionId = sessionIn(target);
      if (sessionId) return { sessionId };
      if (!(await terminal.isSessionOpen(name, target))) throw new HelperError('start_failed', 'Claude Code quit before the session started.');
      if (isAnswered || !TRUST_QUESTION.test(await terminal.readScreen(target).catch(() => ''))) continue;
      if (trust !== true) {
        // It thinks otherwise about this folder: Esc is its "No, exit".
        await terminal.pressKey(target, 'Escape');
        throw needsTrust();
      }
      await answerTrust(terminal, target, settle);
      isAnswered = true;
    }
    // Someone at the Mac can still answer it.
    if (await terminal.hasOpenDialog(target)) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
    throw new HelperError('start_failed', 'Claude Code took too long to start.');
  } finally {
    stopListening();
  }
}
