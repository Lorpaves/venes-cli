// What the helper does with a terminal, whichever one a session runs in. A session in Rex says so
// with `rexSession`, and any other pane is tmux's.

import * as rex from './rex.mjs';
import { plainText, runsOf, screenCells } from './screen.mjs';
import { HelperError } from './sessions.mjs';
import * as tmux from './tmux.mjs';
import { referenceTo } from './uploads.mjs';

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
// Claude Code reads a pasted picture before its mark shows, and text pasted sooner could land ahead
// of it. A picture it doesn't take stays as its path, which Claude can still read.
const IMAGE_SETTLE_LIMIT_MS = 4000;
const IMAGE_SETTLE_CHECK_MS = 100;
const IMAGE_MARK = /\[Image #\d+\]/g;
// The edge a page opens under, across the pane from its first column.
const PAGE_EDGE = /^─{20,}/;
// What a reader can press on a page from afar, by the names tmux and Rex both know them by here.
export const PAGE_KEYS = ['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace'];

export const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
export const bottomOf = screen => screen.trimEnd().split('\n').slice(-DIALOG_SEARCH_LINES).join('\n');
const backendOf = session => (session.rexSession ? rex : tmux);
export const readScreen = session => backendOf(session).readScreen(session);
// With the escape sequences that colour it.
export const readStyledScreen = session => backendOf(session).readStyledScreen(session);
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

const marksIn = screen => bottomOf(screen).match(IMAGE_MARK)?.length ?? 0;

async function pasteImage(session, file, { limit, check }) {
  const before = marksIn(await readScreen(session));
  await backendOf(session).paste(session, file);
  for (const deadline = Date.now() + limit; Date.now() < deadline; await pause(check)) {
    if (marksIn(await readScreen(session)) > before) break;
  }
  await backendOf(session).paste(session, ' ');
}

// Attachments in their order, then the text. A picture is pasted by itself, so Claude Code turns its
// path into an image as it does one dragged into the terminal, and a file is a reference. isBlocked
// is checked again just before Enter, because a request can open while the message is on its way
// and Enter would then answer it.
export async function sendMessage(session, { text = '', attachments = [] }, isBlocked, {
  imageLimit = IMAGE_SETTLE_LIMIT_MS, imageCheck = IMAGE_SETTLE_CHECK_MS,
} = {}) {
  await refuseIfBlocked(session, isBlocked);
  for (const upload of attachments) {
    if (upload.kind === 'image') await pasteImage(session, upload.path, { limit: imageLimit, check: imageCheck });
    else await backendOf(session).paste(session, `${referenceTo(upload)} `);
  }
  if (text) await backendOf(session).paste(session, text);
  await pause(PASTE_SETTLE_MS);
  await refuseIfBlocked(session, isBlocked);
  await pressKey(session, 'Enter');
}

export const sendText = (session, text, isBlocked) => sendMessage(session, { text }, isBlocked);

// What a command opened, like /mcp's servers or /config's settings, from the edge it opened under
// to its footer, as runs of text that look alike: null when nothing is open. `screen` has the
// escape sequences that colour it.
export function pageOf(screen) {
  const rows = screenCells(screen);
  const plain = rows.map(plainText);
  let end = plain.length;
  while (end > 0 && !plain[end - 1].trim()) end -= 1;
  if (!showsDialog(plain.slice(0, end).join('\n'))) return null;
  const top = plain.slice(0, end).findLastIndex(line => PAGE_EDGE.test(line));
  const lines = rows.slice(top + 1, end).map(cells => {
    let last = cells.length;
    while (last > 0 && cells[last - 1].char === ' ' && !cells[last - 1].style.background && !cells[last - 1].style.inverse) last -= 1;
    return runsOf(cells.slice(0, last));
  });
  while (lines.length && !lines[0].length) lines.shift();
  return { lines };
}

export async function readPage(session) {
  return pageOf(await readStyledScreen(session));
}

// A key for what's open, and nothing else: with nothing open, Esc would interrupt the turn and
// Enter would send what's in the box.
export async function pressPageKey(session, key) {
  if (!PAGE_KEYS.includes(key)) throw new HelperError('bad_key', `${key} isn't a key a page takes.`);
  if (!(await hasOpenDialog(session))) throw new HelperError('no_page', 'Nothing is open in the terminal.');
  await pressKey(session, key);
}

// Text for a page's search box.
export async function typeOnPage(session, text) {
  if (!(await hasOpenDialog(session))) throw new HelperError('no_page', 'Nothing is open in the terminal.');
  await backendOf(session).paste(session, text);
}

// Only while a footer says Esc will close something: with nothing open it'd interrupt the turn.
export async function closePage(session, settle = PAGE_CLOSE_SETTLE_MS) {
  for (let press = 0; press < PAGE_CLOSE_PRESSES; press++) {
    if (!PAGE_FOOTER.test(bottomOf(await readScreen(session)))) return;
    await sendEscape(session);
    await pause(settle);
  }
}

// What a reader's slash command leaves on the screen. A question about the cache is one they
// answered by asking. A page is 'page' when the reader can see it, through `keepPage`, and
// otherwise it goes, because the next message would act on it.
export async function settleCommand(session, isBlocked, {
  limit = COMMAND_SETTLE_LIMIT_MS, check = COMMAND_SETTLE_CHECK_MS, requestSettle = REQUEST_SETTLE_MS, pageSettle = PAGE_CLOSE_SETTLE_MS,
  keepPage = false,
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
        return undefined;
      }
      if (keepPage) return 'page';
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
  return { startSession: backend.startSession, isSessionOpen: backend.isSessionOpen, hasOpenDialog, readScreen, pressKey };
}
