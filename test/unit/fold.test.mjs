import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldedItems, foldedPage, foldedTurn, foldOverOf, foldRunsOf, stretchOf } from '../../src/fold.mjs';

const user = text => ({ role: 'user', at: 't0', text });
const said = text => ({ role: 'assistant', at: 't1', text });
const thought = text => ({ role: 'thinking', at: 't1', text });
const call = (id, name = 'Bash', more = {}) => ({ role: 'tool', at: 't1', toolUseId: id, name, input: { command: 'ls' }, result: 'out', isError: false, ...more });
const calls = (count, from = 0) => Array.from({ length: count }, (_, index) => call(`c${from + index}`));

test('a stretch of no more calls than asked stays as it was', () => {
  const items = [user('go'), said('first'), ...calls(3), said('done'), { role: 'turn_end', at: 't2' }];
  assert.deepEqual(foldedItems(items, 3), items);
});

test('a longer one is one fold of its calls, then its last words', () => {
  const items = [user('go'), thought('hm'), said('first'), ...calls(2), said('between'), ...calls(2, 2), thought('so'), said('done'), said('really'), { role: 'turn_end', at: 't2' }];
  const folded = foldedItems(items, 3);
  assert.deepEqual(folded.map(item => item.role), ['user', 'fold', 'assistant', 'assistant', 'turn_end']);
  assert.deepEqual(folded[1], { role: 'fold', at: 't1', key: 'c0', calls: ['c0', 'c1', 'c2', 'c3'].map(id => ({ toolUseId: id, name: 'Bash' })) });
  assert.deepEqual(folded.slice(2, 4).map(item => item.text), ['done', 'really']);
});

test('a call is told by its id, its name, whether it failed and the file it was about', () => {
  const items = [
    call('a', 'Read', { input: { file_path: '/x/a.txt' } }), call('b', 'Bash', { isError: true }),
    call('c', 'NotebookEdit', { input: { notebook_path: '/x/n.ipynb' } }), call('d', 'commandExecution', { input: { type: 'commandExecution', aggregatedOutput: 'long' } }),
  ];
  assert.deepEqual(foldedItems(items, 0)[0].calls, [
    { toolUseId: 'a', name: 'Read', file: '/x/a.txt' }, { toolUseId: 'b', name: 'Bash', isError: true },
    { toolUseId: 'c', name: 'NotebookEdit', file: '/x/n.ipynb' }, { toolUseId: 'd', name: 'commandExecution' },
  ]);
});

test('a Codex call says what its command did and to what, and the files its change touched', () => {
  const read = { type: 'commandExecution', id: 'r', command: 'cat a b', aggregatedOutput: 'long', commandActions: [{ type: 'read', command: 'cat a', name: 'a', path: '/x/a' }, { type: 'search', command: 'rg q', query: 'q' }] };
  const change = { type: 'fileChange', id: 'f', changes: [{ path: '/x/a', kind: { type: 'update', move_path: null }, diff: '@@ long' }, { path: '/x/b', kind: { type: 'add' }, diff: '+new' }] };
  const items = [call('r', 'commandExecution', { input: read }), call('f', 'fileChange', { input: change }), call('w', 'webSearch', { input: { type: 'webSearch', query: 'q' } })];
  assert.deepEqual(foldedItems(items, 0)[0].calls, [
    { toolUseId: 'r', name: 'commandExecution', commandActions: [{ type: 'read', path: '/x/a' }, { type: 'search' }] },
    { toolUseId: 'f', name: 'fileChange', changes: [{ path: '/x/a', kind: { type: 'update', move_path: null } }, { path: '/x/b', kind: { type: 'add' } }] },
    { toolUseId: 'w', name: 'webSearch' },
  ]);
  // Live, it's the item as it ended that says so.
  const turn = [
    event(1, 'tool.start', { toolUseId: 'r', name: 'commandExecution', input: { type: 'commandExecution', id: 'r', command: 'cat a b' } }),
    event(2, 'tool.end', { toolUseId: 'r', name: 'commandExecution', response: read, isError: false }),
  ];
  assert.deepEqual(foldedTurn(turn, 0)[0].calls, [{ toolUseId: 'r', name: 'commandExecution', commandActions: [{ type: 'read', path: '/x/a' }, { type: 'search' }] }]);
});

test("what a subagent did isn't counted, and goes with the call that started it", () => {
  const items = [call('agent', 'Agent'), call('inner1', 'Read', { parentToolUseId: 'agent' }), call('inner2', 'Read', { parentToolUseId: 'agent' }), call('after')];
  assert.deepEqual(foldedItems(items, 2), items, 'two calls of its own');
  assert.deepEqual(foldedItems(items, 1)[0].calls.map(one => one.toolUseId), ['agent', 'after']);
  assert.equal(foldedItems(items, 1).length, 1);
});

test('a page the session published stays whole, after the fold', () => {
  const card = call('p', 'Artifact', { page: { url: 'https://x', title: 'T' } });
  const folded = foldedItems([...calls(2), card, ...calls(2, 2), said('done')], 2);
  assert.deepEqual(folded.map(item => item.role), ['fold', 'tool', 'assistant']);
  assert.equal(folded[0].calls.length, 4);
  assert.deepEqual(folded[1], card);
});

test('a stretch that ends on a call has no last words', () => {
  assert.deepEqual(foldedItems([said('first'), ...calls(3)], 2).map(item => item.role), ['fold']);
});

test('what stands between stretches keeps them apart, each folded on its own', () => {
  const marker = { role: 'compact', at: 't1', trigger: 'auto' };
  const items = [user('one'), ...calls(3), said('a'), marker, ...calls(1, 3), user('two'), ...calls(3, 4), said('b')];
  const folded = foldedItems(items, 2);
  assert.deepEqual(folded.map(item => item.role), ['user', 'fold', 'assistant', 'compact', 'tool', 'user', 'fold', 'assistant']);
  assert.deepEqual(folded.filter(item => item.role === 'fold').map(item => item.key), ['c0', 'c4']);
});

test('a stretch is found again whole by the call its fold was named after, or by any other of its calls', () => {
  const items = [user('one'), said('first'), ...calls(3), said('a'), user('two'), ...calls(2, 3)];
  assert.deepEqual(stretchOf(items, 'c0'), items.slice(1, 6));
  assert.deepEqual(stretchOf(items, 'c2'), items.slice(1, 6));
  assert.deepEqual(stretchOf(items, 'c4'), items.slice(7));
  assert.equal(stretchOf(items, 'gone'), undefined);
});

const event = (seq, kind, more = {}) => ({ seq, at: seq * 10, sessionId: 's', kind, ...more });
const ran = (seq, id, more = {}) => [event(seq, 'tool.start', { toolUseId: id, name: 'Bash', input: { command: 'ls' }, ...more }), event(seq + 1, 'tool.end', { toolUseId: id, name: 'Bash', response: { stdout: 'o' }, isError: false })];

test('a turn going on with no more calls over than asked is as it was', () => {
  const turn = [event(1, 'message.user', { text: 'go' }), ...ran(2, 'a'), ...ran(4, 'b')];
  assert.deepEqual(foldedTurn(turn, 2), turn);
});

test('its calls that are over become one fold where the first of them was, and what follows the last stays', () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }), event(2, 'session.status', { status: 'running' }),
    event(3, 'message.thinking', { text: 'hm' }),
    event(4, 'message.assistant.delta', { messageId: 'm1', index: 0, text: 'first', final: true }),
    ...ran(5, 'a'), event(7, 'tool.images', { toolUseId: 'a', images: [] }), ...ran(8, 'b'),
    event(10, 'message.assistant.delta', { messageId: 'm2', index: 0, text: 'between', final: true }),
    ...ran(11, 'c'),
    event(13, 'message.assistant.delta', { messageId: 'm3', index: 0, text: 'now', final: false }),
    event(14, 'tool.start', { toolUseId: 'd', name: 'Read', input: { file_path: '/f' } }),
  ];
  const folded = foldedTurn(turn, 2);
  assert.deepEqual(folded.map(one => one.kind), ['message.user', 'session.status', 'turn.fold', 'message.assistant.delta', 'tool.start']);
  assert.deepEqual(folded[2], { seq: 3, at: 30, sessionId: 's', kind: 'turn.fold', key: 'a', calls: ['a', 'b', 'c'].map(id => ({ toolUseId: id, name: 'Bash' })) });
  assert.equal(folded[3].messageId, 'm3');
  assert.equal(folded[4].toolUseId, 'd');
});

test('a call still going, a message still being written and what says how the session stands stay where they were', () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }),
    event(2, 'tool.start', { toolUseId: 'slow', name: 'Bash', input: {} }),
    event(3, 'message.assistant.delta', { messageId: 'open', index: 0, text: 'part' }),
    ...ran(4, 'a'), event(6, 'request.opened', { request: { id: 'r' } }), ...ran(7, 'b'),
    event(9, 'background.task', { task: {} }), ...ran(10, 'c', { input: { file_path: '/x' }, name: 'Read' }),
  ];
  const folded = foldedTurn(turn, 2);
  assert.deepEqual(folded.map(one => one.kind), ['message.user', 'tool.start', 'message.assistant.delta', 'turn.fold', 'request.opened', 'background.task']);
  assert.deepEqual(folded[3].calls.at(-1), { toolUseId: 'c', name: 'Read', file: '/x' });
});

test("a subagent's calls go with the fold uncounted, a failed call says so, and a published page stays", () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }),
    event(2, 'tool.start', { toolUseId: 'agent', name: 'Agent', input: {} }),
    event(3, 'tool.start', { toolUseId: 'in', name: 'Read', input: {}, agentId: 'x', parentToolUseId: 'agent' }),
    event(4, 'tool.end', { toolUseId: 'in', name: 'Read', response: {}, isError: false, agentId: 'x', parentToolUseId: 'agent' }),
    event(5, 'tool.end', { toolUseId: 'agent', name: 'Agent', response: {}, isError: false }),
    event(6, 'tool.start', { toolUseId: 'page', name: 'Artifact', input: {} }),
    event(7, 'tool.end', { toolUseId: 'page', name: 'Artifact', response: { url: 'u' }, isError: false }),
    event(8, 'tool.start', { toolUseId: 'bad', name: 'Bash', input: {} }),
    event(9, 'tool.end', { toolUseId: 'bad', name: 'Bash', response: 'no', isError: true }),
    event(10, 'tool.start', { toolUseId: 'cut', name: 'Bash', input: {} }),
    event(11, 'tool.end', { toolUseId: 'cut', name: 'Bash', isError: true, interrupted: true }),
  ];
  const folded = foldedTurn(turn, 1);
  assert.deepEqual(folded[1].calls, [{ toolUseId: 'agent', name: 'Agent' }, { toolUseId: 'bad', name: 'Bash', isError: true }]);
  assert.deepEqual(folded.map(one => [one.kind, one.toolUseId]).slice(2), [['tool.start', 'page'], ['tool.end', 'page'], ['tool.start', 'cut'], ['tool.end', 'cut']]);
});

test("each stretch of a turn's events is folded on its own, where history would cut it", () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }), ...ran(2, 'a'), ...ran(4, 'b'),
    event(6, 'message.user', { text: 'and this', clientId: 'q' }), ...ran(7, 'c'),
    event(9, 'compact.end', { trigger: 'auto' }), ...ran(10, 'd'), ...ran(12, 'e'),
    event(14, 'message.assistant.delta', { messageId: 'm', index: 0, text: 'done', final: true }),
    event(15, 'turn.end', {}), event(16, 'message.user', { text: 'next' }), ...ran(17, 'f'), ...ran(19, 'g'), ...ran(21, 'h'),
  ];
  const folded = foldedTurn(turn, 1);
  assert.deepEqual(folded.map(one => one.kind === 'turn.fold' ? one.calls.map(call => call.toolUseId).join('') : one.kind), [
    'message.user', 'ab', 'message.user', 'tool.start', 'tool.end', 'compact.end', 'de', 'message.assistant.delta', 'turn.end', 'message.user', 'fgh',
  ]);
  assert.deepEqual(folded.filter(one => one.kind === 'turn.fold').map(one => [one.key, one.seq]), [['a', 2], ['d', 10], ['f', 17]]);
  for (const cut of ['message.output', 'turn.interrupted', 'turn.error']) {
    const two = foldedTurn([...ran(1, 'a'), ...ran(3, 'b'), event(5, cut, {}), ...ran(6, 'c'), ...ran(8, 'd')], 1);
    assert.deepEqual(two.map(one => one.kind), ['turn.fold', cut, 'turn.fold'], cut);
  }
});

test('a call that ends in a later stretch than it began in is left as it was', () => {
  const turn = [
    event(1, 'tool.start', { toolUseId: 'slow', name: 'Bash', input: {} }), ...ran(2, 'a'), ...ran(4, 'b'),
    event(6, 'message.user', { text: 'meanwhile' }),
    event(7, 'tool.end', { toolUseId: 'slow', name: 'Bash', response: {}, isError: false }), ...ran(8, 'c'), ...ran(10, 'd'),
  ];
  const folded = foldedTurn(turn, 1);
  assert.deepEqual(folded.map(one => [one.kind, one.toolUseId ?? one.calls?.length]), [
    ['tool.start', 'slow'], ['turn.fold', 2], ['message.user', undefined], ['tool.end', 'slow'], ['turn.fold', 2],
  ]);
});

test('only a client that asks gets folds, and asks with a whole number', () => {
  assert.equal(foldOverOf({ foldOver: 20 }), 20);
  assert.equal(foldOverOf({ foldOver: 0 }), 0);
  for (const other of [{}, { foldOver: '20' }, { foldOver: -1 }, { foldOver: 1.5 }, undefined]) assert.equal(foldOverOf(other), undefined);
  const page = { items: [...calls(3), said('done')], turn: [event(1, 'message.user', {}), ...ran(2, 'a'), ...ran(4, 'b')], before: 0, hasMore: false };
  assert.deepEqual(foldedPage(page, undefined), page);
  const folded = foldedPage(page, 1);
  assert.deepEqual(folded.items.map(item => item.role), ['fold', 'assistant']);
  assert.deepEqual(folded.turn.map(one => one.kind), ['message.user', 'turn.fold']);
  assert.equal(folded.hasMore, false);
  assert.deepEqual(foldedPage({ items: [] }, 1), { items: [] });
});

// A client that shows what was said between calls asks with `foldRuns` (0.43.0).

test('with foldRuns, a longer one keeps its words where they were, and folds each run of calls between them', () => {
  const items = [user('go'), thought('hm'), said('first'), ...calls(2), said('between'), ...calls(2, 2), thought('so'), said('done'), said('really'), { role: 'turn_end', at: 't2' }];
  const folded = foldedItems(items, 3, true);
  assert.deepEqual(folded.map(item => item.role), ['user', 'thinking', 'assistant', 'fold', 'assistant', 'fold', 'assistant', 'assistant', 'turn_end']);
  assert.deepEqual(folded[3], { role: 'fold', at: 't1', key: 'c0', calls: ['c0', 'c1'].map(id => ({ toolUseId: id, name: 'Bash' })) });
  assert.deepEqual(folded[5], { role: 'fold', at: 't1', key: 'c2', calls: ['c2', 'c3'].map(id => ({ toolUseId: id, name: 'Bash' })) });
  assert.deepEqual(folded.filter(item => item.role === 'assistant').map(item => item.text), ['first', 'between', 'done', 'really']);
  // What was thought with no call beside it has nothing to go into, and stays.
  assert.equal(folded[1].text, 'hm');
  // No more calls than asked: as it was.
  assert.deepEqual(foldedItems(items, 4, true), items);
});

test('with foldRuns, words before the calls stay before them, and a page the session published comes after its run', () => {
  assert.deepEqual(foldedItems([said('first'), ...calls(3)], 2, true).map(item => item.role), ['assistant', 'fold']);
  const card = call('p', 'Artifact', { page: { url: 'https://x', title: 'T' } });
  const folded = foldedItems([...calls(2), card, said('mid'), ...calls(2, 2), said('done')], 2, true);
  assert.deepEqual(folded.map(item => item.role), ['fold', 'tool', 'assistant', 'fold', 'assistant']);
  assert.deepEqual(folded[1], card);
});

test('with foldRuns, a run of calls is found again whole by any of its calls, without the words around it', () => {
  const items = [user('one'), said('first'), ...calls(3), thought('then'), said('a'), call('c9'), user('two'), ...calls(2, 3)];
  assert.deepEqual(stretchOf(items, 'c0', true), items.slice(2, 6));
  assert.deepEqual(stretchOf(items, 'c2', true), items.slice(2, 6));
  assert.deepEqual(stretchOf(items, 'c9', true), [items[7]]);
  assert.deepEqual(stretchOf(items, 'c4', true), items.slice(9));
  assert.equal(stretchOf(items, 'gone', true), undefined);
  assert.deepEqual(stretchOf(items, 'c9'), items.slice(1, 8), 'without it, the stretch whole, as ever');
});

test('with foldRuns, its calls that are over become a fold for each run between what was said, where the first of the run was', () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }), event(2, 'session.status', { status: 'running' }),
    event(3, 'message.thinking', { text: 'hm' }),
    event(4, 'message.assistant.delta', { messageId: 'm1', index: 0, text: 'first', final: true }),
    ...ran(5, 'a'), event(7, 'tool.images', { toolUseId: 'a', images: [] }), ...ran(8, 'b'),
    event(10, 'message.assistant.delta', { messageId: 'm2', index: 0, text: 'between', final: true }),
    ...ran(11, 'c'),
    event(13, 'message.assistant.delta', { messageId: 'm3', index: 0, text: 'now', final: false }),
    event(14, 'tool.start', { toolUseId: 'd', name: 'Read', input: { file_path: '/f' } }),
  ];
  const folded = foldedTurn(turn, 2, true);
  assert.deepEqual(folded.map(one => one.kind), [
    'message.user', 'session.status', 'message.thinking', 'message.assistant.delta', 'turn.fold', 'message.assistant.delta', 'turn.fold',
    'message.assistant.delta', 'tool.start',
  ]);
  assert.deepEqual(folded[4], { seq: 5, at: 50, sessionId: 's', kind: 'turn.fold', key: 'a', calls: ['a', 'b'].map(id => ({ toolUseId: id, name: 'Bash' })) });
  assert.deepEqual(folded[6], { seq: 11, at: 110, sessionId: 's', kind: 'turn.fold', key: 'c', calls: [{ toolUseId: 'c', name: 'Bash' }] });
  assert.deepEqual(folded.filter(one => one.kind === 'message.assistant.delta').map(one => one.messageId), ['m1', 'm2', 'm3']);
  assert.equal(folded.at(-1).toolUseId, 'd');
});

test('with foldRuns, what was thought among the calls of a run goes into its fold, and the pieces of what was said all stay', () => {
  const turn = [
    event(1, 'message.user', { text: 'go' }), ...ran(2, 'a'), event(4, 'message.thinking', { text: 'hm' }), ...ran(5, 'b'),
    event(7, 'message.assistant.delta', { messageId: 'm', index: 0, text: 'half', final: false }),
    event(8, 'message.assistant.delta', { messageId: 'm', index: 1, text: ' and all', final: true }),
    ...ran(9, 'c'), ...ran(11, 'd'),
  ];
  const folded = foldedTurn(turn, 3, true);
  assert.deepEqual(folded.map(one => (one.kind === 'turn.fold' ? one.calls.map(call => call.toolUseId).join('') : one.kind)), [
    'message.user', 'ab', 'message.assistant.delta', 'message.assistant.delta', 'cd',
  ]);
  assert.deepEqual(foldedTurn(turn, 4, true), turn, 'no more calls than asked');
});

test('runs are only for a client that asks with foldRuns: true', () => {
  assert.equal(foldRunsOf({ foldRuns: true }), true);
  for (const other of [{}, { foldRuns: 'true' }, { foldRuns: 1 }, undefined]) assert.equal(foldRunsOf(other), false);
  const page = { items: [said('a'), ...calls(2), said('b'), ...calls(2, 2)], turn: [], before: 0, hasMore: false };
  assert.deepEqual(foldedPage(page, 1).items.map(item => item.role), ['fold'], 'one fold of the stretch, as ever');
  assert.deepEqual(foldedPage(page, 1, true).items.map(item => item.role), ['assistant', 'fold', 'assistant', 'fold']);
});
