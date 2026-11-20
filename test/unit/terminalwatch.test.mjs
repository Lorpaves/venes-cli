import test from 'node:test';
import assert from 'node:assert/strict';
import { TERMINAL_CLOSED, TerminalWatch } from '../../src/terminalwatch.mjs';

// A store with these sessions, which writes down what's reported and ends a session as the real one does.
function storeOf(sessions) {
  return {
    reported: [],
    liveSessions() { return sessions.filter(session => session.status !== 'ended'); },
    report(id, kind, data) {
      this.reported.push([id, kind, data.reason]);
      sessions.find(session => session.id === id).status = 'ended';
    },
  };
}
const session = (id, fields = {}) => ({ id, pane: `%${id}`, status: 'idle', ...fields });
// Answers by pane from `answers`, each a value or a list taken one look at a time, and writes down who was asked.
function terminals(answers) {
  const looks = [];
  const hasTerminal = async (asked, map) => {
    looks.push([asked.id, map]);
    const answer = answers[asked.id];
    const value = Array.isArray(answer) ? answer.shift() : answer;
    if (value instanceof Error) throw value;
    return value;
  };
  return { looks, hasTerminal };
}
const FAST = { confirm: 5, isRunning: async () => false };

test('a session whose terminal is twice not there has ended, and the others go on', async () => {
  const sessions = [session('gone'), session('there'), session('unknown')];
  const store = storeOf(sessions);
  const { hasTerminal } = terminals({ gone: false, there: true, unknown: undefined });
  await new TerminalWatch({ store, hasTerminal, ...FAST }).look();
  assert.deepEqual(store.reported, [['gone', 'session.ended', TERMINAL_CLOSED]]);
  assert.equal(TERMINAL_CLOSED, 'terminal_closed');
});

test('a terminal not found once and there the next time is still its session\'s', async () => {
  const store = storeOf([session('back'), session('lost')]);
  const { hasTerminal } = terminals({ back: [false, true], lost: [false, undefined] });
  await new TerminalWatch({ store, hasTerminal, ...FAST }).look();
  assert.deepEqual(store.reported, []);
});

test('only Claude Code\'s sessions with a terminal are looked for, and each look asks a server once for all', async () => {
  const sessions = [session('one'), session('two'), session('codex', { agent: 'codex' }), session('bare', { pane: undefined }), session('over', { status: 'ended' })];
  const store = storeOf(sessions);
  const { looks, hasTerminal } = terminals({ one: true, two: true });
  await new TerminalWatch({ store, hasTerminal, ...FAST }).look();
  assert.deepEqual(looks.map(([id]) => id).sort(), ['one', 'two']);
  assert.equal(looks[0][1], looks[1][1], 'what a server said is kept for the look');
  assert.ok(looks[0][1] instanceof Map);
});

test('a terminal that can\'t be asked about ends nothing', async () => {
  const store = storeOf([session('one')]);
  const { hasTerminal } = terminals({ one: new Error('rex timed out') });
  const watch = new TerminalWatch({ store, hasTerminal, ...FAST });
  await watch.look();
  assert.equal(await watch.endIfGone(store.liveSessions()[0]), false);
  assert.deepEqual(store.reported, []);
});

test('a session that ended or moved while its terminal was looked for is left as it is', async () => {
  const moved = session('moved');
  const ended = session('ended');
  const store = storeOf([moved, ended]);
  const hasTerminal = async asked => {
    if (asked === moved) moved.pane = '%new';
    if (asked === ended) ended.status = 'ended';
    return false;
  };
  const watch = new TerminalWatch({ store, hasTerminal, ...FAST });
  assert.equal(await watch.endIfGone(moved), false);
  assert.equal(await watch.endIfGone(ended), false);
  assert.deepEqual(store.reported, []);
});

test('for a message on its way, one look ends a session whose terminal has gone', async () => {
  const store = storeOf([session('gone'), session('there')]);
  const { looks, hasTerminal } = terminals({ gone: false, there: true });
  const watch = new TerminalWatch({ store, hasTerminal, ...FAST });
  const [gone, there] = store.liveSessions();
  assert.equal(await watch.endIfGone(gone), true);
  assert.equal(await watch.endIfGone(there), false);
  assert.equal(await watch.endIfGone(gone), false, 'it has ended already');
  assert.deepEqual(store.reported, [['gone', 'session.ended', 'terminal_closed']]);
  assert.deepEqual(looks.map(([id]) => id), ['gone', 'there']);
});

test('a look that starts while another is going does nothing', async () => {
  const store = storeOf([session('one')]);
  let asked = 0;
  let answer;
  const hasTerminal = () => { asked += 1; return new Promise(resolve => { answer = resolve; }); };
  const watch = new TerminalWatch({ store, hasTerminal, ...FAST });
  const first = watch.look();
  await watch.look();
  assert.equal(asked, 1);
  answer(true);
  await first;
});

test('it looks again and again until it\'s stopped', async () => {
  const store = storeOf([session('one')]);
  let asked = 0;
  const watch = new TerminalWatch({ store, hasTerminal: async () => { asked += 1; return true; }, ...FAST });
  const stop = watch.start(10);
  await new Promise(resolve => { setTimeout(resolve, 80); });
  stop();
  const looked = asked;
  assert.ok(looked >= 2, `looked ${looked} times`);
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(asked, looked);
});
test('a session Claude Code still lists as running goes on, though the terminal it names isn\'t there', async () => {
  const store = storeOf([session('editor'), session('killed')]);
  const { hasTerminal } = terminals({ editor: false, killed: false });
  const asks = [];
  const isRunning = async (asked, map) => { asks.push(map); return asked.id === 'editor'; };
  const watch = new TerminalWatch({ store, hasTerminal, confirm: 5, isRunning });
  await watch.look();
  assert.deepEqual(store.reported, [['killed', 'session.ended', 'terminal_closed']]);
  assert.equal(asks[0], asks[1], 'what runs is asked once for the two');
  assert.equal(await watch.endIfGone(store.liveSessions()[0]), false);
});

test('with no way to ask what\'s running, nothing ends', async () => {
  const store = storeOf([session('one')]);
  const { hasTerminal } = terminals({ one: false });
  const watch = new TerminalWatch({ store, hasTerminal, confirm: 5, isRunning: async () => { throw new Error('claude: command not found'); } });
  await watch.look();
  assert.equal(await watch.endIfGone(store.liveSessions()[0]), false);
  assert.deepEqual(store.reported, []);
});
