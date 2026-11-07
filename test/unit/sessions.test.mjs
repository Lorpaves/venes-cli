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
  hook('Stop', {});
  assert.equal(store.nextHeld(s).clientId, 'c2');
  assert.equal(store.nextHeld(s), undefined);
});

function holding(...texts) {
  const context = setup();
  context.hook('UserPromptSubmit', { prompt: 'hi' });
  const s = context.store.get('a');
  texts.forEach((text, i) => context.store.hold(s, { clientId: `c${i}`, text }));
  return { ...context, s, next: at => context.store.nextHeld(s, at)?.text };
}

test('a held message waits for the turn, and for an open request', () => {
  const { store, hook, s, next } = holding('one');
  assert.equal(next(), undefined, 'a turn is running');
  hook('PreToolUse', { ...bash, tool_use_id: 't1', agent_id: 'bg' });
  const held = hook('PermissionRequest', bash);
  assert.equal(next(), undefined, 'a request is open');
  store.respond(held.request.id, { decision: 'deny' });
  hook('Stop', {});
  assert.equal(store.nextHeld(s).text, 'one');
});

test('a message behind a local command goes out, though nothing changed the status', () => {
  const { hook, next } = holding('/context', 'after');
  hook('Stop', {});
  assert.equal(next(1_000_000), '/context');
  assert.equal(next(1_001_000), undefined, 'the first gets time to show whether it started a turn');
  assert.equal(next(1_002_500), 'after');
});

test('a message behind a prompt waits for the turn the prompt started', () => {
  const { hook, next } = holding('one', 'two');
  hook('Stop', {});
  assert.equal(next(1_000_000), 'one');
  hook('UserPromptSubmit', { prompt: 'one' });
  assert.equal(next(1_002_500), undefined);
  hook('Stop', {});
  assert.equal(next(1_002_600), 'two');
});

test('a message behind a compaction waits for it to finish', () => {
  const { store, hook, s } = holding('after');
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  assert.equal(store.nextHeld(s), undefined);
  assert.equal(store.isBusy(s), true);
  assert.equal(store.isQuiet(), false);
  hook('PostCompact', { trigger: 'manual' });
  assert.equal(store.nextHeld(s), undefined, 'compact.end is still waiting for its sizes, and must go first');
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 9, postTokens: 1 } });
  assert.equal(store.nextHeld(s).text, 'after');
});

test('a message behind a compaction still goes if its sizes never come', async () => {
  const { store, hook, events } = setup({ compactWaitMs: 5 });
  hook('UserPromptSubmit', { prompt: 'hi' });
  const s = store.get('a');
  store.hold(s, { clientId: 'c', text: 'after' });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  hook('PostCompact', { trigger: 'manual' });
  await new Promise(resolve => { setTimeout(resolve, 30); });
  assert.ok(events.some(e => e.kind === 'compact.end'));
  assert.equal(store.nextHeld(s).text, 'after');
});

const localOutput = text => ({ type: 'system', subtype: 'local_command', content: `<local-command-stdout>${text}</local-command-stdout>` });

test('a /compact that fails ends, since no PostCompact will come', () => {
  const { store, hook, s, events, kinds } = holding('after');
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  store.handleTranscriptRecord('a', localOutput('Not enough messages to compact.'));
  const failed = events.find(e => e.kind === 'compact.failed');
  assert.deepEqual([failed.trigger, failed.message], ['manual', 'Not enough messages to compact.']);
  assert.ok(!kinds().includes('compact.end'));
  assert.equal(store.nextHeld(s).text, 'after');
});

test('a /compact that works is not mistaken for a failure by its output', () => {
  const { store, hook, kinds } = setup();
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 9, postTokens: 1 } });
  store.handleTranscriptRecord('a', { type: 'user', message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } });
  hook('PostCompact', { trigger: 'manual' });
  assert.ok(!kinds().includes('compact.failed'));
  assert.equal(kinds().filter(k => k === 'compact.end').length, 1);
});

test('other commands\' output means nothing when no compaction is running', () => {
  const { store, hook, kinds } = setup();
  hook('Stop', {});
  store.handleTranscriptRecord('a', localOutput('Settings dialog dismissed'));
  assert.ok(!kinds().includes('compact.failed'));
});

test('a local command during an automatic compaction does not fail it', () => {
  const { store, hook, kinds } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  hook('PreCompact', { trigger: 'auto' });
  store.handleTranscriptRecord('a', localOutput('Settings dialog dismissed'));
  assert.ok(!kinds().includes('compact.failed'));
  assert.equal(store.isBusy(store.get('a')), true);
});

test('a turn that ends takes an unfinished compaction with it', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'hi' });
  hook('PreCompact', { trigger: 'auto' });
  hook('StopFailure', { error: 'server_error' });
  assert.equal(store.isBusy(store.get('a')), false);
});

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const failures = events => events.filter(e => e.kind === 'compact.failed');

test('a compaction that never reports back tells clients, and holds nothing up', async () => {
  const { store, hook, events } = setup({ compactLimitMs: 5 });
  hook('UserPromptSubmit', { prompt: 'hi' });
  const s = store.get('a');
  store.hold(s, { clientId: 'c', text: 'after' });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  assert.equal(store.nextHeld(s), undefined);
  await pause(30);
  const [failed] = failures(events);
  assert.equal(failed.trigger, 'manual');
  assert.equal(failed.message, undefined, 'clients use their own words, as nothing explained it');
  assert.equal(store.nextHeld(s).text, 'after');
});

test('a compaction that finishes does not time out afterwards', async () => {
  const { store, hook, events } = setup({ compactLimitMs: 5 });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  hook('PostCompact', { trigger: 'manual' });
  hook('PreCompact', { trigger: 'manual' });
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'compact_boundary', compactMetadata: {} });
  await pause(30);
  assert.deepEqual(failures(events), []);
});

test('a compaction that fails is only reported once', async () => {
  const { store, hook, events } = setup({ compactLimitMs: 5 });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'local_command', content: '<local-command-stdout>No.</local-command-stdout>' });
  await pause(30);
  assert.deepEqual(failures(events).map(e => e.message), ['No.']);
});

test('a turn or session that ends cancels the time limit', async () => {
  for (const finish of [hook => hook('Stop', {}), hook => hook('SessionEnd', { reason: 'other' })]) {
    const { hook, events } = setup({ compactLimitMs: 5 });
    hook('UserPromptSubmit', { prompt: 'hi' });
    hook('PreCompact', { trigger: 'auto' });
    finish(hook);
    await pause(30);
    assert.deepEqual(failures(events), []);
  }
});

test('a second compaction restarts the time limit', async () => {
  const { hook, events } = setup({ compactLimitMs: 40 });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  await pause(25);
  hook('PreCompact', { trigger: 'manual' });
  await pause(25);
  assert.deepEqual(failures(events), [], 'the first one\'s timer is gone');
  await pause(30);
  assert.equal(failures(events).length, 1);
});

test('a compaction that was slower than the limit still reports its end', async () => {
  const { store, hook, kinds } = setup({ compactLimitMs: 5 });
  hook('Stop', {});
  hook('PreCompact', { trigger: 'manual' });
  await pause(20);
  hook('PostCompact', { trigger: 'manual' });
  store.handleTranscriptRecord('a', { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 9, postTokens: 1 } });
  assert.deepEqual(kinds().filter(k => k.startsWith('compact.')), ['compact.start', 'compact.failed', 'compact.end']);
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

const LATER = 60_000;
const turnKinds = (store, now) => store.openTurn(store.get('a'), now).map(e => e.kind);

test('a session with no turn going has nothing to replay', () => {
  const { store, hook } = setup();
  hook('SessionStart', { source: 'startup' });
  assert.deepEqual(store.openTurn(store.get('a')), []);
});

test('a running turn is replayed from its prompt', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'one' });
  hook('Stop', { last_assistant_message: 'done' });
  hook('MessageDisplay', { message_id: 'late', delta: 'done', index: 0, final: true });
  hook('UserPromptSubmit', { prompt: 'two' });
  hook('PreToolUse', { tool_use_id: 't', ...bash });
  const turn = store.openTurn(store.get('a'), Date.now() + LATER);
  assert.deepEqual(turn.map(e => e.kind), ['message.user', 'session.status', 'tool.start']);
  assert.equal(turn[0].text, 'two');
});

test('a message sent during a turn stays inside it', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'one' });
  hook('PreToolUse', { tool_use_id: 't', ...bash });
  hook('UserPromptSubmit', { prompt: 'and another thing' });
  const turn = store.openTurn(store.get('a'));
  assert.equal(turn[0].text, 'one');
  assert.equal(turn.filter(e => e.kind === 'message.user').length, 2);
});

test('a turn waiting for an answer is still open', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'one' });
  hook('PreToolUse', { tool_use_id: 't', ...bash });
  hook('PermissionRequest', bash);
  assert.equal(store.get('a').status, 'waiting');
  assert.ok(turnKinds(store, Date.now() + LATER).includes('request.opened'));
});

test('a turn started by a finished task begins with its notification', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'one' });
  hook('Stop', { last_assistant_message: 'done' });
  hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>1</task-id>\n<status>completed</status>' });
  hook('PreToolUse', { tool_use_id: 't', ...bash });
  const kinds = turnKinds(store, Date.now() + LATER);
  assert.equal(kinds[0], 'task.notification');
  assert.ok(!kinds.includes('message.user'));
});

test('a turn that has only just ended is replayed whole, until the transcript has caught up', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'zero' });
  hook('Stop', { last_assistant_message: 'old' });
  t.mock.timers.tick(5000);
  hook('UserPromptSubmit', { prompt: 'one' });
  hook('Stop', { last_assistant_message: 'done' });
  hook('MessageDisplay', { message_id: 'late', delta: 'done', index: 0, final: true });
  const turn = store.openTurn(store.get('a'));
  assert.equal(turn[0].text, 'one');
  assert.deepEqual(turn.map(e => e.kind), ['message.user', 'session.status', 'session.status', 'turn.end', 'message.assistant.delta']);
  t.mock.timers.tick(5000);
  assert.deepEqual(store.openTurn(store.get('a')), []);
});

for (const [name, end] of [
  ['interrupted', (store) => store.handleTranscriptRecord('a', { type: 'user', message: { content: '[Request interrupted by user]' } })],
  ['failed', (store, hook) => hook('StopFailure', { error: 'overloaded' })],
  ['ended with its session', (store, hook) => hook('SessionEnd', { reason: 'other' })],
]) {
  test(`a turn that ${name} is over once the transcript has caught up`, t => {
    t.mock.timers.enable({ apis: ['Date'], now: 1000 });
    const { store, hook } = setup();
    hook('UserPromptSubmit', { prompt: 'one' });
    end(store, hook);
    assert.notEqual(store.get('a').status, 'running');
    assert.equal(store.openTurn(store.get('a'))[0].text, 'one');
    t.mock.timers.tick(5000);
    assert.deepEqual(store.openTurn(store.get('a')), []);
  });
}

test('a turn that follows straight on from another brings it along', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'one' });
  t.mock.timers.tick(5000);
  hook('Stop', { last_assistant_message: 'done' });
  t.mock.timers.tick(50);
  hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>1</task-id>\n<status>completed</status>' });
  const turn = store.openTurn(store.get('a'));
  assert.equal(turn[0].text, 'one', 'the first turn\'s last words may still be on their way to the file');
  t.mock.timers.tick(5000);
  assert.equal(store.openTurn(store.get('a'))[0].kind, 'task.notification');
});

test('a turn is only ever made of its own session\'s events', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'mine' });
  store.handleHook({ session_id: 'b', cwd: '/x', hook_event_name: 'UserPromptSubmit', prompt: 'theirs' });
  assert.ok(store.openTurn(store.get('a')).every(e => e.sessionId === 'a'));
});

test('a turn that started before the log did is replayed from what is left', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'long' });
  for (let i = 0; i < 2600; i++) {
    hook('PreToolUse', { tool_use_id: `t${i}`, ...bash });
    hook('PostToolUse', { tool_use_id: `t${i}`, ...bash, tool_response: {} });
  }
  assert.deepEqual(store.openTurn(store.get('a')), [], 'nothing left says where it began, so history stands alone');
  hook('UserPromptSubmit', { prompt: 'still going' });
  assert.equal(store.openTurn(store.get('a'))[0].text, 'still going');
});

test('a session reports its model and its last words for a list', () => {
  const { store, hook } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-x' });
  hook('UserPromptSubmit', { prompt: 'hi' });
  hook('Stop', { last_assistant_message: 'done' });
  const [view] = store.sessions();
  assert.deepEqual([view.model, view.lastPrompt, view.lastMessage], ['claude-x', 'hi', 'done']);
});

test('a session from before a restart is listed again, idle and with nothing in progress', () => {
  const { store } = setup();
  store.restore([{ id: 'a', cwd: '/w', pane: '%1', transcriptPath: '/t', lastPrompt: 'hi', lastMessage: 'done', lastEventAt: 5 }]);
  const [view] = store.sessions();
  assert.deepEqual([view.id, view.status, view.pane, view.lastPrompt, view.lastMessage], ['a', 'idle', '%1', 'hi', 'done']);
  assert.deepEqual([view.tasks, view.requests], [[], []]);
});

test('a restored session carries on when it is next heard from', () => {
  const { store, hook, kinds } = setup();
  store.restore([{ id: 'a', cwd: '/w', pane: '%1', transcriptPath: '/t' }]);
  hook('UserPromptSubmit', { prompt: 'again' });
  assert.equal(store.get('a').status, 'running');
  assert.equal(store.get('a').pane, '%1', 'its pane is kept, so it can be typed into straight away');
  assert.ok(!kinds().includes('session.discovered'));
});

test('restoring never overwrites a session already heard from', () => {
  const { store, hook } = setup();
  hook('UserPromptSubmit', { prompt: 'new' });
  store.restore([{ id: 'a', cwd: '/old', pane: '%9' }]);
  assert.equal(store.get('a').cwd, '/w');
  assert.equal(store.get('a').status, 'running');
});

test('only sessions a restart could not find again are remembered', () => {
  const { store } = setup();
  store.handleHook({ session_id: 'tmux', cwd: '/w', hook_event_name: 'SessionStart' }, { pane: '%1' });
  store.handleHook({ session_id: 'plain', cwd: '/w', hook_event_name: 'SessionStart' });
  store.handleHook({ session_id: 'gone', cwd: '/w', hook_event_name: 'SessionStart' }, { pane: '%2' });
  store.handleHook({ session_id: 'gone', hook_event_name: 'SessionEnd', reason: 'other' });
  assert.deepEqual(store.registry().map(s => s.id), ['tmux']);
});

test('a model switch reaches clients, and the session remembers it', () => {
  const { store, hook, events } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
  hook('PostModelSwitch', { from_model: 'claude-haiku-5-5', to_model: 'claude-sonnet-5-5', source: 'command' });
  assert.equal(events.find(e => e.kind === 'session.model').model, 'claude-sonnet-5-5');
  assert.equal(store.sessions()[0].model, 'claude-sonnet-5-5');
});

test('a switch with no name leaves the model as it was', () => {
  const { store, hook, kinds } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
  hook('PostModelSwitch', {});
  assert.equal(store.get('a').model, 'claude-haiku-5-5');
  assert.ok(!kinds().includes('session.model'));
});

test('a switch to the model it\'s already on tells nobody', () => {
  const { hook, kinds } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
  hook('PostModelSwitch', { to_model: 'claude-haiku-5-5' });
  assert.ok(!kinds().includes('session.model'));
});

const effortEvents = events => events.filter(e => e.kind === 'session.effort').map(e => e.effort);

test('effort is reported when it changes, and only then', () => {
  const { store, hook, events } = setup();
  hook('Stop', { effort: { level: 'high' } });
  hook('PreToolUse', { ...bash, tool_use_id: 't', effort: { level: 'high' } });
  hook('Stop', { effort: { level: 'low' } });
  assert.deepEqual(effortEvents(events), ['high', 'low']);
  assert.equal(store.sessions()[0].effort, 'low');
});

test('an event with no effort says nothing about it', () => {
  const { store, hook, events } = setup();
  hook('Stop', { effort: { level: 'high' } });
  hook('UserPromptSubmit', { prompt: 'hi' });
  assert.deepEqual(effortEvents(events), ['high']);
  assert.equal(store.get('a').effort, 'high');
});

test('a subagent\'s effort is its own', () => {
  const { store, hook, events } = setup();
  hook('Stop', { effort: { level: 'high' } });
  hook('PreToolUse', { ...bash, tool_use_id: 't', agent_id: 'x', agent_type: 'Explore', effort: { level: 'low' } });
  assert.deepEqual(effortEvents(events), ['high']);
  assert.equal(store.get('a').effort, 'high');
});

test('a switch about to happen gets no answer, so Claude Code does what it would anyway', () => {
  const { hook } = setup();
  hook('SessionStart', {});
  assert.equal(hook('PreModelSwitch', { to_model: 'claude-sonnet-5-5' }), undefined);
});

const replyFrom = model => ({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'hi' }] } });

test('a session that hasn\'t said which model it\'s on is known by its replies', () => {
  const { store, hook, events } = setup();
  hook('SessionStart', { source: 'resume' });
  store.handleTranscriptRecord('a', replyFrom('claude-sonnet-5-5'));
  store.handleTranscriptRecord('a', replyFrom('claude-sonnet-5-5'));
  assert.deepEqual(events.filter(e => e.kind === 'session.model').map(e => e.model), ['claude-sonnet-5-5']);
  assert.equal(store.get('a').model, 'claude-sonnet-5-5');
});

test('a reply that lands after a switch doesn\'t undo it', () => {
  const { store, hook } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
  hook('PostModelSwitch', { to_model: 'claude-sonnet-5-5' });
  store.handleTranscriptRecord('a', replyFrom('claude-haiku-5-5'));
  assert.equal(store.get('a').model, 'claude-sonnet-5-5');
});

test('a resume forgets the old model, which it may not be on any more', () => {
  const { store, hook } = setup();
  hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
  hook('SessionStart', { source: 'resume' });
  assert.equal(store.get('a').model, undefined);
  hook('SessionStart', { source: 'resume', model: 'claude-opus-5-5' });
  assert.equal(store.get('a').model, 'claude-opus-5-5');
});

test('clearing or compacting leaves the model alone, when it says nothing about it', () => {
  for (const source of ['clear', 'compact']) {
    const { store, hook } = setup();
    hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
    hook('SessionStart', { source });
    assert.equal(store.get('a').model, 'claude-haiku-5-5', source);
  }
});
