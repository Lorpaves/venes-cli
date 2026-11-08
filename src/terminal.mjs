// What the helper does with a terminal, whichever one a session runs in. A session in Rex says so
// with `rexSession`, and any other pane is tmux's.

import * as rex from './rex.mjs';
import { isBlank, plainText, runsOf, screenCells } from './screen.mjs';
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

// The edge of Claude Code's input box, across the pane.
const BOX_EDGE = /^\s*─{8,}/;
// The start of what's typed in the box. "!" is the same box running a shell command.
const PROMPT = /^\s*[❯!]/;
// Spaces this wide or wider are the terminal keeping two things apart, like a notice at the right.
const GAP = 3;

export const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
export const bottomOf = screen => screen.trimEnd().split('\n').slice(-DIALOG_SEARCH_LINES).join('\n');
const backendOf = session => (session.rexSession ? rex : tmux);
export const readScreen = session => backendOf(session).readScreen(session);
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

// What Claude Code shows under its input box: the status line a person set up, in whatever look
// they gave it, then its own line for the mode and what's running. None when something covers the
// box. `screen` has the escape sequences that colour it. Things the terminal keeps apart on one
// line come as lines of their own, for a narrower screen.
export function statusLines(screen) {
  const rows = screenCells(screen);
  const plain = rows.map(plainText);
  const none = { lines: [], styled: [] };
  if (showsDialog(plain.join('\n'))) return none;
  // A status line can draw edges of its own, so the box is found by what's typed in it first.
  const prompt = plain.findLastIndex(line => PROMPT.test(line));
  const under = prompt < 0 ? -1 : plain.findIndex((line, i) => i > prompt && BOX_EDGE.test(line));
  const edge = under < 0 ? plain.findLastIndex(line => BOX_EDGE.test(line)) : under;
  if (edge < 0) return none;
  const pieces = rows.slice(edge + 1).flatMap(piecesOf);
  return { lines: pieces.map(plainText), styled: pieces.map(runsOf) };
}

// A line's parts, without the spaces around them that show nothing.
function piecesOf(cells) {
  const pieces = [];
  let piece = [];
  let gap = [];
  for (const cell of cells) {
    if (isBlank(cell)) {
      gap.push(cell);
      continue;
    }
    if (piece.length && gap.length >= GAP) {
      pieces.push(piece);
      piece = [];
    } else if (piece.length) {
      piece.push(...gap);
    }
    gap = [];
    piece.push(cell);
  }
  if (piece.length) pieces.push(piece);
  return pieces;
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
