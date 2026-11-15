import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT, Antigravity, conversationFiles, historyOf, isTrusted, levelFor, libraryItem, limitsFrom, MODE_IDS, modelOf, modelsFrom, pageOf, requestOf, resultOf, runsIn, stepsIn, toolOf,
  transcriptOf, typedText,
} from '../../src/antigravity.mjs';
import { SessionStore } from '../../src/sessions.mjs';

const ID = '9a2b37ed-a910-4ecc-9241-54964775c9c9';
const RULE = '─'.repeat(70);
const bar = (hint, settings = 'Gemini 4 Hydrogen · xhigh') => `${hint.padEnd(40)}${settings}`;
const IDLE = ['> ', RULE, bar('? for shortcuts')].join('\n');
const BUSY = ['⣾  Generating...', RULE, '>', RULE, bar('esc to cancel')].join('\n');
const idleIn = mode => ['> ', RULE, bar('? for shortcuts', `${mode} · Gemini 4 Hydrogen · xhigh`)].join('\n');
const PROMPT = [
  'Command', RULE, 'Requesting permission for:', '   echo three', 'Run this command?', '> 1. Yes, run command',
  '  2. Yes, and always allow in this conversation for commands that start with \'echo\'', '  3. No, cancel',
  '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', bar('esc to cancel'),
].join('\n');
const TRUST = ['Do you trust the contents of this project?', '', '> Yes, I trust this folder', '  No, exit'].join('\n');

const user = (index, text) => ({
  step_index: index, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE',
  content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-15T10:32:21Z.\n</ADDITIONAL_METADATA>`,
});
const reply = (index, { content, thinking, calls } = {}) => ({
  step_index: index, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', ...(content && { content }), ...(thinking && { thinking }), ...(calls && { tool_calls: calls }),
});
const result = (index, printed, { status = 'DONE', error } = {}) => ({
  step_index: index, source: 'MODEL', type: 'GENERIC', status, ...(error && { error }),
  content: `Created At: 2026-11-15T10:32:25Z\nCompleted At: 2026-11-15T10:32:25Z\nCreated At: 2026-11-15T10:32:25Z\nCompleted At: 2026-11-15T10:32:25Z\n${printed}`,
});
const READ = { name: 'read_file', args: { Path: '/w/note.txt' } };
const RUN = { name: 'run_command', args: { CommandLine: 'echo done', WaitMsBeforeAsync: 5000, toolSummary: 'Echo done' } };
const RAN = 'Command exited with code 0.\n\nCommand output:\ndone\r\n';

test('a call is told as a Claude Code call of its kind is', () => {
  assert.deepEqual(toolOf(READ), { name: 'Read', input: { file_path: '/w/note.txt' } });
  assert.deepEqual(toolOf(RUN), { name: 'Bash', input: { command: 'echo done', description: 'Echo done' } });
  assert.deepEqual(toolOf({ name: 'write_file', args: { Path: '/w/a.txt', Content: 'one' } }), { name: 'Write', input: { file_path: '/w/a.txt', content: 'one' } });
  assert.deepEqual(toolOf({ name: 'edit_file', args: { Path: '/w/a.txt', Target: 'one', Replacement: 'two' } }),
    { name: 'Edit', input: { file_path: '/w/a.txt', old_string: 'one', new_string: 'two' } });
  assert.deepEqual(toolOf({ name: 'browser_open', args: { Url: 'x' } }), { name: 'browser_open', input: { Url: 'x' } });
});

test('what a call came to is told without when it ran, and a command\'s without how it ended', () => {
  assert.deepEqual(resultOf(result(4, RAN), 'Bash'), { text: 'done\n', isError: false });
  assert.deepEqual(resultOf(result(4, 'Command exited with code 2.\n\nCommand output:\nno\n'), 'Bash'), { text: 'no\n', isError: true });
  assert.deepEqual(resultOf(result(2, 'Showing lines 1-1 of 1\n1: HERON'), 'Read'), { text: 'Showing lines 1-1 of 1\n1: HERON', isError: false });
  assert.equal(resultOf(result(8, 'Encountered error', { status: 'ERROR', error: 'denied' }), 'Bash').isError, true);
});

test('a model is named with how hard it thinks, and the ones on offer are put together by what they are', () => {
  assert.deepEqual(modelOf('gemini-4-hydrogen-xhigh'), { model: 'gemini-4-hydrogen', effort: 'xhigh' });
  assert.deepEqual(modelOf('gemini-pro-orchestrator-g1-pro'), { model: 'gemini-pro-orchestrator-g1-pro', effort: undefined });
  assert.deepEqual(modelOf(undefined), {});
  const listing = 'Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\n'
    + 'gemini-4-argon-low\tGemini 4 Argon (Low)\ngemini-pro-orchestrator-g1-pro\tOrchestrator (Argon)\nclaude-opus-5-5-high\tClaude Opus 5.5 (High)\n';
  assert.deepEqual(modelsFrom(listing), [
    { value: 'gemini-4-argon', displayName: 'Gemini 4 Argon', effortLevels: ['low', 'medium', 'high'] },
    { value: 'gemini-pro-orchestrator-g1-pro', displayName: 'Orchestrator (Argon)', effortLevels: [] },
    { value: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', effortLevels: ['high'] },
  ]);
  // A model that can't think the way that's wanted thinks the nearest way it can.
  assert.deepEqual([levelFor(['low', 'medium', 'high'], 'xhigh'), levelFor(['low', 'medium', 'high', 'xhigh'], 'xhigh'), levelFor(['high', 'xhigh'], 'low')], ['high', 'xhigh', 'high']);
  assert.deepEqual([levelFor(['low', 'medium', 'high'], undefined), levelFor(['low', 'high'], undefined), levelFor([], 'high'), levelFor(['medium'], 'max')], ['medium', 'low', undefined, 'medium']);
});

test('a conversation is what was said, each call with how it ended, and its turns\' ends', () => {
  const steps = [
    user(0, 'read the note'), reply(1, { thinking: 'I will read it.\n\n\n', calls: [READ] }), result(2, 'Showing lines 1-1 of 1\n1: HERON'),
    reply(3, { calls: [RUN] }), result(4, RAN), reply(5, { content: 'HERON', thinking: 'Done.\n' }),
    user(6, 'again'), reply(7, { calls: [RUN] }),
  ];
  assert.deepEqual(historyOf(steps), [
    { role: 'user', text: 'read the note' }, { role: 'thinking', text: 'I will read it.' },
    { role: 'tool', toolUseId: 'step-2', name: 'Read', input: { file_path: '/w/note.txt' }, result: 'Showing lines 1-1 of 1\n1: HERON', isError: false },
    { role: 'tool', toolUseId: 'step-4', name: 'Bash', input: { command: 'echo done', description: 'Echo done' }, result: 'done\n', isError: false },
    { role: 'thinking', text: 'Done.' }, { role: 'assistant', text: 'HERON' }, { role: 'turn_end' },
    { role: 'user', text: 'again' },
    // Stopped before it ran: nothing says how it ended.
    { role: 'tool', toolUseId: 'step-8', name: 'Bash', input: { command: 'echo done', description: 'Echo done' }, result: undefined, isError: false },
    { role: 'turn_end' },
  ]);
  assert.equal(requestOf('plain words'), 'plain words');
  // A line half written is left for the next read.
  assert.equal(stepsIn(`${JSON.stringify(user(0, 'a'))}\n${JSON.stringify(reply(1, { content: 'b' }))}\n{"step_index": 2, "ty`).length, 2);
  const page = pageOf(historyOf(steps), { limit: 2 });
  assert.deepEqual([page.items[0], page.before, page.hasMore], [{ role: 'user', text: 'again' }, 7, true]);
});

test('a stored conversation is listed by its summary, and a message is typed with its files named first', () => {
  const row = { conversation_id: ID, title: 'Read Note', last_modified_time: '2026-11-15 10:39:39.196533+00:00', workspace_uris: '["file:///w/my%20folder"]', step_count: 18 };
  assert.deepEqual(libraryItem(row, 'idle'), { id: ID, title: 'Read Note', cwd: '/w/my folder', lastActiveAt: Date.parse('2026-11-15T10:39:39.196533+00:00'), status: 'idle', agent: AGENT });
  assert.deepEqual(libraryItem({ conversation_id: ID, title: '', workspace_uris: 'nonsense' }), { id: ID, title: undefined, cwd: undefined, lastActiveAt: undefined, status: null, agent: AGENT });
  assert.equal(typedText('look', [{ path: '/up/a.png', kind: 'image' }, { path: '/up/b.txt' }]), '/up/a.png\n/up/b.txt\nlook');
  assert.deepEqual(MODE_IDS, ['default', 'acceptEdits', 'auto', 'plan']);
});

// What `agy -p /usage --output-format json` printed (1.5.8), less its words about each limit.
const USAGE = {
  conversation_id: '', status: 'SUCCESS', num_turns: 0,
  command: { name: 'usage', data: { description: 'Within each group, models share a weekly limit and a 5-hour limit.', groups: [
    { name: 'Gemini Models', description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.9481035470962524, reset_time: '2026-11-21T03:32:17Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.9864928722381592, reset_time: '2026-11-15T15:32:22Z' },
    ] },
    { name: 'Claude and GPT models', buckets: [
      { id: '3p-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 1, reset_time: '2026-11-22T12:01:08Z' },
      { id: '3p-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 1, reset_time: '2026-11-15T17:01:08Z' },
    ] },
    { name: 'Gemini 4 Argon', buckets: [{ id: 'gemini-argon-wtu-weekly', name: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remaining_fraction: 0.9699529409408569, reset_time: '2026-11-21T03:27:31Z' }] },
  ] } },
};
const LIMITS = [
  { name: 'Gemini Models', window: 'sevenDay', percent: 5.2, resetsAt: 1795231937 }, { name: 'Gemini Models', window: 'fiveHour', percent: 1.4, resetsAt: 1794756742 },
  { name: 'Claude and GPT models', window: 'sevenDay', percent: 0, resetsAt: 1795348868 }, { name: 'Claude and GPT models', window: 'fiveHour', percent: 0, resetsAt: 1794762068 },
  { name: 'Gemini 4 Argon', window: 'sevenDay', percent: 3, resetsAt: 1795231651 },
];

test('the account\'s limits are every one Antigravity lists, by its group, with how much is used', () => {
  assert.deepEqual(limitsFrom(USAGE), LIMITS);
  const odd = { command: { data: { groups: [
    { name: 'Some', buckets: [{ window: 'monthly', remaining_fraction: 1.4, reset_time: 'soon' }, { window: '5h', remaining_fraction: -0.2 }, { window: '5h', remaining_fraction: '0.5' }, null] },
    { name: '', buckets: [{ window: '5h', remaining_fraction: 0.5 }] }, { name: 'None' }, 'a group',
  ] } } };
  // A window that's neither of the two is told with none, and what isn't a share of anything isn't told.
  assert.deepEqual(limitsFrom(odd), [{ name: 'Some', percent: 0 }, { name: 'Some', window: 'fiveHour', percent: 100 }]);
  assert.deepEqual([limitsFrom({}), limitsFrom(undefined), limitsFrom({ command: { data: { groups: 'none' } } })], [[], [], []]);
});

// An Antigravity with a folder of its own for what it stores, a terminal that shows what a test says
// it shows, and nothing real started.
function setup(t, { screen = IDLE, trusted = [], rows = [], timing = {}, usage = async () => USAGE } = {}) {
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-agy-')));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ trustedWorkspaces: trusted }));
  const store = new SessionStore();
  const events = [];
  store.on('event', event => events.push(event));
  const terminal = {
    screen, keys: [], pasted: [], started: [], isOpen: true, isGone: false, onKey: undefined,
    startSession: async spec => { terminal.started.push(spec); return { pane: '%9', tmuxSocket: '/tmp/sock' }; },
    isSessionOpen: async () => terminal.isOpen,
    readScreen: async () => { if (terminal.isGone) throw new Error('no such pane'); return terminal.screen; },
    pressKey: async (_, key) => { terminal.keys.push(key); terminal.onKey?.(key); },
    paste: async (_, text) => { terminal.pasted.push(text); },
    running: 'zsh',
    foreground: async () => { if (terminal.isGone) throw new Error('no such pane'); return terminal.running; },
    processOf: async () => { if (terminal.isGone) throw new Error('no such pane'); return { name: terminal.running, pid: 4242 }; },
  };
  const minted = [];
  // What was moved to the Trash, as the folder's name and what was in it, taken out of Antigravity's lists, and told to go.
  const trashed = [];
  const forgotten = [];
  const killed = [];
  const agent = new Antigravity({
    store, terminal, data, installed: () => true, rows: async () => rows,
    mint: async folder => { minted.push(folder); return ID; },
    models: async () => modelsFrom('gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'),
    usage,
    trash: async folder => { trashed.push([path.basename(folder), fs.readdirSync(folder).sort()]); },
    forget: async id => { forgotten.push(id); },
    kill: pid => { killed.push(pid); terminal.onKill?.(pid); },
    env: { PATH: '/bin', VENES_HOME: '/h', SECRET: 'x' },
    timing: { watch: 15, rest: 15, startLimit: 400, startCheck: 5, keySettle: 1, pasteSettle: 1, stepWait: 60, stepCheck: 5, keyLimit: 300, keyCheck: 5, commandLimit: 300, modelsWait: 200, usageWait: 200, quitLimit: 150, quitCheck: 5, ...timing },
  });
  t.after(() => agent.stop());
  const file = transcriptOf(data, ID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const write = steps => fs.writeFileSync(file, steps.map(step => `${JSON.stringify(step)}\n`).join(''));
  const hook = (event, fields = {}, where = { pane: '%9', socket: '/tmp/sock' }) => agent.handleHook({
    conversationId: ID, cwd: '/w', workspacePaths: ['/w'], transcriptPath: file, modelName: 'gemini-4-hydrogen-xhigh', hookEventName: event, ...fields,
  }, where);
  const kinds = () => events.map(event => event.kind);
  const until = async (isSo, what) => {
    for (let tries = 0; tries < 400; tries++) {
      if (isSo()) return;
      await new Promise(resolve => { setTimeout(resolve, 5); });
    }
    assert.fail(`never: ${what}`);
  };
  // A conversation as Antigravity keeps one: its file, its folder with the transcript, and its notes.
  const stored = (id = ID) => {
    for (const kept of conversationFiles(data, id).filter(kept => /\.(db|pbtxt)$/.test(kept))) {
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      fs.writeFileSync(kept, '');
    }
    fs.mkdirSync(path.join(data, 'brain', id), { recursive: true });
  };
  return { agent, store, events, terminal, minted, data, file, write, hook, kinds, until, trashed, forgotten, killed, stored };
}

test('a session at the Mac is followed from its hooks, and a turn told in a Claude Code turn\'s shapes', async t => {
  const { agent, store, events, write, hook, kinds } = setup(t);
  write([user(0, 'read the note')]);
  await hook('SessionStart', { lastUserInput: 'read the note' });
  assert.deepEqual(kinds(), ['session.discovered', 'session.model', 'session.effort', 'session.started']);
  const known = store.get(ID);
  assert.deepEqual([known.agent, known.cwd, known.pane, known.tmuxSocket, known.model, known.effort, known.permissionMode],
    [AGENT, '/w', '%9', '/tmp/sock', 'gemini-4-hydrogen', 'xhigh', 'default']);
  assert.equal(await agent.owns(ID), true);

  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'read the note' });
  assert.deepEqual(events.slice(4).map(event => [event.kind, event.text ?? event.status]), [['message.user', 'read the note'], ['session.status', 'running']]);

  write([user(0, 'read the note'), reply(1, { thinking: 'I will read it.\n\n', calls: [READ] }), result(2, 'Showing lines 1-1 of 1\n1: HERON')]);
  await hook('PostToolUse', { stepIdx: 2, toolCall: { id: 'call_1', ...READ }, error: '' });
  await hook('PostInvocation', { invocationNum: 0 });
  const told = events.slice(6);
  assert.deepEqual(told.map(event => event.kind), ['message.thinking', 'tool.start', 'tool.end']);
  assert.equal(told[0].text, 'I will read it.');
  assert.deepEqual([told[1].toolUseId, told[1].name, told[1].input], ['step-2', 'Read', { file_path: '/w/note.txt' }]);
  assert.deepEqual([told[2].toolUseId, told[2].response, told[2].isError], ['step-2', 'Showing lines 1-1 of 1\n1: HERON', false]);

  await hook('PreInvocation', { invocationNum: 1, initialNumSteps: 3 });
  write([user(0, 'read the note'), reply(1, { calls: [READ] }), result(2, 'x'), reply(3, { content: 'HERON' })]);
  await hook('PostInvocation', { invocationNum: 1 });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true, error: '' });
  const rest = events.slice(9);
  assert.deepEqual(rest.map(event => event.kind), ['message.assistant.delta', 'message.assistant.delta', 'session.status', 'turn.end']);
  assert.deepEqual([rest[0].text, rest[0].final, rest[1].final, rest[3].lastMessage], ['HERON', false, true, 'HERON']);
  assert.equal(store.get(ID).status, 'idle');

  // And what's past is read from the transcript, a turn whole.
  const page = await agent.history({ sessionId: ID });
  assert.deepEqual(page.items.map(item => item.role), ['user', 'tool', 'assistant', 'turn_end']);
  const joined = await agent.join({ sessionId: ID });
  assert.deepEqual([joined.sessions[0].id, joined.sessions[0].agent, joined.turn, joined.requests], [ID, AGENT, [], []]);
});

test('a message is typed into the terminal, and known for the client\'s own when its turn starts', async t => {
  const { agent, store, events, terminal, hook } = setup(t);
  await hook('SessionStart');
  const sent = await agent.send({ sessionId: ID, text: 'look at this', clientId: 'c1', attachments: [{ uploadId: 'u1', name: 'a.png', mediaType: 'image/png', size: 3, path: '/up/a.png', kind: 'image' }] });
  assert.deepEqual([sent, terminal.pasted, terminal.keys], [{ queued: false }, ['/up/a.png\nlook at this'], ['Enter']]);
  assert.equal(store.get(ID).status, 'running');
  // What's sent meanwhile waits for the turn's end.
  assert.deepEqual(await agent.send({ sessionId: ID, text: 'and then', clientId: 'c2' }), { queued: true });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: '/up/a.png\nlook at this' });
  const said = events.find(event => event.kind === 'message.user');
  assert.deepEqual([said.text, said.clientId, said.attachments], ['look at this', 'c1', [{ uploadId: 'u1', name: 'a.png', mediaType: 'image/png', size: 3 }]]);
  // One typed at the Mac has no client.
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 3, lastUserInput: 'typed here' });
  assert.equal(events.filter(event => event.kind === 'message.user').at(-1).clientId, undefined);
});

test('nothing is typed while something is open in the terminal, or with no terminal to type into', async t => {
  const { agent, terminal, hook } = setup(t, { screen: PROMPT, timing: { watch: 100_000 } });
  await hook('SessionStart');
  await assert.rejects(agent.send({ sessionId: ID, text: 'hello' }), { code: 'dialog_open' });
  assert.deepEqual(terminal.pasted, []);
  const bare = setup(t);
  await bare.hook('SessionStart', {}, {});
  await assert.rejects(bare.agent.send({ sessionId: ID, text: 'hello' }), { code: 'no_pane' });
});

test('a prompt in the terminal is a request, answered by pressing its row', async t => {
  const { agent, store, events, terminal, write, hook, until } = setup(t);
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'run it' });
  write([user(0, 'run it'), reply(1, { calls: [RUN] })]);
  terminal.screen = PROMPT;
  await until(() => store.requests().length === 1, 'a request');
  const [request] = store.requests();
  assert.deepEqual([request.kind, request.agent, request.toolName, request.toolUseId, request.input],
    ['permission', AGENT, 'Bash', 'step-2', { command: 'echo done', description: 'Echo done' }]);
  assert.deepEqual(request.options, [{ id: '2', label: 'Yes, and always allow in this conversation for commands that start with \'echo\'' }]);
  assert.equal(store.get(ID).status, 'waiting');
  assert.throws(() => store.respond(request.id, { decision: 'allow', option: '3' }), { code: 'bad_option' });
  // Its row is pressed, and the prompt goes.
  terminal.onKey = () => { terminal.screen = BUSY; };
  store.respond(request.id, { decision: 'allow' });
  await until(() => terminal.keys.length === 1, 'a key');
  assert.deepEqual(terminal.keys, ['1']);
  // The press is watched until the prompt has gone, which a prompt drawn again at once would look like it hadn't.
  const settled = () => new Promise(resolve => { setTimeout(resolve, 80); });
  await settled();
  assert.deepEqual(events.filter(event => event.kind.startsWith('request.')).map(event => [event.kind, event.by]), [['request.opened', undefined], ['request.closed', 'client']]);

  // No is its last row, and one of its other ways of saying yes is its own.
  for (const [answer, key] of [[{ decision: 'deny' }, '3'], [{ decision: 'allow', option: '2' }, '2']]) {
    terminal.keys.length = 0;
    terminal.onKey = undefined;
    terminal.screen = PROMPT;
    await until(() => store.requests().length === 1, 'the next request');
    terminal.onKey = () => { terminal.screen = BUSY; };
    store.respond(store.requests()[0].id, answer);
    await until(() => terminal.keys.length === 1, 'its key');
    assert.deepEqual(terminal.keys, [key]);
    await settled();
  }

  // Answered at the Mac, it's closed here.
  terminal.onKey = undefined;
  terminal.screen = PROMPT;
  await until(() => store.requests().length === 1, 'one more');
  terminal.screen = BUSY;
  await until(() => store.requests().length === 0, 'its end');
  assert.equal(events.filter(event => event.kind === 'request.closed').at(-1).by, 'terminal');
  assert.equal(agent.name, AGENT);
});

test('a turn stopped at the Mac is told as stopped, though no hook says so', async t => {
  const { store, events, terminal, write, hook, until } = setup(t, { screen: BUSY });
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'make it' });
  write([user(0, 'make it'), reply(1, { calls: [RUN] })]);
  await until(() => events.some(event => event.kind === 'tool.start'), 'the call, from the transcript');
  terminal.screen = IDLE;
  await until(() => events.some(event => event.kind === 'turn.interrupted'), 'the stop');
  const end = events.find(event => event.kind === 'tool.end');
  assert.deepEqual([end.toolUseId, end.isError, end.interrupted, store.get(ID).status], ['step-2', true, true, 'idle']);
});

test('interrupting presses Esc, and the turn ends once the terminal waits again', async t => {
  const { agent, events, terminal, hook } = setup(t, { screen: BUSY, timing: { watch: 100_000 } });
  await hook('SessionStart');
  await assert.rejects(agent.interrupt({ sessionId: ID }), { code: 'not_running' });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'go' });
  terminal.onKey = () => { terminal.screen = IDLE; };
  await agent.interrupt({ sessionId: ID });
  assert.deepEqual(terminal.keys, ['Escape']);
  assert.equal(events.at(-1).kind, 'turn.interrupted');
});

test('a session whose terminal has gone, or shows something else, has ended', async t => {
  const gone = setup(t);
  await gone.hook('SessionStart');
  gone.terminal.isGone = true;
  await gone.until(() => gone.store.get(ID).status === 'ended', 'its end');
  assert.equal(gone.events.at(-1).reason, 'closed');
  const quit = setup(t);
  await quit.hook('SessionStart');
  quit.terminal.screen = 'lorpaves@mac ~ % ';
  await quit.until(() => quit.store.get(ID).status === 'ended', 'its end');
  // A page of Antigravity's own that the helper can't read is still Antigravity, by what the terminal runs.
  const paged = setup(t);
  await paged.hook('SessionStart');
  paged.terminal.running = 'antigravity';
  paged.terminal.screen = 'Resume a conversation\n  1. Read Note\n  2. Another';
  await new Promise(resolve => { setTimeout(resolve, 120); });
  assert.equal(paged.store.get(ID).status, 'idle');
});

test('another conversation in the same terminal takes the first one\'s place, unless it\'s one Antigravity started to help with a turn', async t => {
  const OTHER = 'eef93a97-d082-444f-a4fb-05574f6b3135';
  const another = (event, fields = {}) => ({ conversationId: OTHER, cwd: '/w', hookEventName: event, ...fields });
  const where = { pane: '%9', socket: '/tmp/sock' };
  const helped = setup(t, { timing: { watch: 100_000 } });
  await helped.hook('SessionStart');
  await helped.hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'do a lot' });
  const before = helped.events.length;
  // During the turn: it's part of that turn, and nothing is told of it as a session.
  for (const event of ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop']) await helped.agent.handleHook(another(event, { invocationNum: 0, lastUserInput: 'a part of it' }), where);
  assert.deepEqual([helped.store.find(OTHER), helped.events.length, helped.store.get(ID).status, await helped.agent.owns(OTHER)], [undefined, before, 'running', false]);
  // And it stays so once the turn has ended.
  await helped.hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await helped.agent.handleHook(another('Stop'), where);
  assert.equal(helped.store.find(OTHER), undefined);

  const { agent, store, hook } = setup(t);
  await hook('SessionStart');
  await agent.handleHook(another('SessionStart'), where);
  assert.deepEqual([store.get(ID).status, store.get(OTHER).status], ['ended', 'idle']);
});

test('a turn that goes on by itself says nothing new was said, and only a transcript of Antigravity\'s own is read', async t => {
  const { store, events, write, hook, data } = setup(t, { timing: { watch: 100_000 } });
  write([user(0, 'build it'), reply(1, { content: 'Started.' })]);
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'build it' });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: false });
  // What it left running ended, and it carries on: the step before isn't someone's.
  write([user(0, 'build it'), reply(1, { content: 'Started.' }), result(2, 'The build finished.')]);
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 3, lastUserInput: 'build it' });
  assert.deepEqual([events.filter(event => event.kind === 'message.user').length, store.get(ID).status], [1, 'running']);
  write([user(0, 'build it'), reply(1, { content: 'Started.' }), result(2, 'The build finished.'), reply(3, { content: 'Built.' })]);
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL', fullyIdle: true });
  assert.deepEqual(events.slice(-1)[0].lastMessage, 'Built.');

  const mine = store.get(ID).transcriptPath;
  await hook('PostInvocation', { transcriptPath: '/etc/passwd' });
  // Beside the command line's folder is where the desktop app keeps its own, and no further out.
  await hook('PostInvocation', { transcriptPath: path.join(data, '..', '..', 'elsewhere.jsonl') });
  await hook('PostInvocation', { transcriptPath: path.join(data, 'notes.txt') });
  assert.equal(store.get(ID).transcriptPath, mine);
});

test('a transcript is read as it grows, and from its start again when it\'s no longer what was read', async t => {
  const { agent, events, file, write, hook } = setup(t, { timing: { watch: 100_000 } });
  write([user(0, 'one')]);
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'one' });
  // A line half written is left until the rest of it is there.
  const whole = `${JSON.stringify(reply(1, { content: 'first' }))}\n`;
  fs.appendFileSync(file, whole.slice(0, 20));
  await hook('PostInvocation');
  assert.equal(events.filter(event => event.kind === 'message.assistant.delta').length, 0);
  fs.appendFileSync(file, whole.slice(20));
  await hook('PostInvocation');
  assert.deepEqual(events.filter(event => event.kind === 'message.assistant.delta' && !event.final).map(event => event.text), ['first']);
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  // Rewound at the Mac to before that reply, and gone on from there.
  write([user(0, 'one'), reply(1, { content: 'another way, and a longer one than before' }), user(2, 'two'), reply(3, { content: 'second' })]);
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 3, lastUserInput: 'two' });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  assert.equal(events.at(-1).lastMessage, 'second');
  assert.deepEqual((await agent.history({ sessionId: ID })).items.filter(item => item.role === 'assistant').map(item => item.text), ['another way, and a longer one than before', 'second']);
});

test('a new session is an empty conversation of Antigravity\'s, opened in a terminal of its own', async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-agy-ws-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const untrusted = setup(t);
  await assert.rejects(untrusted.agent.start({ cwd: folder }), { code: 'needs_trust' });
  assert.deepEqual([untrusted.minted, untrusted.terminal.started], [[], []]);

  const { agent, store, events, terminal, minted, data } = setup(t, { trusted: [folder], screen: idleIn('auto') });
  assert.equal(isTrusted(folder, data), true);
  assert.deepEqual(await agent.start({ cwd: folder }), { sessionId: ID });
  assert.deepEqual(minted, [folder]);
  assert.deepEqual(terminal.started, [{ name: 'venes-agy-9a2b37ed', cwd: folder, command: ['agy', '--conversation', ID], env: { PATH: '/bin', VENES_HOME: '/h' } }]);
  const known = store.get(ID);
  assert.deepEqual([known.agent, known.cwd, known.pane, known.tmuxSocket, known.status, known.permissionMode], [AGENT, folder, '%9', '/tmp/sock', 'idle', 'auto']);
  // What it runs on is read off its bar, with nothing said in it yet, and named as the models on offer are.
  assert.deepEqual([known.model, known.effort], ['gemini-4-hydrogen', 'xhigh']);
  assert.deepEqual(events.map(event => event.kind), ['session.discovered', 'session.started', 'session.mode', 'session.model', 'session.effort']);
  // Its first hook tells nothing of its start again.
  await agent.handleHook({ conversationId: ID, cwd: folder, hookEventName: 'SessionStart', modelName: 'gemini-4-hydrogen-xhigh' }, { pane: '%9', socket: '/tmp/sock' });
  assert.equal(events.filter(event => event.kind === 'session.started').length, 1);
});

test('the reader\'s word answers Antigravity\'s question about a folder, and without it nothing is left running', async t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-agy-ws-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const { agent, terminal } = setup(t, { screen: TRUST });
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = IDLE; };
  assert.deepEqual(await agent.start({ cwd: folder, trust: true }), { sessionId: ID });
  assert.deepEqual(terminal.keys, ['Enter']);
  // Its settings said it was trusted, and it asks all the same.
  const asked = setup(t, { screen: TRUST, trusted: [folder] });
  await assert.rejects(asked.agent.start({ cwd: folder }), { code: 'needs_trust' });
  assert.deepEqual(asked.terminal.keys, ['Escape']);
  const quit = setup(t, { screen: '' });
  quit.terminal.isOpen = false;
  await assert.rejects(quit.agent.start({ cwd: folder, trust: true }), { code: 'start_failed' });
});

test('a stored conversation is read from its transcript, and opened in a terminal once something is sent to it', async t => {
  const rows = [
    { conversation_id: ID, title: 'Read Note', last_modified_time: '2026-11-15 10:39:39+00:00', workspace_uris: `["file://${os.tmpdir()}"]`, step_count: 4 },
    { conversation_id: 'd652c9b5-ac30-4e25-9b39-222bbd73eaf3', title: '', last_modified_time: '2026-11-15 11:00:00+00:00', workspace_uris: '[]', step_count: 0 },
  ];
  const { agent, store, terminal, write, data, stored } = setup(t, { rows });
  stored();
  write([user(0, 'read the note'), reply(1, { content: 'HERON' })]);
  // One with nothing said in it isn't listed.
  assert.deepEqual((await agent.library()).map(item => [item.id, item.title, item.cwd, item.status]), [[ID, 'Read Note', os.tmpdir(), null]]);
  assert.equal(await agent.folderOf(ID), os.tmpdir());
  fs.writeFileSync(path.join(data, 'conversations', 'e0000000-0000-4000-8000-000000000001.db'), '');
  assert.deepEqual([await agent.owns('e0000000-0000-4000-8000-000000000001'), await agent.owns('f0000000-0000-4000-8000-000000000002'), await agent.owns(undefined)], [true, false, false]);
  const joined = await agent.join({ sessionId: ID });
  assert.deepEqual([joined.items.map(item => item.role), joined.sessions[0].status, joined.sessions[0].cwd], [['user', 'assistant', 'turn_end'], 'ended', os.tmpdir()]);
  assert.deepEqual(terminal.started, []);

  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ trustedWorkspaces: [fs.realpathSync(os.tmpdir())] }));
  assert.deepEqual(await agent.send({ sessionId: ID, text: 'again', clientId: 'c1' }), { queued: false });
  assert.deepEqual([terminal.started[0].command, terminal.started[0].cwd, terminal.pasted, terminal.keys], [['agy', '--conversation', ID], os.tmpdir(), ['again'], ['Enter']]);
  assert.equal(store.get(ID).pane, '%9');
  await assert.rejects(agent.send({ sessionId: 'f0000000-0000-4000-8000-000000000002', text: 'x' }), { code: 'unknown_session' });
});

test('a stored conversation is deleted as Antigravity deletes one: its files to the Trash, and out of Antigravity\'s lists', async t => {
  const rows = [{ conversation_id: ID, title: 'Read Note', last_modified_time: '2026-11-15 10:39:39+00:00', workspace_uris: `["file://${os.tmpdir()}"]`, step_count: 4 }];
  const { agent, events, terminal, data, stored, write, trashed, forgotten, killed } = setup(t, { rows });
  stored();
  write([user(0, 'read the note'), reply(1, { content: 'HERON' })]);
  fs.writeFileSync(path.join(data, 'conversations', `${ID}.db-wal`), '');
  assert.equal((await agent.library()).length, 1);
  assert.deepEqual(await agent.remove({ sessionId: ID }), {});
  assert.deepEqual(trashed, [['Antigravity session 9a2b37ed', [ID, `${ID}.db`, `${ID}.db-wal`, `${ID}.pbtxt`]]]);
  assert.deepEqual([forgotten, killed, terminal.keys], [[ID], [], []]);
  assert.deepEqual(conversationFiles(data, ID).filter(file => fs.existsSync(file)), [], 'nothing of it is left where Antigravity keeps it');
  assert.equal(events.at(-1).kind, 'session.deleted');
  // Antigravity's summary can still have its row, and it's listed no more.
  assert.deepEqual([await agent.library(), await agent.owns(ID)], [[], false]);
  await assert.rejects(agent.remove({ sessionId: ID }), { code: 'unknown_session' });
  await assert.rejects(agent.remove({ sessionId: '../../etc' }), { code: 'unknown_session' });
  await assert.rejects(agent.remove({}), { code: 'unknown_session' });
});

test('a session open in a terminal is told to go before it\'s deleted, and one that won\'t go isn\'t', async t => {
  const { agent, store, events, terminal, data, stored, hook, trashed, killed } = setup(t, { timing: { watch: 100_000 } });
  stored();
  await hook('SessionStart');
  terminal.running = 'antigravity';
  // It doesn't stop: nothing of it is touched.
  await assert.rejects(agent.remove({ sessionId: ID }), { code: 'session_running' });
  assert.deepEqual([killed, trashed, fs.existsSync(path.join(data, 'conversations', `${ID}.db`)), store.get(ID).status], [[4242], [], true, 'idle']);
  // It goes when it's told to.
  terminal.onKill = () => { terminal.running = 'zsh'; };
  await agent.remove({ sessionId: ID });
  assert.deepEqual([killed, trashed.length, store.find(ID)], [[4242, 4242], 1, undefined]);
  assert.deepEqual(events.slice(-2).map(event => [event.kind, event.reason]), [['session.ended', 'deleted'], ['session.deleted', undefined]]);

  // One the helper doesn't follow, whose terminal it opened before, is found by its name and told to go too.
  const before = setup(t);
  before.stored();
  before.terminal.findSession = async name => (name === 'venes-agy-9a2b37ed' ? { pane: 'block:7', rexSession: 'session:1' } : undefined);
  before.terminal.running = 'antigravity';
  before.terminal.onKill = () => { before.terminal.running = 'zsh'; };
  await before.agent.remove({ sessionId: ID });
  assert.deepEqual([before.killed, before.trashed.length], [[4242], 1]);
});

test('with no way to the Trash from here a conversation is deleted for good, and a list that keeps its row stops nothing', async t => {
  const none = Object.assign(new Error('needs macOS 15'), { code: 'no_trash' });
  const data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-agy-')));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  const store = new SessionStore();
  const agent = new Antigravity({
    store, data, installed: () => true, trash: async () => { throw none; }, forget: async () => { throw new Error('database is locked'); }, timing: { watch: 100_000 },
  });
  t.after(() => agent.stop());
  fs.mkdirSync(path.join(data, 'conversations'));
  fs.writeFileSync(path.join(data, 'conversations', `${ID}.db`), '');
  await agent.remove({ sessionId: ID });
  assert.equal(fs.existsSync(path.join(data, 'conversations', `${ID}.db`)), false);
  // Any other failure to move it leaves it where it was.
  fs.writeFileSync(path.join(data, 'conversations', `${ID}.db`), '');
  const failing = new Antigravity({ store, data, installed: () => true, trash: async () => { throw new Error('disk full'); }, forget: async () => {}, timing: { watch: 100_000 } });
  t.after(() => failing.stop());
  await assert.rejects(failing.remove({ sessionId: ID }), /disk full/);
});

test('a conversation whose terminal is still open with Antigravity in it is gone back to, and no second one opened', async t => {
  const rows = [{ conversation_id: ID, title: 'Read Note', last_modified_time: '2026-11-15 10:39:39+00:00', workspace_uris: `["file://${os.tmpdir()}"]`, step_count: 4 }];
  // As after the helper has started again: it knows nothing of the session, and its terminal is where it was.
  const { agent, store, events, terminal } = setup(t, { rows, trusted: [fs.realpathSync(os.tmpdir())] });
  const looked = [];
  terminal.findSession = async (name, env) => { looked.push([name, env]); return { pane: 'block:7', rexSession: 'session:1' }; };
  terminal.running = 'antigravity';
  assert.deepEqual(await agent.send({ sessionId: ID, text: 'carry on', clientId: 'c1' }), { queued: false });
  assert.deepEqual([looked, terminal.started, terminal.pasted], [[['venes-agy-9a2b37ed', { PATH: '/bin', VENES_HOME: '/h' }]], [], ['carry on']]);
  assert.deepEqual([store.get(ID).pane, store.get(ID).rexSession, events.find(event => event.kind === 'session.started').source], ['block:7', 'session:1', 'resume']);

  // One that's there with something else in it, as its shell is once Antigravity has quit, isn't.
  const quit = setup(t, { rows, trusted: [fs.realpathSync(os.tmpdir())] });
  quit.terminal.findSession = async () => ({ pane: 'block:7', rexSession: 'session:1' });
  await quit.agent.send({ sessionId: ID, text: 'carry on' });
  assert.equal(quit.terminal.started.length, 1);
  assert.deepEqual([await runsIn({ foreground: async () => 'antigravity' }, {}), await runsIn({ foreground: async () => 'agy' }, {}), await runsIn({ foreground: async () => 'zsh' }, {}),
    await runsIn({ foreground: async () => { throw new Error('gone'); } }, {})], [true, true, false, false]);
});

test('its mode is changed with Shift+Tab, and what it runs on with its own commands', async t => {
  const { agent, store, events, terminal, hook } = setup(t, { screen: idleIn('auto'), timing: { watch: 100_000 } });
  await hook('SessionStart');
  const round = [idleIn('plan'), IDLE, idleIn('accept-edits'), idleIn('auto')];
  terminal.onKey = key => { if (key === 'BTab') terminal.screen = round[(terminal.keys.length - 1) % round.length]; };
  await agent.setMode({ sessionId: ID, mode: 'acceptEdits' });
  assert.deepEqual([terminal.keys, store.get(ID).permissionMode], [['BTab', 'BTab', 'BTab'], 'acceptEdits']);
  assert.deepEqual(events.at(-1).permissionModes, MODE_IDS);
  await assert.rejects(agent.setMode({ sessionId: ID, mode: 'bypassPermissions' }), { code: 'bad_mode' });

  terminal.keys.length = 0;
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = `> /model\n  ⎿  Model set to Gemini 4 Hydrogen (High)\n${IDLE}`; };
  await agent.configure({ sessionId: ID, model: 'gemini-4-hydrogen', effort: 'high' });
  assert.deepEqual([terminal.pasted, terminal.keys, store.get(ID).effort], [['/model gemini-4-hydrogen-high'], ['Enter'], 'high']);
  // A model that can't think the way the session does is given the nearest way it can.
  await agent.configure({ sessionId: ID, model: 'gemini-3.8-flash' });
  assert.deepEqual([terminal.pasted.at(-1), store.get(ID).model, store.get(ID).effort], ['/model gemini-3.8-flash-low', 'gemini-3.8-flash', 'low']);
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = `> /effort\n  ⎿  Effort set to xhigh\n${IDLE}`; };
  await agent.configure({ sessionId: ID, effort: 'xhigh' });
  assert.deepEqual([terminal.pasted.at(-1), store.get(ID).effort], ['/effort xhigh', 'xhigh']);
  await assert.rejects(agent.configure({ sessionId: ID, model: 'gpt-none' }), { code: 'bad_model' });
  await assert.rejects(agent.configure({ sessionId: ID, model: 'gemini-3.8-flash', effort: 'max' }), { code: 'bad_effort' });
  await assert.rejects(agent.configure({ sessionId: ID }), { code: 'bad_model' });
  // Neither is changed during a turn, when its bar says nothing of them and a command would wait.
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'go' });
  await assert.rejects(agent.configure({ sessionId: ID, effort: 'high' }), { code: 'session_busy' });
  await assert.rejects(agent.setMode({ sessionId: ID, mode: 'plan' }), { code: 'session_busy' });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  const can = await agent.capabilities({ sessionId: ID });
  assert.deepEqual([can.commands, can.skills, can.models.map(model => model.value)], [[], [], ['gemini-4-hydrogen', 'gemini-3.8-flash']]);
  assert.deepEqual((await agent.status({ sessionId: ID })).status.project, 'w');
});

test('a status has what the session runs on and the account\'s limits, asked for once in a while', async t => {
  let asked = 0;
  let answer = async () => USAGE;
  const { agent, hook } = setup(t, { timing: { watch: 100_000 }, usage: () => { asked += 1; return answer(); } });
  assert.deepEqual(await agent.status({ sessionId: ID }), { status: null });
  assert.equal(asked, 0, 'nothing asked for a session that isn\'t followed');
  await hook('SessionStart');
  const { status } = await agent.status({ sessionId: ID });
  assert.deepEqual([status.model, status.effort, status.project, status.limits], ['gemini-4-hydrogen', 'xhigh', 'w', LIMITS]);
  await agent.status({ sessionId: ID });
  assert.equal(asked, 1, 'and kept for the next');

  // Slow to say, a status goes without them, and they come with a later one.
  let release;
  const slow = setup(t, { timing: { watch: 100_000, usageWait: 20 }, usage: () => new Promise(resolve => { release = () => resolve(USAGE); }) });
  await slow.hook('SessionStart');
  assert.equal('limits' in (await slow.agent.status({ sessionId: ID })).status, false);
  release();
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.deepEqual((await slow.agent.status({ sessionId: ID })).status.limits, LIMITS);

  // And when it won't say at all, there are none.
  answer = async () => { throw new Error('agy: not signed in'); };
  const none = setup(t, { timing: { watch: 100_000 }, usage: () => answer() });
  await none.hook('SessionStart');
  assert.equal('limits' in (await none.agent.status({ sessionId: ID })).status, false);
});

test('a model picked for a session with nothing said in it keeps how hard its bar says it thinks', async t => {
  // The models aren't known when it's first heard of, so only its bar says how it thinks.
  const { agent, store, terminal, hook } = setup(t, { screen: idleIn('auto'), timing: { watch: 100_000 } });
  await hook('SessionStart', { modelName: undefined });
  assert.deepEqual([store.get(ID).model, store.get(ID).effort], [undefined, undefined]);
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = `> /model\n  ⎿  Model set to Gemini 4 Hydrogen (XHigh)\n${idleIn('auto')}`; };
  await agent.configure({ sessionId: ID, model: 'gemini-4-hydrogen' });
  assert.deepEqual([terminal.pasted, store.get(ID).model, store.get(ID).effort], [['/model gemini-4-hydrogen-xhigh'], 'gemini-4-hydrogen', 'xhigh']);
});

test('what its bar says it runs on is told when it\'s changed at the Mac, between turns', async t => {
  const { agent, store, events, terminal, hook, until } = setup(t);
  await hook('SessionStart');
  await agent.capabilities({ sessionId: ID });
  terminal.screen = ['> ', RULE, bar('? for shortcuts', 'plan · Gemini 3.8 Flash · low')].join('\n');
  await until(() => store.get(ID).model === 'gemini-3.8-flash', 'the model');
  assert.deepEqual([store.get(ID).effort, store.get(ID).permissionMode], ['low', 'plan']);
  // During a turn a hook's word stands, as for a single message sent to another model.
  terminal.screen = ['⣾  Generating...', RULE, '>', RULE, bar('esc to cancel', 'Gemini 3.8 Flash · low')].join('\n');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'go', modelName: 'gemini-4-hydrogen-high' });
  const told = events.length;
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.deepEqual([store.get(ID).model, store.get(ID).effort, events.slice(told).filter(event => event.kind === 'session.model').length], ['gemini-4-hydrogen', 'high', 0]);
});

test('with no Antigravity on the Mac there\'s nothing to list or start', async t => {
  const store = new SessionStore();
  const agent = new Antigravity({ store, installed: () => false, rows: async () => { throw new Error('not asked'); }, timing: { watch: 100_000 } });
  t.after(() => agent.stop());
  assert.deepEqual([agent.isAvailable(), await agent.library(), (await agent.capabilities()).models], [false, [], []]);
  await assert.rejects(agent.start({ cwd: os.tmpdir() }), { code: 'no_antigravity' });
});
