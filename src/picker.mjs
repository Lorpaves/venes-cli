// Changes a running session's model and effort through the model picker, the one place a person
// can change them for a single session: typed as /model and /effort they also become the defaults
// for new sessions. The picker's keys are documented but what it draws isn't, so every key is
// checked on the screen before the next, and anything unexpected closes it with nothing changed.

import { HelperError } from './sessions.mjs';
import { bottomOf, closePage, pause, pressKey, readScreen, refuseIfBlocked, refuseIfRequested, settleCommand } from './terminal.mjs';

// Option+P, which unlike typing /model leaves anything in the prompt alone.
const OPEN_KEY = 'M-p';
const THIS_SESSION_KEY = 's';
const THIS_SESSION_HINT = /\bs to use this session only\b/;
const HIGHLIGHTED_ROW = /^\s*❯\s*(\d+)\.\s+(.*?)\s*$/;
const EFFORT_LINE = /\b(low|medium|high|xhigh|max) effort\b.*to adjust/i;
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const CURRENT_MARK = ' ✔';
// Enough to go through every row, of which there were 13 when measured.
const MOST_ROWS = 40;
const KEY_LIMIT_MS = 1500;
const KEY_CHECK_MS = 30;
// The picker asked nothing when measured. Claude Code could yet, or a hook of the user's could.
const QUESTION_LIMIT_MS = 400;

const failed = () => new HelperError('picker_failed', 'The terminal\'s model picker wasn\'t as expected, so nothing changed.');

// What the picker shows, or nothing if it isn't open. Its rows can reach above the part of the
// screen that dialogs are looked for in, and the lowest marker is the picker's, because the prompt
// goes while it's open and only a message further up could look the same.
export function readPicker(screen) {
  if (!THIS_SESSION_HINT.test(bottomOf(screen).split(/\s+/).join(' '))) return undefined;
  const lines = screen.split('\n');
  const row = lines.findLast(line => HIGHLIGHTED_ROW.test(line))?.match(HIGHLIGHTED_ROW);
  if (!row) return undefined;
  const effort = lines.findLast(line => EFFORT_LINE.test(line))?.match(EFFORT_LINE)[1].toLowerCase();
  return { number: Number(row[1]), text: row[2], effort };
}

const isOnRow = ({ text }, label) => text === label || text.startsWith(`${label} `);
const isOnCurrentRow = ({ text }) => text.split(/\s{2,}/)[0].endsWith(CURRENT_MARK);

async function waitFor(session, isDone, { limit, check }) {
  const end = Date.now() + limit;
  for (;;) {
    const picker = readPicker(await readScreen(session));
    if (isDone(picker)) return picker;
    if (Date.now() >= end) throw failed();
    await pause(check);
  }
}

async function press(session, key, isBlocked, hasMoved, timing) {
  refuseIfRequested(isBlocked);
  await pressKey(session, key);
  return waitFor(session, picker => picker && hasMoved(picker), timing);
}

async function moveToRow(session, start, { label, number }, isBlocked, timing) {
  let picker = start;
  for (let step = 0; step < MOST_ROWS; step++) {
    if (isOnRow(picker, label)) return picker;
    const { number: from } = picker;
    if (from === number) break;
    picker = await press(session, from < number ? 'Down' : 'Up', isBlocked, next => next.number !== from, timing);
  }
  throw failed();
}

async function moveToEffort(session, start, effort, isBlocked, timing) {
  let picker = start;
  for (let step = 0; step < EFFORT_ORDER.length; step++) {
    if (picker.effort === effort) return picker;
    if (!picker.effort) throw failed();
    const { effort: from } = picker;
    const key = EFFORT_ORDER.indexOf(from) < EFFORT_ORDER.indexOf(effort) ? 'Right' : 'Left';
    picker = await press(session, key, isBlocked, next => next.effort !== from, timing);
  }
  throw failed();
}

async function choose(session, { row, effort }, isBlocked, timing) {
  let picker = await waitFor(session, Boolean, timing);
  if (row) picker = await moveToRow(session, picker, row, isBlocked, timing);
  // Pressing the key on any other row would switch the model as well.
  else if (!isOnCurrentRow(picker)) throw failed();
  if (effort) await moveToEffort(session, picker, effort, isBlocked, timing);
  refuseIfRequested(isBlocked);
  await pressKey(session, THIS_SESSION_KEY);
  await waitFor(session, open => !open, timing);
}

// A request takes the picker's place on the screen and doesn't bring it back, and Esc would refuse
// the request instead, so it's left alone.
export async function switchInPicker(session, change, isBlocked, {
  limit = KEY_LIMIT_MS, check = KEY_CHECK_MS, questionLimit = QUESTION_LIMIT_MS, pageSettle,
} = {}) {
  await refuseIfBlocked(session, isBlocked);
  await pressKey(session, OPEN_KEY);
  try {
    await choose(session, change, isBlocked, { limit, check });
  } catch (error) {
    if (!isBlocked()) await closePage(session, pageSettle);
    throw error;
  }
  await settleCommand(session, isBlocked, { limit: questionLimit });
}
