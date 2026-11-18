// Picks a stored session back up when a message comes for it: `claude --resume` in a terminal
// session of its own, with the message as its first prompt. Claude Code's own command line carries the
// message, so nothing has to wait for the terminal to be ready for typing.

import os from 'node:os';
import fs from 'node:fs';
import { HelperError, notTypable } from './sessions.mjs';
import { isShell, pickChoice, readChoice } from './terminal.mjs';
import { referenceTo } from './uploads.mjs';

const START_LIMIT_MS = 20_000;
const CHECK_MS = 500;
// tmux refuses a command of about 16 KB, and the first message travels in one. Later ones are
// pasted, so they have no such limit.
const FIRST_MESSAGE_LIMIT_BYTES = 12_000;
const SESSION_PREFIX = 'venes-';
const SHORT_ID_LENGTH = 8;
// A terminal server keeps the environment it started with, which may be older or barer than this one.
const PASSED_ENV = ['PATH', 'LANG', 'LC_ALL', 'CLAUDE_CONFIG_DIR', 'VENES_HOME', 'VENES_CLAUDE_SETTINGS', 'VENES_TMUX_SOCKET', 'VENES_REX_SERVER', 'DISABLE_UPDATES'];

const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function workingDirectory(cwd) {
  return cwd && fs.existsSync(cwd) ? cwd : os.homedir();
}

function resumeCommand(sessionId, text, env, { model, effort, mode } = {}) {
  const chosen = [
    ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
    ...(mode && mode !== 'default' ? ['--permission-mode', mode] : []),
  ];
  // `--` keeps a message that starts with "-" from being read as a flag. A restart has nothing to say,
  // and the session waits at its prompt.
  return ['claude', ...JSON.parse(env.VENES_RESUME_ARGS ?? '[]'), ...chosen, '--resume', sessionId, ...(text ? ['--', text] : [])];
}

// What says a session is back: its first prompt, or for one resumed with nothing to say, its start.
function heardFrom(store, sessionId, kind = 'message.user') {
  let stopListening;
  const prompted = new Promise(resolve => {
    const listener = event => { if (event.sessionId === sessionId && event.kind === kind) resolve(); };
    store.on('event', listener);
    stopListening = () => store.off('event', listener);
  });
  return { prompted, stopListening };
}

const dialogOpen = () => new HelperError('dialog_open', 'A dialog is open in the terminal.');
// While a question's card waits for its answer, how often the terminal is looked at for an answer given there.
const ASKED_CHECK_MS = 2000;

// What's on the terminal when it asks something with a list to pick from, or nothing. A terminal that
// can't be read asks nothing that can be shown.
const choiceAt = async (terminal, target) => (terminal.readScreen ? readChoice(await terminal.readScreen(target).catch(() => '')) : undefined);

// Waits for the session to be back, which its first prompt says. Claude Code can ask something first,
// before there's a session for it to ask through, as it asks about Code Mode of whoever has turned
// that on and not said yes to it yet: that comes back as what's asked, for the reader to answer. It's
// taken for a question only when two looks in a row find the same one, since the old conversation
// is drawn on the way and can have the same words in it.
async function waitForPrompt({ state, terminal, name, target, limit, check, isOpen }) {
  let seen;
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    await delay(check);
    if (state.isPrompted) return undefined;
    const open = isOpen ? await isOpen() : await terminal.isSessionOpen(name, target);
    if (!open) throw new HelperError('resume_failed', 'Claude Code quit without resuming this session.');
    const choice = await choiceAt(terminal, target);
    if (choice && JSON.stringify(choice) === seen) return choice;
    seen = choice && JSON.stringify(choice);
  }
  // Only now: until then the screen shows the end of the old conversation, which could say anything.
  if (await terminal.hasOpenDialog(target)) throw dialogOpen();
  throw new HelperError('resume_failed', 'Claude Code took too long to resume this session.');
}

// The card for a question the terminal asks: its words and its options are the terminal's own, as a
// question Claude asks in a session is shown, so a client needs nothing new to show it.
function cardFor(choice) {
  const question = choice.text || choice.title;
  const fields = {
    kind: 'question', toolName: 'AskUserQuestion',
    input: { questions: [{ question, header: choice.title, options: choice.options.map(label => ({ label })), multiSelect: false }] },
  };
  const decide = ({ decision, answers }) => {
    // Left unanswered from here. It's still on the terminal, for someone there or for the next message.
    if (decision === 'deny') return { isLeft: true };
    if (decision !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${decision}`);
    const option = answers?.[question];
    if (!choice.options.includes(option)) throw new HelperError('missing_answers', 'Every question needs an answer.', { missing: [question] });
    return { option };
  };
  return { fields, decide };
}

// Asks the reader what the terminal asks, and gives their answer: an option, that they left it, or
// nothing when it was answered at the terminal meanwhile or the session went.
async function ask({ store, terminal, session, name, target, state, check, isOpen: opened }, choice) {
  const { fields, decide } = cardFor(choice);
  const { request, decision } = store.ask(session.id, fields, decide);
  let answer;
  let isAnswered = false;
  decision.then(value => { answer = value; isAnswered = true; });
  while (!isAnswered) {
    await delay(check);
    if (isAnswered) break;
    const isOpen = opened ? await opened().catch(() => false) : await terminal.isSessionOpen(name, target).catch(() => false);
    if (!state.isPrompted && isOpen && (await choiceAt(terminal, target))) continue;
    store.settle(request.id, { decision: 'unknown', by: 'terminal' });
    break;
  }
  return answer;
}

// Goes on from a question: asks it, presses what was answered, and sees what comes of that, which can
// be another question. It ends with the session back, with its terminal closed, which ends the
// session, or with a question left unanswered, which stays where it is.
async function follow(deps, first) {
  const { store, terminal, session, name, target, state, limit, check, isOpen } = deps;
  let choice = first;
  while (choice) {
    const answer = await ask({ ...deps, check: deps.askedCheck }, choice);
    // A request that closes leaves its session as one at work, which this one isn't: no turn has begun,
    // and the prompt that begins one would be taken for a message typed during a turn.
    if (!state.isPrompted && session.status === 'running') store.report(session.id, 'session.status', { status: 'idle' });
    if (state.isPrompted || session.status === 'ended' || answer?.isLeft) return;
    if (answer?.option) await pickChoice(terminal, target, answer.option).catch(() => {});
    choice = undefined;
    try {
      choice = await waitForPrompt({ state, terminal, name, target, limit, check, isOpen });
    } catch (error) {
      // A dialog that can't be shown is left for someone at the terminal. Anything else is the end of it.
      if (error.code !== 'dialog_open') store.abandon(session);
      return;
    }
  }
}

// What became of a resume that stopped at something the terminal asks, for the next message to the
// session: nothing while there was none, `open` while its terminal is still there, and `gone` once
// that has closed with the session never back, which ends the wait so that the message resumes it
// anew. Without this the session had no terminal and wasn't over, and a message to it was told that
// it couldn't be typed into, which sent the reader looking for a terminal to restart it in.
export async function dialogLeft({ store, terminal }, session) {
  const waiting = session?.waitingAt;
  if (!waiting || session.pane || session.status === 'ended') return undefined;
  if (await terminal.isSessionOpen(waiting.name, waiting.target).catch(() => false)) return 'open';
  store.abandon(session);
  return 'gone';
}

// A message for a session whose resume stands at a question: the question is asked again if nothing is
// asking it now, and the message is refused, since the one that resumed the session is still the first
// it will hear.
export function askAgain({ store, terminal, limit = START_LIMIT_MS, check = CHECK_MS, askedCheck = ASKED_CHECK_MS }, session) {
  const { name, target } = session.waitingAt;
  if (!session.asking) {
    session.asking = true;
    const { prompted, stopListening } = heardFrom(store, session.id);
    const state = { isPrompted: false };
    prompted.then(() => { state.isPrompted = true; });
    choiceAt(terminal, target)
      .then(choice => follow({ store, terminal, session, name, target, state, limit, check, askedCheck }, choice))
      .catch(error => console.error(`resume: ${error.message}`))
      .finally(() => { session.asking = false; stopListening(); });
  }
  throw new HelperError('dialog_open', 'Claude Code is asking something first. Answer it, then send this again.');
}

// A session running anywhere else can't be resumed here: the two would write into one transcript.
// The first message's attachments can't be pasted, so each is a reference, pictures too.
export async function resumeSession({
  store, library, terminal, env = process.env, limit = START_LIMIT_MS, check = CHECK_MS, askedCheck = ASKED_CHECK_MS,
}, sessionId, { clientId, text, attachments = [] }, chosen) {
  const prompt = [...attachments.map(referenceTo), text].filter(Boolean).join(' ');
  if (Buffer.byteLength(prompt) > FIRST_MESSAGE_LIMIT_BYTES) throw new HelperError('message_too_long', 'Send something shorter first, to start this session.');
  const running = await library.running();
  if (running.some(session => session.id === sessionId)) throw notTypable();
  const info = await library.info(sessionId);
  if (!info) throw new HelperError('unknown_session', `No stored session ${sessionId}`);
  const session = store.reopen(sessionId, { cwd: info.cwd, startedAt: info.createdAt });
  if (clientId) store.expectEcho(session, clientId, text);
  const name = `${SESSION_PREFIX}${sessionId.slice(0, SHORT_ID_LENGTH)}`;
  const { prompted, stopListening } = heardFrom(store, sessionId, prompt ? 'message.user' : 'session.started');
  const state = { isPrompted: false };
  prompted.then(() => { state.isPrompted = true; });
  let target;
  let isFollowed = false;
  try {
    const variables = Object.fromEntries(PASSED_ENV.filter(key => env[key]).map(key => [key, env[key]]));
    target = await terminal.startSession({ name, cwd: workingDirectory(info.cwd), command: resumeCommand(sessionId, prompt, env, chosen), env: variables });
    const choice = await waitForPrompt({ state, terminal, name, target, limit, check });
    if (choice) {
      // Claude Code asks something before the session is back. That's the reader's to answer: it's
      // asked on the session, whose first message waits on the command line for what they say.
      session.waitingAt = { name, target };
      session.asking = true;
      isFollowed = true;
      follow({ store, terminal, session, name, target, state, limit, check, askedCheck }, choice)
        .catch(error => console.error(`resume: ${error.message}`))
        .finally(() => { session.asking = false; stopListening(); });
    }
    return { queued: false, resumed: true };
  } catch (error) {
    if (clientId) store.forgetEcho(session, clientId);
    // The terminal stays open for a dialog: someone at the Mac can still answer it. Where it is, is
    // kept with the session, for what a later message is told.
    if (error.code === 'dialog_open') session.waitingAt = { name, target };
    else store.abandon(session);
    throw error;
  } finally {
    if (!isFollowed) stopListening();
  }
}

const EXIT_LIMIT_MS = 20_000;
// How long a shell has to stay in a terminal before it's typed into: one that has only just come back can be one
// on its way to another, as `sh -c '…; exec sh'` is, and what's typed then is lost.
const SHELL_SETTLE_MS = 1000;

// A command line for a shell to run: each word as it is, or quoted when the shell would read it apart.
const shellLine = words => words.map(word => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)).join(' ');

const until = async (isDone, limit, check) => {
  for (const end = Date.now() + limit; Date.now() < end; await delay(check)) if (await isDone()) return true;
  return isDone();
};

// Claude Code is started again in the terminal it was in, by that terminal's own shell, so whatever the
// reader's `claude` adds to it there is added again. Its start says it's back, or what it asks first is
// asked of the reader, as when a session is resumed.
async function resumeInShell(deps, session, target, chosen) {
  const { store, library, terminal, env = process.env, limit = START_LIMIT_MS, check = CHECK_MS, askedCheck = ASKED_CHECK_MS } = deps;
  const sessionId = session.id;
  const info = await library.info(sessionId).catch(() => undefined);
  const reopened = store.reopen(sessionId, { cwd: info?.cwd ?? session.cwd, startedAt: info?.createdAt });
  const { prompted, stopListening } = heardFrom(store, sessionId, 'session.started');
  const state = { isPrompted: false };
  prompted.then(() => { state.isPrompted = true; });
  const isOpen = () => terminal.foreground(target).then(() => true, () => false);
  let isFollowed = false;
  try {
    await terminal.paste(target, shellLine(resumeCommand(sessionId, '', env, chosen)));
    await terminal.pressKey(target, 'Enter');
    const choice = await waitForPrompt({ state, terminal, target, limit, check, isOpen });
    if (choice) {
      reopened.asking = true;
      isFollowed = true;
      follow({ store, terminal, session: reopened, target, state, limit, check, askedCheck, isOpen }, choice)
        .catch(error => console.error(`restart: ${error.message}`))
        .finally(() => { reopened.asking = false; stopListening(); });
    }
    return { restarted: true };
  } catch (error) {
    if (error.code !== 'dialog_open') store.abandon(reopened);
    throw error;
  } finally {
    if (!isFollowed) stopListening();
  }
}

// Restarts a session so that it runs the Claude Code installed now. One open in a terminal is asked to
// quit, as /exit asks, and is picked up again where it was: in the same terminal when that's left with a
// shell, or else in a terminal of its own, as a stopped session is resumed. `chosen` is what it ran with:
// its model, effort and permission mode.
export async function restartSession(deps, sessionId, chosen = {}) {
  const { store, terminal, check = CHECK_MS, exitLimit = EXIT_LIMIT_MS, settle = SHELL_SETTLE_MS } = deps;
  const session = store.find(sessionId);
  if (session?.pane && session.status !== 'ended') {
    const target = { pane: session.pane, tmuxSocket: session.tmuxSocket, rexSession: session.rexSession, rexServer: session.rexServer };
    await terminal.sendText(target, '/exit', () => store.pendingFor(session).length > 0);
    if (!(await until(() => store.find(sessionId)?.status === 'ended', exitLimit, check))) {
      throw new HelperError('restart_failed', "Claude Code didn't quit, so the session wasn't restarted.");
    }
    // Claude Code says it's over a moment before it has gone from its terminal: what's left there is
    // known once it shows a shell, or the terminal has gone with it.
    let left;
    await until(async () => {
      left = await terminal.foreground(target).catch(() => null);
      return left === null || isShell(left);
    }, exitLimit, check);
    if (isShell(left)) {
      await delay(settle);
      left = await terminal.foreground(target).catch(() => null);
    }
    if (isShell(left)) return resumeInShell(deps, session, target, chosen);
  }
  await resumeSession(deps, sessionId, { text: '' }, chosen);
  return { restarted: true };
}
