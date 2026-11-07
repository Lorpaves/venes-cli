import test from 'node:test';
import assert from 'node:assert/strict';
import { configureSession, oneAtATime, readSwitch } from '../../src/configure.mjs';
import { HelperError, SessionStore } from '../../src/sessions.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const MODELS = [
  { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-sonnet-5-5' },
  { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
  { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' },
  { value: 'claude-sonnet-5', displayName: 'Sonnet 5', resolvedModel: 'claude-sonnet-5' },
];

function setUp({ running = [], models = MODELS } = {}) {
  const store = new SessionStore({ agentParent: () => undefined });
  const switched = [];
  const asked = [];
  const chosenForResume = new Map();
  const deps = {
    store, chosenForResume,
    library: {
      running: async () => running,
      capabilities: async folder => { asked.push(folder); return { models }; },
    },
    sessionWithPane: id => {
      const session = store.get(id);
      if (!session.pane) throw new HelperError('no_pane', 'Not in tmux.');
      return session;
    },
    switchTo: async (session, change) => { switched.push(change); },
  };
  return { deps, store, switched, asked, chosenForResume };
}

const start = (store, tmux = { pane: '%1' }) => store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, cwd: '/w' }, tmux);

test('a running session changes on the row of the model, found by where it comes in the list', async () => {
  const { deps, store, switched, asked } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, model: 'sonnet', effort: 'low' });
  assert.deepEqual(switched, [{ row: { label: 'Sonnet 5.5', number: 3 }, effort: 'low' }]);
  assert.deepEqual(asked, ['/w']);
});

test('only what was asked for changes', async () => {
  const { deps, store, switched } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, effort: 'max' });
  await configureSession(deps, { sessionId: ID, model: 'opus' });
  assert.deepEqual(switched, [{ row: undefined, effort: 'max' }, { row: { label: 'Opus 5.5', number: 2 }, effort: undefined }]);
});

test('a full model name works too, and goes to the row that has it for a name', async () => {
  const { deps, store, switched } = setUp();
  start(store);
  await configureSession(deps, { sessionId: ID, model: 'claude-opus-5-5' });
  await configureSession(deps, { sessionId: ID, model: 'claude-sonnet-5' });
  assert.deepEqual(switched.map(change => change.row.label), ['Opus 5.5', 'Sonnet 5']);
});

test('a name that\'s one row\'s value beats another row resolving to it', async () => {
  const models = [{ value: 'default', displayName: 'Default', resolvedModel: 'sonnet' }, { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5' }];
  const { deps, store, switched } = setUp({ models });
  start(store);
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  assert.equal(switched[0].row.label, 'Sonnet 5.5');
});

test('a model the picker doesn\'t list can\'t be chosen for one session', async () => {
  const { deps, store, switched } = setUp();
  start(store);
  await assert.rejects(configureSession(deps, { sessionId: ID, model: 'claude-opus-4-1' }), { code: 'bad_model' });
  assert.deepEqual(switched, []);
});

test('a session that ended keeps the choice for later, and touches nothing', async () => {
  const { deps, store, switched, chosenForResume } = setUp();
  start(store);
  store.handleHook({ hook_event_name: 'SessionEnd', session_id: ID, reason: 'other' });
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  assert.deepEqual(chosenForResume.get(ID), { model: 'sonnet' });
  assert.deepEqual(switched, []);
});

test('a session the helper hasn\'t seen keeps it too, and choices add up', async () => {
  const { deps, chosenForResume } = setUp();
  await configureSession(deps, { sessionId: ID, model: 'sonnet' });
  await configureSession(deps, { sessionId: ID, effort: 'low' });
  await configureSession(deps, { sessionId: ID, model: 'opus' });
  assert.deepEqual(chosenForResume.get(ID), { model: 'opus', effort: 'low' });
});

test('a stopped session can be given a model the picker doesn\'t list, since --model takes any', async () => {
  const { deps, chosenForResume } = setUp();
  await configureSession(deps, { sessionId: ID, model: 'claude-opus-4-1' });
  assert.deepEqual(chosenForResume.get(ID), { model: 'claude-opus-4-1' });
});

test('a session running somewhere else can\'t be changed, or kept for a resume that won\'t come', async () => {
  const { deps, chosenForResume } = setUp({ running: [{ id: ID, status: 'idle' }] });
  await assert.rejects(configureSession(deps, { sessionId: ID, model: 'sonnet' }), { code: 'no_pane' });
  assert.equal(chosenForResume.size, 0);
});

test('a running session with no pane can\'t be changed', async () => {
  const { deps, store, switched } = setUp();
  start(store, {});
  await assert.rejects(configureSession(deps, { sessionId: ID, effort: 'low' }), { code: 'no_pane' });
  assert.deepEqual(switched, []);
});

test('a choice kept for the command line has to be a model name', async () => {
  const { deps, chosenForResume } = setUp();
  for (const model of ['', 'two words', 'opus\n/exit', '-x', '/clear', 'a;b', 'a$(b)']) {
    await assert.rejects(configureSession(deps, { sessionId: ID, model }), { code: 'bad_model' }, JSON.stringify(model));
  }
  assert.equal(chosenForResume.size, 0);
});

test('the names providers give their models are fine on the command line', async () => {
  const { deps, chosenForResume } = setUp();
  for (const model of ['default', 'sonnet[1m]', 'claude-opus-5-5', 'claude-sonnet-4@20250514', 'us.anthropic.claude-haiku-5-5-v1:0', 'arn:aws:bedrock:us-east-1:1:inference-profile/x']) {
    await configureSession(deps, { sessionId: ID, model });
    assert.equal(chosenForResume.get(ID).model, model);
  }
});

test('only levels the picker has are effort levels', async () => {
  const { deps, store, switched } = setUp();
  start(store);
  for (const effort of ['', 'extreme', 'low high', 'ultracode', 'auto', 'status']) {
    await assert.rejects(configureSession(deps, { sessionId: ID, effort }), { code: 'bad_effort' }, JSON.stringify(effort));
  }
  assert.deepEqual(switched, []);
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) await configureSession(deps, { sessionId: ID, effort });
  assert.equal(switched.length, 5);
});

test('a change typed as a message is read as one', () => {
  assert.deepEqual(readSwitch('/model sonnet'), { model: 'sonnet' });
  assert.deepEqual(readSwitch('  /model  claude-opus-5-5  '), { model: 'claude-opus-5-5' });
  assert.deepEqual(readSwitch('/effort high'), { effort: 'high' });
});

test('anything else stays a message or a command of its own', () => {
  for (const text of ['/model', '/effort', '/effort status', '/effort auto', '/effort ultracode on', '/models sonnet', '/model a b', 'use /model sonnet', 'model sonnet']) {
    assert.equal(readSwitch(text), undefined, text);
  }
});

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

test('things for one session happen one at a time, in the order they came', async () => {
  const inTurn = oneAtATime();
  const happened = [];
  await Promise.all([
    inTurn('a', async () => { happened.push('first starts'); await pause(20); happened.push('first ends'); }),
    inTurn('a', async () => { happened.push('second'); }),
  ]);
  assert.deepEqual(happened, ['first starts', 'first ends', 'second']);
});

test('each one\'s result is its own', async () => {
  const inTurn = oneAtATime();
  assert.deepEqual(await Promise.all([inTurn('a', async () => 1), inTurn('a', async () => 2)]), [1, 2]);
});

test('a failure stays with whoever it belongs to, and the next goes ahead', async () => {
  const inTurn = oneAtATime();
  const failing = inTurn('a', async () => { throw new Error('no'); });
  const next = inTurn('a', async () => 'fine');
  await assert.rejects(failing, /no/);
  assert.equal(await next, 'fine');
});

test('sessions don\'t wait for each other', async () => {
  const inTurn = oneAtATime();
  const happened = [];
  await Promise.all([
    inTurn('a', async () => { await pause(20); happened.push('a'); }),
    inTurn('b', async () => { happened.push('b'); }),
  ]);
  assert.deepEqual(happened, ['b', 'a']);
});
