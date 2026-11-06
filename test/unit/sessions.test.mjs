import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../../src/sessions.mjs';

function setup(options) {
  const store = new SessionStore(options);
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

test('the working folder is known from the first event', () => {
  const { hook, events } = setup();
  hook('SessionStart', { source: 'startup', model: 'm' });
  assert.equal(events.find(e => e.kind === 'session.discovered').cwd, '/w');
  assert.equal(events.find(e => e.kind === 'session.started').cwd, '/w');
});

const userEvents = events => events.filter(e => e.kind === 'message.user');

test('a sent message echoes with its client id, however whitespace was changed', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.expectEcho(store.get('a'), 'c1', 'line one\nline two\n');
  hook('UserPromptSubmit', { prompt: 'line one\n  line two' });
  assert.equal(userEvents(events)[0].clientId, 'c1');
});

test('a message typed in the terminal has no client id, and leaves the wait open', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.expectEcho(store.get('a'), 'c1', 'from the phone');
  hook('UserPromptSubmit', { prompt: 'from the terminal' });
  hook('UserPromptSubmit', { prompt: 'from the phone' });
  assert.deepEqual(userEvents(events).map(e => e.clientId), [undefined, 'c1']);
});

test('identical messages echo in the order they were sent', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.expectEcho(store.get('a'), 'c1', 'same');
  store.expectEcho(store.get('a'), 'c2', 'same');
  hook('UserPromptSubmit', { prompt: 'same' });
  hook('UserPromptSubmit', { prompt: 'same' });
  assert.deepEqual(userEvents(events).map(e => e.clientId), ['c1', 'c2']);
});

test('a send that failed no longer claims a later message', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.expectEcho(store.get('a'), 'c1', 'same');
  store.forgetEcho(store.get('a'), 'c1');
  hook('UserPromptSubmit', { prompt: 'same' });
  assert.equal(userEvents(events)[0].clientId, undefined);
});

test('echoes that never come do not pile up', () => {
  const { store, hook } = setup();
  hook('Stop', {});
  for (let i = 0; i < 100; i++) store.expectEcho(store.get('a'), `c${i}`, '/help');
  assert.equal(store.get('a').echoes.length, 32);
});

test('a held message can be cancelled once, and only by its id', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  const s = store.get('a');
  store.hold(s, { clientId: 'c1', text: 'one' });
  store.hold(s, { clientId: 'c2', text: 'two' });
  assert.equal(store.cancelHeld(s, 'nope'), false);
  assert.equal(store.cancelHeld(s, 'c1'), true);
  assert.equal(store.cancelHeld(s, 'c1'), false);
  assert.equal(store.nextHeld(s).clientId, 'c2');
  assert.equal(store.nextHeld(s), undefined);
});

test('held messages keep a session busy, so a later one cannot overtake them', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  assert.equal(store.isBusy(store.get('a')), true);
  hook('Stop', {});
  assert.equal(store.isBusy(store.get('a')), false);
  store.hold(store.get('a'), { clientId: 'c1', text: 'one' });
  assert.equal(store.isBusy(store.get('a')), true);
});

test('a session that ends tells the client what it was still holding', () => {
  const { store, hook, events } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  store.hold(store.get('a'), { clientId: 'c1', text: 'one' });
  hook('SessionEnd', { reason: 'other' });
  const failed = events.find(e => e.kind === 'send.failed');
  assert.deepEqual([failed.clientId, failed.code], ['c1', 'session_ended']);
  assert.equal(store.get('a').held.length, 0);
});

test('a session replaced in its pane fails what it was holding too', () => {
  const { store, events } = setup();
  store.handleHook({ session_id: 'old', hook_event_name: 'UserPromptSubmit', prompt: 'x' }, { pane: '%1', socket: '/s' });
  store.hold(store.get('old'), { clientId: 'c1', text: 'one' });
  store.handleHook({ session_id: 'new', hook_event_name: 'SessionStart' }, { pane: '%1', socket: '/s' });
  assert.equal(events.find(e => e.kind === 'send.failed').clientId, 'c1');
});

const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'touch x' }], behavior: 'allow', destination: 'localSettings' }];

test('always allow hands back the rules Claude Code suggested', async () => {
  const { store, hook, events } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', { ...bash, permission_suggestions: suggestions });
  assert.deepEqual(events.find(e => e.kind === 'request.opened').request.permissionSuggestions, suggestions);
  store.respond(held.request.id, { decision: 'allow', always: true });
  const { decision } = (await held.decision).hookSpecificOutput;
  assert.deepEqual(decision, { behavior: 'allow', updatedPermissions: suggestions });
});

test('always allow never changes the session\'s mode or folders', async () => {
  const { store, hook, events } = setup();
  const widening = [
    { type: 'addDirectories', directories: ['/w'], destination: 'session' },
    { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
  ];
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const edit = hook('PermissionRequest', { ...bash, permission_suggestions: widening });
  assert.deepEqual(events.find(e => e.kind === 'request.opened').request.permissionSuggestions, [], 'so it isn\'t offered');
  assert.throws(() => store.respond(edit.request.id, { decision: 'allow', always: true }), { code: 'nothing_to_remember' });
  store.respond(edit.request.id, { decision: 'deny' });

  hook('PreToolUse', { ...bash, tool_use_id: 't2' });
  const mixed = hook('PermissionRequest', { ...bash, permission_suggestions: [...widening, ...suggestions] });
  store.respond(mixed.request.id, { decision: 'allow', always: true });
  assert.deepEqual((await mixed.decision).hookSpecificOutput.decision.updatedPermissions, suggestions);
});

test('allowing once remembers nothing', async () => {
  const { store, hook } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', { ...bash, permission_suggestions: suggestions });
  store.respond(held.request.id, { decision: 'allow' });
  assert.deepEqual((await held.decision).hookSpecificOutput.decision, { behavior: 'allow' });
});

test('always allow is refused when there is no rule, and the request stays open', () => {
  const { store, hook } = setup();
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  const held = hook('PermissionRequest', bash);
  assert.throws(() => store.respond(held.request.id, { decision: 'allow', always: true }), { code: 'nothing_to_remember' });
  assert.equal(store.pendingFor(store.get('a')).length, 1);
});

test('a plan offers no remembered rule, whatever Claude Code suggested', () => {
  const { hook } = setup();
  const plan = { tool_name: 'ExitPlanMode', tool_input: { plan: '# p' } };
  hook('PreToolUse', { ...plan, tool_use_id: 't1' });
  assert.equal(hook('PermissionRequest', { ...plan, permission_suggestions: suggestions }).request.permissionSuggestions, undefined);
});

const taskEvents = events => events.filter(e => e.kind === 'background.task').map(e => e.task);

function launchShell(hook) {
  const input = { command: 'sleep 5', description: 'Wait', run_in_background: true };
  hook('PreToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 't1' });
  hook('PostToolUse', { tool_name: 'Bash', tool_input: input, tool_use_id: 't1', tool_response: { backgroundTaskId: 'b1' } });
}

const finishedShell = '<task-notification>\n<task-id>b1</task-id>\n<output-file>/t/b1.output</output-file>\n<status>completed</status>\n<summary>Done</summary>\n</task-notification>';

test('a background command is followed from launch to finish', () => {
  const { store, hook, events } = setup();
  launchShell(hook);
  const launched = taskEvents(events)[0];
  assert.deepEqual(
    [launched.id, launched.type, launched.status, launched.toolUseId, launched.description, launched.command],
    ['b1', 'shell', 'running', 't1', 'Wait', 'sleep 5'],
  );
  assert.equal(launched.hasOutput, false);
  hook('UserPromptSubmit', { prompt: finishedShell });
  const finished = taskEvents(events).at(-1);
  assert.deepEqual([finished.status, finished.summary, finished.hasOutput], ['completed', 'Done', true]);
  assert.ok(finished.finishedAt);
  assert.equal(finished.description, 'Wait', 'what was known at launch stays');
  const notified = events.find(e => e.kind === 'task.notification');
  assert.deepEqual([notified.taskId, notified.status], ['b1', 'completed']);
  assert.equal(store.sessions()[0].tasks[0].status, 'completed', 'a snapshot lists it');
});

test('a background agent is followed, and its result is its output', () => {
  const { store, hook, events } = setup();
  const input = { description: 'Look', subagent_type: 'Explore' };
  hook('PreToolUse', { tool_name: 'Agent', tool_input: input, tool_use_id: 't1' });
  hook('PostToolUse', {
    tool_name: 'Agent', tool_input: input, tool_use_id: 't1',
    tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1', description: 'Look', outputFile: '/t/a1.output' },
  });
  const launched = taskEvents(events)[0];
  assert.deepEqual([launched.id, launched.type, launched.agentType], ['a1', 'subagent', 'Explore']);
  assert.equal(launched.hasOutput, false, 'its output file is a raw transcript');
  hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>All good</result>\n<usage><subagent_tokens>10</subagent_tokens><tool_uses>2</tool_uses></usage>\n</task-notification>' });
  const finished = taskEvents(events).at(-1);
  assert.deepEqual([finished.tokens, finished.toolUses, finished.hasOutput], [10, 2, true]);
  assert.equal(finished.result, undefined, 'a result can be long, so it stays out of the event');
  assert.equal(store.task('a', 'a1').result, 'All good');
});

test('stop lists running tasks, and adds what only it knows', () => {
  const { hook, events } = setup();
  hook('Stop', { background_tasks: [{ id: 'w1', type: 'workflow', status: 'running', description: 'Review', name: 'review-changes' }] });
  const end = events.find(e => e.kind === 'turn.end');
  assert.equal(end.backgroundTasks, 1);
  assert.deepEqual(end.tasks.map(t => [t.id, t.type, t.name]), [['w1', 'workflow', 'review-changes']]);
});

test('a finished task is not listed as running at the next stop', () => {
  const { hook, events } = setup();
  launchShell(hook);
  hook('UserPromptSubmit', { prompt: finishedShell });
  hook('Stop', { background_tasks: [] });
  assert.deepEqual(events.find(e => e.kind === 'turn.end').tasks, []);
});

test('nothing is reported when a task has not changed', () => {
  const { hook, events } = setup();
  hook('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] });
  hook('Stop', { background_tasks: [{ id: 'b1', type: 'shell', status: 'running' }] });
  assert.equal(taskEvents(events).length, 1);
});

test('a launch read from the transcript after the finish does not reopen the task', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: finishedShell });
  store.handleTranscriptRecord('a', {
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Output is being written to: /t/b1.output' }] },
  });
  assert.equal(store.task('a', 'b1').status, 'completed');
});

test('a running command\'s output file comes from its tool result', () => {
  const { store, hook } = setup();
  launchShell(hook);
  store.handleTranscriptRecord('a', {
    type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Output is being written to: /t/b1.output' }] },
  });
  assert.equal(store.task('a', 'b1').outputFile, '/t/b1.output');
});

test('an agent that is sent more work runs again', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' });
  hook('Stop', { background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }] });
  assert.equal(store.task('a', 'a1').status, 'running');
  assert.equal(store.task('a', 'a1').finishedAt, undefined);
});

test('old finished tasks fall off, running ones never do', () => {
  const { store, hook } = setup();
  hook('Stop', { background_tasks: [{ id: 'keep', status: 'running' }] });
  for (let i = 0; i < 150; i++) hook('UserPromptSubmit', { prompt: `<task-notification>\n<task-id>t${i}</task-id>\n<status>completed</status>\n</task-notification>` });
  assert.equal(store.get('a').tasks.size, 100);
  assert.equal(store.task('a', 'keep').status, 'running');
});

test('an unknown task is an error', () => {
  const { store, hook } = setup();
  hook('Stop', {});
  assert.throws(() => store.task('a', 'nope'), { code: 'unknown_task' });
});

test('a subagent\'s calls name the call that started it', () => {
  const { hook, events } = setup({ agentParent: (transcript, agentId) => (agentId === 'a1' ? 'parent' : undefined) });
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('PreToolUse', { ...bash, tool_use_id: 't1', agent_id: 'a1' });
  hook('PostToolUse', { ...bash, tool_use_id: 't1', agent_id: 'a1', tool_response: {} });
  assert.equal(events.find(e => e.kind === 'agent.start').parentToolUseId, 'parent');
  assert.equal(events.find(e => e.kind === 'tool.start').parentToolUseId, 'parent');
  assert.equal(events.find(e => e.kind === 'tool.end').parentToolUseId, 'parent');
});

test('a parent that is not on disk yet is looked up again, then remembered', () => {
  let reads = 0;
  const { hook, events } = setup({ agentParent: () => (++reads < 2 ? undefined : 'parent') });
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('PreToolUse', { ...bash, tool_use_id: 't1', agent_id: 'a1' });
  hook('PreToolUse', { ...bash, tool_use_id: 't2', agent_id: 'a1' });
  assert.equal(events.find(e => e.kind === 'agent.start').parentToolUseId, undefined);
  assert.deepEqual(events.filter(e => e.kind === 'tool.start').map(e => e.parentToolUseId), ['parent', 'parent']);
  assert.equal(reads, 2);
});

test('the main thread\'s calls have no parent, and read no files', () => {
  let reads = 0;
  const { hook, events } = setup({ agentParent: () => { reads++; return 'x'; } });
  hook('PreToolUse', { ...bash, tool_use_id: 't1' });
  assert.equal(events.find(e => e.kind === 'tool.start').parentToolUseId, undefined);
  assert.equal(reads, 0);
});

const boundary = { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 900, postTokens: 100 } };
const compactEnds = events => events.filter(e => e.kind === 'compact.end');

test('compaction ends once the transcript gives its sizes', () => {
  const { store, hook, events } = setup();
  hook('PostCompact', { trigger: 'manual' });
  assert.equal(compactEnds(events).length, 0, 'the sizes reach the transcript just after this hook');
  store.handleTranscriptRecord('a', boundary);
  const [end] = compactEnds(events);
  assert.deepEqual([end.trigger, end.preTokens, end.postTokens], ['manual', 900, 100]);
});

test('compaction sizes that arrive first are still used', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.handleTranscriptRecord('a', boundary);
  hook('PostCompact', { trigger: 'auto' });
  assert.deepEqual(compactEnds(events).map(e => [e.trigger, e.preTokens]), [['auto', 900]]);
  hook('PostCompact', { trigger: 'auto' });
  assert.equal(compactEnds(events).length, 1, 'they are only used once');
});

test('compaction still ends if the transcript never says', async () => {
  const { hook, events } = setup({ compactWaitMs: 5 });
  hook('PostCompact', { trigger: 'manual' });
  await new Promise(resolve => { setTimeout(resolve, 30); });
  assert.deepEqual(compactEnds(events).map(e => [e.trigger, e.preTokens]), [['manual', undefined]]);
});

test('a second compaction replaces the wait of the first, and its timer', async () => {
  const { store, hook, events } = setup({ compactWaitMs: 5 });
  hook('PostCompact', { trigger: 'manual' });
  hook('PostCompact', { trigger: 'auto' });
  await new Promise(resolve => { setTimeout(resolve, 30); });
  assert.equal(compactEnds(events).length, 1);
  store.handleTranscriptRecord('a', boundary);
  assert.equal(compactEnds(events).length, 1);
});

test('thinking from the transcript reaches clients without changing the status', () => {
  const { store, hook, events } = setup();
  hook('Stop', {});
  store.handleTranscriptRecord('a', { type: 'assistant', thinkingDurationMs: 700, message: { content: [{ type: 'thinking', thinking: '' }] } });
  const thinking = events.find(e => e.kind === 'message.thinking');
  assert.deepEqual([thinking.text, thinking.durationMs], ['', 700]);
  assert.equal(store.get('a').status, 'idle');
});

test('a refusal says which message it was about', () => {
  const { store, hook, events } = setup();
  hook('UserPromptSubmit', { prompt: 'do the thing' });
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'model_refusal_no_fallback', uuid: 'r1', originalModel: 'big', apiRefusalCategory: 'bio' });
  const refusal = events.find(e => e.kind === 'model.refusal');
  assert.deepEqual([refusal.id, refusal.model, refusal.category, refusal.prompt], ['r1', 'big', 'bio', 'do the thing']);
});
