// A session whose terminal has closed is over, and Claude Code doesn't always get to say so. Rex gives
// what ran in a terminal it closes a second before it kills it, which is about what Claude Code takes to
// end there, and one killed outright says nothing at all. Such a session stayed open for good: it was
// listed as waiting or at work, and a message for it failed in a terminal that wasn't there. So each
// session's terminal is looked for now and then, and a session whose terminal has gone has ended.
//
// Unless Claude Code still lists it as running. A session can name a terminal it was never in: one
// started from an editor that was itself started in a terminal carries that terminal's name, and goes
// on after it closes.

const LOOK_MS = 10_000;
// A terminal not found is looked for once more before its session ends, since ending it closes what it
// asked and fails what waited for it.
const CONFIRM_MS = 1000;
export const TERMINAL_CLOSED = 'terminal_closed';

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Only Claude Code's own sessions: another agent's are its own to follow. One with no terminal known
// can't be looked for.
const isWatched = session => Boolean(session.pane) && !session.agent && session.status !== 'ended';

export class TerminalWatch {
  #store;
  #hasTerminal;
  #isRunning;
  #confirm;
  #isLooking = false;

  // `hasTerminal(session, asked)` says whether the session's terminal is there: true, false, or nothing
  // when it can't tell, which ends no session. `isRunning(session, asked)` says whether Claude Code still
  // lists the session as running. Both are given `asked`, a map to keep what was asked once for every
  // session of a look.
  constructor({ store, hasTerminal, isRunning, confirm = CONFIRM_MS }) {
    this.#store = store;
    this.#hasTerminal = hasTerminal;
    this.#isRunning = isRunning;
    this.#confirm = confirm;
  }

  // Ends the session if its terminal has gone, and says whether it did. One look is enough for a message
  // on its way to it, which would only fail there.
  async endIfGone(session, asked = new Map()) {
    if (!isWatched(session)) return false;
    const { pane } = session;
    const isThere = await this.#hasTerminal(session, asked).catch(() => undefined);
    // If what's running can't be asked, it's taken to be: nothing ends on a guess.
    if (isThere !== false || await this.#isRunning(session, asked).catch(() => true)) return false;
    // It can have ended, or moved to another terminal, while this looked.
    if (!isWatched(session) || session.pane !== pane) return false;
    this.#store.report(session.id, 'session.ended', { reason: TERMINAL_CLOSED });
    return true;
  }

  // Looks for every session's terminal once, and ends the sessions whose terminal is twice not there.
  async look() {
    if (this.#isLooking) return;
    this.#isLooking = true;
    try {
      const asked = new Map();
      const missing = [];
      await Promise.all(this.#store.liveSessions().filter(isWatched).map(async session => {
        const { pane } = session;
        if (await this.#hasTerminal(session, asked).catch(() => undefined) === false) missing.push({ session, pane });
      }));
      if (!missing.length) return;
      await pause(this.#confirm);
      const again = new Map();
      await Promise.all(missing.map(({ session, pane }) => (session.pane === pane ? this.endIfGone(session, again) : false)));
    } finally {
      this.#isLooking = false;
    }
  }

  // Looks every `interval`, until what it returns is called.
  start(interval = LOOK_MS) {
    const timer = setInterval(() => { this.look().catch(error => console.error(`terminals: ${error.message}`)); }, interval);
    timer.unref();
    return () => clearInterval(timer);
  }
}
