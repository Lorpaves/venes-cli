import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { SessionStore } from '../../src/sessions.mjs';
import {
  Codex, approvalRequest, historyOf, inputOf, isListed, isTool, isTrustedByCodex, libraryItem, modelsOf, permissionsRequest, questionRequest, textOf, thinkingOf,
  trustedFolders,
} from '../../src/codex.mjs';

const FOLDER = os.homedir();
const rpcError = message => Object.assign(new Error(message), { rpcCode: -32600 });
const settle = () => new Promise(resolve => { setImmediate(resolve); });

const stored = (id, fields = {}) => ({
  id, cwd: FOLDER, source: 'cli', ephemeral: false, parentThreadId: null, preview: 'first words', name: null,
  model: 'gpt-6', reasoningEffort: 'high', createdAt: 1000, updatedAt: 2000, status: { type: 'idle' }, turns: [], ...fields,
});

// Codex's app server, as far as the helper speaks to it. `threads` is what it has stored, `loaded`
// what it has in memory, and `calls` what it was asked.
function fakeCodex() {
  const server = {
    threads: new Map(), loaded: new Set(), turns: new Map(), calls: [], answers: [], links: [], fails: {},
    isRunning: true, starts: 0, next: 1,
    models: [
      { id: 'gpt-6', model: 'gpt-6', displayName: 'GPT-6', description: 'The big one', hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
      { id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', description: 'The old one', hidden: false, isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
      { id: 'secret', model: 'secret', displayName: 'Secret', description: '', hidden: true, isDefault: false, supportedReasoningEfforts: [] },
    ],
  };
  server.say = (method, params) => { for (const link of server.links) if (link.isOpen) link.emit('notification', { method, params }); };
  server.ask = (id, method, params) => { for (const link of server.links) if (link.isOpen) link.emit('request', { id, method, params }); };
  server.called = method => server.calls.filter(call => call.method === method).map(call => call.params);
  server.drop = () => { for (const link of server.links) if (link.isOpen) link.close(); };
  const handlers = {
    'thread/loaded/list': () => ({ data: [...server.loaded] }),
    'thread/read': ({ threadId }) => {
      if (!server.threads.has(threadId)) throw rpcError('no such thread');
      return { thread: server.threads.get(threadId) };
    },
    'thread/resume': ({ threadId }) => {
      const thread = server.threads.get(threadId);
      if (!thread) throw rpcError(`no rollout found for thread id ${threadId}`);
      if (thread.elsewhere) throw rpcError(`thread ${threadId} already has an active writer`);
      if (thread.isNew) throw rpcError(`no rollout found for thread id ${threadId}`);
      server.loaded.add(threadId);
      return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort };
    },
    'thread/start': ({ cwd }) => {
      const thread = stored(`new-${server.next++}`, { cwd, source: 'vscode', preview: '', isNew: true });
      server.threads.set(thread.id, thread);
      server.loaded.add(thread.id);
      server.say('thread/started', { thread });
      return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort };
    },
    'thread/list': () => ({ data: [...server.threads.values()] }),
    'thread/delete': ({ threadId }) => { server.threads.delete(threadId); server.loaded.delete(threadId); return {}; },
    'thread/turns/list': ({ threadId, limit, cursor }) => {
      const newestFirst = [...(server.turns.get(threadId) ?? [])].reverse();
      const from = cursor ? Number(cursor) : 0;
      const data = newestFirst.slice(from, from + limit);
      return { data, nextCursor: from + limit < newestFirst.length ? String(from + limit) : null };
    },
    'turn/start': () => ({ turn: { id: 'turn', status: 'inProgress', items: [] } }),
    'turn/steer': () => ({}),
    'turn/interrupt': () => ({}),
    'model/list': () => ({ data: server.models }),
  };
  server.connect = async () => {
    if (!server.isRunning) throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
    const link = new EventEmitter();
    link.isOpen = true;
    link.request = async (method, params) => {
      server.calls.push({ method, params });
      if (!link.isOpen) throw new Error('Codex isn\'t connected.');
      if (server.fails[method]) throw rpcError(server.fails[method]);
      return handlers[method](params);
    };
    link.respond = (id, result) => server.answers.push({ id, result });
    link.close = () => { if (link.isOpen) { link.isOpen = false; link.emit('close'); } };
    server.links.push(link);
    return link;
  };
  server.startDaemon = async () => { server.starts += 1; server.isRunning = true; };
  return server;
}

function setup({ threads = [], loaded = [], isRunning = true, trusts = () => true } = {}) {
  const server = fakeCodex();
  server.isRunning = isRunning;
  for (const thread of threads) server.threads.set(thread.id, thread);
  for (const id of loaded) server.loaded.add(id);
  const store = new SessionStore();
  const events = [];
  store.on('event', event => events.push(event));
  const codex = new Codex({ store, socketPath: '/nowhere', connect: server.connect, startDaemon: server.startDaemon, retryMs: 5, trusts });
  const kinds = () => events.map(event => event.kind);
  const last = kind => events.findLast(event => event.kind === kind);
  return { server, store, events, codex, kinds, last };
}

// A session with a turn going, started from a client.
async function running(options) {
  const made = setup(options);
  const { sessionId } = await made.codex.start({ cwd: FOLDER });
  await made.codex.send({ sessionId, text: 'do it', clientId: 'c1' });
  made.server.threads.get(sessionId).isNew = false;
  made.server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-1' } });
  made.server.say('item/started', { threadId: sessionId, turnId: 'turn-1', item: { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'do it' }] } });
  return { ...made, sessionId, say: (method, params) => made.server.say(method, { threadId: sessionId, turnId: 'turn-1', ...params }) };
}

const command = (fields = {}) => ({
  type: 'commandExecution', id: 'exec-1', command: '/bin/zsh -lc \'touch x\'', cwd: FOLDER, status: 'inProgress',
  commandActions: [{ type: 'unknown', command: 'touch x' }], aggregatedOutput: null, exitCode: null, durationMs: null, ...fields,
});

test('a message is its text, without what came with it', () => {
  assert.equal(textOf([{ type: 'localImage', path: '/a.png' }, { type: 'text', text: 'look' }, { type: 'text', text: 'here' }]), 'look\nhere');
  assert.equal(textOf(), '');
});

test('thinking is its summary, or all of it where there is none', () => {
  assert.equal(thinkingOf({ summary: ['one', 'two'], content: ['long'] }), 'one\n\ntwo');
  assert.equal(thinkingOf({ summary: [], content: ['long'] }), 'long');
  assert.equal(thinkingOf({}), '');
});

test('a thread a person started is listed, and one Codex made for itself is not', () => {
  assert.equal(isListed(stored('a')), true);
  assert.equal(isListed(stored('a', { source: 'vscode' })), true);
  assert.equal(isListed(stored('a', { ephemeral: true })), false);
  assert.equal(isListed(stored('a', { parentThreadId: 'b' })), false);
  assert.equal(isListed(stored('a', { source: { subAgent: { threadSpawn: {} } } })), false);
  assert.equal(isListed(stored('a', { source: 'subAgentReview' })), false);
  assert.equal(isListed(stored('a', { source: 'exec' })), false);
});

test('everything Codex does is a tool, and what it says is not', () => {
  for (const type of ['commandExecution', 'fileChange', 'mcpToolCall', 'webSearch', 'imageView', 'collabAgentToolCall']) assert.equal(isTool({ type }), true);
  for (const type of ['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction']) assert.equal(isTool({ type }), false);
});

test('a picture goes as an image, and any other file by its path ahead of the text', () => {
  const picture = { kind: 'image', mediaType: 'image/png', path: '/d/a.png' };
  const file = { kind: 'file', mediaType: 'application/pdf', path: '/d/b.pdf' };
  assert.deepEqual(inputOf('look', [picture, file]), [
    { type: 'localImage', path: '/d/a.png' },
    { type: 'text', text: '/d/b.pdf\nlook', text_elements: [] },
  ]);
  assert.deepEqual(inputOf('', [picture]), [{ type: 'localImage', path: '/d/a.png' }]);
  assert.deepEqual(inputOf('hi'), [{ type: 'text', text: 'hi', text_elements: [] }]);
});

test('a stored turn is told as history tells one', () => {
  const turn = {
    id: 't', status: 'completed', startedAt: 1_700_000_000, durationMs: 4200,
    items: [
      { type: 'userMessage', id: 'u', clientId: 'c9', content: [{ type: 'text', text: 'hello' }] },
      { type: 'reasoning', id: 'r', summary: ['thinking it over'], content: [] },
      { type: 'agentMessage', id: 'm1', text: 'On it.', phase: 'commentary' },
      command({ status: 'completed', exitCode: 0, aggregatedOutput: 'ok' }),
      { type: 'agentMessage', id: 'm2', text: '', phase: 'commentary' },
      { type: 'contextCompaction', id: 'k' },
      { type: 'agentMessage', id: 'm3', text: 'Done.', phase: 'final_answer' },
    ],
  };
  const items = historyOf(turn);
  assert.deepEqual(items.map(item => item.role), ['user', 'thinking', 'assistant', 'tool', 'compact', 'assistant', 'turn_end']);
  assert.deepEqual(items[0], { role: 'user', at: '2023-11-14T22:13:20.000Z', text: 'hello', clientId: 'c9' });
  assert.equal(items[2].phase, 'commentary');
  assert.deepEqual({ ...items[3], input: undefined, result: undefined }, { role: 'tool', at: items[0].at, toolUseId: 'exec-1', name: 'commandExecution', input: undefined, result: undefined, isError: false });
  assert.equal(items[3].result.aggregatedOutput, 'ok');
  assert.equal(items.at(-1).durationMs, 4200);
  assert.deepEqual(historyOf({ status: 'interrupted', items: [] }), [{ role: 'system', at: undefined, kind: 'interrupted' }]);
  assert.deepEqual(historyOf({ status: 'inProgress', items: [command({ status: 'declined' })] }).map(item => item.isError), [true]);
});

test('a stored thread is a library item that says it is Codex\'s', () => {
  assert.deepEqual(libraryItem(stored('a', { name: 'Named' })), { id: 'a', title: 'Named', cwd: FOLDER, lastActiveAt: 2_000_000, startedAt: 1_000_000, status: null, agent: 'codex' });
  assert.equal(libraryItem(stored('a')).title, 'first words');
  assert.equal(libraryItem(stored('a', { preview: '' }), 'running').status, 'running');
});

test('the models on offer are the ones that are not hidden, with their effort levels', () => {
  assert.deepEqual(modelsOf(fakeCodex().models), [
    { value: 'gpt-6', displayName: 'GPT-6', description: 'The big one', resolvedModel: 'gpt-6', effortLevels: ['low', 'high'], isDefault: true },
    { value: 'gpt-5', displayName: 'GPT-5', description: 'The old one', resolvedModel: 'gpt-5', effortLevels: ['low'] },
  ]);
});

test('a command\'s approval offers Codex\'s other ways of saying yes, in its terminal\'s words', () => {
  const amendment = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } };
  const { fields, decide } = approvalRequest('commandExecution', {
    threadId: 't', turnId: 'u', itemId: 'exec-1', command: 'touch x', cwd: '/w', availableDecisions: ['accept', amendment, 'acceptForSession', 'cancel'],
  });
  assert.equal(fields.kind, 'permission');
  assert.equal(fields.agent, 'codex');
  assert.equal(fields.toolName, 'commandExecution');
  assert.equal(fields.toolUseId, 'exec-1');
  assert.equal(fields.input.command, 'touch x');
  assert.equal(fields.input.threadId, undefined);
  assert.deepEqual(fields.options, [
    { id: 'acceptWithExecpolicyAmendment', label: 'Yes, and don\'t ask again for commands that start with `touch x`' },
    { id: 'acceptForSession', label: 'Yes, and don\'t ask again for this command in this session' },
  ]);
  assert.deepEqual(decide({ decision: 'allow' }), { result: { decision: 'accept' } });
  assert.deepEqual(decide({ decision: 'allow', option: 'acceptWithExecpolicyAmendment' }), { result: { decision: amendment } });
  assert.deepEqual(decide({ decision: 'allow', option: 'acceptForSession' }), { result: { decision: 'acceptForSession' } });
  assert.deepEqual(decide({ decision: 'deny' }), { result: { decision: 'cancel' } });
  assert.deepEqual(decide({ decision: 'deny', message: ' use mkdir ' }), { result: { decision: 'cancel' }, followUp: 'use mkdir' });
  assert.throws(() => decide({ decision: 'allow', option: 'cancel' }), error => error.code === 'bad_option');
  assert.throws(() => decide({ decision: 'maybe' }), error => error.code === 'bad_decision');
});

test('a no is a decline where Codex offers no way to stop the turn', () => {
  const { decide } = approvalRequest('commandExecution', { itemId: 'e', availableDecisions: ['accept', 'decline'] });
  assert.deepEqual(decide({ decision: 'deny' }), { result: { decision: 'decline' } });
});

test('a file change\'s approval shows what would change, and can be for the session', () => {
  const changes = [{ path: '/w/a.txt', kind: 'add', diff: '+hi' }];
  const { fields, decide } = approvalRequest('fileChange', { threadId: 't', turnId: 'u', itemId: 'p1', reason: 'needs to write' }, { changes });
  assert.deepEqual(fields.input, { itemId: 'p1', reason: 'needs to write', changes });
  assert.deepEqual(fields.options, [{ id: 'acceptForSession', label: 'Yes, and don\'t ask again for these files' }]);
  assert.deepEqual(decide({ decision: 'allow', option: 'acceptForSession' }), { result: { decision: 'acceptForSession' } });
});

test('more room is granted for the turn, or the session, or not at all', () => {
  const permissions = { network: { enabled: true } };
  const { fields, decide } = permissionsRequest({ threadId: 't', turnId: 'u', itemId: 'i', permissions, reason: 'needs the network' });
  assert.equal(fields.toolName, 'permissions');
  assert.deepEqual(fields.options, [{ id: 'session', label: 'Yes, grant these permissions for this session' }]);
  assert.deepEqual(decide({ decision: 'allow' }), { result: { permissions, scope: 'turn' } });
  assert.deepEqual(decide({ decision: 'allow', option: 'session' }), { result: { permissions, scope: 'session' } });
  assert.deepEqual(decide({ decision: 'deny' }), { result: { permissions: {}, scope: 'turn' } });
});

test('Codex\'s questions are asked as Claude Code\'s are, and answered by their ids', () => {
  const { fields, decide } = questionRequest({
    threadId: 't', turnId: 'u', itemId: 'q-item', questions: [
      { id: 'q1', header: 'Colour', question: 'Which colour?', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], isOther: true },
      { id: 'q2', header: 'Key', question: 'What is the key?', options: null, isSecret: true },
    ],
  });
  assert.equal(fields.kind, 'question');
  assert.deepEqual(fields.input.questions[0], {
    question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false, id: 'q1', isOther: true, isSecret: false,
  });
  assert.deepEqual(fields.input.questions[1].options, []);
  assert.deepEqual(decide({ decision: 'allow', answers: { 'Which colour?': 'Blue', 'What is the key?': 'abc' } }), {
    result: { answers: { q1: { answers: ['Blue'] }, q2: { answers: ['abc'] } } },
  });
  assert.throws(() => decide({ decision: 'allow', answers: { 'Which colour?': 'Blue' } }), error => error.code === 'missing_answers' && error.details.missing[0] === 'What is the key?');
  assert.deepEqual(decide({ decision: 'deny' }), { result: { answers: {} } });
});

test('the threads the daemon has in memory are sessions going on, and the rest are not', async () => {
  const { codex, store, server } = setup({
    threads: [stored('live', { status: { type: 'active', activeFlags: [] } }), stored('quiet'), stored('sub', { parentThreadId: 'live' }), stored('kept')],
    loaded: ['live', 'quiet', 'sub'],
  });
  await codex.restore();
  const sessions = store.sessions();
  assert.deepEqual(sessions.map(session => [session.id, session.status, session.agent]), [['live', 'running', 'codex'], ['quiet', 'idle', 'codex']]);
  assert.equal(sessions[0].cwd, FOLDER);
  assert.equal(sessions[0].model, 'gpt-6');
  assert.equal(sessions[0].effort, 'high');
  assert.equal(sessions[0].lastPrompt, 'first words');
  assert.deepEqual(server.called('thread/resume').map(params => params.threadId), ['live', 'quiet']);
  assert.equal(server.starts, 0);
});

test('with no Codex running, there is nothing, and nothing is started to look', async () => {
  const { codex, store, server } = setup({ isRunning: false });
  await codex.restore();
  assert.deepEqual(await codex.library(), []);
  assert.equal(await codex.owns('anything'), false);
  assert.deepEqual(store.sessions(), []);
  assert.equal(server.starts, 0);
});

test('a new session starts Codex\'s server if it has to, and is a session from then on', async () => {
  const { codex, store, server, events } = setup({ isRunning: false });
  const { sessionId } = await codex.start({ cwd: FOLDER });
  assert.equal(server.starts, 1);
  assert.deepEqual(server.called('thread/start'), [{ cwd: FOLDER }]);
  assert.equal(store.get(sessionId).agent, 'codex');
  assert.deepEqual(events.slice(0, 2).map(event => [event.kind, event.agent ?? event.source]), [['session.discovered', 'codex'], ['session.started', 'startup']]);
  assert.equal(await codex.owns(sessionId), true);
});

const CONFIG = `model = "gpt-6"

[projects."/Users/me/app"]
trust_level = "trusted"

[projects."/Users/me/a \\"quoted\\" one"]
trust_level = "trusted"

[projects."/Users/me/unsure"]
trust_level = "untrusted"

[tui]
theme = "dark"
`;

test('the folders Codex trusts are the ones its config says so of', () => {
  assert.deepEqual(trustedFolders(CONFIG), ['/Users/me/app', '/Users/me/a "quoted" one']);
  assert.deepEqual(trustedFolders(''), []);
});

test('a folder is trusted by itself, or by the repository it\'s in', () => {
  const repositories = new Set(['/Users/me/app/.git', '/Users/me/other/.git']);
  const exists = file => repositories.has(file);
  assert.equal(isTrustedByCodex('/Users/me/app', { config: CONFIG, exists }), true);
  assert.equal(isTrustedByCodex('/Users/me/app/src/deep', { config: CONFIG, exists }), true);
  assert.equal(isTrustedByCodex('/Users/me/other/src', { config: CONFIG, exists }), false);
  assert.equal(isTrustedByCodex('/Users/me/unsure', { config: CONFIG, exists }), false);
  // One above it that's trusted says nothing of a folder that isn't in its repository.
  assert.equal(isTrustedByCodex('/Users/me/app-notes', { config: CONFIG, exists }), false);
  assert.equal(isTrustedByCodex('/Users/me/app', { home: '/no/such/codex/home' }), false);
});

test('a folder Codex doesn\'t trust yet starts nothing until the reader says so', async () => {
  const { codex, server } = setup({ trusts: folder => folder !== FOLDER });
  await assert.rejects(codex.start({ cwd: FOLDER }), error => error.code === 'needs_trust');
  assert.equal(server.calls.length, 0);
  const { sessionId } = await codex.start({ cwd: FOLDER, trust: true });
  assert.equal(server.called('thread/start').length, 1);
  assert.ok(sessionId);
});

test('a folder that isn\'t there starts nothing, and neither does a Mac without Codex', async () => {
  const { codex, server } = setup();
  await assert.rejects(codex.start({ cwd: '/no/such/folder/here' }), error => error.code === 'no_folder');
  assert.equal(server.calls.length, 0);
  const none = setup({ isRunning: false });
  none.server.startDaemon = async () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }); };
  const codexless = new Codex({ store: none.store, socketPath: '/nowhere', connect: none.server.connect, startDaemon: none.server.startDaemon, trusts: () => true });
  await assert.rejects(codexless.start({ cwd: FOLDER }), error => error.code === 'no_codex' && /isn't installed/.test(error.message));
});

test('a turn comes as the events a Claude Code turn does', async () => {
  const { say, store, sessionId, events, last, server } = await running();
  assert.deepEqual(server.called('turn/start'), [{ threadId: sessionId, input: [{ type: 'text', text: 'do it', text_elements: [] }], clientUserMessageId: 'c1' }]);
  assert.equal(store.get(sessionId).status, 'running');
  assert.deepEqual({ ...last('message.user'), seq: 0, at: 0 }, { seq: 0, at: 0, sessionId, kind: 'message.user', text: 'do it', clientId: 'c1' });
  // Its other notice is the same message, said once.
  say('item/completed', { item: { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'do it' }] } });
  assert.equal(events.filter(event => event.kind === 'message.user').length, 1);

  say('item/started', { item: { type: 'agentMessage', id: 'm1', text: '', phase: 'commentary' } });
  say('item/agentMessage/delta', { itemId: 'm1', delta: 'I\'ll ' });
  say('item/agentMessage/delta', { itemId: 'm1', delta: 'run it.' });
  say('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'I\'ll run it.', phase: 'commentary' } });
  const deltas = events.filter(event => event.kind === 'message.assistant.delta');
  assert.deepEqual(deltas.map(event => [event.messageId, event.index, event.text, event.final, event.phase, event.turnId]), [
    ['m1', 0, 'I\'ll ', false, 'commentary', 'turn-1'], ['m1', 1, 'run it.', false, 'commentary', 'turn-1'], ['m1', 2, '', true, 'commentary', 'turn-1'],
  ]);

  say('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] } });
  say('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Weighing it'], content: [] } });
  assert.equal(last('message.thinking').text, 'Weighing it');

  say('item/started', { item: command() });
  assert.deepEqual([last('tool.start').toolUseId, last('tool.start').name, last('tool.start').input.command], ['exec-1', 'commandExecution', '/bin/zsh -lc \'touch x\'']);
  say('item/completed', { item: command({ status: 'completed', exitCode: 0, aggregatedOutput: 'done\n', durationMs: 31 }) });
  const ended = last('tool.end');
  assert.deepEqual([ended.toolUseId, ended.name, ended.response.aggregatedOutput, ended.durationMs, ended.isError], ['exec-1', 'commandExecution', 'done\n', 31, false]);

  say('turn/plan/updated', { explanation: 'Two steps', plan: [{ step: 'Look', status: 'completed' }, { step: 'Fix', status: 'inProgress' }] });
  assert.deepEqual([last('plan.updated').explanation, last('plan.updated').plan.length], ['Two steps', 2]);

  say('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'All done.', phase: 'final_answer' } });
  // One whose pieces never came is all there in its last one.
  assert.deepEqual([last('message.assistant.delta').text, last('message.assistant.delta').index, last('message.assistant.delta').final], ['All done.', 0, true]);
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed', durationMs: 900 } });
  assert.equal(store.get(sessionId).status, 'idle');
  assert.deepEqual([last('turn.end').lastMessage, last('turn.end').backgroundTasks, last('turn.end').tasks], ['All done.', 0, []]);
  assert.equal(store.get(sessionId).lastMessage, 'All done.');
  assert.equal(store.get(sessionId).lastPrompt, 'do it');
});

test('a message typed at Codex\'s own terminal has no send to name', async () => {
  const { say, last } = await running();
  say('item/started', { item: { type: 'userMessage', id: 'u2', clientId: null, content: [{ type: 'text', text: 'from the Mac' }] } });
  assert.equal(last('message.user').text, 'from the Mac');
  assert.equal(last('message.user').clientId, undefined);
});

test('a message\'s files come back as the client named them, with its own words', async () => {
  const { codex, server, last } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const upload = { uploadId: 'up1', name: 'notes.pdf', mediaType: 'application/pdf', size: 12, kind: 'file', path: '/d/notes.pdf' };
  await codex.send({ sessionId, text: 'read this', clientId: 'c7', attachments: [upload] });
  assert.equal(server.called('turn/start')[0].input[0].text, '/d/notes.pdf\nread this');
  server.say('item/started', { threadId: sessionId, item: { type: 'userMessage', id: 'u', clientId: 'c7', content: [{ type: 'text', text: '/d/notes.pdf\nread this' }] } });
  assert.equal(last('message.user').text, 'read this');
  assert.deepEqual(last('message.user').attachments, [{ uploadId: 'up1', name: 'notes.pdf', mediaType: 'application/pdf', size: 12 }]);
});

test('a kind of work that\'s only said when it\'s done still starts and ends', async () => {
  const { say, kinds } = await running();
  say('item/completed', { item: { type: 'webSearch', id: 'w1', query: 'venes', action: { type: 'search', query: 'venes' } } });
  assert.deepEqual(kinds().slice(-2), ['tool.start', 'tool.end']);
});

test('a command that was turned down ended in an error', async () => {
  const { say, last } = await running();
  say('item/started', { item: command() });
  say('item/completed', { item: command({ status: 'declined' }) });
  assert.equal(last('tool.end').isError, true);
});

test('a turn that\'s stopped ends what was going, and says it was stopped', async () => {
  const { say, store, sessionId, kinds, last } = await running();
  say('item/started', { item: command() });
  say('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  assert.deepEqual(kinds().slice(-3), ['tool.end', 'session.status', 'turn.interrupted']);
  assert.deepEqual([last('tool.end').isError, last('tool.end').interrupted], [true, true]);
  assert.equal(store.get(sessionId).status, 'idle');
});

test('a turn that fails says what Codex said of it', async () => {
  const { say, last } = await running();
  say('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'You\'ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } });
  assert.deepEqual([last('turn.error').error, last('turn.error').details], ['You\'ve hit your usage limit.', 'usageLimitExceeded']);
});

test('an approval waits for a client, and its answer goes to Codex', async () => {
  const { say, store, sessionId, server, last } = await running();
  say('item/started', { item: command() });
  server.ask(4, 'item/commandExecution/requestApproval', {
    threadId: sessionId, turnId: 'turn-1', itemId: 'exec-1', command: 'touch x', cwd: FOLDER,
    availableDecisions: ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } }, 'cancel'],
  });
  const { request } = last('request.opened');
  assert.deepEqual([request.kind, request.toolName, request.toolUseId, request.agent, request.options.length], ['permission', 'commandExecution', 'exec-1', 'codex', 1]);
  assert.equal(request.decide, undefined);
  assert.equal(store.get(sessionId).status, 'waiting');
  store.respond(request.id, { decision: 'allow', option: 'acceptWithExecpolicyAmendment' });
  await settle();
  assert.deepEqual(server.answers, [{ id: 4, result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } } } }]);
  assert.deepEqual([last('request.closed').decision, last('request.closed').by], ['allow', 'client']);
  assert.equal(store.get(sessionId).status, 'running');
  // Codex then says it's settled, which is nothing new.
  say('serverRequest/resolved', { requestId: 4 });
  assert.equal(store.requests().length, 0);
});

test('an answer that won\'t do leaves the request open', async () => {
  const { store, sessionId, server, last } = await running();
  server.ask(4, 'item/commandExecution/requestApproval', { threadId: sessionId, itemId: 'exec-1', availableDecisions: ['accept', 'cancel'] });
  assert.throws(() => store.respond(last('request.opened').request.id, { decision: 'allow', option: 'acceptForSession' }), error => error.code === 'bad_option');
  assert.equal(store.requests().length, 1);
  assert.deepEqual(server.answers, []);
});

test('an approval answered at Codex\'s own terminal closes here', async () => {
  const { say, store, server, last } = await running();
  server.ask(9, 'item/fileChange/requestApproval', { threadId: store.sessions()[0].id, itemId: 'p1' });
  assert.equal(last('request.opened').request.toolName, 'fileChange');
  say('serverRequest/resolved', { requestId: 9 });
  assert.deepEqual([last('request.closed').decision, last('request.closed').by], ['unknown', 'terminal']);
  assert.deepEqual(server.answers, []);
});

test('a file change\'s approval shows the change it\'s about', async () => {
  const { say, sessionId, server, last } = await running();
  say('item/started', { item: { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: '/w/a', kind: 'add', diff: '+x' }] } });
  server.ask(2, 'item/fileChange/requestApproval', { threadId: sessionId, itemId: 'p1', reason: null });
  assert.deepEqual(last('request.opened').request.input.changes, [{ path: '/w/a', kind: 'add', diff: '+x' }]);
});

test('a no stops the turn, and what to do instead is said once it has', async () => {
  const { say, store, sessionId, server, last } = await running();
  server.ask(4, 'item/commandExecution/requestApproval', { threadId: sessionId, itemId: 'exec-1', availableDecisions: ['accept', 'cancel'] });
  store.respond(last('request.opened').request.id, { decision: 'deny', message: 'use mkdir instead' });
  await settle();
  assert.deepEqual(server.answers, [{ id: 4, result: { decision: 'cancel' } }]);
  assert.equal(server.called('turn/start').length, 1);
  say('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  await settle();
  await settle();
  assert.deepEqual(server.called('turn/start').at(-1), { threadId: sessionId, input: [{ type: 'text', text: 'use mkdir instead', text_elements: [] }] });
});

test('a question is answered by what was picked', async () => {
  const { store, sessionId, server, last } = await running();
  server.ask(6, 'item/tool/requestUserInput', {
    threadId: sessionId, turnId: 'turn-1', itemId: 'q', questions: [{ id: 'q1', header: 'Which', question: 'Which one?', options: [{ label: 'A', description: '' }] }],
  });
  const { request } = last('request.opened');
  assert.equal(request.kind, 'question');
  store.respond(request.id, { decision: 'allow', answers: { 'Which one?': 'A' } });
  await settle();
  assert.deepEqual(server.answers, [{ id: 6, result: { answers: { q1: { answers: ['A'] } } } }]);
});

test('a turn that ends takes its open requests with it', async () => {
  const { say, store, sessionId, server, last } = await running();
  server.ask(4, 'item/commandExecution/requestApproval', { threadId: sessionId, itemId: 'exec-1' });
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(store.requests().length, 0);
  assert.equal(last('request.closed').by, 'turn_end');
});

test('something Codex asks that the helper has no card for is left to its other clients', async () => {
  const { store, sessionId, server } = await running();
  server.ask(4, 'mcpServer/elicitation/request', { threadId: sessionId });
  server.ask(5, 'item/commandExecution/requestApproval', { threadId: 'someone-elses', itemId: 'e' });
  assert.equal(store.requests().length, 0);
});

test('a message during a turn goes into it, and starts the next when the turn won\'t take it', async () => {
  const { codex, sessionId, server } = await running();
  assert.deepEqual(await codex.send({ sessionId, text: 'also this', clientId: 'c2' }), { queued: false });
  assert.deepEqual(server.called('turn/steer'), [{ threadId: sessionId, input: [{ type: 'text', text: 'also this', text_elements: [] }], clientUserMessageId: 'c2', expectedTurnId: 'turn-1' }]);
  assert.equal(server.called('turn/start').length, 1);
  server.fails['turn/steer'] = 'no active turn to steer';
  await codex.send({ sessionId, text: 'and this', clientId: 'c3' });
  assert.equal(server.called('turn/start').length, 2);
  assert.equal(server.called('turn/start')[1].clientUserMessageId, 'c3');
});

test('a message for later is held while a turn runs', async () => {
  const { codex, store, sessionId, server, say } = await running();
  assert.deepEqual(await codex.send({ sessionId, text: 'after this', clientId: 'c2', lane: 'later' }), { queued: true });
  assert.equal(server.called('turn/steer').length, 0);
  assert.equal(store.get(sessionId).held.length, 1);
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  // The helper's timer takes it from here, as it does any held message.
  const held = store.nextHeld(store.get(sessionId), Date.now() + 10_000);
  await codex.deliver(store.get(sessionId), held);
  assert.equal(server.called('turn/start').at(-1).clientUserMessageId, 'c2');
});

test('a message Codex won\'t take fails, and its echo isn\'t waited for', async () => {
  const { codex, server } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  server.fails['turn/start'] = 'input too large';
  await assert.rejects(codex.send({ sessionId, text: 'x', clientId: 'c1' }), error => error.code === 'send_failed' && /input too large/.test(error.message));
});

test('a stored session is loaded by its first message', async () => {
  const { codex, store, server, kinds } = setup({ threads: [stored('old')] });
  assert.equal(await codex.owns('old'), true);
  assert.deepEqual(await codex.send({ sessionId: 'old', text: 'carry on', clientId: 'c1' }), { queued: false });
  assert.deepEqual(server.called('thread/resume'), [{ threadId: 'old', excludeTurns: true }]);
  assert.equal(store.get('old').agent, 'codex');
  assert.deepEqual(kinds().slice(0, 2), ['session.discovered', 'session.started']);
  assert.equal(server.called('turn/start')[0].threadId, 'old');
});

test('one that\'s open in a terminal of Codex\'s own can\'t be sent to from here', async () => {
  const { codex } = setup({ threads: [stored('busy', { elsewhere: true })] });
  await assert.rejects(codex.send({ sessionId: 'busy', text: 'hi' }), error => error.code === 'session_elsewhere');
});

test('a turn can be stopped, and nothing can when none is going', async () => {
  const { codex, sessionId, server, say } = await running();
  await codex.interrupt({ sessionId });
  assert.deepEqual(server.called('turn/interrupt'), [{ threadId: sessionId, turnId: 'turn-1' }]);
  say('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  await assert.rejects(codex.interrupt({ sessionId }), error => error.code === 'not_running');
});

const turnOf = (number, status = 'completed') => ({
  id: `turn-${number}`, status, startedAt: 1_700_000_000 + number, durationMs: 10,
  items: [
    { type: 'userMessage', id: `u${number}`, clientId: null, content: [{ type: 'text', text: `ask ${number}` }] },
    { type: 'agentMessage', id: `m${number}`, text: `reply ${number}`, phase: 'final_answer' },
  ],
});

test('history comes a page at a time, oldest first, back to where a turn starts', async () => {
  const { codex, server } = setup({ threads: [stored('old')] });
  server.turns.set('old', Array.from({ length: 45 }, (_, index) => turnOf(index + 1)));
  const first = await codex.history({ sessionId: 'old', limit: 30 });
  // Five turns at a time, three items each, so thirty items take two reads.
  assert.equal(first.items.length, 30);
  assert.equal(server.called('thread/turns/list').length, 2);
  assert.deepEqual(first.items.slice(0, 3).map(item => item.text ?? item.role), ['ask 36', 'reply 36', 'turn_end']);
  assert.equal(first.items.at(-2).text, 'reply 45');
  assert.equal(first.hasMore, true);
  assert.equal(server.called('thread/turns/list')[0].itemsView, 'full');
  const second = await codex.history({ sessionId: 'old', limit: 200, before: first.before });
  assert.deepEqual([second.items[0].text, second.items.at(-2).text, second.hasMore, second.before], ['ask 1', 'reply 35', false, 0]);
  // A cursor that's another session's, or from before a restart, gets nothing.
  assert.deepEqual(await codex.history({ sessionId: 'other', before: first.before }), { items: [], before: 0, hasMore: false });
});

test('a session that has had no message yet has nothing to show, which is no error', async () => {
  const { codex, server } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  server.fails['thread/turns/list'] = `thread ${sessionId} is not materialized yet; thread/turns/list is unavailable before first user message`;
  const joined = await codex.join({ sessionId });
  assert.deepEqual([joined.items, joined.hasMore, joined.sessions[0].status], [[], false, 'idle']);
  server.fails['thread/turns/list'] = 'something else went wrong';
  await assert.rejects(codex.join({ sessionId }), /something else/);
});

test('joining a session that isn\'t going on gives what it said', async () => {
  const { codex, server } = setup({ threads: [stored('old')] });
  server.turns.set('old', [turnOf(1)]);
  const joined = await codex.join({ sessionId: 'old', limit: 50 });
  assert.deepEqual(joined.items.map(item => item.role), ['user', 'assistant', 'turn_end']);
  assert.deepEqual([joined.turn, joined.queued, joined.requests], [[], [], []]);
  assert.deepEqual(joined.sessions, [{ id: 'old', status: 'ended', cwd: FOLDER, model: 'gpt-6', agent: 'codex', tasks: [], backgroundTasks: 0 }]);
  assert.equal(server.called('thread/resume').length, 0);
});

test('joining one with a turn going gives that turn as its events, and the rest as history', async () => {
  const { codex, sessionId, server, say, store } = await running();
  say('item/agentMessage/delta', { itemId: 'm1', delta: 'Working' });
  server.ask(4, 'item/commandExecution/requestApproval', { threadId: sessionId, itemId: 'exec-1' });
  server.turns.set(sessionId, [turnOf(0), { ...turnOf(1, 'inProgress'), id: 'turn-1' }]);
  const joined = await codex.join({ sessionId });
  assert.deepEqual(joined.items.map(item => item.text ?? item.role), ['ask 0', 'reply 0', 'turn_end']);
  assert.deepEqual(joined.turn.map(event => event.kind), ['session.status', 'message.user', 'message.assistant.delta', 'session.status', 'request.opened']);
  assert.equal(joined.sessions[0].status, 'waiting');
  assert.equal(joined.requests.length, 1);
  assert.equal(joined.seq, store.seq);
});

test('a session runs on what the reader chose from its next turn', async () => {
  const { codex, store, server, events, last } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  assert.deepEqual((await codex.capabilities()).models.map(model => model.value), ['gpt-6', 'gpt-5']);
  assert.deepEqual((await codex.capabilities()).commands, []);
  assert.equal(server.called('model/list').length, 1);
  await assert.rejects(codex.configure({ sessionId, model: 'gpt-9' }), error => error.code === 'bad_model');
  await assert.rejects(codex.configure({ sessionId, model: 'gpt-5', effort: 'high' }), error => error.code === 'bad_effort');
  await assert.rejects(codex.configure({ sessionId }), error => error.code === 'bad_model');
  await codex.configure({ sessionId, model: 'gpt-5', effort: 'low' });
  assert.equal(store.get(sessionId).model, 'gpt-5');
  assert.equal(last('session.model').model, 'gpt-5');
  assert.equal(last('session.effort').effort, 'low');
  await codex.send({ sessionId, text: 'go' });
  assert.deepEqual([server.called('turn/start')[0].model, server.called('turn/start')[0].effort], ['gpt-5', 'low']);
  await codex.send({ sessionId, text: 'again' });
  assert.equal(server.called('turn/start')[1].model, undefined);
  // Codex saying the same afterwards is nothing new.
  const before = events.length;
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-5', effort: 'low' } });
  assert.equal(events.length, before);
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-6', effort: 'high' } });
  assert.deepEqual([store.get(sessionId).model, store.get(sessionId).effort], ['gpt-6', 'high']);
});

test('the library has Codex\'s stored threads, and says which are going on', async () => {
  const { codex } = setup({ threads: [stored('live', { status: { type: 'active', activeFlags: [] } }), stored('old'), stored('sub', { parentThreadId: 'live' })], loaded: ['live'] });
  const items = await codex.library();
  assert.deepEqual(items.map(item => [item.id, item.status, item.agent]), [['live', 'running', 'codex'], ['old', null, 'codex']]);
});

test('whose a session is gets asked of Codex once', async () => {
  const { codex, server, store } = setup({ threads: [stored('old')] });
  assert.equal(await codex.owns('old'), true);
  assert.equal(await codex.owns('claude-session'), false);
  assert.equal(await codex.owns('claude-session'), false);
  assert.equal(server.called('thread/read').length, 2);
  assert.equal(await codex.owns(undefined), false);
  // One the helper has from Claude Code's hooks isn't Codex's, whatever Codex would say.
  store.handleHook({ session_id: 'hooked', cwd: '/w', hook_event_name: 'SessionStart' });
  assert.equal(await codex.owns('hooked'), false);
  assert.equal(server.called('thread/read').length, 2);
});

test('a thread another client starts on the daemon is a session too, joined at its first turn', async () => {
  const { codex, store, server } = setup();
  await codex.restore();
  const thread = stored('theirs', { isNew: true, preview: '' });
  server.threads.set('theirs', thread);
  server.loaded.add('theirs');
  server.say('thread/started', { thread });
  await settle();
  assert.equal(store.get('theirs').agent, 'codex');
  thread.isNew = false;
  server.say('thread/status/changed', { threadId: 'theirs', status: { type: 'active', activeFlags: [] } });
  await settle();
  assert.equal(store.get('theirs').status, 'running');
  assert.equal(server.called('thread/resume').filter(params => params.threadId === 'theirs').length, 2);
  server.say('thread/status/changed', { threadId: 'theirs', status: { type: 'idle' } });
  // Joined by now, so the turn's own end says so, and this says nothing more.
  server.say('turn/completed', { threadId: 'theirs', turn: { id: 't', status: 'completed' } });
  assert.equal(store.get('theirs').status, 'idle');
});

test('a thread the daemon lets go of is a session that ended, and one deleted is gone', async () => {
  const { codex, store, server, last, kinds } = setup({ threads: [stored('one'), stored('two')], loaded: ['one', 'two'] });
  await codex.restore();
  server.say('thread/closed', { threadId: 'one' });
  assert.equal(store.get('one').status, 'ended');
  assert.equal(last('session.ended').reason, 'closed');
  server.say('thread/deleted', { threadId: 'two' });
  assert.equal(store.find('two'), undefined);
  assert.equal(kinds().at(-1), 'session.deleted');
  assert.equal(await codex.owns('two'), false);
});

test('deleting a session stops its turn and has Codex delete it', async () => {
  const { codex, store, sessionId, server, kinds } = await running();
  await codex.remove({ sessionId });
  assert.deepEqual(server.called('turn/interrupt'), [{ threadId: sessionId, turnId: 'turn-1' }]);
  assert.deepEqual(server.called('thread/delete'), [{ threadId: sessionId }]);
  assert.equal(store.find(sessionId), undefined);
  assert.deepEqual(kinds().slice(-2), ['session.ended', 'session.deleted']);
});

test('a connection that drops is made again, and its sessions go on', async () => {
  const { codex, store, server, sessionId, last } = await running();
  server.ask(4, 'item/commandExecution/requestApproval', { threadId: sessionId, itemId: 'exec-1' });
  server.threads.get(sessionId).status = { type: 'active', activeFlags: [] };
  server.drop();
  // What was asked over it can't be answered over it.
  assert.equal(store.requests().length, 0);
  assert.equal(last('request.closed').by, 'session_end');
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(server.links.filter(link => link.isOpen).length, 1);
  assert.equal(store.get(sessionId).status, 'running');
  assert.equal(server.called('thread/resume').at(-1).threadId, sessionId);
  codex.stop();
});

test('a daemon that\'s gone takes its sessions with it', async () => {
  const { store, server, sessionId, last } = await running();
  server.isRunning = false;
  server.drop();
  await new Promise(resolve => { setTimeout(resolve, 80); });
  assert.equal(store.get(sessionId).status, 'ended');
  assert.equal(last('session.ended').reason, 'disconnected');
  assert.equal(server.starts, 0);
});
