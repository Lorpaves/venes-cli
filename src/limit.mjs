import { pause, pickChoice, readChoice } from './terminal.mjs';
import { cardFor } from './resume.mjs';

// When a turn stops at a usage limit, Claude Code's terminal asks what to do now: wait for the limit to
// reset, use extra usage, go on with another model, upgrade. Which of those it offers depends on the account
// and the limit, so the reader is asked what the terminal asks, on a card, in its own words and options, with
// the limit's own line first, and what they pick is pressed there as someone at the terminal would. Asked
// for after the limit's line came to the app as a reply and nothing else (2026-11-24): 「这种情况要加弹窗」,
// then 「直接把终端里的弹窗改为弹卡显示出来就行」.

// How often, and how many times, the terminal is looked at for the question once the limit is told.
const LOOK_MS = 500;
const LOOKS = 20;
// A limit told longer ago than this is over: whatever the terminal asks now is about something else. A
// helper that starts reads what the transcripts said before it, limits among them.
const FRESH_MS = 2 * 60 * 1000;
// While the card waits, how often the terminal is looked at for an answer given there.
const CHECK_MS = 2000;

// `screen` reads the session's terminal and presses a key in it. `lead` is the limit's line, and `at` when it
// was written. Nothing is asked for a limit that's over, nor while the session already asks the reader
// something, which the terminal is showing then and is on its own card.
export async function askAtLimit({
  store, screen, session, lead, at = undefined, now = Date.now, fresh = FRESH_MS, look = LOOK_MS, looks = LOOKS, check = CHECK_MS,
}) {
  if (at !== undefined && now() - at > fresh) return;
  const choice = await asked(screen, look, looks);
  if (!choice || session.status === 'ended' || store.pendingFor(session).length) return;
  const wasAtRest = session.status !== 'running';
  const { fields, decide } = cardFor(choice, lead);
  const { request, decision } = store.ask(session.id, fields, decide);
  let answer;
  let isAnswered = false;
  decision.then(value => { answer = value; isAnswered = true; });
  while (!isAnswered) {
    await pause(check);
    if (isAnswered) break;
    if (session.status === 'ended' || !(await isStillAsked(screen, choice))) {
      store.settle(request.id, { decision: 'unknown', by: 'terminal' });
      break;
    }
  }
  // A request that closes leaves its session at work, which it isn't for the card: anything the answer
  // starts says so itself.
  if (wasAtRest && session.status === 'running') store.report(session.id, 'session.status', { status: 'idle' });
  if (answer?.option) {
    const terminal = { readScreen: () => screen.read(), pressKey: (_target, key) => screen.press(key) };
    await pickChoice(terminal, undefined, answer.option).catch(error => console.error(`limit: ${error.message}`));
  }
}

// The question, once two looks in a row find the same one: the terminal draws it in pieces.
async function asked(screen, look, looks) {
  let seen;
  for (let i = 0; i < looks; i++) {
    await pause(look);
    const choice = readChoice(await screen.read().catch(() => ''));
    if (choice && JSON.stringify(choice.options) === seen) return choice;
    seen = choice && JSON.stringify(choice.options);
  }
  return undefined;
}

async function isStillAsked(screen, choice) {
  const now = readChoice(await screen.read().catch(() => ''));
  return Boolean(now) && now.title === choice.title && JSON.stringify(now.options) === JSON.stringify(choice.options);
}
