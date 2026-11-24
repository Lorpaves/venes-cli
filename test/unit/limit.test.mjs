import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/sessions.mjs';
import { askAtLimit } from '../../src/limit.mjs';
import { signalsFrom } from '../../src/transcript.mjs';

const LIMIT = "You've hit your Fable limit · resets Nov 26 at 7am (Europe/London)";
const OPTIONS = ['Stop and wait for limit to reset', 'Switch to Opus 5.5', 'Upgrade your plan'];
const QUESTION = `${LIMIT}\n\nWhat do you want to do?`;
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Claude Code's terminal at a usage limit, as its question draws it: the pointer moves with the keys
// pressed, and the question goes once one is chosen.
function terminalAt(options = OPTIONS) {
  const term = { pointed: 0, chosen: undefined, presses: [], isAsked: true };
  term.read = async () => (term.isAsked ? [
    '⏺ Working on it', `  ⎿  ${LIMIT}`, '', '─'.repeat(60), ' What do you want to do?', '',
    ...options.map((label, index) => `${index === term.pointed ? ' ❯' : '  '} ${index + 1}. ${label}`), '',
    ' Enter to confirm · Esc to cancel',
  ].join('\n') : '❯ \n');
  term.press = async key => {
    term.presses.push(key);
    if (key === 'Down') term.pointed += 1;
    else if (key === 'Up') term.pointed -= 1;
    else if (key === 'Enter') {
      term.chosen = options[term.pointed];
      term.isAsked = false;
    }
  };
  return term;
}

function setup() {
  const store = new SessionStore();
  store.adopt('s1', { cwd: '/w' });
  const events = [];
  store.on('event', event => events.push(event));
  return { store, events, session: store.get('s1') };
}

const fast = { look: 1, looks: 30, check: 5 };

test('a turn stopped at a usage limit asks on a card what the terminal asks, and the pick is pressed there', async () => {
  const { store, events, session } = setup();
  const term = terminalAt();
  const done = askAtLimit({ store, screen: term, session, lead: LIMIT, ...fast });
  while (!store.requests().length) await pause(2);
  const [request] = store.requests();
  assert.equal(request.kind, 'question');
  assert.equal(request.toolName, 'AskUserQuestion');
  assert.deepEqual(request.input.questions.map(({ question, header, multiSelect }) => [question, header, multiSelect]), [[QUESTION, 'What do you want to do?', false]]);
  assert.deepEqual(request.input.questions[0].options.map(option => option.label), OPTIONS, 'the terminal\'s own options, in its order');
  assert.equal(session.status, 'waiting');
  store.respond(request.id, { decision: 'allow', answers: { [QUESTION]: 'Switch to Opus 5.5' } });
  await done;
  assert.deepEqual(term.presses, ['Down', 'Enter']);
  assert.equal(term.chosen, 'Switch to Opus 5.5');
  assert.equal(session.status, 'idle', 'the card was all that was going on');
  assert.ok(events.some(event => event.kind === 'request.closed'));
});

test('one answered at the terminal meanwhile closes its card, and nothing is pressed', async () => {
  const { store, events, session } = setup();
  const term = terminalAt();
  const done = askAtLimit({ store, screen: term, session, lead: LIMIT, ...fast });
  while (!store.requests().length) await pause(2);
  term.isAsked = false;
  await done;
  assert.equal(store.requests().length, 0);
  assert.equal(events.find(event => event.kind === 'request.closed').by, 'terminal');
  assert.deepEqual(term.presses, []);
});

test('one left from here is left on the terminal, for someone there', async () => {
  const { store, session } = setup();
  const term = terminalAt();
  const done = askAtLimit({ store, screen: term, session, lead: LIMIT, ...fast });
  while (!store.requests().length) await pause(2);
  store.respond(store.requests()[0].id, { decision: 'deny' });
  await done;
  assert.deepEqual(term.presses, []);
  assert.equal(term.isAsked, true);
});

test('a terminal that asks nothing gets no card', async () => {
  const { store, session } = setup();
  const term = terminalAt();
  term.isAsked = false;
  await askAtLimit({ store, screen: term, session, lead: LIMIT, look: 1, looks: 5, check: 5 });
  assert.equal(store.requests().length, 0);
});

test('the limit is told by the reply Claude Code writes for it, with when it resets and when it was written', () => {
  const record = {
    type: 'assistant', isApiErrorMessage: true, error: 'rate_limit', apiErrorStatus: 429, timestamp: '2026-11-24T03:58:12.000Z',
    message: { model: '<synthetic>', content: [{ type: 'text', text: LIMIT }] }, quotaLimits: { status: 'rejected', resetsAt: 1795676400 },
  };
  const at = Date.parse('2026-11-24T03:58:12.000Z');
  assert.deepEqual(signalsFrom(record).filter(signal => signal.type === 'usageLimit'), [{ type: 'usageLimit', text: LIMIT, resetsAt: 1795676400000, at }]);
  assert.deepEqual(signalsFrom({ ...record, error: 'overloaded' }).filter(signal => signal.type === 'usageLimit'), []);
  assert.deepEqual(signalsFrom({ ...record, isApiErrorMessage: false }).filter(signal => signal.type === 'usageLimit'), []);
  const store = new SessionStore();
  store.adopt('s1', { cwd: '/w' });
  const told = [];
  store.on('limit', limit => told.push(limit));
  store.handleTranscriptRecord('s1', record);
  assert.deepEqual(told, [{ sessionId: 's1', text: LIMIT, resetsAt: 1795676400000, at }]);
});

test('a limit that is over asks nothing, whatever the terminal shows', async () => {
  const { store, session } = setup();
  const term = terminalAt();
  let reads = 0;
  const read = term.read;
  term.read = () => { reads += 1; return read(); };
  await askAtLimit({ store, screen: term, session, lead: LIMIT, at: 1_000, now: () => 1_000 + 3 * 60 * 1000, ...fast });
  assert.equal(store.requests().length, 0);
  assert.equal(reads, 0, 'the terminal is not even looked at');
});

test('nothing is asked while the session asks something else, which is what the terminal shows then', async () => {
  const { store, session } = setup();
  store.ask(session.id, { kind: 'permission', toolName: 'Bash', input: { command: 'ls' } }, () => ({}));
  await askAtLimit({ store, screen: terminalAt(), session, lead: LIMIT, at: Date.now(), ...fast });
  assert.deepEqual(store.requests().map(request => request.kind), ['permission']);
});
