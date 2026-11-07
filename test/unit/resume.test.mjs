import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/sessions.mjs';
import { resumeSession } from '../../src/resume.mjs';

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
