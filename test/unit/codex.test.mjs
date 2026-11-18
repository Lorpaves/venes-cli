import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions.mjs';
import {
  accessOf, approvalRequest, Codex, collaborationOf, commandOf, COMMANDS, historyOf, IMPLEMENT_PROMPT, planRequest, inputOf, picturesOf, pictureSourcesOf, readPicture, withoutPictures, isListed, isShellLine, isTool, isTrustedByCodex, libraryItem, MODE_IDS, modelsOf,
  creditsOf, limitResetsOf, mergedLimits, modeOf, otherLimitsOf, permissionsRequest, questionRequest, shellWords, skillsNamed, skillsOf, statusLineOf, terminalCommand, textOf, thinkingOf, trustedFolders,
  turnsOf, unwrapped,
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
    isRunning: true, starts: 0, next: 1, quiet: false, joined: {}, settings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
    skills: [
      { name: 'rex', description: 'Use the rex CLI to manage Rex sessions.\nMore about it.', path: '/skills/rex/SKILL.md', scope: 'user', enabled: true },
      { name: 'pdf:pdf', description: 'Long words about PDFs', interface: { shortDescription: 'Read, create, render, and verify PDF files' }, path: '/skills/pdf/SKILL.md', scope: 'user', enabled: true },
      { name: 'old', description: 'Turned off', path: '/skills/old/SKILL.md', scope: 'user', enabled: false },
    ],
    limits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_800_000_000 }, secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1_800_500_000 } },
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
      return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort, ...server.joined };
    },
    'thread/start': ({ cwd }) => {
      const thread = stored(`new-${server.next++}`, { cwd, source: 'vscode', preview: '', isNew: true });
      server.threads.set(thread.id, thread);
      server.loaded.add(thread.id);
      server.say('thread/started', { thread });
      return { thread, model: thread.model, reasoningEffort: thread.reasoningEffort };
    },
    'thread/list': () => ({ data: [...server.threads.values()] }),
    'thread/delete': ({ threadId }) => {
      if (server.fails.delete) throw rpcError(`cannot delete thread ${threadId}: forked history still references it`);
      server.threads.delete(threadId); server.loaded.delete(threadId); return {};
    },
    'thread/turns/list': ({ threadId, limit, cursor }) => {
      const newestFirst = [...(server.turns.get(threadId) ?? [])].reverse();
      const from = cursor ? Number(cursor) : 0;
      const data = newestFirst.slice(from, from + limit);
      return { data, nextCursor: from + limit < newestFirst.length ? String(from + limit) : null };
    },
    'turn/start': () => ({ turn: { id: 'turn', status: 'inProgress', items: [] } }),
    // Codex says what a thread's settings are once they've changed.
    'thread/settings/update': ({ threadId, collaborationMode }) => {
      if (!server.quiet) server.say('thread/settings/updated', { threadId, threadSettings: { ...server.settings, model: collaborationMode.settings.model, collaborationMode } });
      return {};
    },
    'turn/steer': () => ({}),
    'thread/shellCommand': () => ({}),
    'thread/compact/start': () => { if (server.fails.compact) throw rpcError('nothing to compact'); return {}; },
    'review/start': ({ threadId }) => ({ reviewThreadId: threadId, turn: { id: 'review', status: 'inProgress', items: [] } }),
    'thread/name/set': ({ threadId, name }) => { server.threads.get(threadId).name = name; return {}; },
    'thread/fork': ({ threadId }) => ({ thread: stored(`fork-of-${threadId}`) }),
    'thread/archive': () => ({}),
    'turn/interrupt': () => ({}),
    'model/list': () => ({ data: server.models }),
    'skills/list': ({ cwds = [] }) => {
      if (server.fails.skills) throw rpcError('no skills here');
      return { data: [{ cwd: cwds[0] ?? FOLDER, errors: [], skills: server.skills }] };
    },
    'account/rateLimits/read': () => ({ rateLimits: server.limits }),
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
  // A restart forgets what it had loaded, and its clients' connections go with it.
  server.restarts = 0;
  server.restartDaemon = async () => { server.restarts += 1; server.loaded.clear(); server.drop(); };
  return server;
}

function setup({ threads = [], loaded = [], isRunning = true, trusts = () => true, terminal = undefined, env = {}, kill = undefined, quitLimitMs = 60 } = {}) {
  const server = fakeCodex();
  server.isRunning = isRunning;
  for (const thread of threads) server.threads.set(thread.id, thread);
  for (const id of loaded) server.loaded.add(id);
  const store = new SessionStore();
  const events = [];
  store.on('event', event => events.push(event));
  const codex = new Codex({
    store, socketPath: '/nowhere', connect: server.connect, startDaemon: server.startDaemon, restartDaemon: server.restartDaemon, retryMs: 5, trusts,
    installed: () => isRunning, terminal, env: { PATH: '/bin', LANG: 'en_US.UTF-8', CODEX_HOME: '/codex-home', SECRET: 'not passed on', ...env }, keyLimitMs: 40,
    ...(kill && { kill }), quitLimitMs,
  });
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
  for (const type of ['userMessage', 'agentMessage', 'reasoning', 'plan', 'contextCompaction', 'subAgentActivity']) assert.equal(isTool({ type }), false);
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
  assert.equal(codex.isAvailable(), false);
  assert.equal(setup().codex.isAvailable(), true);
  await codex.restore();
  assert.deepEqual(await codex.library(), []);
  assert.equal(await codex.owns('anything'), false);
  assert.equal(codex.denies('anything'), false, 'a Codex that can\'t be asked hasn\'t said no');
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

test('the turns some events are of are the one the first is in, and every one after', () => {
  const starts = [{ id: 'a', after: 10 }, { id: 'b', after: 20 }, { id: 'c', after: 30 }];
  assert.deepEqual([...turnsOf([], starts)], []);
  assert.deepEqual([...turnsOf([{ seq: 31 }, { seq: 32 }], starts)], ['c']);
  assert.deepEqual([...turnsOf([{ seq: 25 }, { seq: 31 }], starts)], ['b', 'c']);
  assert.deepEqual([...turnsOf([{ seq: 11 }], starts)], ['a', 'b', 'c']);
  // Events from before any turn the helper heard start, which leaves every turn it did hear to them.
  assert.deepEqual([...turnsOf([{ seq: 5 }], starts)], ['a', 'b', 'c']);
  assert.deepEqual([...turnsOf([{ seq: 5 }])], []);
  // What's said once a turn is over is of no turn: that turn is history's, and the ones after aren't.
  const over = [{ id: 'a', after: 10, ended: 18 }, { id: 'b', after: 20, ended: 28 }, { id: 'c', after: 40 }];
  assert.deepEqual([[...turnsOf([{ seq: 29 }, { seq: 30 }], over)], [...turnsOf([{ seq: 28 }], over)], [...turnsOf([{ seq: 19 }], over)]], [['c'], ['b', 'c'], ['b', 'c']]);
  assert.deepEqual([...turnsOf([{ seq: 29 }], over.slice(0, 2))], []);
});

test('a turn that just ended and the one after it are both told as events, and neither twice', async () => {
  const { codex, sessionId, server, say } = await running();
  say('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'First.', phase: 'final_answer' } });
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  // The next turn starts within the two seconds a finished one still counts as going on.
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-2' } });
  server.say('item/started', { threadId: sessionId, turnId: 'turn-2', item: { type: 'userMessage', id: 'u2', clientId: 'c2', content: [{ type: 'text', text: 'and then' }] } });
  server.turns.set(sessionId, [turnOf(0), { ...turnOf(1), id: 'turn-1' }, { ...turnOf(2, 'inProgress'), id: 'turn-2' }]);
  const joined = await codex.join({ sessionId });
  assert.deepEqual(joined.items.map(item => item.text ?? item.role), ['ask 0', 'reply 0', 'turn_end']);
  assert.deepEqual(joined.turn.filter(event => event.kind === 'message.user').map(event => event.text), ['do it', 'and then']);
});

test('a session runs on what the reader chose from its next turn', async () => {
  const { codex, store, server, events, last } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  assert.deepEqual((await codex.capabilities()).models.map(model => model.value), ['gpt-6', 'gpt-5']);
  assert.deepEqual((await codex.capabilities()).commands.map(command => command.name), ['compact', 'review', 'init', 'rename', 'fork', 'archive']);
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

test('a line is a command when it starts with one the helper carries out, and a message otherwise', () => {
  assert.deepEqual(commandOf('/compact'), { name: 'compact', argument: '' });
  assert.deepEqual(commandOf('  /review  look at the tests\nand the docs  '), { name: 'review', argument: 'look at the tests\nand the docs' });
  assert.deepEqual(commandOf('/rename My thread'), { name: 'rename', argument: 'My thread' });
  assert.deepEqual(commandOf('/init'), { name: 'init', argument: '' });
  for (const message of ['/tmp/a.txt is what?', '/model', '/compactor', '/Compact', 'please /compact', '/', '', undefined, '/rename-it x']) assert.equal(commandOf(message), undefined, `${message}`);
  assert.deepEqual(COMMANDS.map(command => command.name), ['compact', 'review', 'init', 'rename', 'fork', 'archive']);
});

test('the commands on offer are carried out as Codex\'s terminal would, and aren\'t messages', async () => {
  const { codex, server, events, last } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  assert.deepEqual((await codex.capabilities()).commands.map(command => [command.name, command.argumentHint]), [['compact', ''], ['review', '[instructions]'], ['init', ''], ['rename', '<name>'], ['fork', ''], ['archive', '']]);

  await codex.send({ sessionId, text: '/compact', clientId: 'c1' });
  assert.deepEqual(server.called('thread/compact/start'), [{ threadId: sessionId }]);
  // The compaction it asked for is told as one made by hand, and the next one Codex makes by itself isn't.
  server.say('item/started', { threadId: sessionId, turnId: 't', item: { type: 'contextCompaction', id: 'k1' } });
  server.say('item/completed', { threadId: sessionId, turnId: 't', item: { type: 'contextCompaction', id: 'k1' } });
  assert.deepEqual([last('compact.start').trigger, last('compact.end').trigger], ['manual', 'manual']);
  server.say('item/started', { threadId: sessionId, turnId: 't', item: { type: 'contextCompaction', id: 'k2' } });
  assert.equal(last('compact.start').trigger, 'auto');

  await codex.send({ sessionId, text: '/review', clientId: 'c-review' });
  // Codex opens the review with a message of its own, which is told as the line that asked for it.
  server.say('item/started', { threadId: sessionId, turnId: 'r', item: { type: 'userMessage', id: 'u-review', clientId: null, content: [{ type: 'text', text: 'Review the current code changes.' }] } });
  assert.deepEqual([last('message.user').text, last('message.user').clientId], ['Review the current code changes.', 'c-review']);
  // Only that one message: the next with no send to name is someone's at Codex's own terminal.
  server.say('item/started', { threadId: sessionId, turnId: 'r', item: { type: 'userMessage', id: 'u-other', clientId: null, content: [{ type: 'text', text: 'typed at the Mac' }] } });
  assert.equal(last('message.user').clientId, undefined);
  server.say('turn/completed', { threadId: sessionId, turn: { id: 'r', status: 'completed' } });
  await codex.send({ sessionId, text: '/review only the tests' });
  assert.deepEqual(server.called('review/start').map(call => call.target), [{ type: 'uncommittedChanges' }, { type: 'custom', instructions: 'only the tests' }]);

  await codex.send({ sessionId, text: '/rename  Fix the header ' });
  assert.deepEqual(server.called('thread/name/set'), [{ threadId: sessionId, name: 'Fix the header' }]);
  await assert.rejects(codex.send({ sessionId, text: '/rename' }), error => error.code === 'command_failed' && /Usage: \/rename/.test(error.message));
  // None of them went to Codex as something said, and none but the review's own opening is told as a message.
  assert.equal(server.called('turn/start').length, 0);
  assert.equal(events.filter(event => event.kind === 'message.user').length, 2);

  // /init is a message, in the terminal's own words, and a path is one in the reader's.
  await codex.send({ sessionId, text: '/init', clientId: 'c2' });
  await codex.send({ sessionId, text: '/tmp/a.txt is what?' });
  const [init, path] = server.called('turn/start');
  assert.match(init.input[0].text, /^Generate a file named AGENTS\.md that serves as a contributor guide for this repository\./);
  assert.match(init.input[0].text, /adapt as needed — add sections[\s\S]*project’s Git history/);
  assert.equal(init.clientUserMessageId, 'c2');
  assert.equal(path.input[0].text, '/tmp/a.txt is what?');
});

test('a command waits for the turn to end, as it does in Codex\'s terminal, and says why when Codex won\'t', async () => {
  const { codex, sessionId, server } = await running();
  await assert.rejects(codex.send({ sessionId, text: '/compact' }), error => error.code === 'command_failed' && error.message === "'/compact' is disabled while a task is in progress.");
  await assert.rejects(codex.send({ sessionId, text: '/review' }), error => error.code === 'command_failed');
  assert.deepEqual([server.called('thread/compact/start').length, server.called('review/start').length], [0, 0]);
  // A name can be given at any time.
  await codex.send({ sessionId, text: '/rename During a turn' });
  assert.equal(server.called('thread/name/set').length, 1);

  const idle = setup();
  const started = await idle.codex.start({ cwd: FOLDER });
  idle.server.fails.compact = true;
  await assert.rejects(idle.codex.send({ sessionId: started.sessionId, text: '/compact' }), error => error.code === 'command_failed' && /nothing to compact/.test(error.message));
  // One that failed isn't taken for the next compaction's cause.
  idle.server.say('item/started', { threadId: started.sessionId, turnId: 't', item: { type: 'contextCompaction', id: 'k' } });
  assert.equal(idle.last('compact.start').trigger, 'auto');
});

test('a folder\'s skills are those Codex has on, each with a line of what it\'s for', () => {
  const data = [
    { cwd: '/other', errors: [], skills: [{ name: 'theirs', description: 'Another folder\'s', path: '/o/SKILL.md', enabled: true }] },
    { cwd: '/w', errors: [], skills: [
      { name: 'rex', description: 'Use the rex CLI.\nAnd more.', path: '/s/rex/SKILL.md', enabled: true },
      { name: 'pdf:pdf', description: 'Long', shortDescription: 'Older short', interface: { shortDescription: ' Read PDFs ' }, path: '/s/pdf/SKILL.md', enabled: true },
      { name: 'docs', description: 'Long', shortDescription: 'Docs, briefly', path: '/s/docs/SKILL.md' },
      { name: 'off', description: 'Turned off', path: '/s/off/SKILL.md', enabled: false }, { description: 'No name', path: '/s/x/SKILL.md', enabled: true },
    ] },
  ];
  assert.deepEqual(skillsOf(data, '/w'), [
    { name: 'rex', description: 'Use the rex CLI.', path: '/s/rex/SKILL.md' }, { name: 'pdf:pdf', description: 'Read PDFs', path: '/s/pdf/SKILL.md' },
    { name: 'docs', description: 'Docs, briefly', path: '/s/docs/SKILL.md' },
  ]);
  // Asked of one folder, the answer is that folder's, whatever it's called there.
  assert.deepEqual(skillsOf(data.slice(0, 1), '/elsewhere').map(skill => skill.name), ['theirs']);
  assert.deepEqual([skillsOf(), skillsOf([]), skillsOf([{ cwd: '/w', errors: [] }], '/w')], [[], [], []]);
});

test('a message names a skill with a dollar sign at the start of a word', () => {
  const skills = [{ name: 'rex', path: '/r' }, { name: 'pdf:pdf', path: '/p' }, { name: 'excel-live', path: '/e' }];
  const named = text => skillsNamed(text, skills).map(skill => skill.name);
  assert.deepEqual(named('$rex open a tab, then $pdf:pdf, and $rex again'), ['rex', 'pdf:pdf']);
  assert.deepEqual(named('Use $excel-live.'), ['excel-live']);
  assert.deepEqual(named('$rex: split the pane'), ['rex']);
  // A shell variable, a price, a word with one in its middle, and a name that's no skill's name nothing.
  for (const text of ['echo ${rex} and $HOME', 'it costs $5 or US$rex', 'a$rex', '$$rex', '$rexes', '$', '', undefined]) assert.deepEqual(named(text), [], `${text}`);
  assert.deepEqual(skillsNamed('$rex'), []);
});

test('a session offers its folder\'s skills, and a message that names one takes it along', async () => {
  const { codex, server } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const { skills } = await codex.capabilities({ sessionId });
  assert.deepEqual(skills, [{ name: 'rex', description: 'Use the rex CLI to manage Rex sessions.' }, { name: 'pdf:pdf', description: 'Read, create, render, and verify PDF files' }]);
  assert.deepEqual(server.called('skills/list'), [{ cwds: [FOLDER] }]);

  await codex.send({ sessionId, text: 'Use $rex and $pdf:pdf, not $old or $nothing', clientId: 'c1' });
  const [turn] = server.called('turn/start');
  assert.deepEqual(turn.input, [
    { type: 'text', text: 'Use $rex and $pdf:pdf, not $old or $nothing', text_elements: [] },
    { type: 'skill', name: 'rex', path: '/skills/rex/SKILL.md' }, { type: 'skill', name: 'pdf:pdf', path: '/skills/pdf/SKILL.md' },
  ]);
  // The list is asked for once for a while, and a message with no dollar sign in it asks for nothing.
  await codex.send({ sessionId, text: 'plain words' });
  assert.equal(server.called('skills/list').length, 1);
  assert.deepEqual(server.called('turn/start')[1].input, [{ type: 'text', text: 'plain words', text_elements: [] }]);
});

test('a server that lists no skills leaves a message as it is, and the rest of what\'s on offer', async () => {
  const { codex, server } = setup();
  server.fails.skills = true;
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const offered = await codex.capabilities({ sessionId });
  assert.deepEqual([offered.skills, offered.commands.length, offered.models.length], [[], 6, 2]);
  await codex.send({ sessionId, text: 'Use $rex' });
  assert.deepEqual(server.called('turn/start')[0].input, [{ type: 'text', text: 'Use $rex', text_elements: [] }]);
});

test('Codex\'s terminal is opened on a thread as another client of the server that has it', () => {
  // With nothing of the thread's permissions, which Codex refuses for a thread it joins on a server.
  assert.deepEqual(terminalCommand('/s/c.sock', 'abc'), ['codex', '--remote', 'unix:///s/c.sock', 'resume', 'abc']);
});

// A terminal that writes down what it was asked to open.
function fakeTerminal({ fails = false } = {}) {
  const opened = [];
  return { opened, startSession: async asked => { opened.push(asked); if (fails) throw new Error('no terminal here'); return { pane: '%1' }; } };
}

test('a session the helper starts is opened in Codex\'s terminal at the Mac once it has a turn, and only once', async () => {
  const terminal = fakeTerminal();
  const { codex, server } = setup({ terminal });
  const { sessionId } = await codex.start({ cwd: FOLDER });
  // Before its first turn there's nothing for another of Codex's clients to join.
  assert.equal(terminal.opened.length, 0);
  await codex.setMode({ sessionId, mode: 'readOnly' });
  await codex.send({ sessionId, text: 'go' });
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-1' } });
  await Promise.resolve();
  assert.equal(terminal.opened.length, 1);
  const [asked] = terminal.opened;
  assert.deepEqual([asked.name, asked.cwd], [`venes-codex-${sessionId.slice(0, 8)}`, FOLDER]);
  assert.deepEqual(asked.command, ['codex', '--remote', 'unix:///nowhere', 'resume', sessionId]);
  assert.deepEqual(asked.env, { PATH: '/bin', LANG: 'en_US.UTF-8', CODEX_HOME: '/codex-home' });
  server.say('turn/completed', { threadId: sessionId, turn: { id: 'turn-1', status: 'completed' } });
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-2' } });
  await Promise.resolve();
  assert.equal(terminal.opened.length, 1);
});

test('a stored session the helper loads gets a terminal too, and one another client started doesn\'t', async () => {
  const terminal = fakeTerminal();
  const { codex, server } = setup({ terminal, threads: [stored('old', { cwd: FOLDER })] });
  await codex.send({ sessionId: 'old', text: 'carry on' });
  server.say('turn/started', { threadId: 'old', turn: { id: 'turn-1' } });
  await Promise.resolve();
  assert.deepEqual(terminal.opened.map(asked => asked.command.at(-1)), ['old']);
  // A thread started from Codex's own app or terminal is in front of whoever started it already.
  const theirs = stored('theirs', { cwd: FOLDER, status: { type: 'idle' } });
  server.threads.set('theirs', theirs);
  server.loaded.add('theirs');
  server.say('thread/started', { thread: theirs });
  server.say('turn/started', { threadId: 'theirs', turn: { id: 'turn-9' } });
  await Promise.resolve();
  assert.equal(terminal.opened.length, 1);
});

test('with no terminal to open, or one that won\'t, the session goes on', async () => {
  const none = setup();
  const first = await none.codex.start({ cwd: FOLDER });
  none.server.say('turn/started', { threadId: first.sessionId, turn: { id: 'turn-1' } });
  assert.equal(none.store.get(first.sessionId).status, 'idle');

  const terminal = fakeTerminal({ fails: true });
  const { codex, server, store } = setup({ terminal });
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const { error } = console;
  console.error = () => {};
  try {
    server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-1' } });
    await new Promise(resolve => { setTimeout(resolve, 5); });
  } finally {
    console.error = error;
  }
  assert.equal(terminal.opened.length, 1);
  server.say('item/started', { threadId: sessionId, turnId: 'turn-1', item: { type: 'agentMessage', id: 'm1', text: '', phase: 'final_answer' } });
  assert.equal(store.get(sessionId).status, 'running');
});

test('a thread\'s settings are one of the three choices Codex gives, or the reader\'s own', () => {
  assert.equal(modeOf({ approvalPolicy: 'on-request', sandbox: { type: 'readOnly' } }), 'readOnly');
  assert.equal(modeOf({ approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } }), 'workspace');
  assert.equal(modeOf({ approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' } }), 'fullAccess');
  for (const own of [
    { approvalPolicy: 'never', sandbox: { type: 'workspaceWrite' } }, { approvalPolicy: 'untrusted', sandbox: { type: 'readOnly' } },
    { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite', networkAccess: true } }, { approvalPolicy: 'on-request', sandbox: { type: 'dangerFullAccess' } },
    { approvalPolicy: { granular: { rules: true, sandbox_approval: true, mcp_elicitations: true } }, sandbox: { type: 'workspaceWrite' } },
    { approvalPolicy: 'never', sandbox: { type: 'externalSandbox' } },
  ]) assert.equal(modeOf(own), 'custom', JSON.stringify(own));
  for (const untold of [undefined, {}, { approvalPolicy: 'never' }, { sandbox: { type: 'readOnly' } }, { approvalPolicy: 'never', sandbox: {} }]) assert.equal(modeOf(untold), undefined);
  assert.deepEqual(MODE_IDS, ['readOnly', 'workspace', 'fullAccess', 'plan']);
  // A thread that's planning is in plan mode, whichever of the three it has meanwhile.
  const planning = { approvalPolicy: 'never', sandbox: { type: 'dangerFullAccess' }, collaborationMode: { mode: 'plan', settings: { model: 'gpt-6' } } };
  assert.deepEqual([modeOf(planning), accessOf(planning)], ['plan', 'fullAccess']);
  assert.deepEqual([modeOf({ ...planning, collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } }), modeOf({ collaborationMode: planning.collaborationMode })], ['fullAccess', 'plan']);
  // Codex is told to plan, or to stop, with the model and effort it's on, and its own instructions for the mode.
  assert.deepEqual(collaborationOf({ plans: true, model: 'gpt-6', effort: 'high' }), { mode: 'plan', settings: { model: 'gpt-6', reasoning_effort: 'high', developer_instructions: null } });
  assert.deepEqual(collaborationOf({ plans: false, model: 'gpt-6' }), { mode: 'default', settings: { model: 'gpt-6', reasoning_effort: null, developer_instructions: null } });
});

test('a session starts and stops planning at once, and goes back to what it could do before', async () => {
  const { codex, store, server, last, events } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-6', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }, collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } } });
  server.settings = { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  assert.equal(store.get(sessionId).permissionMode, 'fullAccess');

  assert.deepEqual(await codex.setMode({ sessionId, mode: 'plan' }), {});
  assert.deepEqual(server.called('thread/settings/update'), [{ threadId: sessionId, collaborationMode: { mode: 'plan', settings: { model: 'gpt-6', reasoning_effort: 'high', developer_instructions: null } } }]);
  assert.deepEqual([store.get(sessionId).permissionMode, last('session.mode').permissionMode, last('session.mode').permissionModes], ['plan', 'plan', MODE_IDS]);
  // Said once, whether Codex's word of it or the helper's own came first.
  assert.equal(events.filter(event => event.kind === 'session.mode' && event.permissionMode === 'plan').length, 1);
  // Picked again, there's nothing to tell Codex.
  await codex.setMode({ sessionId, mode: 'plan' });
  assert.equal(server.called('thread/settings/update').length, 1);
  // A turn in it is started as any is: Codex has the mode already.
  await codex.send({ sessionId, text: 'plan it' });
  assert.deepEqual([server.called('turn/start')[0].collaborationMode, server.called('turn/start')[0].approvalPolicy], [undefined, undefined]);

  // Stopped from Codex's terminal, it's back in the one of the three it had.
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { ...server.settings, model: 'gpt-6', collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } } });
  assert.deepEqual([store.get(sessionId).permissionMode, last('session.mode').permissionMode], ['fullAccess', 'fullAccess']);

  // Another of the three picked while it plans stops the planning at once, and is taken with the next turn.
  await codex.setMode({ sessionId, mode: 'plan' });
  await codex.configure({ sessionId, model: 'gpt-5', effort: 'low' });
  await codex.setMode({ sessionId, mode: 'readOnly' });
  assert.deepEqual(server.called('thread/settings/update').at(-1).collaborationMode, { mode: 'default', settings: { model: 'gpt-5', reasoning_effort: 'low', developer_instructions: null } });
  assert.deepEqual([store.get(sessionId).permissionMode, events.at(-1).kind === 'session.mode' && events.at(-1).permissionMode], ['readOnly', 'readOnly']);
  await codex.send({ sessionId, text: 'look' });
  assert.deepEqual([server.called('turn/start').at(-1).approvalPolicy, server.called('turn/start').at(-1).sandboxPolicy], ['on-request', { type: 'readOnly' }]);

  // A Codex that won't take it leaves the session as it was.
  server.fails['thread/settings/update'] = 'unknown method';
  await assert.rejects(codex.setMode({ sessionId, mode: 'plan' }), error => error.code === 'mode_unavailable');
  assert.equal(store.get(sessionId).permissionMode, 'readOnly');
});

test('a thread that\'s planning when it\'s loaded is in plan mode', async () => {
  const thread = stored('planning');
  const { codex, store, server } = setup({ threads: [thread] });
  server.joined = { approvalPolicy: 'on-request', sandbox: { type: 'workspaceWrite' }, collaborationMode: { mode: 'plan', settings: { model: 'gpt-6' } } };
  await codex.send({ sessionId: 'planning', text: 'go on' });
  assert.equal(store.get('planning').permissionMode, 'plan');
  // Out of it, it has what it had under the planning.
  server.say('thread/settings/updated', { threadId: 'planning', threadSettings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } } });
  assert.equal(store.get('planning').permissionMode, 'workspace');
});

// A session that's planning, with a turn that has written a plan.
async function planned(options) {
  const made = await running(options);
  const { server, sessionId, say, codex } = made;
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-6', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } } });
  await codex.setMode({ sessionId, mode: 'plan' });
  say('item/started', { item: { type: 'plan', id: 'turn-1-plan', text: '' } });
  say('item/plan/delta', { itemId: 'turn-1-plan', delta: '1. Look' });
  say('item/completed', { item: { type: 'plan', id: 'turn-1-plan', text: '1. Look\n2. Fix\n' } });
  return made;
}

test('a plan Codex writes is told as a proposed plan, and asked about once its turn is over', async () => {
  const { store, server, sessionId, say, last, events } = await planned();
  // Whole, as a call a client shows as a proposed plan.
  assert.deepEqual([last('tool.start').name, last('tool.start').toolUseId, last('tool.start').input], ['ExitPlanMode', 'turn-1-plan', { plan: '1. Look\n2. Fix\n' }]);
  assert.deepEqual([last('tool.end').name, last('tool.end').toolUseId, last('tool.end').isError], ['ExitPlanMode', 'turn-1-plan', false]);
  assert.equal(events.filter(event => event.kind === 'tool.start').length, 1);
  assert.equal(store.requests().length, 0);

  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const [request] = store.requests();
  assert.deepEqual([request.kind, request.toolName, request.toolUseId, request.input, request.options], ['plan', 'ExitPlanMode', 'turn-1-plan', { plan: '1. Look\n2. Fix\n' }, [{ id: 'implement', label: 'Yes, implement this plan' }]]);
  // After the turn's end, which is when Codex's terminal asks.
  assert.deepEqual([store.get(sessionId).status, events.at(-1).kind, events.findLastIndex(event => event.kind === 'turn.end') < events.length - 1], ['waiting', 'request.opened', true]);

  // Yes ends the planning, and says so to Codex in its terminal's words.
  await assert.rejects(async () => store.respond(request.id, { decision: 'allow', option: 'other' }), error => error.code === 'bad_option');
  store.respond(request.id, { decision: 'allow', option: 'implement' });
  await settle();
  await settle();
  assert.deepEqual(server.called('thread/settings/update').at(-1).collaborationMode.mode, 'default');
  assert.deepEqual(server.called('turn/start').at(-1).input, [{ type: 'text', text: IMPLEMENT_PROMPT, text_elements: [] }]);
  assert.deepEqual([store.get(sessionId).permissionMode, store.get(sessionId).status, last('request.closed').decision, last('request.closed').by], ['workspace', 'running', 'allow', 'client']);
  assert.ok(server.calls.findLastIndex(call => call.method === 'thread/settings/update') < server.calls.findLastIndex(call => call.method === 'turn/start'));
  // What a page of its history has of it is the same call.
  const [, call] = historyOf({ id: 'turn-1', status: 'completed', items: [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'plan it' }] }, { type: 'plan', id: 'turn-1-plan', text: '1. Look' }] });
  assert.deepEqual([call.role, call.toolUseId, call.name, call.input, call.result, call.isError], ['tool', 'turn-1-plan', 'ExitPlanMode', { plan: '1. Look' }, { plan: '1. Look' }, false]);
});

test('a client that joins while a plan waits is told the plan\'s turn, then as history', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const { server, sessionId, say, codex } = await planned();
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  server.turns.set(sessionId, [{
    id: 'turn-1', status: 'completed',
    items: [{ type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'do it' }] }, { type: 'plan', id: 'turn-1-plan', text: '1. Look\n2. Fix\n' }],
  }]);
  // At once, the turn is still what's going on, and the request is the last of it.
  const atOnce = await codex.join({ sessionId });
  assert.deepEqual([atOnce.items.length, atOnce.turn.some(event => event.kind === 'tool.start'), atOnce.turn.at(-1).kind, atOnce.requests.length], [0, true, 'request.opened', 1]);
  // Later the turn is history, all of it, and what's going on is that the plan waits.
  t.mock.timers.tick(3000);
  const later = await codex.join({ sessionId });
  assert.deepEqual([later.items.map(item => item.role), later.items[1].name, later.items[1].input, later.turn.map(event => event.kind), later.requests.length],
    [['user', 'tool', 'turn_end'], 'ExitPlanMode', { plan: '1. Look\n2. Fix\n' }, ['session.status', 'request.opened'], 1]);
});

// Codex's own terminal at the Mac, with its question about a plan showing until one of its rows is pressed.
function askingTerminal() {
  const question = ['  Implement this plan?', '', '› 1. Yes, implement this plan          Switch to Default and start coding',
    '  2. Yes, clear context and implement  Start a fresh thread (current context: 5% used)', '  3. No, stay in Plan mode             Continue planning with the model', '', '  enter select · esc back'].join('\n');
  const terminal = {
    ...fakeTerminal(), screen: question, keys: [], found: [],
    findSession: async (name, env) => { terminal.found.push([name, Object.keys(env)]); return terminal.isGone ? undefined : { pane: '%1' }; },
    readScreen: async () => terminal.screen,
    pressKey: async (_, key) => { terminal.keys.push(key); if (!terminal.isStuck) terminal.screen = '› Ask Codex to do anything'; },
  };
  return terminal;
}

test('a plan answered from a client is put away in Codex\'s terminal at the Mac first, with the row that changes nothing', async () => {
  const terminal = askingTerminal();
  const { store, server, sessionId, say } = await planned({ terminal });
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const before = server.calls.length;
  terminal.pressKey = (press => async (target, key) => { terminal.at = server.calls.length - before; return press(target, key); })(terminal.pressKey);
  store.respond(store.requests()[0].id, { decision: 'allow', option: 'implement' });
  await settle();
  await settle();
  await settle();
  // Its own third row, before Codex is told anything, and then the plan is carried out as before.
  assert.deepEqual([terminal.keys, terminal.at, terminal.found.at(-1)], [['3'], 0, [`venes-codex-${sessionId.slice(0, 8)}`, ['PATH', 'LANG', 'CODEX_HOME']]]);
  assert.deepEqual([server.called('thread/settings/update').at(-1).collaborationMode.mode, server.called('turn/start').at(-1).input[0].text], ['default', IMPLEMENT_PROMPT]);
});

test('with no question in Codex\'s terminal, or no terminal, nothing is pressed and the answer still goes', async () => {
  // Something else on its screen, as once the question was answered there.
  const waiting = askingTerminal();
  waiting.screen = '› Ask Codex to do anything\n\n  ? for shortcuts';
  // No terminal of the helper's on the thread any more.
  const gone = askingTerminal();
  gone.isGone = true;
  // A question that stays whatever's pressed is left to whoever's at the Mac.
  const stuck = askingTerminal();
  stuck.isStuck = true;
  for (const [terminal, keys] of [[waiting, []], [gone, []], [stuck, ['3']]]) {
    const { store, server, say } = await planned({ terminal });
    say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    store.respond(store.requests()[0].id, { decision: 'deny', message: 'Shorter.' });
    await new Promise(resolve => { setTimeout(resolve, 90); });
    assert.deepEqual([terminal.keys, server.called('turn/start').at(-1).input[0].text], [keys, 'Shorter.']);
  }
  // A plan left alone from here, as one answered at the Mac, has nothing put away.
  const left = askingTerminal();
  const { server, sessionId, say } = await planned({ terminal: left });
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-2' } });
  await settle();
  assert.deepEqual(left.keys, []);
});

test('a plan sent back with what to change goes on being planned', async () => {
  const { store, server, sessionId, say } = await planned();
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  const [request] = store.requests();
  store.respond(request.id, { decision: 'deny', message: '  Skip the second step.  ' });
  await settle();
  await settle();
  assert.deepEqual(server.called('turn/start').at(-1).input, [{ type: 'text', text: 'Skip the second step.', text_elements: [] }]);
  assert.deepEqual([store.get(sessionId).permissionMode, store.get(sessionId).status, server.called('thread/settings/update').length], ['plan', 'running', 1]);

  // The next plan is asked about in its turn, and a bare no leaves the session at rest, still planning.
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-2' } });
  server.say('item/completed', { threadId: sessionId, turnId: 'turn-2', item: { type: 'plan', id: 'turn-2-plan', text: '1. Look\n' } });
  server.say('turn/completed', { threadId: sessionId, turn: { id: 'turn-2', status: 'completed' } });
  const [second] = store.requests();
  assert.deepEqual(second.input, { plan: '1. Look\n' });
  const turns = server.called('turn/start').length;
  store.respond(second.id, { decision: 'deny' });
  await settle();
  assert.deepEqual([store.get(sessionId).status, store.get(sessionId).permissionMode, server.called('turn/start').length, store.requests().length], ['idle', 'plan', turns, 0]);
});

test('a plan answered from Codex\'s terminal, or left behind, stops being asked about', async () => {
  const { store, server, sessionId, say, last } = await planned();
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  // A turn started from somewhere else.
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-2' } });
  await settle();
  assert.deepEqual([store.requests().length, last('request.closed').by, store.get(sessionId).status], [0, 'terminal', 'running']);
  // The planning stopped from somewhere else, with no turn.
  server.say('item/completed', { threadId: sessionId, turnId: 'turn-2', item: { type: 'plan', id: 'turn-2-plan', text: 'Again' } });
  server.say('turn/completed', { threadId: sessionId, turn: { id: 'turn-2', status: 'completed' } });
  assert.equal(store.requests().length, 1);
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' }, collaborationMode: { mode: 'default', settings: { model: 'gpt-6' } } } });
  await settle();
  assert.deepEqual([store.requests().length, last('request.closed').by, store.get(sessionId).status, store.get(sessionId).permissionMode], [0, 'terminal', 'idle', 'workspace']);
});

test('a plan isn\'t asked about after a turn that was stopped, or one that wasn\'t planning', async () => {
  const stopped = await planned();
  stopped.say('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
  assert.equal(stopped.store.requests().length, 0);
  // The plan a turn before wrote isn't the next turn's.
  stopped.server.say('turn/started', { threadId: stopped.sessionId, turn: { id: 'turn-2' } });
  stopped.server.say('turn/completed', { threadId: stopped.sessionId, turn: { id: 'turn-2', status: 'completed' } });
  assert.equal(stopped.store.requests().length, 0);

  const left = await planned();
  await left.codex.setMode({ sessionId: left.sessionId, mode: 'workspace' });
  left.say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(left.store.requests().length, 0);
});

test('a plan\'s answers are to carry it out, or to go on planning', () => {
  const { fields, decide } = planRequest({ type: 'plan', id: 'p1', text: 'Do it' });
  assert.deepEqual(fields, { kind: 'plan', agent: 'codex', toolName: 'ExitPlanMode', toolUseId: 'p1', input: { plan: 'Do it' }, options: [{ id: 'implement', label: 'Yes, implement this plan' }] });
  assert.deepEqual([decide({ decision: 'allow' }), decide({ decision: 'allow', option: 'implement' })], [{ implements: true }, { implements: true }]);
  assert.deepEqual([decide({ decision: 'deny' }), decide({ decision: 'deny', message: ' Less. ' }), decide({ decision: 'deny', message: '  ' })], [{ implements: false }, { implements: false, followUp: 'Less.' }, { implements: false }]);
  assert.throws(() => decide({ decision: 'allow', option: 'session' }), error => error.code === 'bad_option');
  assert.throws(() => decide({ decision: 'maybe' }), error => error.code === 'bad_decision');
  assert.equal(planRequest({ type: 'plan', id: 'p2' }).fields.input.plan, '');
});

test('a session may do what the reader chose from its next turn, and says so at once', async () => {
  const { codex, store, server, last } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  assert.deepEqual(store.get(sessionId).permissionModes, MODE_IDS);
  assert.deepEqual(store.sessions().find(session => session.id === sessionId).permissionModes, MODE_IDS);
  // What it runs with is told when it's joined, and whenever Codex says it has changed.
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-6', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  assert.deepEqual([store.get(sessionId).permissionMode, last('session.mode').permissionMode, last('session.mode').permissionModes], ['fullAccess', 'fullAccess', MODE_IDS]);

  for (const mode of ['custom', 'bypassPermissions', undefined, 'constructor']) await assert.rejects(codex.setMode({ sessionId, mode }), error => error.code === 'bad_mode', `${mode}`);
  await assert.rejects(codex.setMode({ sessionId: 'nobody', mode: 'readOnly' }), error => error.code === 'unknown_session');
  assert.deepEqual(await codex.setMode({ sessionId, mode: 'readOnly' }), {});
  assert.deepEqual([store.get(sessionId).permissionMode, last('session.mode').permissionMode], ['readOnly', 'readOnly']);
  // Until the turn that takes it, Codex still says what the thread had, which isn't what's shown.
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { model: 'gpt-6', approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } } });
  assert.equal(store.get(sessionId).permissionMode, 'readOnly');
  await codex.configure({ sessionId, effort: 'low' });
  await codex.send({ sessionId, text: 'go' });
  const [first] = server.called('turn/start');
  assert.deepEqual([first.approvalPolicy, first.sandboxPolicy, first.effort], ['on-request', { type: 'readOnly' }, 'low']);
  // It holds for the turns after, so it's sent once.
  await codex.send({ sessionId, text: 'again' });
  assert.deepEqual([server.called('turn/start')[1].approvalPolicy, server.called('turn/start')[1].sandboxPolicy], [undefined, undefined]);
  // Settings of the reader's own, from Codex's terminal, are told as that.
  server.say('thread/settings/updated', { threadId: sessionId, threadSettings: { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite', networkAccess: true } } });
  assert.equal(store.get(sessionId).permissionMode, 'custom');
  await codex.setMode({ sessionId, mode: 'workspace' });
  await codex.send({ sessionId, text: 'third' });
  assert.deepEqual(server.called('turn/start')[2].sandboxPolicy, { type: 'workspaceWrite' });
});

test('the library has Codex\'s stored threads, and says which are going on', async () => {
  const { codex } = setup({ threads: [stored('live', { status: { type: 'active', activeFlags: [] } }), stored('old'), stored('sub', { parentThreadId: 'live' })], loaded: ['live'] });
  const items = await codex.library();
  assert.deepEqual(items.map(item => [item.id, item.status, item.agent]), [['live', 'running', 'codex'], ['old', null, 'codex']]);
});

test('whose a session is gets asked of Codex once', async () => {
  const { codex, server, store } = setup({ threads: [stored('old')] });
  assert.equal(await codex.owns('old'), true);
  assert.equal(codex.denies('claude-session'), false, 'not asked yet, so not said');
  assert.equal(await codex.owns('claude-session'), false);
  assert.equal(await codex.owns('claude-session'), false);
  assert.equal(server.called('thread/read').length, 2);
  // Codex said it has no such thread, which is what lets a client be told a session has gone.
  assert.equal(codex.denies('claude-session'), true);
  assert.equal(codex.denies('old'), false);
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

test('a status is what Codex says of the session and the account, as Claude Code\'s status line would', () => {
  const session = { model: 'gpt-6', effort: 'high', cwd: '/Users/me/app' };
  const usage = { last: { totalTokens: 20_868, inputTokens: 20_822 }, total: { totalTokens: 90_000 }, modelContextWindow: 258_400 };
  const limits = { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1_794_662_176 }, secondary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1_795_230_430 } };
  assert.deepEqual(statusLineOf({ session, usage, limits, branch: 'main', at: 1_794_659_546_700 }), {
    model: 'gpt-6', effort: 'high', project: 'app', branch: 'main', context: { percent: 8.1, used: 20_868, size: 258_400 },
    fiveHour: { percent: 100, resetsAt: 1_794_662_176 }, sevenDay: { percent: 31, resetsAt: 1_795_230_430 }, updatedAt: 1_794_659_546,
  });
  // Before a first reply there's no context to speak of, and a window of some other length isn't one of the two.
  assert.deepEqual(statusLineOf({ session, limits: { primary: { usedPercent: 5, windowDurationMins: 60 }, secondary: null }, at: 1000 }), {
    model: 'gpt-6', effort: 'high', project: 'app', branch: undefined, updatedAt: 1,
  });
});

test('a status has what an account has past its plan\'s limits: the limits metered apart, the credits left, and the resets to hand', () => {
  const session = { model: 'gpt-6', effort: 'high', cwd: '/Users/me/app' };
  const plan = {
    limitId: 'codex', limitName: null, primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1_794_747_670 },
    secondary: { usedPercent: 43, windowDurationMins: 10080, resetsAt: 1_795_230_430 }, credits: { hasCredits: true, unlimited: false, balance: '36521.0736720000' },
  };
  const spark = { limitId: 'codex_spark', limitName: 'GPT-6-Codex-Spark', primary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1_794_747_000 }, secondary: { usedPercent: 9, windowDurationMins: 10080 } };
  const resets = { availableCount: 2, credits: [
    { id: 'a', resetType: 'codexRateLimits', status: 'available', grantedAt: 1_794_516_945, expiresAt: 1_797_108_945, title: 'Full reset (Weekly + 5 hr)', description: 'Thanks.' },
    { id: 'b', resetType: 'codexRateLimits', status: 'redeemed', grantedAt: 1, expiresAt: null, title: 'Used' },
    { id: 'c', resetType: 'codexRateLimits', status: 'available', grantedAt: 1, expiresAt: null, title: null },
  ] };
  const status = statusLineOf({ session, limits: plan, others: { codex: plan, codex_spark: spark }, resets, at: 1000 });
  assert.deepEqual([status.fiveHour, status.sevenDay], [{ percent: 29, resetsAt: 1_794_747_670 }, { percent: 43, resetsAt: 1_795_230_430 }]);
  assert.deepEqual(status.limits, [
    { name: 'GPT-6-Codex-Spark', window: 'fiveHour', percent: 4, resetsAt: 1_794_747_000 }, { name: 'GPT-6-Codex-Spark', window: 'sevenDay', percent: 9 },
  ]);
  assert.deepEqual(status.credits, { unlimited: false, balance: 36521.073672 });
  assert.deepEqual(status.limitResets, [{ title: 'Full reset (Weekly + 5 hr)', expiresAt: 1_797_108_945 }, {}]);

  assert.deepEqual([creditsOf({ hasCredits: true, unlimited: true, balance: null }), creditsOf({ hasCredits: false, unlimited: false, balance: '0' }), creditsOf(null), creditsOf({ hasCredits: true, balance: 'lots' })],
    [{ unlimited: true }, undefined, undefined, { unlimited: false }]);
  // One with no name of its own goes by its id, and the plan's own isn't one of them.
  assert.deepEqual(otherLimitsOf({ codex: plan, other: { limitId: 'other', limitName: null, primary: { usedPercent: 1, windowDurationMins: 300 } } }), [{ name: 'other', window: 'fiveHour', percent: 1 }]);
  assert.deepEqual([otherLimitsOf(null), otherLimitsOf({ codex: plan })], [[], []]);
  // Told only how many resets there are, that many with nothing said of them.
  assert.deepEqual([limitResetsOf({ availableCount: 2, credits: null }), limitResetsOf({ availableCount: 0, credits: [] }), limitResetsOf(null)], [[{}, {}], [], []]);
  // An account with none of these has none of them in its status.
  const bare = statusLineOf({ session, limits: { ...plan, credits: { hasCredits: false, unlimited: false, balance: null } }, others: { codex: plan }, resets: { availableCount: 0, credits: [] }, at: 1000 });
  assert.deepEqual(['limits', 'credits', 'limitResets'].filter(key => key in bare), []);
  // A notice of a change keeps the credits and the plan it leaves out, and its windows are as it says.
  assert.deepEqual(mergedLimits({ ...plan, planType: 'plus' }, { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300 }, secondary: null, credits: null }),
    { limitId: 'codex', primary: { usedPercent: 31, windowDurationMins: 300 }, secondary: null, credits: plan.credits, planType: 'plus' });
  assert.deepEqual([mergedLimits(plan, undefined), mergedLimits(undefined, spark)], [plan, { ...spark, credits: null, planType: null }]);
});

test('a session\'s status has its context after a reply, and the limits asked for once in a while', async () => {
  const { codex, say, sessionId, server } = await running();
  assert.deepEqual(await codex.status({ sessionId: 'nobody' }), { status: null });
  const before = (await codex.status({ sessionId })).status;
  assert.deepEqual([before.model, before.effort, before.context, before.fiveHour.percent, before.sevenDay.percent], ['gpt-6', 'high', undefined, 12, 31]);
  say('thread/tokenUsage/updated', { tokenUsage: { last: { totalTokens: 1000 }, total: { totalTokens: 1000 }, modelContextWindow: 10_000 } });
  server.say('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 13, windowDurationMins: 300 }, secondary: null } });
  const after = (await codex.status({ sessionId })).status;
  assert.deepEqual([after.context, after.fiveHour, after.sevenDay], [{ percent: 10, used: 1000, size: 10_000 }, { percent: 13 }, undefined]);
  assert.equal(server.called('account/rateLimits/read').length, 1);
  // A notice about a limit metered apart leaves the plan's own as it was, and is told by its name.
  server.say('account/rateLimits/updated', { rateLimits: { limitId: 'codex_spark', limitName: 'Spark', primary: { usedPercent: 2, windowDurationMins: 300 }, secondary: null } });
  const apart = (await codex.status({ sessionId })).status;
  assert.deepEqual([apart.fiveHour, apart.limits], [{ percent: 13 }, [{ name: 'Spark', window: 'fiveHour', percent: 2 }]]);
});

test('the account\'s limits are told for a list of what\'s used, where Codex is running to say', async () => {
  const { codex, server } = await running();
  server.limits = { ...server.limits, planType: 'pro', credits: { hasCredits: true, unlimited: false, balance: '12.5' } };
  const said = await codex.limits();
  assert.deepEqual(said.limits, [{ window: 'fiveHour', percent: 12, resetsAt: 1_800_000_000 }, { window: 'sevenDay', percent: 31, resetsAt: 1_800_500_000 }]);
  assert.deepEqual([said.plan, said.credits], ['pro', { unlimited: false, balance: 12.5 }]);
  assert.ok(Math.abs(said.updatedAt - Date.now() / 1000) < 5);
  // One metered apart comes after the plan's own, by its name, and what was said a moment ago stands.
  server.say('account/rateLimits/updated', { rateLimits: { limitId: 'codex_spark', limitName: 'Spark', primary: { usedPercent: 2, windowDurationMins: 300 }, secondary: null } });
  await new Promise(resolve => { setTimeout(resolve, 5); });
  assert.deepEqual((await codex.limits()).limits.at(-1), { name: 'Spark', window: 'fiveHour', percent: 2 });
  assert.equal(server.called('account/rateLimits/read').length, 1);

  // Where it isn't running, it's not started to be asked, and there's nothing to tell.
  const idle = setup({ isRunning: false });
  assert.equal(await idle.codex.limits(), undefined);
  assert.equal(idle.server.isRunning, false);
});

const shellLine = (fields = {}) => command({ id: 'line-1', command: "/bin/zsh -lc 'ls -la'", source: 'userShell', ...fields });

test('a command line comes apart as a shell would take it', () => {
  assert.deepEqual(shellWords("a 'b c' d\\ e \"f g\""), ['a', 'b c', 'd e', 'f g']);
  assert.deepEqual(shellWords('say "it\'s \\"here\\"" \'\''), ['say', 'it\'s "here"', '']);
  assert.deepEqual(shellWords('  '), []);
});

test('a line run with ! is the command as it was typed, out of the shell Codex runs it in', () => {
  // As Codex's server gave them for `echo venes-shell; ls /no/such/place` and `printf "it's \"quoted\"\n"`.
  assert.equal(unwrapped("/bin/zsh -lc 'echo venes-shell; ls /no/such/place'"), 'echo venes-shell; ls /no/such/place');
  assert.equal(unwrapped('/bin/zsh -lc "printf \\"it\'s \\\\\\"quoted\\\\\\"\\\\n\\""'), 'printf "it\'s \\"quoted\\"\\n"');
  assert.equal(unwrapped('/bin/zsh -lc ls'), 'ls');
  assert.equal(unwrapped('/bin/bash -lc "git status"'), 'git status');
  // Anything else is left as it is.
  assert.equal(unwrapped('git status'), 'git status');
  assert.equal(unwrapped('/usr/bin/env -lc ls'), '/usr/bin/env -lc ls');
  assert.equal(isShellLine(shellLine()), true);
  assert.equal(isShellLine(command()), false);
});

test('a stored line run with ! is the reader\'s, with what it printed, and no reply to end', () => {
  const alone = historyOf({ id: 't', status: 'completed', startedAt: 1_700_000_000, durationMs: 40, items: [shellLine({ status: 'failed', aggregatedOutput: 'ls: nope\n', exitCode: 1 })] });
  assert.deepEqual(alone, [
    { role: 'user', at: '2023-11-14T22:13:20.000Z', text: '!ls -la', shell: true },
    { role: 'output', at: '2023-11-14T22:13:20.000Z', stdout: 'ls: nope\n', stderr: '', replies: false },
  ]);
  // One run during a turn is answered by that turn's reply.
  const within = historyOf({
    id: 't', status: 'completed', durationMs: 900, items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: 'look' }] }, shellLine({ aggregatedOutput: null }),
      { type: 'agentMessage', id: 'm', text: 'I see.', phase: 'final_answer' },
    ],
  });
  assert.deepEqual(within.map(item => [item.role, item.replies]), [['user', undefined], ['user', undefined], ['output', true], ['assistant', undefined], ['turn_end', undefined]]);
  assert.equal(within[2].stdout, '');
});

test('a line that starts with ! is run in the reader\'s shell, and comes back as theirs', async () => {
  const { codex, store, server, events, last, kinds } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const before = events.length;
  assert.deepEqual(await codex.send({ sessionId, text: '! ls -la', clientId: 'c1' }), { queued: false });
  assert.deepEqual(server.called('thread/shellCommand'), [{ threadId: sessionId, command: 'ls -la' }]);
  assert.equal(server.called('turn/start').length, 0);
  const say = (method, params) => server.say(method, { threadId: sessionId, turnId: 'turn-s', ...params });
  say('turn/started', { turn: { id: 'turn-s' } });
  say('item/started', { item: shellLine() });
  assert.deepEqual({ ...last('message.user'), seq: 0, at: 0 }, { seq: 0, at: 0, sessionId, kind: 'message.user', text: '!ls -la', clientId: 'c1', shell: true });
  say('item/completed', { item: shellLine({ status: 'completed', aggregatedOutput: 'total 0\n', exitCode: 0 }) });
  assert.deepEqual({ ...last('message.output'), seq: 0, at: 0 }, { seq: 0, at: 0, sessionId, kind: 'message.output', stdout: 'total 0\n', stderr: '', replies: false, clientId: 'c1' });
  say('turn/completed', { turn: { id: 'turn-s', status: 'completed' } });
  // Nothing was at work, so nothing says it was, and no turn is said to have ended.
  assert.deepEqual(kinds().slice(before), ['message.user', 'message.output']);
  assert.equal(store.get(sessionId).status, 'idle');
  assert.equal(store.get(sessionId).lastPrompt, '!ls -la');
  assert.deepEqual(store.openTurn(store.get(sessionId), Date.now() + 10_000), []);
});

test('one typed at Codex\'s own terminal has no send to name, and one only heard of at its end is still told', async () => {
  const { codex, server, events } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  const before = events.length;
  server.say('turn/started', { threadId: sessionId, turn: { id: 'turn-s' } });
  server.say('item/completed', { threadId: sessionId, item: shellLine({ status: 'completed', aggregatedOutput: 'x\n' }) });
  assert.deepEqual(events.slice(before).map(event => [event.kind, event.text ?? event.stdout, event.clientId]), [['message.user', '!ls -la', undefined], ['message.output', 'x\n', undefined]]);
});

test('a line run with ! during a turn is answered by that turn', async () => {
  const { codex, sessionId, server, say, last, kinds } = await running();
  await codex.send({ sessionId, text: '!ls -la', clientId: 'c2' });
  assert.equal(server.called('turn/steer').length, 0);
  say('item/started', { item: shellLine() });
  say('item/completed', { item: shellLine({ status: 'completed', aggregatedOutput: 'total 0\n' }) });
  assert.deepEqual([last('message.output').replies, last('message.output').clientId], [true, 'c2']);
  say('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  assert.equal(kinds().at(-1), 'turn.end');
});

test('a line with nothing after its ! isn\'t run, and one Codex won\'t run fails', async () => {
  const { codex, server } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  await assert.rejects(codex.send({ sessionId, text: '!  ' }), error => error.code === 'bad_text');
  server.fails['thread/shellCommand'] = 'thread is archived';
  await assert.rejects(codex.send({ sessionId, text: '!ls', clientId: 'c1' }), error => error.code === 'send_failed');
  // Its send isn't waited for: the same line typed later at the terminal is nobody's.
  server.say('item/started', { threadId: sessionId, item: shellLine({ command: '/bin/zsh -lc ls' }) });
  assert.equal(server.called('thread/shellCommand').length, 1);
});

test('a line with a file attached is a message, since a shell takes none', async () => {
  const { codex, server } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  await codex.send({ sessionId, text: '!look', attachments: [{ uploadId: 'u', name: 'a.png', mediaType: 'image/png', size: 1, kind: 'image', path: '/d/a.png' }] });
  assert.equal(server.called('thread/shellCommand').length, 0);
  assert.equal(server.called('turn/start').length, 1);
});

// A PNG two pixels wide and three high, and where one is kept for a test. Its size is told from its
// base64 as a Claude Code session's is, which counts the padding at its end: 75 for its 74 bytes.
const DOT = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGP4z8DwH4QZYAwAR8oH+WdZbrcAAAAASUVORK5CYII=';
function pictures(t) {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-codex-pictures-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = (name, contents = Buffer.from(DOT, 'base64')) => {
    fs.writeFileSync(path.join(folder, name), contents);
    return path.join(folder, name);
  };
  return { folder, file };
}

test('an item\'s pictures are those a message came with, the one Codex looked at or made, and those a tool gave back', () => {
  const data = `data:image/jpeg;base64,${DOT}`;
  assert.deepEqual(pictureSourcesOf({ type: 'userMessage', content: [
    { type: 'text', text: 'look' }, { type: 'localImage', path: '/d/a.png' }, { type: 'image', url: data }, { type: 'image', url: 'https://example.com/a.png' },
    { type: 'localImage' },
  ] }), [{ path: '/d/a.png' }, { mediaType: 'image/jpeg', data: DOT }]);
  assert.deepEqual(pictureSourcesOf({ type: 'imageView', id: 'v', path: '/d/shot.png' }), [{ path: '/d/shot.png' }]);
  assert.deepEqual(pictureSourcesOf({ type: 'imageGeneration', id: 'g', result: DOT, savedPath: '/d/made.png' }), [{ path: '/d/made.png' }]);
  assert.deepEqual(pictureSourcesOf({ type: 'imageGeneration', id: 'g', result: DOT, savedPath: null }), [{ mediaType: 'image/png', data: DOT }]);
  assert.deepEqual(pictureSourcesOf({ type: 'mcpToolCall', id: 'm', result: { content: [{ type: 'text', text: 'x' }, { type: 'image', data: DOT, mimeType: 'image/webp' }] } }),
    [{ mediaType: 'image/webp', data: DOT }]);
  assert.deepEqual(pictureSourcesOf({ type: 'dynamicToolCall', id: 'd', contentItems: [{ type: 'inputText', text: 'x' }, { type: 'inputImage', imageUrl: data }] }),
    [{ mediaType: 'image/jpeg', data: DOT }]);
  for (const item of [{ type: 'commandExecution', id: 'c' }, { type: 'mcpToolCall', id: 'm', result: null }, { type: 'imageView', id: 'v' }, { type: 'agentMessage', text: 'hi' }, undefined]) {
    assert.deepEqual(pictureSourcesOf(item), []);
  }
});

test('a picture is read where it is, when it\'s one by its name, there, and no bigger than is shown', t => {
  const { folder, file } = pictures(t);
  const shot = file('shot.png');
  assert.deepEqual(readPicture({ path: shot }), { mediaType: 'image/png', data: DOT });
  assert.deepEqual(readPicture({ mediaType: 'image/webp', data: DOT }), { mediaType: 'image/webp', data: DOT });
  assert.equal(readPicture({ path: path.join(folder, 'gone.png') }), undefined);
  assert.equal(readPicture({ path: file('notes.txt', 'words') }), undefined);
  assert.equal(readPicture({ path: shot }, { limit: 10 }), undefined);
});

test('a page is told of a picture by an id, its kind and its size, and never given its bytes', t => {
  const { folder, file } = pictures(t);
  const kept = new Map();
  const keep = (id, source) => kept.set(id, source);
  const shot = file('shot.png');
  const message = { type: 'userMessage', id: 'u1', content: [{ type: 'localImage', path: path.join(folder, 'gone.png') }, { type: 'localImage', path: shot }, { type: 'text', text: 'look' }] };
  // One that has gone isn't told of, and the next keeps its own place's id.
  assert.deepEqual(picturesOf(message, keep), [{ id: 'u1:1', mediaType: 'image/png', bytes: 75, width: 2, height: 3 }]);
  assert.deepEqual([...kept], [['u1:1', { path: shot }]]);
  const tool = { type: 'mcpToolCall', id: 'm1', status: 'completed', result: { content: [{ type: 'image', data: DOT, mimeType: 'image/png' }, { type: 'text', text: 'done' }] } };
  const made = { type: 'imageGeneration', id: 'g1', status: 'completed', result: DOT, savedPath: null };
  const turn = { id: 't', status: 'completed', startedAt: 1_700_000_000, items: [message, { type: 'imageView', id: 'v1', path: shot }, tool, made] };
  const items = historyOf(turn, keep);
  assert.deepEqual(items.map(item => [item.role, item.name, item.images?.map(image => image.id)]),
    [['user', undefined, ['u1:1']], ['tool', 'imageView', ['v1:0']], ['tool', 'mcpToolCall', ['m1:0']], ['tool', 'imageGeneration', ['g1:0']], ['turn_end', undefined, undefined]]);
  assert.equal(JSON.stringify(items).includes(DOT), false, 'no picture\'s bytes are on the page');
  assert.deepEqual(items[2].result.result.content, [{ type: 'image', data: undefined, mimeType: 'image/png' }, { type: 'text', text: 'done' }]);
  assert.deepEqual([...kept.keys()], ['u1:1', 'v1:0', 'm1:0', 'g1:0']);
  // Without anything to keep them, the page is the same.
  assert.deepEqual(historyOf(turn), items);
  assert.deepEqual(withoutPictures({ type: 'dynamicToolCall', id: 'd', contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,AAAA' }] }).contentItems,
    [{ type: 'inputImage', imageUrl: undefined }]);
  assert.deepEqual(withoutPictures(command()), command());
});

test('a turn\'s pictures are told as they come, and each is had by its id', async t => {
  const { file } = pictures(t);
  const shot = file('shot.png');
  const { say, events, codex, sessionId, last } = await running();
  say('item/completed', { item: { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'see this' }, { type: 'localImage', path: shot }] } });
  assert.deepEqual(last('message.images').images, [{ id: 'u2:0', mediaType: 'image/png', bytes: 75, width: 2, height: 3 }]);
  say('item/started', { item: { type: 'imageView', id: 'v1', path: shot } });
  say('item/completed', { item: { type: 'imageView', id: 'v1', path: shot } });
  const shown = last('tool.images');
  assert.deepEqual([shown.toolUseId, shown.images], ['v1', [{ id: 'v1:0', mediaType: 'image/png', bytes: 75, width: 2, height: 3 }]]);
  // After the tool's end, as a Claude Code session's are.
  const kinds = events.map(event => event.kind);
  assert.ok(kinds.lastIndexOf('tool.images') > kinds.lastIndexOf('tool.end'));
  say('item/completed', { item: { type: 'mcpToolCall', id: 'm1', server: 's', tool: 'shoot', status: 'completed', result: { content: [{ type: 'image', data: DOT, mimeType: 'image/png' }] } } });
  assert.equal(JSON.stringify(events).includes(DOT), false, 'no event carries a picture\'s bytes');
  assert.deepEqual(codex.image({ sessionId, imageId: 'v1:0' }), { mediaType: 'image/png', data: DOT });
  assert.deepEqual(codex.image({ sessionId, imageId: 'm1:0' }), { mediaType: 'image/png', data: DOT });
  assert.throws(() => codex.image({ sessionId, imageId: 'v1:9' }), { code: 'unknown_image' });
  assert.throws(() => codex.image({ sessionId: 'another', imageId: 'v1:0' }), { code: 'unknown_image' });
  // A picture that has gone from the Mac since isn't there to give.
  fs.rmSync(shot);
  assert.throws(() => codex.image({ sessionId, imageId: 'v1:0' }), { code: 'unknown_image' });
  // A message with no picture says nothing of pictures.
  const before = events.filter(event => event.kind === 'message.images').length;
  say('item/completed', { item: { type: 'userMessage', id: 'u3', content: [{ type: 'text', text: 'plain' }] } });
  assert.equal(events.filter(event => event.kind === 'message.images').length, before);
});

test('a chat forked is a session from then, and one put away is gone', async () => {
  const { codex, server, store } = setup();
  const { sessionId } = await codex.start({ cwd: FOLDER });
  // Asked of Codex in its own words for it, and no message to it. What Codex answers is the new session.
  await codex.send({ sessionId, text: '/fork' });
  assert.deepEqual(server.called('thread/fork'), [{ threadId: sessionId }]);
  assert.equal(store.find(`fork-of-${sessionId}`)?.agent, 'codex');
  // Codex keeps a chat while a fork of it is kept, and the reader is told what to do about it.
  server.fails.delete = true;
  await assert.rejects(codex.remove({ sessionId }), error => error.code === 'session_forked' && /Delete the fork first/.test(error.message));
  server.fails.delete = false;
  assert.equal(store.find(sessionId)?.id, sessionId, 'refused, it stays');
  await codex.send({ sessionId, text: '/archive' });
  assert.deepEqual(server.called('thread/archive'), [{ threadId: sessionId }]);
  assert.equal(store.find(sessionId), undefined, 'put away, it has left the list here');
});

test('a restart restarts Codex\'s daemon, then opens the session on it again', async () => {
  const { server, codex, last } = setup({ threads: [stored('t1')], loaded: ['t1'] });
  await codex.restore();
  await codex.restartNow('t1');
  assert.equal(server.restarts, 1);
  assert.ok(server.called('thread/resume').some(params => params.threadId === 't1'));
  assert.equal(last('session.started').source, 'resume');
});

test('a test\'s own Codex server is no daemon to restart', async () => {
  const { server, codex } = setup({ threads: [stored('t1')], loaded: ['t1'], env: { VENES_CODEX_SOCKET: '/tmp/test.sock' } });
  await codex.restore();
  await assert.rejects(codex.restartNow('t1'), { code: 'restart_unsupported' });
  assert.equal(server.restarts, 0);
});

test('Codex is at work while any of its sessions has a turn going', async () => {
  const { codex } = await running();
  assert.equal(codex.isBusy(), true);
});

// Codex's own terminal on a thread, with Codex in it until it's told to go.
function codexWindow({ program = 'codex', stays = false } = {}) {
  const killed = [];
  const terminal = {
    running: program, asked: [],
    findSession: async (name, env) => { terminal.asked.push([name, env]); return { pane: '%4' }; },
    processOf: async () => ({ name: terminal.running, pid: 4242 }),
  };
  const kill = pid => { killed.push(pid); if (!stays) terminal.running = 'zsh'; };
  return { terminal, killed, kill };
}

test('closing a Codex session quits Codex\'s own terminal on it, and leaves the thread to Codex\'s server', async () => {
  const { terminal, killed, kill } = codexWindow();
  const { server, codex } = setup({ threads: [stored('t1')], loaded: ['t1'], terminal, kill });
  await codex.restore();
  assert.equal(await codex.isClosable('t1'), true);
  await codex.closeNow('t1');
  assert.deepEqual(killed, [4242]);
  assert.equal(terminal.asked[0][0], 'venes-codex-t1');
  assert.equal(await codex.isClosable('t1'), false);
  assert.equal(server.restarts, 0);
  assert.ok(server.loaded.has('t1'), 'the thread is still loaded');
});

test('a Codex session with no terminal of Codex\'s on it has nothing to close', async () => {
  const { codex } = setup({ threads: [stored('t1')], loaded: ['t1'] });
  await codex.restore();
  assert.equal(await codex.isClosable('t1'), false);
  await assert.rejects(codex.closeNow('t1'), { code: 'not_open' });
  const left = codexWindow({ program: '-zsh' });
  const other = setup({ threads: [stored('t1')], loaded: ['t1'], terminal: left.terminal, kill: left.kill });
  await other.codex.restore();
  assert.equal(await other.codex.isClosable('t1'), false, 'Codex has left it for its shell');
});

test('a Codex that won\'t quit is said to', async () => {
  const { terminal, kill } = codexWindow({ stays: true });
  const { codex } = setup({ threads: [stored('t1')], loaded: ['t1'], terminal, kill, quitLimitMs: 30 });
  await codex.restore();
  await assert.rejects(codex.closeNow('t1'), { code: 'session_running' });
});

test('closing waits for its own thread\'s turn, and no other', async () => {
  const { codex, sessionId } = await running();
  assert.equal(codex.isWorking(sessionId), true);
  assert.equal(codex.isWorking('another-thread'), false);
});
