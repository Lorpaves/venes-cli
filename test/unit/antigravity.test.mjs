import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AGENT, Antigravity, asksReview, conversationFiles, historyOf, isTrusted, levelFor, libraryItem, limitsFrom, MODE_IDS, modelOf, modelsFrom, pageOf, pictureSourcesOf, picturesOf, readPicture, requestOf,
  resultOf, reviewIn, reviewRequest, runsIn, saidOf, saidPictures, stepsIn, toolOf, transcriptOf, typedText,
  commandsFrom,
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
// The plan Antigravity writes in plan mode: a file of its own, written to be looked over first.
const PLAN = {
  name: 'write_file',
  args: { Path: '/data/brain/9a2b/implementation_plan.md', Content: '1. Look\n2. Fix\n', Overwrite: true, ArtifactMetadata: { RequestFeedback: true, UserFacing: true, Summary: 'A plan' } },
};
// What its terminal shows while the plan waits, and the panel it's answered in.
const reviewHint = (count = 1) => ['  I have written the plan for your review.', `${' '.repeat(40)}${count} artifact${count === 1 ? '' : 's'} · /artifact to review`, RULE, '> ', RULE,
  bar('? for shortcuts', 'plan · Gemini 4 Hydrogen · xhigh')].join('\n');
const reviewPanel = (left = 1) => [RULE, '>', RULE, `Action required (${left} left)`, '› □ new implementation_plan.md   open  approve reject',
  'Keyboard: ↑/↓ Navigate  y/n Approve/reject  shift+a Approve all  p Preview  ctrl+g open in editor  esc Done', `${' '.repeat(40)}plan · Gemini 4 Hydrogen · xhigh`].join('\n');
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
const LISTED = [
  { name: 'compact', description: ' Compact the conversation now. ' },
  { name: 'schedule', description: 'Run an instruction on a schedule.', input: { hint: '<when> <what>' } },
  { name: 'two words', description: 'not a command a line can start with' }, { description: 'no name' },
];

function setup(t, { screen = IDLE, trusted = [], rows = [], timing = {}, usage = async () => USAGE, commands = undefined, installed = true } = {}) {
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
  // The folders whose commands were asked for.
  const asked = [];
  // What was moved to the Trash, as the folder's name and what was in it, taken out of Antigravity's lists, and told to go.
  const trashed = [];
  const forgotten = [];
  const killed = [];
  const agent = new Antigravity({ version: async () => '1.5.11',
    store, terminal, data, installed: () => installed, rows: async () => rows,
    mint: async folder => { minted.push(folder); return ID; },
    models: async () => modelsFrom('gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)\ngemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'),
    usage,
    commands: commands ?? (async folder => { asked.push(folder); return commandsFrom(LISTED); }),
    trash: async folder => { trashed.push([path.basename(folder), fs.readdirSync(folder).sort()]); },
    forget: async id => { forgotten.push(id); },
    kill: pid => { killed.push(pid); terminal.onKill?.(pid); },
    env: { PATH: '/bin', VENES_HOME: '/h', SECRET: 'x' },
    timing: { watch: 15, rest: 15, startLimit: 400, startCheck: 5, keySettle: 1, pasteSettle: 1, stepWait: 60, stepCheck: 5, keyLimit: 300, keyCheck: 5, commandLimit: 300, commandSettle: 40, modelsWait: 200, usageWait: 200, quitLimit: 150, quitCheck: 5, ...timing },
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
  return { agent, store, events, terminal, minted, asked, data, file, write, hook, kinds, until, trashed, forgotten, killed, stored };
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

test('what\'s left in the terminal\'s box is taken out before a message is typed, so the message is all that\'s sent', async t => {
  const { agent, terminal, hook } = setup(t, { timing: { boxSettle: 1 } });
  await hook('SessionStart');
  // A draft left at the Mac: the bar says nothing of shortcuts while something's typed.
  terminal.screen = ['  ok', RULE, '> left at the mac', '  on two lines', RULE, bar('')].join('\n');
  terminal.onKey = key => { if (key === 'C-u' && terminal.keys.filter(pressed => pressed === 'C-u').length === 6) terminal.screen = IDLE; };
  const order = [];
  const { paste, pressKey } = terminal;
  terminal.paste = async (target, text) => { order.push('paste'); return paste(target, text); };
  terminal.pressKey = async (target, key) => { order.push(key); return pressKey(target, key); };
  await agent.send({ sessionId: ID, text: 'from the app', clientId: 'c1' });
  assert.deepEqual([terminal.pasted, order.join(' ')], [['from the app'], `${'C-k '.repeat(6)}${'C-u '.repeat(6)}paste Enter`]);
  // An empty box is typed into as it is.
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'from the app' });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  order.length = 0;
  terminal.onKey = undefined;
  await agent.send({ sessionId: ID, text: 'again', clientId: 'c2' });
  assert.equal(order.join(' '), 'paste Enter');
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

test('what\'s said in plan mode is told without the command Antigravity puts before it', async t => {
  assert.deepEqual([saidOf('/plan write a plan'), saidOf('/plan\twrite'), saidOf('/planning ahead'), saidOf('/plan'), saidOf('a /plan b'), saidOf(undefined)],
    ['write a plan', 'write', '/planning ahead', '/plan', 'a /plan b', '']);
  assert.deepEqual([requestOf(user(0, '/plan write a plan').content), requestOf(user(0, '[Approved] implementation_plan.md\n').content)], ['write a plan', '[Approved] implementation_plan.md']);
  assert.equal(historyOf([user(0, '/plan write a plan'), reply(1, { content: 'Here.' })])[0].text, 'write a plan');

  // A message typed from a client in plan mode is the client's own, though Antigravity kept it otherwise.
  const { agent, events, hook } = setup(t);
  await hook('SessionStart');
  await agent.send({ sessionId: ID, text: 'write a plan', clientId: 'c1' });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: '/plan write a plan' });
  assert.deepEqual(events.filter(event => event.kind === 'message.user').map(event => [event.text, event.clientId]), [['write a plan', 'c1']]);
  // One typed at the Mac is told as it was said, and the command itself typed from a client is its own too.
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 3, lastUserInput: '/plan again' });
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await agent.send({ sessionId: ID, text: '/plan once more', clientId: 'c2' });
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: '/plan once more' });
  assert.deepEqual(events.filter(event => event.kind === 'message.user').slice(1).map(event => [event.text, event.clientId]), [['again', undefined], ['/plan once more', 'c2']]);
});

test('a document written to be looked over is a proposed plan, and the one that waits is the last with nothing said since', () => {
  assert.deepEqual([asksReview(PLAN), asksReview({ name: 'write_file', args: { Path: '/w/a.txt', Content: 'a' } }), asksReview({ ...PLAN, name: 'edit_file' }),
    asksReview({ name: 'write_file', args: { ...PLAN.args, ArtifactMetadata: { RequestFeedback: false, UserFacing: true } } }), asksReview()], [true, false, false, false, false]);
  assert.deepEqual(toolOf(PLAN), { name: 'ExitPlanMode', input: { plan: '1. Look\n2. Fix\n' } });
  assert.deepEqual(toolOf({ name: 'write_file', args: { Path: '/w/a.txt', Content: 'a' } }), { name: 'Write', input: { file_path: '/w/a.txt', content: 'a' } });
  const steps = [user(0, '/plan it'), reply(1, { calls: [PLAN] }), result(2, 'Created file'), reply(3, { content: 'For your review.' })];
  assert.deepEqual(reviewIn(steps), { call: PLAN, index: 2 });
  // The later of two, and none once it's been answered, or with nothing written to look over.
  const again = { ...PLAN, args: { ...PLAN.args, Content: 'Shorter' } };
  assert.equal(reviewIn([...steps, user(4, '/plan shorter'), reply(5, { calls: [READ, again] }), result(6, 'x'), result(7, 'Created file')]).index, 7);
  assert.deepEqual([reviewIn([...steps, user(4, '[Approved] implementation_plan.md')]), reviewIn([user(0, 'hi'), reply(1, { calls: [READ] })]), reviewIn([])], [undefined, undefined, undefined]);
  // In history it's the same call.
  const [, call] = historyOf(steps);
  assert.deepEqual([call.role, call.name, call.toolUseId, call.input], ['tool', 'ExitPlanMode', 'step-2', { plan: '1. Look\n2. Fix\n' }]);

  const { fields, decide } = reviewRequest(PLAN, 2);
  assert.deepEqual(fields, { kind: 'plan', agent: AGENT, toolName: 'ExitPlanMode', toolUseId: 'step-2', input: { plan: '1. Look\n2. Fix\n' }, options: [{ id: 'approve', label: 'Approve' }] });
  assert.deepEqual([decide({ decision: 'allow' }), decide({ decision: 'allow', option: 'approve' }), decide({ decision: 'deny' }), decide({ decision: 'deny', message: '  ' }), decide({ decision: 'deny', message: ' Less. ' })],
    [{ key: 'y' }, { key: 'y' }, { key: 'n' }, { key: 'n' }, { followUp: 'Less.' }]);
  assert.throws(() => decide({ decision: 'allow', option: '2' }), { code: 'bad_option' });
  assert.throws(() => decide({ decision: 'maybe' }), { code: 'bad_decision' });
});

// A session whose turn wrote a plan to be looked over, with the terminal saying it waits.
async function planned(t, options) {
  const made = setup(t, options);
  const { terminal, write, hook, store, until } = made;
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: '/plan it' });
  write([user(0, '/plan it'), reply(1, { calls: [PLAN] }), result(2, 'Created file'), reply(3, { content: 'For your review.' })]);
  await hook('PostToolUse', { stepIdx: 2, toolCall: PLAN });
  terminal.screen = reviewHint();
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await until(() => store.requests().length === 1, 'the plan\'s request');
  return made;
}

test('a plan that waits to be looked over is asked about, and a yes is its key in Antigravity\'s own panel', async t => {
  const { agent, store, events, terminal, hook, until, kinds } = await planned(t);
  const [request] = store.requests();
  assert.deepEqual([request.kind, request.agent, request.toolName, request.toolUseId, request.input, request.options],
    ['plan', AGENT, 'ExitPlanMode', 'step-2', { plan: '1. Look\n2. Fix\n' }, [{ id: 'approve', label: 'Approve' }]]);
  // The plan was told as a proposed plan, and it's asked about once the turn is over, and once.
  const started = events.find(event => event.kind === 'tool.start');
  assert.deepEqual([started.name, started.toolUseId, started.input], ['ExitPlanMode', 'step-2', { plan: '1. Look\n2. Fix\n' }]);
  assert.ok(kinds().indexOf('turn.end') < kinds().indexOf('request.opened'));
  assert.equal(store.get(ID).status, 'waiting');
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.deepEqual([store.requests().length, store.get(ID).status, kinds().filter(kind => kind === 'request.opened').length], [1, 'waiting', 1]);
  // A client that joins has it, and the turn as history.
  const joined = await agent.join({ sessionId: ID });
  assert.deepEqual([joined.requests.map(open => open.kind), joined.turn, joined.items.map(item => item.role)], [['plan'], [], ['user', 'tool', 'assistant', 'turn_end']]);
  // The mode can be switched past it, as at the Mac.
  assert.deepEqual(await agent.setMode({ sessionId: ID, mode: 'plan' }), {});

  // Yes: the panel is opened with its command, and its key pressed until the panel has gone.
  terminal.keys.length = 0;
  terminal.onKey = key => {
    if (key === 'Enter') terminal.screen = reviewPanel(2);
    else if (key === 'y') terminal.screen = terminal.keys.filter(pressed => pressed === 'y').length < 2 ? reviewPanel(1) : BUSY;
  };
  store.respond(request.id, { decision: 'allow', option: 'approve' });
  await until(() => terminal.keys.filter(key => key === 'y').length === 2, 'both keys');
  assert.deepEqual([terminal.pasted, terminal.keys], [['/artifact'], ['Enter', 'y', 'y']]);
  assert.deepEqual([events.findLast(event => event.kind === 'request.closed').decision, events.findLast(event => event.kind === 'request.closed').by, store.get(ID).status], ['allow', 'client', 'running']);
  // Antigravity says so itself, as the next thing said, and nothing's asked again.
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: '[Approved] implementation_plan.md' });
  assert.deepEqual([events.findLast(event => event.kind === 'message.user').text, store.requests().length], ['[Approved] implementation_plan.md', 0]);
});

test('a plan sent back with what to change is typed as a message, and a bare no is the panel\'s own', async t => {
  const first = await planned(t);
  const [request] = first.store.requests();
  first.terminal.keys.length = 0;
  first.terminal.screen = reviewHint();
  first.store.respond(request.id, { decision: 'deny', message: ' Make it shorter. ' });
  await first.until(() => first.terminal.keys.length === 1, 'the message sent');
  assert.deepEqual([first.terminal.pasted, first.terminal.keys, first.store.get(ID).status], [['Make it shorter.'], ['Enter'], 'running']);

  const second = await planned(t);
  second.terminal.keys.length = 0;
  second.terminal.onKey = key => { second.terminal.screen = key === 'Enter' ? reviewPanel(1) : BUSY; };
  second.store.respond(second.store.requests()[0].id, { decision: 'deny' });
  await second.until(() => second.terminal.keys.length === 2, 'the panel\'s no');
  assert.deepEqual([second.terminal.pasted, second.terminal.keys], [['/artifact'], ['Enter', 'n']]);

  // A panel that doesn't open leaves nothing answered, puts away what did, and the plan is asked about again.
  const third = await planned(t);
  third.terminal.keys.length = 0;
  third.store.respond(third.store.requests()[0].id, { decision: 'allow' });
  await third.until(() => third.terminal.keys.includes('Escape'), 'what opened put away');
  assert.deepEqual(third.terminal.keys, ['Enter', 'Escape']);
  await third.until(() => third.store.requests().length === 1, 'asked again');
  assert.equal(third.store.get(ID).status, 'waiting');
});

test('a plan answered at the Mac, or put away there, stops being asked about', async t => {
  const { store, events, terminal, hook, write } = await planned(t);
  // Something said in the terminal starts a turn, which is the answer.
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: '[Rejected] implementation_plan.md' });
  assert.deepEqual([store.requests().length, events.findLast(event => event.kind === 'request.closed').by, store.get(ID).status], [0, 'terminal', 'running']);
  // Answered, it isn't asked about again, whatever the screen still says.
  write([user(0, '/plan it'), reply(1, { calls: [PLAN] }), result(2, 'Created file'), reply(3, { content: 'For your review.' }),
    user(4, '[Rejected] implementation_plan.md'), reply(5, { content: 'What should change?' })]);
  terminal.screen = reviewHint();
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.equal(store.requests().length, 0, 'nothing waits once it\'s been answered');

  // The line gone from the screen with no turn, it's no longer waited on.
  const other = await planned(t);
  other.terminal.screen = idleIn('plan');
  await other.until(() => other.store.requests().length === 0, 'its end');
  assert.deepEqual([other.events.findLast(event => event.kind === 'request.closed').by, other.store.get(ID).status], ['terminal', 'idle']);
  // With no line there's nothing to ask, whatever the conversation has.
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.equal(other.store.requests().length, 0);
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
  const agent = new Antigravity({ version: async () => '1.5.11',
    store, data, installed: () => true, trash: async () => { throw none; }, forget: async () => { throw new Error('database is locked'); }, timing: { watch: 100_000 },
  });
  t.after(() => agent.stop());
  fs.mkdirSync(path.join(data, 'conversations'));
  fs.writeFileSync(path.join(data, 'conversations', `${ID}.db`), '');
  await agent.remove({ sessionId: ID });
  assert.equal(fs.existsSync(path.join(data, 'conversations', `${ID}.db`)), false);
  // Any other failure to move it leaves it where it was.
  fs.writeFileSync(path.join(data, 'conversations', `${ID}.db`), '');
  const failing = new Antigravity({ version: async () => '1.5.11', store, data, installed: () => true, trash: async () => { throw new Error('disk full'); }, forget: async () => {}, timing: { watch: 100_000 } });
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
  assert.deepEqual([can.skills, can.models.map(model => model.value)], [[], ['gemini-4-hydrogen', 'gemini-3.8-flash']]);
  // Its commands are what Antigravity lists for the session's folder, each with what it does and what it takes.
  assert.deepEqual(can.commands, [
    { name: 'compact', description: 'Compact the conversation now.', argumentHint: '' },
    { name: 'schedule', description: 'Run an instruction on a schedule.', argumentHint: '<when> <what>' },
  ]);
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

test('the account\'s limits are told for a list of what\'s used, with no session to ask for', async t => {
  let asked = 0;
  const { agent } = setup(t, { timing: { watch: 100_000 }, usage: async () => { asked += 1; return USAGE; } });
  const said = await agent.limits();
  assert.deepEqual([said.limits, said.reading], [LIMITS, false]);
  assert.ok(Math.abs(said.updatedAt - Date.now() / 1000) < 5);
  await agent.limits();
  assert.equal(asked, 1, 'and kept for the next');

  // Slow to say, the first answer has none yet and says they're being read.
  let release;
  const slow = setup(t, { timing: { watch: 100_000, usageWait: 20 }, usage: () => new Promise(resolve => { release = () => resolve(USAGE); }) });
  assert.deepEqual(await slow.agent.limits(), { limits: [], reading: true });
  release();
  await new Promise(resolve => { setTimeout(resolve, 10); });
  assert.deepEqual((await slow.agent.limits()).limits, LIMITS);

  // Where Antigravity isn't installed there's nothing to tell, and nothing is run to ask.
  const absent = setup(t, { installed: false, usage: async () => { asked += 100; return USAGE; } });
  assert.equal(await absent.agent.limits(), undefined);
  assert.equal(asked, 1);
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

// A picture of one pixel, and something that's only named like one.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// How big a picture is said to be: from the length of what's sent of it, as for any session's.
const PNG_BYTES = Math.floor(PNG.toString('base64').length * 3 / 4);

// A conversation with a picture a call looked at, kept among its own files as Antigravity keeps one, and a message that came with one.
function pictured(t) {
  const made = setup(t, { timing: { watch: 100_000 } });
  const media = path.join(path.dirname(made.file), 'media', 'step_2_media_0.png');
  fs.mkdirSync(path.dirname(media), { recursive: true });
  fs.writeFileSync(media, PNG);
  const sent = path.join(made.data, 'sent.png');
  fs.writeFileSync(sent, PNG);
  const looked = { ...result(2, 'Showing binary file of type image/png'), media: [{ mime_type: 'image/png', uri: `file://${media}` }] };
  const steps = [user(0, 'look at pic.png'), reply(1, { calls: [READ] }), looked, reply(3, { content: 'Blue' }), user(4, `${sent}\nand this one?`), reply(5, { content: 'Blue too' })];
  // What Antigravity keeps is under the folder its own folder is in, which here is where the test's folder is.
  return { ...made, media, sent, steps, root: path.dirname(made.data) };
}

test('a call\'s pictures are the ones its step names among Antigravity\'s own files, and a message\'s the files its first lines name', t => {
  const { media, sent, steps, root, data } = pictured(t);
  assert.deepEqual(pictureSourcesOf(steps[2], root), [{ path: media, mediaType: 'image/png' }]);
  assert.deepEqual(picturesOf(steps[2], root), [{ id: 'step-2:0', mediaType: 'image/png', bytes: PNG_BYTES, width: 1, height: 1 }]);
  assert.deepEqual(picturesOf(steps[4], root), [{ id: 'said-4:0', mediaType: 'image/png', bytes: PNG_BYTES, width: 1, height: 1 }]);
  assert.deepEqual(saidPictures(`${sent}\nand this one?`), { paths: [sent], rest: 'and this one?' });
  // Only the first lines, only files that are there, and only pictures by their names.
  const text = path.join(data, 'notes.txt');
  fs.writeFileSync(text, 'words');
  assert.deepEqual(saidPictures(`see ${sent}`).paths, []);
  assert.deepEqual(saidPictures(`first\n${sent}`).paths, []);
  assert.deepEqual(saidPictures(`${text}\n${sent}`).paths, []);
  assert.deepEqual(saidPictures(`${path.join(data, 'gone.png')}\nwhere?`).paths, []);
  assert.deepEqual(saidPictures(`${sent}\n${sent}`), { paths: [sent, sent], rest: '' });
  // A file named like a picture that isn't one isn't read as a message's.
  const fake = path.join(data, 'fake.png');
  fs.writeFileSync(fake, 'not a picture at all');
  assert.equal(readPicture({ path: fake, isSaid: true }), undefined);
  assert.deepEqual(picturesOf(user(6, `${fake}\nlook`), root), []);
  // What a step names outside Antigravity's own folders, or that isn't a picture or a file, is nothing.
  const named = uri => pictureSourcesOf({ step_index: 9, type: 'GENERIC', media: [{ mime_type: 'image/png', uri }] }, root);
  assert.deepEqual([named('file:///etc/passwd'), named(`file://${root}/../elsewhere.png`), named('https://example.com/a.png'), named(undefined)], [[], [], [], []]);
  assert.deepEqual(pictureSourcesOf({ step_index: 9, type: 'GENERIC', media: [{ mime_type: 'application/pdf', uri: `file://${media}` }] }, root), []);
  assert.deepEqual([pictureSourcesOf({ step_index: 9, type: 'GENERIC' }, root), pictureSourcesOf(steps[2], undefined)], [[], []]);
  // One too big, or gone since, isn't read.
  assert.equal(readPicture({ path: media }, { limit: 10 }), undefined);
  assert.equal(readPicture({ path: path.join(data, 'gone.png') }), undefined);
});

test('history has a message\'s and a call\'s pictures, and a picture is given by its id', async t => {
  const { agent, write, steps, root, sent } = pictured(t);
  write(steps);
  const items = historyOf(steps, { root });
  assert.deepEqual(items.map(item => [item.role, item.text ?? item.name, item.images?.map(image => image.id)]), [
    ['user', 'look at pic.png', undefined], ['tool', 'Read', ['step-2:0']], ['assistant', 'Blue', undefined], ['turn_end', undefined, undefined],
    // Its words are without the line that named its picture.
    ['user', 'and this one?', ['said-4:0']], ['assistant', 'Blue too', undefined], ['turn_end', undefined, undefined],
  ]);
  // With nowhere said to read them from, there are none, and a message's words are as it was typed.
  assert.deepEqual(historyOf(steps).map(item => [item.text, 'images' in item]).filter(([text]) => text?.includes('this one')), [[`${sent}\nand this one?`, false]]);
  assert.deepEqual((await agent.history({ sessionId: ID })).items.filter(item => item.images).map(item => item.images[0].id), ['step-2:0', 'said-4:0']);
  assert.deepEqual(agent.image({ sessionId: ID, imageId: 'step-2:0' }), { mediaType: 'image/png', data: PNG.toString('base64') });
  assert.deepEqual(agent.image({ sessionId: ID, imageId: 'said-4:0' }), { mediaType: 'image/png', data: PNG.toString('base64') });
  for (const imageId of ['step-2:1', 'step-3:0', 'said-2:0', 'step-4:0', 'step-99:0', 'nonsense', undefined, '../../x']) {
    assert.throws(() => agent.image({ sessionId: ID, imageId }), { code: 'unknown_image' }, String(imageId));
  }
});

test('a turn tells of the pictures a message came with and a call looked at', async t => {
  const { agent, events, write, hook, steps, sent } = pictured(t);
  write(steps.slice(0, 1));
  await hook('SessionStart');
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'look at pic.png' });
  write(steps.slice(0, 3));
  await hook('PostToolUse', { stepIdx: 2, toolCall: { id: 'call_1', ...READ }, error: '' });
  const told = events.filter(event => event.kind.startsWith('tool.'));
  assert.deepEqual(told.map(event => [event.kind, event.toolUseId]), [['tool.start', 'step-2'], ['tool.end', 'step-2'], ['tool.images', 'step-2']]);
  assert.deepEqual(told[2].images, [{ id: 'step-2:0', mediaType: 'image/png', bytes: PNG_BYTES, width: 1, height: 1 }]);
  write(steps.slice(0, 4));
  await hook('Stop', { terminationReason: 'NO_TOOL_CALL' });
  // A message sent from a client with a picture: its words, what it was sent with, and the picture.
  await agent.send({ sessionId: ID, text: 'and this one?', clientId: 'c1', attachments: [{ uploadId: 'u1', name: 'sent.png', mediaType: 'image/png', size: PNG.length, path: sent, kind: 'image' }] });
  write(steps.slice(0, 5));
  await hook('PreInvocation', { invocationNum: 0, initialNumSteps: 5, lastUserInput: `${sent}\nand this one?` });
  const said = events.filter(event => event.kind.startsWith('message.')).slice(-2);
  assert.deepEqual(said.map(event => [event.kind, event.text, event.images?.map(image => image.id)]), [['message.user', 'and this one?', undefined], ['message.images', undefined, ['said-4:0']]]);
});

test('with no Antigravity on the Mac there\'s nothing to list or start', async t => {
  const store = new SessionStore();
  const agent = new Antigravity({ version: async () => '1.5.11', store, installed: () => false, rows: async () => { throw new Error('not asked'); }, timing: { watch: 100_000 } });
  t.after(() => agent.stop());
  assert.deepEqual([agent.isAvailable(), await agent.library(), (await agent.capabilities()).models], [false, [], []]);
  await assert.rejects(agent.start({ cwd: os.tmpdir() }), { code: 'no_antigravity' });
});

test('a folder\'s commands are asked of Antigravity once and kept, and one that can\'t be asked is asked again', async t => {
  const { agent, asked } = setup(t);
  const first = await agent.capabilities();
  const again = await agent.capabilities();
  assert.deepEqual(first.commands.map(command => command.name), ['compact', 'schedule']);
  assert.deepEqual(again.commands, first.commands);
  assert.deepEqual(asked, [os.homedir()], 'with no session, the home folder\'s, and once');
  // What Antigravity couldn't say is no commands, with the models still there, and isn't kept as an answer for long.
  let tries = 0;
  const failing = setup(t, { commands: async () => { tries += 1; throw new Error('no server'); } });
  const can = await failing.agent.capabilities();
  assert.deepEqual([can.commands, can.models.length > 0], [[], true]);
  assert.equal(tries, 1);
});

test('what the protocol lists that isn\'t a command by a name is left out', () => {
  assert.deepEqual(commandsFrom(undefined), []);
  assert.deepEqual(commandsFrom([{ name: '/slashed' }, { name: '' }, { name: 'plan', description: 7 }]), [{ name: 'plan', description: '7', argumentHint: '' }]);
});

// The list /model opens, as Antigravity 1.5.8 draws it.
const MODEL_PAGE = [
  RULE, '>', RULE, 'Switch Model', '  Search:', '  Gemini 4 Argon', '> Gemini 4 Hydrogen  (current)', '  Gemini 3.8 Flash',
  'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back', bar(''),
].join('\n');

test('a command that opens a page in the terminal leaves it open for a client that shows pages, to see and work', async t => {
  const { agent, terminal, store, hook } = setup(t);
  await hook('SessionStart', {});
  // The list of commands is up while the line is typed, which isn't something in the way, and Enter opens the page.
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = MODEL_PAGE; if (key === 'Escape') terminal.screen = IDLE; };
  assert.deepEqual(await agent.send({ sessionId: ID, text: '/model', clientId: 'c1', pages: true }), { queued: false, page: true });
  assert.equal(terminal.pasted.at(-1), '/model');
  assert.notEqual(store.find(ID).status, 'running', 'no turn is waited for');
  const { page } = await agent.page({ sessionId: ID });
  const text = page.lines.map(line => line.map(run => run.text).join(''));
  assert.deepEqual([text[0], text.at(-1)], ['Switch Model', 'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back']);
  // A message would be typed into its search box, so it's refused while the page is open.
  await assert.rejects(agent.send({ sessionId: ID, text: 'hello', clientId: 'c2' }), { code: 'dialog_open' });
  await agent.pageKey({ sessionId: ID, key: 'Down' });
  await agent.pageText({ sessionId: ID, text: 'flash' });
  assert.deepEqual([terminal.keys.at(-1), terminal.pasted.at(-1)], ['Down', 'flash']);
  await assert.rejects(agent.pageKey({ sessionId: ID, key: 'C-c' }), { code: 'bad_key' });
  await agent.pageClose({ sessionId: ID });
  assert.equal(terminal.keys.at(-1), 'Escape');
  assert.deepEqual(await agent.page({ sessionId: ID }), { page: null });
  await assert.rejects(agent.pageKey({ sessionId: ID, key: 'Enter' }), { code: 'no_page' }, 'with nothing open, Enter would send what\'s in the box');
});

test('for a client that shows no pages, such a command is closed again and refused', async t => {
  const { agent, terminal, hook } = setup(t);
  await hook('SessionStart', {});
  terminal.onKey = key => { if (key === 'Enter') terminal.screen = MODEL_PAGE; if (key === 'Escape') terminal.screen = IDLE; };
  await assert.rejects(agent.send({ sessionId: ID, text: '/model', clientId: 'c1' }), { code: 'terminal_only' });
  assert.equal(terminal.keys.at(-1), 'Escape');
  assert.equal(terminal.screen, IDLE);
});

test('a command that only prints something leaves the session waiting, and a file\'s path isn\'t a command', async t => {
  const { agent, terminal, store, hook } = setup(t);
  await hook('SessionStart', {});
  assert.deepEqual(await agent.send({ sessionId: ID, text: '/usage', clientId: 'c1', pages: true }), { queued: false });
  assert.notEqual(store.find(ID).status, 'running');
  // A message with a file starts with the file's path, which begins with a slash too.
  assert.deepEqual(await agent.send({ sessionId: ID, text: 'look', clientId: 'c2', attachments: [{ path: '/tmp/a.png', name: 'a.png' }] }), { queued: false });
  assert.equal(store.find(ID).status, 'running', 'a message waits for its turn');
});

// What the model asks the reader, as Antigravity 1.5.8 draws it.
const QUESTION = [
  '? Pick a size', 'Question', RULE, 'Question 1/1: Pick a size', '> 1. Small', '  2. Medium', '  3. Large', '  4. Write-in...',
  '  ↑/↓ Navigate · enter Select · esc Skip', bar('esc to cancel'),
].join('\n');
const WRITING = QUESTION.replace('  4. Write-in...', '> 4. Write-in...\n  Your answer:').replace('> 1. Small', '  1. Small')
  .replace('  ↑/↓ Navigate · enter Select · esc Skip', '  enter Submit · esc Back');

async function asked(t) {
  const made = setup(t);
  await made.hook('SessionStart');
  await made.hook('PreInvocation', { invocationNum: 0, initialNumSteps: 1, lastUserInput: 'ask me' });
  made.terminal.screen = QUESTION;
  await made.until(() => made.store.requests().length === 1, 'the question');
  return { ...made, request: made.store.requests()[0] };
}

test('what the model asks the reader is a question for them, answered by pressing its row', async t => {
  const { store, terminal, request, until } = await asked(t);
  assert.deepEqual([request.kind, request.agent, request.toolName], ['question', AGENT, 'AskUserQuestion']);
  assert.deepEqual(request.input.questions, [{ question: 'Pick a size', header: 'Question', options: [{ label: 'Small' }, { label: 'Medium' }, { label: 'Large' }], multiSelect: false }]);
  assert.equal(store.get(ID).status, 'waiting');
  assert.throws(() => store.respond(request.id, { decision: 'allow' }), { code: 'missing_answers' });
  assert.throws(() => store.respond(request.id, { decision: 'allow', answers: { 'Pick a size': '  ' } }), { code: 'missing_answers' });
  terminal.onKey = () => { terminal.screen = BUSY; };
  store.respond(request.id, { decision: 'allow', answers: { 'Pick a size': 'Medium' } });
  await until(() => terminal.keys.length === 1, 'a key');
  assert.deepEqual([terminal.keys, terminal.pasted], [['2'], []]);
});

test('an answer in the reader\'s own words is written on the line its row opens', async t => {
  const { store, terminal, request, until } = await asked(t);
  terminal.onKey = key => { terminal.screen = key === '4' ? WRITING : BUSY; };
  store.respond(request.id, { decision: 'allow', answers: { 'Pick a size': ' Extra large ' } });
  await until(() => terminal.keys.includes('Enter'), 'the answer sent');
  assert.deepEqual([terminal.keys, terminal.pasted], [['4', 'Enter'], ['Extra large']]);
});

test('a question left unanswered is skipped, as Esc skips it at the terminal', async t => {
  const { store, terminal, request, until } = await asked(t);
  terminal.onKey = () => { terminal.screen = BUSY; };
  store.respond(request.id, { decision: 'deny' });
  await until(() => terminal.keys.length === 1, 'a key');
  assert.deepEqual(terminal.keys, ['Escape']);
});

test('a restart tells the Antigravity on a session to go and opens it again, running the version installed now', async t => {
  const rows = [{ conversation_id: ID, title: 'Read Note', last_modified_time: '2026-11-15 10:39:39+00:00', workspace_uris: `["file://${os.tmpdir()}"]`, step_count: 4 }];
  const { agent, store, terminal, data, stored, hook, killed } = setup(t, { rows, timing: { watch: 100_000 } });
  stored();
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ trustedWorkspaces: [fs.realpathSync(os.tmpdir())] }));
  await hook('SessionStart', { cwd: os.tmpdir(), workspacePaths: [os.tmpdir()] });
  terminal.running = 'antigravity';
  terminal.onKill = () => { terminal.running = 'zsh'; };
  assert.equal(agent.isBusy(ID), false);
  await agent.restartNow(ID);
  assert.deepEqual(killed, [4242]);
  assert.deepEqual([terminal.started.at(-1).command, terminal.started.at(-1).cwd], [['agy', '--conversation', ID], os.tmpdir()]);
  assert.equal(agent.runningVersion(ID), '1.5.11');
  assert.equal(store.get(ID).pane, '%9');
});
