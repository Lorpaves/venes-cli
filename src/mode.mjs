// Changes the permission mode of a session that's running in a terminal, the way a person does:
// Shift+Tab, which goes round the modes the session has. Which those are isn't told to anyone, so
// the status bar is read after each press, as Claude Code's docs give it ("Switch permission modes"),
// and a mode the session doesn't come round to isn't one it has.

import { HelperError } from './sessions.mjs';
import { bottomOf, pause, pressKey, readScreen, refuseIfBlocked, refuseIfRequested } from './terminal.mjs';

const CYCLE_KEY = 'BTab';
// What the status bar says of each mode. Manual is `default` to hooks and settings.
const BARS = [
  ['default', /⏸\s*manual mode on/],
  ['acceptEdits', /⏵⏵\s*accept edits on/],
  ['plan', /⏸\s*plan mode on/],
  ['auto', /⏵⏵\s*auto mode on/],
  ['dontAsk', /⏵⏵\s*don['’]t ask on/],
  ['bypassPermissions', /⏵⏵\s*bypass permissions on/],
];
// The modes a session can come round to. `dontAsk` is only ever started in.
export const SWITCHABLE = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
// More presses than there are modes to go round.
const MOST_PRESSES = 8;
const KEY_LIMIT_MS = 1500;
const KEY_CHECK_MS = 30;

const failed = () => new HelperError('mode_failed', 'The terminal didn\'t show the session\'s mode as expected, so it was left as it is.');

// The mode the status bar says the session is in, or nothing when it isn't on the screen, as while
// a dialog or a page is open. The bar is under everything else, so the lowest line that names a mode is it.
export function readMode(screen) {
  for (const line of bottomOf(screen).split('\n').reverse()) {
    const found = BARS.find(([, bar]) => bar.test(line));
    if (found) return found[0];
  }
  return undefined;
}

async function changedFrom(session, before, { limit, check }) {
  for (const end = Date.now() + limit; ; await pause(check)) {
    const mode = readMode(await readScreen(session));
    if (mode && mode !== before) return mode;
    if (Date.now() >= end) throw failed();
  }
}

// Goes round to `mode`, and says which modes it passed on the way: those are modes the session has.
// One it comes all the way round without is one it hasn't, and by then it's back where it started.
export async function switchMode(session, mode, isBlocked, { limit = KEY_LIMIT_MS, check = KEY_CHECK_MS } = {}) {
  if (!SWITCHABLE.includes(mode)) throw new HelperError('bad_mode', `Not a mode a session can be switched to: ${mode}`);
  await refuseIfBlocked(session, isBlocked);
  const start = readMode(await readScreen(session));
  if (!start) throw failed();
  const passed = [];
  let current = start;
  for (let press = 0; current !== mode; press++) {
    if (press >= MOST_PRESSES) throw failed();
    refuseIfRequested(isBlocked);
    await pressKey(session, CYCLE_KEY);
    current = await changedFrom(session, current, { limit, check });
    passed.push(current);
    if (current === start) throw new HelperError('mode_unavailable', 'This session can\'t be switched to that mode.');
  }
  return { mode, passed };
}
