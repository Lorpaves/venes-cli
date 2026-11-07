import test from 'node:test';
import assert from 'node:assert/strict';
import { removeSession } from '../../src/remove.mjs';
import { HelperError, SessionStore } from '../../src/sessions.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const FAST = { limit: 60, check: 5 };

function setUp({ running = [], stopsAfter = 1, deleting = async () => {} } = {}) {
  const store = new SessionStore({ agentParent: () => undefined });
  const events = [];
  store.on('event', event => events.push(event));
  const steps = [];
  let kills = 0;
  let checks = 0;
  const library = {
    running: async () => {
      if (kills) checks += 1;
      return kills && checks >= stopsAfter ? [] : running;
    },
    delete: async id => {
      steps.push(`delete ${id}`);
      await deleting();
    },
  };
  const kill = pid => {
    kills += 1;
    steps.push(`kill ${pid}`);
  };
  return { deps: { store, library, kill, ...FAST }, store, events, steps };
}

const start = store => store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, cwd: '/w' }, { pane: '%1' });

test('a stored session is deleted, and every client hears', async () => {
  const { deps, events, steps } = setUp();
  await removeSession(deps, ID);
  assert.deepEqual(steps, [`delete ${ID}`]);
  assert.deepEqual(events.map(event => event.kind), ['session.deleted']);
});

test('a running session ends first, because it would write its transcript back', async () => {
  const { deps, steps } = setUp({ running: [{ id: ID, pid: 42, kind: 'interactive' }] });
  await removeSession(deps, ID);
  assert.deepEqual(steps, ['kill 42', `delete ${ID}`]);
});

test('it waits for the session to go, however many looks that takes', async () => {
  const { deps, steps } = setUp({ running: [{ id: ID, pid: 42, kind: 'interactive' }], stopsAfter: 4 });
  await removeSession(deps, ID);
  assert.deepEqual(steps, ['kill 42', `delete ${ID}`]);
});

test('a session that won\'t stop keeps its transcript', async () => {
  const { deps, store, steps, events } = setUp({ running: [{ id: ID, pid: 42, kind: 'interactive' }], stopsAfter: Infinity });
  start(store);
  await assert.rejects(removeSession(deps, ID), { code: 'session_running' });
  assert.deepEqual(steps, ['kill 42']);
  assert.ok(store.find(ID));
  assert.ok(!events.some(event => event.kind === 'session.deleted'));
});

test('someone else\'s session is left alone', async () => {
  const { deps, steps } = setUp({ running: [{ id: 'other', pid: 7, kind: 'interactive' }] });
  await removeSession(deps, ID);
  assert.deepEqual(steps, [`delete ${ID}`]);
});

test('a background session is left to claude rm', async () => {
  for (const entry of [{ id: ID, pid: 42, kind: 'background' }, { id: ID, kind: 'background' }, { id: ID }]) {
    const { deps, steps } = setUp({ running: [entry] });
    await assert.rejects(removeSession(deps, ID), { code: 'background_session' }, JSON.stringify(entry));
    assert.deepEqual(steps, []);
  }
});

test('with no way to tell what\'s running, nothing is deleted', async () => {
  const { deps, steps } = setUp();
  deps.library.running = async () => { throw new Error('no claude'); };
  await assert.rejects(removeSession(deps, ID), /no claude/);
  assert.deepEqual(steps, []);
});

test('a failed delete leaves the session where it was', async () => {
  const { deps, store, events } = setUp({ deleting: async () => { throw new HelperError('sdk_unavailable', 'no'); } });
  start(store);
  await assert.rejects(removeSession(deps, ID), { code: 'sdk_unavailable' });
  assert.ok(store.find(ID));
  assert.ok(!events.some(event => event.kind === 'session.deleted'));
});

test('a session that never wrote a transcript still goes from the list', async () => {
  const { deps, store, events } = setUp({ deleting: async () => { throw new HelperError('unknown_session', 'none'); } });
  start(store);
  await removeSession(deps, ID);
  assert.equal(store.find(ID), undefined);
  assert.equal(events.at(-1).kind, 'session.deleted');
});

test('a session nobody has heard of is reported as unknown', async () => {
  const { deps, events } = setUp({ deleting: async () => { throw new HelperError('unknown_session', 'none'); } });
  await assert.rejects(removeSession(deps, ID), { code: 'unknown_session' });
  assert.deepEqual(events, []);
});
