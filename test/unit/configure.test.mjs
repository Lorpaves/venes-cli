import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSession } from '../../src/configure.mjs';
import { HelperError, SessionStore } from '../../src/sessions.mjs';

const ID = '11111111-2222-4333-8444-555555555555';

function setUp({ running = [] } = {}) {
  const store = new SessionStore({ agentParent: () => undefined });
  const told = [];
  const chosenForResume = new Map();
  const deps = {
    store, chosenForResume,
    library: { running: async () => running },
    sessionWithPane: id => {
      const session = store.get(id);
      if (!session.pane) throw new HelperError('no_pane', 'Not in tmux.');
      return session;
    },
    tell: async (session, text) => { told.push(text); },
  };
  return { deps, store, told, chosenForResume };
}

const start = (store, tmux = { pane: '%1' }) => store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, cwd: '/w' }, tmux);
const switching = store => store.handleHook({ hook_event_name: 'PreModelSwitch', session_id: ID, to_model: 'claude-sonnet-5-5' });

test('a running session is told, model first, so that the effort is the new model\'s', async () => {
  const { deps, store, told } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, model: 'sonnet', effort: 'low' });
  assert.deepEqual(told, ['/model sonnet', '/effort low']);
});

test('only what was asked for is told', async () => {
  const { deps, store, told } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, effort: 'high' });
  await configureSession(deps, { sessionId: ID, model: 'opus' });
  assert.deepEqual(told, ['/effort high', '/model opus']);
});

test('a reader\'s switch doesn\'t stop to ask, and an effort change makes no promise about one', async () => {
  const { deps, store } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, effort: 'high' });
  assert.equal(switching(store), undefined);
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  assert.equal((await switching(store).decision).hookSpecificOutput.permissionDecision, 'allow');
});

test('a session that ended keeps the choice for later, and types nothing', async () => {
  const { deps, store, told, chosenForResume } = setUp();
  start(store);
  store.handleHook({ hook_event_name: 'SessionEnd', session_id: ID, reason: 'other' });
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  assert.deepEqual(chosenForResume.get(ID), { model: 'sonnet' });
  assert.deepEqual(told, []);
});

test('a session the helper hasn\'t seen keeps it too, and choices add up', async () => {
  const { deps, chosenForResume } = setUp();
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  await configureSession(deps, { sessionId: ID, effort: 'low' });
  await configureSession(deps, { sessionId: ID, model: 'opus' });
  assert.deepEqual(chosenForResume.get(ID), { model: 'opus', effort: 'low' });
});

test('a session running somewhere else can\'t be told, or kept for a resume that won\'t come', async () => {
  const { deps, chosenForResume } = setUp({ running: [{ id: ID, status: 'idle' }] });
  await assert.rejects(configureSession(deps, { sessionId: ID, model: 'sonnet' }), { code: 'no_pane' });
  assert.equal(chosenForResume.size, 0);
});

test('a running session with no pane can\'t be told', async () => {
  const { deps, store, told } = setUp();
  start(store, {});
  await assert.rejects(configureSession(deps, { sessionId: ID, effort: 'low' }), { code: 'no_pane' });
  assert.deepEqual(told, []);
});

test('nothing but a model name gets typed into the terminal', async () => {
  const { deps, store, told, chosenForResume } = setUp();
  start(store);
  for (const model of ['', 'two words', 'opus\n/exit', '-x', '/clear', 'a;b', 'a$(b)']) {
    await assert.rejects(configureSession(deps, { sessionId: ID, model }), { code: 'bad_model' }, JSON.stringify(model));
  }
  for (const effort of ['', 'extreme', 'low high', 'ultracode']) {
    await assert.rejects(configureSession(deps, { sessionId: ID, effort }), { code: 'bad_effort' }, JSON.stringify(effort));
  }
  assert.deepEqual(told, []);
  assert.equal(chosenForResume.size, 0);
});

test('the names providers give their models get through', async () => {
  const { deps, store, told } = setUp();
  start(store);
  const models = ['default', 'sonnet[1m]', 'claude-opus-5-5', 'claude-sonnet-4@20250514', 'us.anthropic.claude-haiku-5-5-v1:0', 'arn:aws:bedrock:us-east-1:1:inference-profile/x'];
  for (const model of models) await configureSession(deps, { sessionId: ID, model });
  assert.deepEqual(told, models.map(model => `/model ${model}`));
});
