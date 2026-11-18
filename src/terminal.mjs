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
// Claude Code's input box is drawn between two such edges, its first line after this mark. Empty, it
// shows a line of what could be asked, dimmed, which isn't something typed.
const BOX_MARK = '❯';
// What empties the box, as its own keys do (2.1.323): Ctrl+K takes what's after the cursor to the end
// of its line, then the line's end with it, and Ctrl+U what's before it, a line at a time. Wherever the
// cursor was left, a few of each, a few times over, take it all. Enough for a draft of dozens of lines.
const BOX_KEYS = ['C-k', 'C-u'];
const BOX_PRESSES = 6;
const BOX_ROUNDS = 12;
const BOX_SETTLE_MS = 120;
// What a reader can press on a page from afar, by the names tmux and Rex both know them by here.
export const PAGE_KEYS = ['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape', 'Tab', 'BTab', 'Space', 'BSpace'];

export const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
// Whether a terminal's program is its shell, as when what ran in it has quit back to it.
export const isShell = program => /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|pwsh|powershell|cmd)(\.exe)?$/i.test(String(program ?? '').split(/[\\/]/).pop());
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

// A question the terminal asks before a session is there to ask through its hooks, with a list to pick
// from: as Claude Code asks about Code Mode of whoever has turned that on and not yet said yes to it,
// at every start. What it says and offers is read off the screen, for a client to show and the reader to
// answer, which is theirs to do. It's told by being the last thing on the screen, down to the line that
// says what Enter does, with one of its options pointed at. Nothing for anything else.
const CHOICE_FOOTER = /\bEnter to (?:confirm|select)\b/;
const CHOICE_MARK = '❯';
const RULE = /^[─━]{8,}$/;

export function readChoice(screen) {
  const lines = String(screen ?? '').split('\n').map(line => line.trimEnd());
  let end = lines.length - 1;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  if (end < 0 || !CHOICE_FOOTER.test(lines[end])) return undefined;
  const pointed = lines.slice(0, end).findLastIndex(line => line.trimStart().startsWith(`${CHOICE_MARK} `));
  if (pointed < 0) return undefined;
  // An option's words start two along from the mark, on its line and on the others'.
  const column = lines[pointed].indexOf(CHOICE_MARK) + 2;
  const isOption = line => line.length > column && line[column] !== ' ' && !line.slice(0, column).replace(CHOICE_MARK, ' ').trim();
  let first = pointed;
  while (first > 0 && isOption(lines[first - 1])) first -= 1;
  let last = pointed;
  while (last + 1 < end && isOption(lines[last + 1])) last += 1;
  const options = lines.slice(first, last + 1).map(line => line.slice(column).trim().replace(/^\d+\.\s+/, ''));
  if (options.length < 2 || new Set(options).size !== options.length) return undefined;
  // What it asks is above them, from the line that sets it off: its name on the first line, then what
  // it says, a paragraph to each run of lines.
  let top = first - 1;
  while (top >= 0 && !RULE.test(lines[top].trim())) top -= 1;
  const said = lines.slice(top + 1, first).map(line => line.trim());
  const named = said.findIndex(Boolean);
  if (named < 0) return undefined;
  const title = said[named];
  const rest = said.slice(named + 1).join('\n').split(/\n{2,}/).map(run => run.split('\n').filter(Boolean).join(' ')).filter(Boolean);
  return { title, text: rest.join('\n\n'), options, pointed: pointed - first };
}

const CHOICE_SETTLE_MS = 150;
const CHOICE_MOVES = 12;

// Presses the option a reader picked, as someone at the terminal would: down or up to it, then Enter.
// The screen is read again before each key, so a question that has gone, or isn't the one that was
// answered, gets none.
export async function pickChoice(terminal, target, option, { settle = CHOICE_SETTLE_MS } = {}) {
  for (let move = 0; move < CHOICE_MOVES; move++) {
    const now = readChoice(await terminal.readScreen(target));
    const at = now?.options.indexOf(option) ?? -1;
    if (at < 0) throw new HelperError('choice_gone', 'That question isn\'t on the terminal any more.');
    if (now.pointed === at) {
      await terminal.pressKey(target, 'Enter');
      return;
    }
    await terminal.pressKey(target, now.pointed < at ? 'Down' : 'Up');
    await pause(settle);
  }
  throw new HelperError('choice_gone', 'The terminal didn\'t move to that answer.');
}

export function refuseIfRequested(isBlocked) {
  const pending = isBlocked();
  if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
}

export async function refuseIfBlocked(session, isBlocked) {
  refuseIfRequested(isBlocked);
  if (await hasOpenDialog(session)) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
}

// What's typed in Claude Code's input box, from a screen with its colours: an empty string when there's
// nothing, and nothing at all when the screen has no box to read, as with a dialog open over it.
export function typedIn(styledScreen) {
  const rows = screenCells(styledScreen);
  const plain = rows.map(plainText);
  const edges = plain.flatMap((line, index) => (PAGE_EDGE.test(line) ? [index] : []));
  const [top, bottom] = edges.slice(-2);
  if (bottom === undefined || bottom - top < 2 || !plain[top + 1].startsWith(BOX_MARK)) return undefined;
  return rows.slice(top + 1, bottom).map((cells, index) => {
    // Past the mark on the first line, and whatever's dimmed.
    const typed = (index === 0 ? cells.slice(BOX_MARK.length) : cells).filter(cell => !cell.style.dim);
    return typed.map(cell => cell.char).join('').replace(/\u00a0/g, ' ').trim();
  }).join('\n').trim();
}

// Empties the input box of whatever's in it, so that what's typed next is all that's sent: a draft left
// at the Mac, or a message Claude Code put back there when its turn was stopped. `read` gives what's
// typed, or nothing when that can't be told, in which case the box is left alone.
// Returns whether it's empty at the end.
export async function emptyBox(session, read, { press = pressKey, settle = BOX_SETTLE_MS } = {}) {
  for (let round = 0; round < BOX_ROUNDS; round++) {
    if (!await read(session)) return true;
    for (const key of BOX_KEYS) for (let presses = 0; presses < BOX_PRESSES; presses++) await press(session, key);
    await pause(settle);
  }
  return !await read(session);
}

const BOX_NOT_EMPTY = 'The terminal\'s input box has something in it that couldn\'t be cleared.';

const boxOf = async session => typedIn(await readStyledScreen(session));

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
// and Enter would then answer it. The box is emptied first, so that the message is all that's sent
// and not added to what was there: a message that couldn't be sent after all, and is still in the
// box behind whatever opened, is taken out by the next one.
export async function sendMessage(session, { text = '', attachments = [] }, isBlocked, {
  imageLimit = IMAGE_SETTLE_LIMIT_MS, imageCheck = IMAGE_SETTLE_CHECK_MS, boxSettle = BOX_SETTLE_MS,
} = {}) {
  await refuseIfBlocked(session, isBlocked);
  if (!await emptyBox(session, boxOf, { settle: boxSettle })) throw new HelperError('box_not_empty', BOX_NOT_EMPTY);
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
// `isOpen` says whether a screen has something open, for a terminal that isn't Claude Code's.
export function pageOf(screen, isOpen = showsDialog) {
  const rows = screenCells(screen);
  const plain = rows.map(plainText);
  let end = plain.length;
  while (end > 0 && !plain[end - 1].trim()) end -= 1;
  if (!isOpen(plain.slice(0, end).join('\n'))) return null;
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
  return {
    // Windows has no tmux, so without Rex nothing can be started there, which is known before anything is tried.
    canStart: useRex || process.platform !== 'win32',
    startSession: backend.startSession, isSessionOpen: backend.isSessionOpen, hasOpenDialog, readScreen, readStyledScreen, pressKey,
    paste: (session, text) => backendOf(session).paste(session, text),
    foreground: session => backendOf(session).foreground(session),
    findSession: backend.findSession,
    processOf: session => backendOf(session).processOf(session),
    sendText,
  };
}
