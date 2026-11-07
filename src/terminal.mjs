// What the helper does with a terminal, whichever one a session runs in. A session in Rex says so
// with `rexSession`, and any other pane is tmux's.

import * as rex from './rex.mjs';
import { HelperError } from './sessions.mjs';
import * as tmux from './tmux.mjs';

const PASTE_SETTLE_MS = 150;

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

export const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
export const bottomOf = screen => screen.trimEnd().split('\n').slice(-DIALOG_SEARCH_LINES).join('\n');
const backendOf = session => (session.rexSession ? rex : tmux);
export const readScreen = session => backendOf(session).readScreen(session);
export const pressKey = (session, key) => backendOf(session).pressKey(session, key);
export const sendEscape = session => pressKey(session, 'Escape');

export function showsDialog(screen) {
  const bottom = bottomOf(screen);
  return DIALOG_FOOTER.test(bottom) || SWITCH_QUESTION.test(bottom);
}

export async function hasOpenDialog(session) {
  return showsDialog(await readScreen(session));
}

export function refuseIfRequested(isBlocked) {
  const pending = isBlocked();
  if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
}

export async function refuseIfBlocked(session, isBlocked) {
  refuseIfRequested(isBlocked);
  if (await hasOpenDialog(session)) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
}

// isBlocked is checked again just before Enter, because a request can open while
// the text is on its way and Enter would then answer it.
export async function sendText(session, text, isBlocked) {
  await refuseIfBlocked(session, isBlocked);
  await backendOf(session).paste(session, text);
  await pause(PASTE_SETTLE_MS);
  await refuseIfBlocked(session, isBlocked);
  await pressKey(session, 'Enter');
}

// Only while a footer says Esc will close something: with nothing open it'd interrupt the turn.
export async function closePage(session, settle = PAGE_CLOSE_SETTLE_MS) {
  for (let press = 0; press < PAGE_CLOSE_PRESSES; press++) {
    if (!PAGE_FOOTER.test(bottomOf(await readScreen(session)))) return;
    await sendEscape(session);
    await pause(settle);
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
        await pressKey(session, 'Enter');
        return;
      }
      await closePage(session, pageSettle);
      throw new HelperError('terminal_only', 'That command only works at the terminal.');
    }
    await pause(check);
  }
}

// Which terminal a hook says its session is in. tmux inside Rex is tmux's, because that's the pane
// keys need to reach.
export function terminalFrom(headers) {
  const pane = headers['x-venes-pane'];
  if (pane) return { pane, socket: tmux.parseTmuxEnv(headers['x-venes-tmux']) };
  const block = headers['x-venes-rex-block'];
  if (!block) return {};
  return { pane: block, rexSession: headers['x-venes-rex-session'], rexServer: headers['x-venes-rex-server'] || undefined };
}

// Where a stopped session picks up again: Rex if it's on this Mac, as nothing else is needed for it.
export function resumeTerminal(env = process.env) {
  const useRex = env.VENES_TERMINAL ? env.VENES_TERMINAL === 'rex' : rex.isInstalled();
  const backend = useRex ? rex : tmux;
  return { startSession: backend.startSession, isSessionOpen: backend.isSessionOpen, hasOpenDialog };
}
