import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/sessions.mjs';
import { askAgain, dialogLeft, restartSession, resumeSession } from '../../src/resume.mjs';
import { pickChoice, readChoice } from '../../src/terminal.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const FAST = { limit: 200, check: 5 };

function setUp({ running = [], info = { cwd: '/tmp', createdAt: 1000 }, onStart = () => {}, open = () => true, dialog = () => false, env = {} } = {}) {
  const store = new SessionStore({ agentParent: () => undefined });
  const events = [];
  store.on('event', event => events.push(event));
  const started = [];
  const terminal = {
    startSession: async request => { started.push(request); onStart(store); return { pane: '%7' }; },
    isSessionOpen: async () => open(),
    hasOpenDialog: async () => dialog(),
  };
  const library = { running: async () => running, info: async () => info };
  return { deps: { store, library, terminal, env: { PATH: '/bin', ...env }, ...FAST }, store, events, started };
}

const prompt = (store, text) => store.handleHook({ hook_event_name: 'UserPromptSubmit', session_id: ID, prompt: text, cwd: '/tmp' }, { pane: '%7' });

test('a message resumes the session in tmux, with itself as the first prompt', async () => {
  const { deps, started } = setUp({ onStart: store => prompt(store, 'carry on') });
  assert.deepEqual(await resumeSession(deps, ID, { text: 'carry on' }), { queued: false, resumed: true });
  assert.deepEqual(started[0].command, ['claude', '--resume', ID, '--', 'carry on']);
  assert.equal(started[0].name, 'venes-11111111');
  assert.equal(started[0].cwd, '/tmp');
  assert.deepEqual(started[0].env, { PATH: '/bin' });
});

test('the message carries its client id through the first prompt', async () => {
  const { deps, events } = setUp({ onStart: store => prompt(store, 'carry on') });
  await resumeSession(deps, ID, { clientId: 'c1', text: 'carry on' });
  assert.equal(events.find(event => event.kind === 'message.user').clientId, 'c1');
});

test('a folder that has gone falls back to home', async () => {
  const { deps, started } = setUp({ info: { cwd: '/no/such/folder' }, onStart: store => prompt(store, 'x') });
  await resumeSession(deps, ID, { text: 'x' });
  assert.notEqual(started[0].cwd, '/no/such/folder');
});

test('a session running somewhere else is left alone', async () => {
  const { deps, started, store } = setUp({ running: [{ id: ID, status: 'idle' }] });
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'no_pane' });
  assert.equal(started.length, 0);
  assert.equal(store.find(ID), undefined);
});

test('a session that isn\'t stored can\'t be resumed', async () => {
  const { deps, started } = setUp({ info: undefined });
  deps.library.info = async () => undefined;
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'unknown_session' });
  assert.equal(started.length, 0);
});

test('when Claude quits the session ends and the message is forgotten', async () => {
  const { deps, store, events } = setUp({ open: () => false });
  await assert.rejects(resumeSession(deps, ID, { clientId: 'c1', text: 'x' }), { code: 'resume_failed' });
  assert.equal(store.find(ID).status, 'ended');
  assert.equal(store.find(ID).echoes.length, 0);
  assert.equal(events.at(-1).kind, 'session.ended');
});

test('a first message tmux would refuse is stopped before anything starts', async () => {
  const { deps, started, store } = setUp();
  await assert.rejects(resumeSession(deps, ID, { text: 'x'.repeat(12_001) }), { code: 'message_too_long' });
  assert.equal(started.length, 0);
  assert.equal(store.find(ID), undefined);
});

test('the limit is in bytes, which is what tmux counts', async () => {
  const { deps } = setUp();
  await assert.rejects(resumeSession(deps, ID, { text: '中'.repeat(4001) }), { code: 'message_too_long' });
});

test('words on screen from the old conversation don\'t count as a dialog while it\'s starting', async () => {
  let asked = 0;
  const { deps, store } = setUp({ dialog: () => { asked += 1; return true; }, onStart: s => { setTimeout(() => prompt(s, 'x'), 20); } });
  assert.deepEqual(await resumeSession(deps, ID, { text: 'x' }), { queued: false, resumed: true });
  assert.equal(asked, 0);
  assert.notEqual(store.find(ID).status, 'ended');
});

test('a dialog is reported, and its terminal stays open for someone to answer it', async () => {
  const { deps, store } = setUp({ dialog: () => true });
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'dialog_open' });
  assert.notEqual(store.find(ID).status, 'ended');
});

test('it gives up when nothing happens', async () => {
  const { deps, store } = setUp();
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'resume_failed' });
  assert.equal(store.find(ID).status, 'ended');
});

test('a failure to start tmux ends the session too', async () => {
  const { deps, store } = setUp();
  deps.terminal.startSession = async () => { throw Object.assign(new Error('no tmux'), { code: 'no_tmux' }); };
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'no_tmux' });
  assert.equal(store.find(ID).status, 'ended');
});

test('the listener goes when it\'s done', async () => {
  const { deps, store } = setUp({ onStart: s => prompt(s, 'x') });
  const before = store.listenerCount('event');
  await resumeSession(deps, ID, { text: 'x' });
  assert.equal(store.listenerCount('event'), before);
});

test('test settings reach the command and the environment', async () => {
  const env = { VENES_RESUME_ARGS: '["--model","haiku"]', VENES_HOME: '/h', VENES_TMUX_SOCKET: '/s' };
  const { deps, started } = setUp({ onStart: store => prompt(store, 'x'), env });
  await resumeSession(deps, ID, { text: 'x' });
  assert.deepEqual(started[0].command, ['claude', '--model', 'haiku', '--resume', ID, '--', 'x']);
  assert.equal(started[0].env.VENES_HOME, '/h');
  assert.equal(started[0].env.VENES_TMUX_SOCKET, '/s');
});

test('what the reader chose goes on the command line, ahead of the message', async () => {
  const { deps, started } = setUp({ onStart: store => prompt(store, 'x') });
  await resumeSession(deps, ID, { text: 'x' }, { model: 'sonnet', effort: 'low' });
  assert.deepEqual(started[0].command, ['claude', '--model', 'sonnet', '--effort', 'low', '--resume', ID, '--', 'x']);
});

test('a choice of one leaves the other to the session', async () => {
  const { deps, started } = setUp({ onStart: store => prompt(store, 'x') });
  await resumeSession(deps, ID, { text: 'x' }, { effort: 'max' });
  assert.deepEqual(started[0].command, ['claude', '--effort', 'max', '--resume', ID, '--', 'x']);
});

test('a resumed session that had ended comes back with no old pane', () => {
  const store = new SessionStore({ agentParent: () => undefined });
  store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source: 'startup', cwd: '/w' }, { pane: '%1' });
  store.handleHook({ hook_event_name: 'SessionEnd', session_id: ID, reason: 'other' });
  assert.equal(store.find(ID).status, 'ended');
  const session = store.reopen(ID, { cwd: '/w' });
  assert.equal(session.status, 'idle');
  assert.equal(session.pane, undefined);
  store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source: 'resume', cwd: '/w' }, { pane: '%2' });
  assert.equal(store.find(ID).pane, '%2');
});

test('find gives nothing for an unknown session, but still refuses an ambiguous prefix', () => {
  const store = new SessionStore({ agentParent: () => undefined });
  assert.equal(store.find('nope'), undefined);
  store.reopen('aa-1', {});
  store.reopen('aa-2', {});
  assert.throws(() => store.find('aa'), { code: 'ambiguous_session' });
});

// Claude Code's question about Code Mode as 2.1.325 draws it, with `pointed` of its two options marked.
const TEXT = 'In Code Mode, Claude works by writing and running JavaScript that calls its tools, instead of calling them one at a time.';
const OPTIONS = ['No, start without it', 'Yes, turn on Code Mode'];
const codeMode = (pointed = 0) => [
  '────────────────────────────────────────────────────────────────────────────────', '  Code Mode (experimental)', '',
  '  In Code Mode, Claude works by writing and running JavaScript that calls its', '  tools, instead of calling them one at a time.', '',
  ...OPTIONS.map((option, index) => `  ${index === pointed ? '❯' : ' '} ${option}`), '', '  Tell us how it goes with /feedback', '',
  '  Enter to confirm · Esc to start without it', '', '',
].join('\n');
const DRAWN = '⏺ READY\n────────\n❯ \n────────\n  ⏵⏵ bypass permissions on (shift+tab to cycle)\n';

test('a question the terminal asks is read off it: its name, what it says, what it offers and which is pointed at', () => {
  assert.deepEqual(readChoice(codeMode()), { title: 'Code Mode (experimental)', text: TEXT, options: OPTIONS, pointed: 0 });
  assert.equal(readChoice(codeMode(1)).pointed, 1);
  assert.deepEqual(readChoice('────────────\n Pick one\n ❯ 1. First\n   2. Second\n   3. Third\n Enter to select · Esc to cancel').options, ['First', 'Second', 'Third']);
});

test('and nothing else is taken for one', () => {
  // A conversation that has the question in it ends with the box to type in, not with the question.
  assert.equal(readChoice(`${codeMode()}${DRAWN}`), undefined);
  assert.equal(readChoice(DRAWN), undefined);
  assert.equal(readChoice('────────────\n One thing\n ❯ Only this\n Enter to confirm'), undefined, 'nothing to choose between');
  assert.equal(readChoice('────────────\n One thing\n   This\n   That\n Enter to confirm'), undefined, 'none pointed at');
  assert.equal(readChoice('────────────\n One thing\n ❯ Same\n   Same\n Enter to confirm'), undefined, 'two that couldn\'t be told apart');
  assert.equal(readChoice(' Accessing workspace:\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter confirm · Esc cancel'), undefined, 'the folder\'s question, which has its own way');
  assert.equal(readChoice(''), undefined);
  assert.equal(readChoice(undefined), undefined);
});

// A terminal that stands at the question until Enter is pressed on one of its options, and then has
// the session back with its first prompt.
function atQuestion(t, deps, store, { answers = true } = {}) {
  const terminal = { keys: [], pointed: 0, isAsking: true, isThere: true, picked: undefined };
  // Closed when the test is over, which ends whatever is still waiting on it.
  t.after(() => { terminal.isThere = false; });
  deps.terminal.isSessionOpen = async () => terminal.isThere;
  deps.terminal.readScreen = async () => (terminal.isAsking ? codeMode(terminal.pointed) : DRAWN);
  deps.terminal.pressKey = async (_, key) => {
    terminal.keys.push(key);
    if (key === 'Down') terminal.pointed = Math.min(terminal.pointed + 1, OPTIONS.length - 1);
    if (key === 'Up') terminal.pointed = Math.max(terminal.pointed - 1, 0);
    if (key !== 'Enter') return;
    terminal.picked = OPTIONS[terminal.pointed];
    terminal.isAsking = false;
    if (answers) setTimeout(() => prompt(store, 'x'), 10);
  };
  return terminal;
}

const until = async (isSo, what) => {
  for (let tries = 0; tries < 400; tries++) {
    if (isSo()) return;
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  assert.fail(`never: ${what}`);
};
const opened = events => events.filter(event => event.kind === 'request.opened').map(event => event.request);
const closed = events => events.filter(event => event.kind === 'request.closed');
const QUICK = { askedCheck: 5 };

test('the option a reader picked is pressed as someone at the terminal would: to it, then Enter', async t => {
  const { deps, store } = setUp();
  const terminal = atQuestion(t, deps, store, { answers: false });
  await pickChoice(deps.terminal, { pane: '%7' }, 'Yes, turn on Code Mode', { settle: 1 });
  assert.deepEqual([terminal.keys, terminal.picked], [['Down', 'Enter'], 'Yes, turn on Code Mode']);
  terminal.isAsking = true;
  terminal.keys.length = 0;
  await pickChoice(deps.terminal, { pane: '%7' }, 'No, start without it', { settle: 1 });
  assert.deepEqual([terminal.keys, terminal.picked], [['Up', 'Enter'], 'No, start without it']);
  // Gone, or not the question that was answered: no key.
  terminal.keys.length = 0;
  await assert.rejects(pickChoice(deps.terminal, { pane: '%7' }, 'No, start without it', { settle: 1 }), { code: 'choice_gone' });
  terminal.isAsking = true;
  await assert.rejects(pickChoice(deps.terminal, { pane: '%7' }, 'Something else', { settle: 1 }), { code: 'choice_gone' });
  assert.deepEqual(terminal.keys, []);
});

test('what Claude Code asks before the session is back is asked of the reader, on the session, and nothing is pressed for them', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  assert.deepEqual(await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x', clientId: 'c1' }), { queued: false, resumed: true });
  const [request] = opened(events);
  assert.deepEqual([request.kind, request.toolName, request.sessionId], ['question', 'AskUserQuestion', ID]);
  assert.deepEqual(request.input, { questions: [{ question: TEXT, header: 'Code Mode (experimental)', options: OPTIONS.map(label => ({ label })), multiSelect: false }] });
  assert.equal(store.find(ID).status, 'waiting');
  await new Promise(resolve => { setTimeout(resolve, 60); });
  assert.deepEqual(terminal.keys, [], 'it waits for the reader');
  assert.equal(opened(events).length, 1, 'and asks once');
});

test('their answer is pressed in the terminal, and the session comes back with the message that resumed it', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x', clientId: 'c1' });
  store.respond(opened(events)[0].id, { decision: 'allow', answers: { [TEXT]: 'Yes, turn on Code Mode' } });
  await until(() => events.some(event => event.kind === 'message.user'), 'the first prompt');
  assert.deepEqual([terminal.keys, terminal.picked], [['Down', 'Enter'], 'Yes, turn on Code Mode']);
  const session = store.find(ID);
  assert.deepEqual([session.pane, session.waitingAt], ['%7', undefined]);
  assert.notEqual(session.status, 'ended');
  assert.equal(events.find(event => event.kind === 'message.user').clientId, 'c1', 'the message is the reader\'s own');
});

test('an answer that isn\'t one of its options is refused, and the question stays', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x' });
  const { id } = opened(events)[0];
  assert.throws(() => store.respond(id, { decision: 'allow', answers: { [TEXT]: 'Whatever' } }), { code: 'missing_answers' });
  assert.throws(() => store.respond(id, { decision: 'allow' }), { code: 'missing_answers' });
  assert.deepEqual([terminal.keys, closed(events).length], [[], 0]);
});

test('left unanswered, the question stays on the terminal, and the next message has it asked again', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x' });
  store.respond(opened(events)[0].id, { decision: 'deny' });
  await until(() => !store.find(ID).asking, 'the asking to end');
  const session = store.find(ID);
  assert.deepEqual([terminal.keys, session.status === 'ended', Boolean(session.waitingAt)], [[], false, true]);
  assert.equal(await dialogLeft(deps, session), 'open');
  assert.throws(() => askAgain({ ...deps, ...QUICK }, session), { code: 'dialog_open', message: /asking something first/ });
  await until(() => opened(events).length === 2, 'the question asked again');
  // And while it's being asked, another message doesn't ask it a third time.
  assert.throws(() => askAgain({ ...deps, ...QUICK }, session), { code: 'dialog_open' });
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(opened(events).length, 2);
});

test('answered at the terminal instead, the card goes and the session is back', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x' });
  terminal.isAsking = false;
  prompt(store, 'x');
  await until(() => closed(events).length === 1, 'the card to close');
  assert.deepEqual([closed(events)[0].by, terminal.keys], ['terminal', []]);
  assert.equal(store.find(ID).pane, '%7');
});

test('when the terminal closes with the question unanswered, the session is over and so is the card', async t => {
  const { deps, store, events } = setUp();
  const terminal = atQuestion(t, deps, store);
  await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x' });
  terminal.isThere = false;
  await until(() => store.find(ID).status === 'ended', 'the session to end');
  assert.equal(closed(events).length, 1);
  assert.equal(await dialogLeft(deps, store.find(ID)), undefined);
});

test('a question that\'s only on the screen in passing, as the old conversation is drawn, isn\'t asked', async () => {
  const { deps, store, events } = setUp();
  let looks = 0;
  deps.terminal.readScreen = async () => { looks += 1; return looks === 1 ? codeMode() : DRAWN; };
  setTimeout(() => prompt(store, 'x'), 40);
  assert.deepEqual(await resumeSession({ ...deps, ...QUICK }, ID, { text: 'x' }), { queued: false, resumed: true });
  assert.equal(opened(events).length, 0);
  assert.equal(store.find(ID).waitingAt, undefined);
});

test('a resume that stopped at a dialog that can\'t be shown says so again to the next message, until its terminal has gone', async () => {
  let isOpen = true;
  const { deps, store } = setUp({ dialog: () => true, open: () => isOpen });
  await assert.rejects(resumeSession(deps, ID, { text: 'x' }), { code: 'dialog_open' });
  const session = store.find(ID);
  assert.deepEqual(session.waitingAt, { name: 'venes-11111111', target: { pane: '%7' } });
  assert.equal(await dialogLeft(deps, session), 'open');
  assert.notEqual(session.status, 'ended');
  // The terminal closed with nobody having answered: the session is over, and a message resumes it anew.
  isOpen = false;
  assert.equal(await dialogLeft(deps, session), 'gone');
  assert.equal(session.status, 'ended');
  assert.equal(await dialogLeft(deps, session), undefined);
});

test('a session that never had a resume stop at a dialog is asked nothing', async () => {
  const { deps, store } = setUp();
  store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source: 'startup', cwd: '/tmp' }, {});
  assert.equal(await dialogLeft(deps, store.find(ID)), undefined);
  assert.equal(await dialogLeft(deps, undefined), undefined);
});

// A session open in a terminal, as Claude Code's own hooks say.
const startIn = (store, pane, source = 'startup') => store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source, cwd: '/tmp' }, { pane });
const quitIn = (store, pane) => store.handleHook({ hook_event_name: 'SessionEnd', session_id: ID, reason: 'prompt_input_exit', cwd: '/tmp' }, { pane });

test('a restart quits Claude Code and resumes the session in the shell left in its terminal, as it ran', async () => {
  const { deps, store, started } = setUp();
  startIn(store, '%3');
  const typed = [];
  let hasQuit = false;
  Object.assign(deps.terminal, {
    sendText: async (target, text) => { typed.push(['send', target.pane, text]); hasQuit = true; quitIn(store, '%3'); },
    foreground: async () => (hasQuit ? '-zsh' : 'claude'),
    paste: async (target, text) => typed.push(['paste', target.pane, text]),
    pressKey: async (target, key) => { typed.push(['key', target.pane, key]); if (key === 'Enter') startIn(store, '%3', 'resume'); },
    readScreen: async () => '',
  });
  assert.deepEqual(await restartSession(deps, ID, { model: 'claude-opus-5-5', effort: 'max', mode: 'plan' }), { restarted: true });
  assert.deepEqual(typed, [
    ['send', '%3', '/exit'],
    ['paste', '%3', `claude --model claude-opus-5-5 --effort max --permission-mode plan --resume ${ID}`],
    ['key', '%3', 'Enter'],
  ]);
  assert.equal(started.length, 0, 'no terminal of its own');
  assert.deepEqual([store.find(ID).status, store.find(ID).pane], ['idle', '%3']);
});

test('when its terminal went with it, the session is resumed in one of its own, with nothing to say', async () => {
  const { deps, store, started } = setUp({ onStart: s => startIn(s, '%7', 'resume') });
  startIn(store, '%3');
  Object.assign(deps.terminal, { sendText: async () => quitIn(store, '%3'), foreground: async () => { throw new Error('no such pane'); } });
  assert.deepEqual(await restartSession(deps, ID, { mode: 'default' }), { restarted: true });
  assert.deepEqual(started[0].command, ['claude', '--resume', ID]);
  assert.equal(store.find(ID).pane, '%7');
});

test('a Claude Code that won\'t quit isn\'t restarted', async () => {
  const { deps, store, started } = setUp();
  startIn(store, '%3');
  Object.assign(deps.terminal, { sendText: async () => {}, foreground: async () => 'claude' });
  await assert.rejects(restartSession({ ...deps, exitLimit: 30 }, ID), { code: 'restart_failed' });
  assert.equal(started.length, 0);
});

test('a session that isn\'t running is restarted by resuming it', async () => {
  const { deps, started } = setUp({ onStart: s => startIn(s, '%7', 'resume') });
  assert.deepEqual(await restartSession(deps, ID), { restarted: true });
  assert.deepEqual(started[0].command, ['claude', '--resume', ID]);
});
