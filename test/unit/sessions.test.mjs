import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/sessions.mjs';

function setup() {
  const store = new SessionStore();
  const events = [];
  store.on('event', e => events.push(e));
  const hook = (hook_event_name, fields = {}) => store.handleHook({ session_id: 'a', cwd: '/w', permission_mode: 'default', hook_event_name, ...fields });
  return { store, events, hook, kinds: () => events.map(e => e.kind) };
}

const bash = { tool_name: 'Bash', tool_input: { command: 'touch x' } };
const closed = events => events.find(e => e.kind === 'request.closed');

test('a turn moves through running to idle', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  assert.equal(store.get('a').status, 'running');
  hook('Stop', { last_assistant_message: 'done', background_tasks: [] });
  assert.equal(store.get('a').status, 'idle');
});

test('a late text delta does not reopen a finished turn', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  hook('Stop', { last_assistant_message: 'done' });
  hook('MessageDisplay', { message_id: 'm', delta: 'done', index: 0, final: true });
  assert.equal(store.get('a').status, 'idle');
});

test('a task notification is not shown as a user message', () => {
  const { hook, kinds } = setup();
  hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>1</task-id>' });
  assert.ok(kinds().includes('task.notification'));
  assert.ok(!kinds().includes('message.user'));
});

test('stop reports background work still in flight', () => {
  const { store, hook, events } = setup();
  hook('Stop', { background_tasks: [{ id: 't1' }] });
  assert.equal(events.find(e => e.kind === 'turn.end').backgroundTasks, 1);
  assert.equal(store.get('a').status, 'idle');
});

test('internal subagents with no type are filtered out', () => {
  const { hook, kinds } = setup();
  hook('SubagentStop', { agent_id: 'x', agent_type: '' });
  hook('SubagentStop', { agent_id: 'y', agent_type: 'general-purpose' });
  assert.equal(kinds().filter(k => k === 'agent.stop').length, 1);
});

test('a background agent does not reopen a finished turn', () => {
  const { store, hook } = setup();
  hook('Stop', {});
  hook('PreToolUse', { ...bash, tool_use_id: 't', agent_id: 'bg' });
  assert.equal(store.get('a').status, 'idle');
});

test('a permission request pairs with its PreToolUse and waits', async () => {
  const { store, hook } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  assert.equal(held.request.toolUseId, 't1');
  assert.equal(store.get('a').status, 'waiting');
  store.respond(held.request.id, { decision: 'allow' });
  assert.deepEqual(await held.decision, {
    hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
  });
  assert.equal(store.get('a').status, 'running');
});

test('deny carries the message back to Claude', async () => {
  const { store, hook } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  store.respond(held.request.id, { decision: 'deny', message: 'no' });
  const { decision } = (await held.decision).hookSpecificOutput;
  assert.deepEqual(decision, { behavior: 'deny', message: 'no' });
});

test('approving a plan returns its input, because a bare allow is ignored', async () => {
  const { store, hook } = setup();
  const plan = { tool_name: 'ExitPlanMode', tool_input: { plan: '# p', planFilePath: '/p.md' } };
  hook('PreToolUse', { ...plan, tool_use_id: 't1' });
  const held = hook('PermissionRequest', plan);
  assert.equal(held.request.kind, 'plan');
  store.respond(held.request.id, { decision: 'allow' });
  assert.deepEqual((await held.decision).hookSpecificOutput.decision.updatedInput, plan.tool_input);
});

test('a question needs every answer', async () => {
  const { store, hook } = setup();
  const ask = { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q1' }, { question: 'Q2' }] } };
  hook('PreToolUse', { ...ask, tool_use_id: 't1' });
  const held = hook('PermissionRequest', ask);
  assert.throws(() => store.respond(held.request.id, { decision: 'allow', answers: { Q1: 'a' } }), { code: 'missing_answers' });
  store.respond(held.request.id, { decision: 'allow', answers: { Q1: 'a', Q2: 'b' } });
  const { updatedInput } = (await held.decision).hookSpecificOutput.decision;
  assert.deepEqual(updatedInput.answers, { Q1: 'a', Q2: 'b' });
  assert.deepEqual(updatedInput.questions, ask.tool_input.questions);
});

test('an answer that arrives after the terminal answered is refused', async () => {
  const { store, hook, events } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  hook('PostToolUse', { ...bash, tool_use_id: 't1', tool_response: {} });
  assert.deepEqual({ decision: closed(events).decision, by: closed(events).by }, { decision: 'allow', by: 'terminal' });
  assert.equal(await held.decision, undefined);
  assert.throws(() => store.respond(held.request.id, { decision: 'allow' }), { code: 'request_closed' });
});

test('a terminal rejection is found in the transcript, since no hook fires', async () => {
  const { store, hook, events } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  store.handleTranscriptRecord('a', {
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'rejected' }] },
  });
  store.handleTranscriptRecord('a', {
    type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  });
  assert.deepEqual({ decision: closed(events).decision, by: closed(events).by }, { decision: 'deny', by: 'terminal' });
  assert.equal(await held.decision, undefined);
  assert.equal(store.get('a').status, 'idle');
  assert.ok(events.some(e => e.kind === 'turn.interrupted'));
});

test('an interrupt ends tools that were still running', () => {
  const { store, hook, events } = setup();
  hook('UserPromptSubmit', { prompt: 'go' });
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  store.handleTranscriptRecord('a', { type: 'user', message: { content: '[Request interrupted by user]' } });
  assert.equal(events.find(e => e.kind === 'tool.end').interrupted, true);
  assert.equal(store.get('a').status, 'idle');
});

test('a tool failure closes its tool once', () => {
  const { store, hook, kinds } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  store.handleTranscriptRecord('a', {
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'exit 1' }] },
  });
  hook('PostToolUseFailure', { ...bash, tool_use_id: 't1', error: 'exit 1' });
  assert.equal(kinds().filter(k => k === 'tool.end').length, 1);
});

test('a new session in the same pane retires the old one', () => {
  const { store } = setup();
  store.handleHook({ session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, { pane: '%1', socket: '/s' });
  store.handleHook({ session_id: 'new', hook_event_name: 'SessionStart' }, { pane: '%1', socket: '/s' });
  assert.equal(store.get('old').status, 'ended');
  assert.equal(store.get('new').pane, '%1');
});

test('the same pane id on another tmux server is a different pane', () => {
  const { store } = setup();
  store.handleHook({ session_id: 'one', hook_event_name: 'SessionStart' }, { pane: '%1', socket: '/s1' });
  store.handleHook({ session_id: 'two', hook_event_name: 'SessionStart' }, { pane: '%1', socket: '/s2' });
  assert.notEqual(store.get('one').status, 'ended');
});

test('session end releases any waiting hook', async () => {
  const { hook } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  hook('SessionEnd', { reason: 'other' });
  assert.equal(await held.decision, undefined);
});

test('a client can catch up, and learns when events were dropped', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  const seq = store.seq;
  hook('Stop', {});
  assert.ok(store.eventsSince(seq).events.every(e => e.seq > seq));
  assert.equal(store.eventsSince(seq).gap, false);
  for (let i = 0; i < 5100; i++) hook('Notification', {});
  assert.equal(store.eventsSince(seq).gap, true);
});

test('a session is found by a unique id prefix', () => {
  const { store } = setup();
  store.handleHook({ session_id: 'abc1', hook_event_name: 'Stop' });
  store.handleHook({ session_id: 'abc2', hook_event_name: 'Stop' });
  assert.equal(store.get('abc1').id, 'abc1');
  assert.throws(() => store.get('abc'), { code: 'ambiguous_session' });
  assert.throws(() => store.get('zzz'), { code: 'unknown_session' });
});
