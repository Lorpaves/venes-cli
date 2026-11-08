import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TranscriptTail, parseTaskNotification, readAgentParent, readHistory, readImage, readTail, shellCommand, shellOutput, signalsFrom, unwrapPasted,
} from '../../src/transcript.mjs';

const line = record => `${JSON.stringify(record)}\n`;

function tempFile(content = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-test-'));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, content);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true }) };
}

test('interrupts are recognised in both content shapes', () => {
  assert.deepEqual(signalsFrom({ type: 'user', message: { content: '[Request interrupted by user]' } }), [{ type: 'interrupted' }]);
  assert.deepEqual(signalsFrom({
    type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] },
  }), [{ type: 'interrupted' }]);
});

test('the queue says when a message typed during a turn was read or taken back', () => {
  assert.deepEqual(signalsFrom({ type: 'queue-operation', operation: 'remove', content: 'more', reason: 'absorbed_mid_turn' }), [{ type: 'queueRead', text: 'more' }]);
  assert.deepEqual(signalsFrom({ type: 'queue-operation', operation: 'dequeue' }), [{ type: 'queueRead', text: undefined }]);
  assert.deepEqual(signalsFrom({ type: 'queue-operation', operation: 'popAll', content: 'more' }), [{ type: 'queueTakenBack' }]);
  assert.deepEqual(signalsFrom({ type: 'queue-operation', operation: 'enqueue', content: 'more' }), []);
});

test('ordinary and unknown records produce no signal', () => {
  assert.deepEqual(signalsFrom({ type: 'user', message: { content: 'hello' } }), []);
  assert.deepEqual(signalsFrom({ type: 'assistant', message: { content: '[Request interrupted by user]' } }), []);
  assert.deepEqual(signalsFrom({ type: 'mode' }), []);
  assert.deepEqual(signalsFrom(null), []);
});

test('the tail only reports what was written after it started', () => {
  const { file, cleanup } = tempFile(line({ type: 'user', n: 1 }));
  try {
    const tail = new TranscriptTail(file);
    assert.deepEqual(tail.poll(), []);
    fs.appendFileSync(file, line({ type: 'user', n: 2 }));
    assert.deepEqual(tail.poll().map(r => r.n), [2]);
  } finally { cleanup(); }
});

test('a half-written line waits for the rest', () => {
  const { file, cleanup } = tempFile();
  try {
    const tail = new TranscriptTail(file);
    const text = line({ n: 1 });
    fs.appendFileSync(file, text.slice(0, 4));
    assert.deepEqual(tail.poll(), []);
    fs.appendFileSync(file, text.slice(4));
    assert.deepEqual(tail.poll().map(r => r.n), [1]);
  } finally { cleanup(); }
});

test('multi-byte text split across polls survives', () => {
  const { file, cleanup } = tempFile();
  try {
    const tail = new TranscriptTail(file);
    const bytes = Buffer.from(line({ text: '你好' }));
    fs.appendFileSync(file, bytes.subarray(0, 11));
    assert.deepEqual(tail.poll(), []);
    fs.appendFileSync(file, bytes.subarray(11));
    assert.equal(tail.poll()[0].text, '你好');
  } finally { cleanup(); }
});

test('a pasted message is shown as it was sent', () => {
  const wrapped = '\n\n<pasted_content id="e9f4">\nfirst\nsecond\n</pasted_content id="e9f4">\n';
  assert.equal(unwrapPasted(wrapped), 'first\nsecond');
});

test('typed text before a paste is kept', () => {
  const wrapped = 'look at this\n\n<pasted_content id="a1">\nbody\n</pasted_content id="a1">\n';
  assert.equal(unwrapPasted(wrapped), 'look at this\n\nbody');
});

test('text that merely mentions the tag is left alone', () => {
  const text = 'what does <pasted_content id="x"> mean?';
  assert.equal(unwrapPasted(text), text);
});

test('a missing transcript is not an error', () => {
  const tail = new TranscriptTail('/nonexistent/venes.jsonl');
  assert.deepEqual(tail.poll(), []);
});

test('history joins tool calls to results and hides internal records', () => {
  const { file, cleanup } = tempFile([
    line({ type: 'mode' }),
    line({ type: 'user', message: { content: 'hello' } }),
    line({ type: 'user', isMeta: true, message: { content: 'hidden' } }),
    line({ type: 'user', message: { content: '<task-notification>x' } }),
    line({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
    line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } }),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'subagent' }] } }),
    line({ type: 'user', message: { content: '[Request interrupted by user]' } }),
    '{ broken\n',
  ].join(''));
  try {
    const { items } = readHistory(file);
    assert.deepEqual(items.map(i => i.role), ['user', 'thinking', 'assistant', 'tool', 'system']);
    assert.equal(items[3].result, 'a.txt');
  } finally { cleanup(); }
});

const userText = text => line({ type: 'user', message: { content: text } });

test('history pages backwards from a cursor without overlapping', () => {
  const { file, cleanup } = tempFile(['a', 'b', 'c', 'd', 'e'].map(userText).join(''));
  try {
    const first = readHistory(file, { limit: 2 });
    assert.deepEqual(first.items.map(i => i.text), ['d', 'e']);
    assert.deepEqual([first.before, first.hasMore], [3, true]);
    const second = readHistory(file, { limit: 2, before: first.before });
    assert.deepEqual(second.items.map(i => i.text), ['b', 'c']);
    const last = readHistory(file, { limit: 2, before: second.before });
    assert.deepEqual(last.items.map(i => i.text), ['a']);
    assert.deepEqual([last.before, last.hasMore], [0, false]);
  } finally { cleanup(); }
});

const assistantText = text => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const bash = id => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
const turnEnd = line({ type: 'system', subtype: 'turn_duration', durationMs: 5 });
const compaction = line({ type: 'system', subtype: 'compact_boundary', compactMetadata: {} });
const shown = page => page.items.map(item => item.text ?? item.toolUseId ?? item.role);

test('a page reaches back to the start of the turn its limit lands in', () => {
  const { file, cleanup } = tempFile([
    userText('old'), assistantText('old reply'), turnEnd,
    userText('ask'), assistantText('on it'), bash('t1'), bash('t2'), assistantText('done'), turnEnd,
  ].join(''));
  try {
    const page = readHistory(file, { limit: 2 });
    assert.deepEqual(shown(page), ['ask', 'on it', 't1', 't2', 'done', 'turn_end']);
    assert.deepEqual([page.before, page.hasMore], [3, true]);
    assert.deepEqual(shown(readHistory(file, { limit: 2, before: page.before })), ['old', 'old reply', 'turn_end']);
  } finally { cleanup(); }
});

test('the page above ends where the one below begins, so no turn is cut', () => {
  const { file, cleanup } = tempFile([
    userText('a'), bash('t1'), bash('t2'), bash('t3'), turnEnd,
    userText('b'), bash('t4'), bash('t5'), bash('t6'), turnEnd,
    userText('c'), bash('t7'),
  ].join(''));
  try {
    const seen = [];
    let before;
    do {
      const page = readHistory(file, { limit: 3, before });
      assert.equal(page.items[0].role, 'user', 'every page opens at a prompt');
      seen.unshift(...shown(page));
      ({ before } = page);
    } while (before > 0);
    assert.deepEqual(seen, ['a', 't1', 't2', 't3', 'turn_end', 'b', 't4', 't5', 't6', 'turn_end', 'c', 't7']);
  } finally { cleanup(); }
});

test('a limit that lands where a turn begins stays where it landed', () => {
  const { file, cleanup } = tempFile([userText('a'), bash('t1'), turnEnd, userText('b'), bash('t2')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 2 })), ['b', 't2']);
  } finally { cleanup(); }
});

test('a turn with no prompt begins after the one before it ended', () => {
  const { file, cleanup } = tempFile([userText('a'), bash('t1'), turnEnd, assistantText('a task finished'), bash('t2'), bash('t3')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 1 })), ['a task finished', 't2', 't3']);
  } finally { cleanup(); }
});

test('a stopped turn ends there', () => {
  const { file, cleanup } = tempFile([userText('a'), bash('t1'), userText('[Request interrupted by user]'), assistantText('next'), bash('t2')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 1 })), ['next', 't2']);
  } finally { cleanup(); }
});

test('a compaction in the middle of a turn doesn\'t begin one', () => {
  const { file, cleanup } = tempFile([userText('a'), bash('t1'), compaction, bash('t2')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 1 })), ['a', 't1', 'compact', 't2']);
    assert.deepEqual(shown(readHistory(file, { limit: 2 })), ['a', 't1', 'compact', 't2']);
  } finally { cleanup(); }
});

test('a compaction between turns stays with the turn after it', () => {
  const { file, cleanup } = tempFile([userText('a'), turnEnd, compaction, userText('b'), bash('t1')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 3 })), ['compact', 'b', 't1']);
  } finally { cleanup(); }
});

const png = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
const shownByTool = (id, ...parts) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: parts }] } });
const sentWith = (text, ...images) => line({ type: 'user', message: { content: [{ type: 'text', text }, ...images] } });

test('a page lists a message\'s images, and readImage fetches each one', () => {
  const { file, cleanup } = tempFile([userText('before'), sentWith('look at [Image #1]', png('QUJD'), png('REVG'))].join(''));
  try {
    const [, sent] = readHistory(file).items;
    assert.equal(sent.text, 'look at [Image #1]');
    assert.deepEqual(sent.images.map(({ mediaType, bytes }) => [mediaType, bytes]), [['image/png', 3], ['image/png', 3]]);
    assert.deepEqual(sent.images.map(image => readImage(file, image.id).data), ['QUJD', 'REVG']);
    assert.equal(readImage(file, sent.images[0].id).mediaType, 'image/png');
  } finally { cleanup(); }
});

test('an image with nothing to show it under doesn\'t land on an earlier message', () => {
  const { file, cleanup } = tempFile([userText('earlier'), sentWith('<system-reminder>not for reading</system-reminder>', png('QUJD'))].join(''));
  try {
    assert.equal(readHistory(file).items[0].images, undefined);
  } finally { cleanup(); }
});

test('a page leaves the image itself out', () => {
  const { file, cleanup } = tempFile(sentWith('look', png('QUJD')));
  try {
    assert.ok(!JSON.stringify(readHistory(file)).includes('QUJD'));
  } finally { cleanup(); }
});

test('what a tool showed goes with its call, among the words it came with', () => {
  const { file, cleanup } = tempFile([
    userText('read them'), bash('t1'), bash('t2'),
    shownByTool('t1', png('QUJD'), { type: 'text', text: 'one' }), shownByTool('t2', { type: 'text', text: 'none' }),
  ].join(''));
  try {
    const [, first, second] = readHistory(file).items;
    assert.equal(first.result, 'one');
    assert.equal(readImage(file, first.images[0].id).data, 'QUJD');
    assert.equal(second.images, undefined);
  } finally { cleanup(); }
});

test('two tools in one record each keep their own images', () => {
  const record = line({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: [png('QUJD')] }, { type: 'tool_result', tool_use_id: 't2', content: [png('REVG')] },
  ] } });
  const { file, cleanup } = tempFile([bash('t1'), bash('t2'), record].join(''));
  try {
    const [first, second] = readHistory(file).items;
    assert.deepEqual([first, second].map(item => readImage(file, item.images[0].id).data), ['QUJD', 'REVG']);
  } finally { cleanup(); }
});

test('a message sent during a turn keeps its images', () => {
  const queued = line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: [{ type: 'text', text: 'and this' }, png('QUJD')] } });
  const { file, cleanup } = tempFile([userText('first'), queued].join(''));
  try {
    const { images } = readHistory(file).items.at(-1);
    assert.equal(readImage(file, images[0].id).data, 'QUJD');
  } finally { cleanup(); }
});

test('an id stays good while the session writes more, and in a file with no last newline', () => {
  const { file, cleanup } = tempFile(sentWith('look', png('QUJD')).trimEnd());
  try {
    const [{ id }] = readHistory(file).items[0].images;
    fs.appendFileSync(file, `\n${sentWith('and more', png('REVG'))}`);
    assert.equal(readImage(file, id).data, 'QUJD');
  } finally { cleanup(); }
});

test('characters that take several bytes don\'t throw an id off', () => {
  const { file, cleanup } = tempFile([userText('中文 🙂 中文'), sentWith('看这个', png('QUJD'))].join(''));
  try {
    assert.equal(readImage(file, readHistory(file).items[1].images[0].id).data, 'QUJD');
  } finally { cleanup(); }
});

test('a line longer than one read still comes back whole', () => {
  const data = 'QUJD'.repeat(700_000);
  const { file, cleanup } = tempFile(sentWith('big', png(data)));
  try {
    assert.equal(readImage(file, readHistory(file).items[0].images[0].id).data, data);
  } finally { cleanup(); }
});

test('an id that doesn\'t lead to an image finds nothing', () => {
  const { file, cleanup } = tempFile(sentWith('look', png('QUJD')));
  try {
    for (const id of ['0:1', '5:0', '999999:0', 'nonsense', '', undefined, '0:0:0', '-1:0']) {
      assert.equal(readImage(file, id), undefined, id);
    }
    assert.equal(readImage('/nonexistent/venes/t.jsonl', '0:0'), undefined);
  } finally { cleanup(); }
});

test('subagent calls have no images, because their ids would point at another file', () => {
  const { file, cleanup, write } = withSubagent(userText('go') + toolCall('agent1', 'Agent'));
  write('a', 'agent1', [toolCall('sub1', 'Read').replace('"type":"assistant"', '"isSidechain":true,"type":"assistant"'), shownByTool('sub1', png('QUJD'))]);
  try {
    assert.equal(readHistory(file).items.find(item => item.toolUseId === 'sub1').images, undefined);
  } finally { cleanup(); }
});

test('the tail says which images a record brought, with ids that work', () => {
  const { file, cleanup } = tempFile(userText('old'));
  try {
    const tail = new TranscriptTail(file);
    const record = shownByTool('t1', png('QUJD'), png('REVG'));
    fs.appendFileSync(file, record.slice(0, 25));
    assert.deepEqual(tail.poll(), [], 'half a line isn\'t a record yet');
    fs.appendFileSync(file, `${record.slice(25)}${sentWith('中文', png('R0hJ'))}`);
    const [tool, sent] = tail.poll().flatMap(signalsFrom).filter(signal => /Images$/.test(signal.type));
    assert.equal(tool.type, 'toolImages');
    assert.equal(tool.toolUseId, 't1');
    assert.deepEqual(tool.images.map(image => readImage(file, image.id).data), ['QUJD', 'REVG']);
    assert.equal(sent.type, 'userImages');
    assert.equal(readImage(file, sent.images[0].id).data, 'R0hJ');
  } finally { cleanup(); }
});

test('a queued message\'s images are signalled, and other attachments have none', () => {
  const queued = { type: 'attachment', attachment: { type: 'queued_command', prompt: [png('QUJD')] } };
  assert.equal(signalsFrom(queued)[0].type, 'userImages');
  assert.deepEqual(signalsFrom({ type: 'attachment', attachment: { type: 'other', prompt: [png('QUJD')] } }), []);
});

test('what Claude Code adds by itself isn\'t a message with images', () => {
  assert.deepEqual(signalsFrom({ type: 'user', isMeta: true, message: { content: [png('QUJD')] } }), []);
});

test('a cursor still points at the same place after the session writes more', () => {
  const { file, cleanup } = tempFile(['a', 'b', 'c'].map(userText).join(''));
  try {
    const { before } = readHistory(file, { limit: 1 });
    fs.appendFileSync(file, userText('d'));
    assert.deepEqual(readHistory(file, { limit: 1, before }).items.map(i => i.text), ['b']);
  } finally { cleanup(); }
});

test('history includes messages sent during a turn, which have no user record', () => {
  const queued = (prompt, extra) => line({ type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt, ...extra } });
  const { file, cleanup } = tempFile([
    userText('first'),
    queued('typed while running', { origin: { kind: 'human' } }),
    queued([{ type: 'text', text: 'with an image' }, { type: 'image' }], { origin: { kind: 'human' } }),
    queued('from another session', { origin: { kind: 'peer' } }),
    queued('<task-notification>x', { commandMode: 'task-notification' }),
    line({ type: 'attachment', attachment: { type: 'date' } }),
  ].join(''));
  try {
    assert.deepEqual(readHistory(file).items.map(i => i.text), ['first', 'typed while running', 'with an image']);
  } finally { cleanup(); }
});

test('history marks turn ends and compaction, and hides the summary Claude reads', () => {
  const { file, cleanup } = tempFile([
    userText('hi'),
    line({ type: 'system', subtype: 'turn_duration', durationMs: 1200 }),
    line({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 900, postTokens: 100 } }),
    line({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued...' } }),
    line({ type: 'system', subtype: 'stop_hook_summary' }),
  ].join(''));
  try {
    const { items } = readHistory(file);
    assert.deepEqual(items.map(i => i.role), ['user', 'turn_end', 'compact']);
    assert.equal(items[1].durationMs, 1200);
    assert.deepEqual([items[2].preTokens, items[2].postTokens], [900, 100]);
  } finally { cleanup(); }
});

test('history keeps thinking that has a duration, even with no text', () => {
  const think = (thinking, thinkingDurationMs) => line({
    type: 'assistant', thinkingDurationMs, message: { content: [{ type: 'thinking', thinking }] },
  });
  const { file, cleanup } = tempFile(think('', 800) + think('', undefined) + think('why', 5));
  try {
    assert.deepEqual(readHistory(file).items.map(i => [i.text, i.durationMs]), [['', 800], ['why', 5]]);
  } finally { cleanup(); }
});

function withSubagent(parent) {
  const made = tempFile(parent);
  const dir = made.file.replace(/\.jsonl$/, '/subagents');
  fs.mkdirSync(dir, { recursive: true });
  const write = (id, toolUseId, records) => {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify({ toolUseId }));
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), records.join(''));
  };
  return { ...made, write };
}

const toolCall = (id, name) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });
const toolResult = (id, text) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });

test('history puts a subagent\'s calls under the call that started it', () => {
  const { file, cleanup, write } = withSubagent(userText('go') + toolCall('agent1', 'Agent') + toolCall('other', 'Read'));
  write('a', 'agent1', [
    line({ type: 'user', isSidechain: true, message: { content: 'the prompt' } }),
    toolCall('sub1', 'Bash').replace('"type":"assistant"', '"isSidechain":true,"type":"assistant"'),
    toolResult('sub1', 'out'),
    line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'what it wrote' }] } }),
  ]);
  try {
    const { items } = readHistory(file);
    assert.deepEqual(items.map(i => i.toolUseId ?? i.role), ['user', 'agent1', 'sub1', 'other']);
    const sub = items[2];
    assert.deepEqual([sub.parentToolUseId, sub.result], ['agent1', 'out']);
    assert.equal(readHistory(file, { limit: 3 }).items.length, 4, 'subagent calls come with their parent, outside the limit');
  } finally { cleanup(); }
});

test('nested subagents stay nested', () => {
  const { file, cleanup, write } = withSubagent(toolCall('outer', 'Agent'));
  write('a', 'outer', [toolCall('inner', 'Agent')]);
  write('b', 'inner', [toolCall('leaf', 'Bash')]);
  try {
    assert.deepEqual(readHistory(file).items.map(i => [i.toolUseId, i.parentToolUseId]), [['outer', undefined], ['inner', 'outer'], ['leaf', 'inner']]);
  } finally { cleanup(); }
});

test('a subagent\'s parent comes from its metadata file', () => {
  const { file, cleanup, write } = withSubagent('');
  write('a', 'toolu_1', []);
  try {
    assert.equal(readAgentParent(file, 'a'), 'toolu_1');
    assert.equal(readAgentParent(file, 'missing'), undefined);
  } finally { cleanup(); }
});

test('thinking is reported with whatever Claude Code stored', () => {
  const record = (thinking, thinkingDurationMs) => ({ type: 'assistant', thinkingDurationMs, message: { content: [{ type: 'thinking', thinking }] } });
  assert.deepEqual(signalsFrom(record('because', 900)), [{ type: 'thinking', text: 'because', durationMs: 900 }]);
  assert.deepEqual(signalsFrom(record('', 900)), [{ type: 'thinking', text: '', durationMs: 900 }]);
  assert.deepEqual(signalsFrom(record('', undefined)), []);
});

test('a subagent\'s records never count as the session\'s own', () => {
  assert.deepEqual(signalsFrom({ type: 'user', isSidechain: true, message: { content: '[Request interrupted by user]' } }), []);
});

test('compaction sizes and refusals are read from system records', () => {
  assert.deepEqual(
    signalsFrom({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 900, postTokens: 100 } }),
    [{ type: 'compacted', preTokens: 900, postTokens: 100 }],
  );
  const [refusal] = signalsFrom({
    type: 'system', subtype: 'model_refusal_fallback', uuid: 'u', originalModel: 'big', fallbackModel: 'small',
    apiRefusalCategory: 'cyber', content: 'Switched models',
  });
  assert.deepEqual([refusal.type, refusal.id, refusal.model, refusal.fallbackModel, refusal.category], ['refusal', 'u', 'big', 'small', 'cyber']);
  assert.equal(signalsFrom({ type: 'system', subtype: 'model_refusal_no_fallback', originalModel: 'big' })[0].fallbackModel, undefined);
  assert.deepEqual(signalsFrom({ type: 'system', subtype: 'turn_duration' }), []);
});

test('a local command\'s output is read from either kind of record', () => {
  assert.deepEqual(
    signalsFrom({ type: 'system', subtype: 'local_command', content: '<local-command-stdout>Not enough messages to compact.</local-command-stdout>' }),
    [{ type: 'localOutput', text: 'Not enough messages to compact.' }],
  );
  assert.deepEqual(
    signalsFrom({ type: 'user', message: { content: '<local-command-stderr>failed\nbadly</local-command-stderr>' } }),
    [{ type: 'localOutput', text: 'failed\nbadly' }],
  );
  assert.deepEqual(signalsFrom({ type: 'system', subtype: 'local_command', content: '<command-name>/usage</command-name>' }), []);
});

test('a background command\'s output file is found in its tool result', () => {
  const content = 'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output. Keep going.';
  const [signal] = signalsFrom({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } });
  assert.equal(signal.outputFile, '/tmp/x/tasks/b1.output');
});

test('a command moved to the background, by a message or its timeout, has its output file found too', () => {
  const outputOf = content => signalsFrom({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } })[0].outputFile;
  assert.equal(outputOf(
    'Command was moved to the background (ID: bljlg8ger) so that a message that arrived while it was running can reach you; it was not interrupted. '
    + 'Output is being written to: /private/tmp/c/tasks/bljlg8ger.output. You will be notified when it completes.',
  ), '/private/tmp/c/tasks/bljlg8ger.output');
  assert.equal(outputOf(
    "0.3.11 ['tmux', 'rex']\nℹ tests 333\nCommand did not complete within its 590s timeout and was moved to the background (ID: b0rvd96r6). "
    + 'Output is being written to: /private/tmp/c/tasks/b0rvd96r6.output',
  ), '/private/tmp/c/tasks/b0rvd96r6.output', 'after what it printed before it moved');
});

test('a result that only mentions an output file, like source code that matches it, starts no task', () => {
  const outputOf = content => signalsFrom({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content }] } })[0].outputFile;
  for (const content of [
    'const BACKGROUND_OUTPUT = /Output is being written to: (\\S+\\.output)/;',
    '11:const BACKGROUND_OUTPUT = /Output is being written to: (\\S+\\.output)/;',
    'Output is being written to: /t/b1.output',
    'Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b2.output.',
    '[… earlier output omitted; full output: /private/tmp/c/tasks/bgfouusel.output]',
    'see: Command running in background with ID: b1. Output is being written to: /tmp/x/tasks/b1.output',
  ]) {
    assert.equal(outputOf(content), undefined, content);
  }
});

test('a task notification is read, with or without a result', () => {
  const shell = parseTaskNotification(`<task-notification>
<task-id>b1</task-id>
<tool-use-id>toolu_1</tool-use-id>
<output-file>/tmp/b1.output</output-file>
<status>completed</status>
<summary>Background command "x" completed (exit code 0)</summary>
</task-notification>`);
  assert.deepEqual(
    [shell.id, shell.toolUseId, shell.outputFile, shell.status, shell.result, shell.tokens],
    ['b1', 'toolu_1', '/tmp/b1.output', 'completed', undefined, undefined],
  );
  const agent = parseTaskNotification(`<task-notification>
<task-id>a1</task-id>
<status>completed</status>
<summary>Agent "x" finished</summary>
<result>Line one
<status>failed</status> is what the agent quoted
<tool_uses>99</tool_uses></result>
<usage><subagent_tokens>25719</subagent_tokens><tool_uses>1</tool_uses><duration_ms>3333</duration_ms></usage>
</task-notification>`);
  assert.equal(agent.status, 'completed', 'tags inside a result are not read');
  assert.match(agent.result, /quoted/);
  assert.deepEqual([agent.tokens, agent.toolUses, agent.durationMs], [25719, 1, 3333]);
  assert.equal(parseTaskNotification('<task-notification>'), undefined);
});

test('a long output file is cut from the front, and says so', () => {
  const { file, cleanup } = tempFile('0123456789');
  try {
    assert.deepEqual(readTail(file, 4), { output: '6789', truncated: true });
    assert.deepEqual(readTail(file, 100), { output: '0123456789', truncated: false });
  } finally { cleanup(); }
});

const T = Date.parse('2026-11-06T10:00:00.000Z');
const stamped = (at, record) => line({ timestamp: new Date(at).toISOString(), ...record });
const said = (at, text) => stamped(at, { type: 'user', message: { content: text } });
const replied = (at, text) => stamped(at, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
const texts = page => page.items.map(i => i.text);

test('a page stops at the prompt of the open turn, which is stamped before its hook arrives', () => {
  const { file, cleanup } = tempFile([said(T, 'old'), replied(T + 10, 'old reply'), said(T + 70, 'now'), replied(T + 200, 'so far')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 100, prompt: 'now' } })), ['old', 'old reply']);
  } finally { cleanup(); }
});

test('the same words said earlier are not the open turn\'s prompt', () => {
  const { file, cleanup } = tempFile([said(T, 'again'), replied(T + 10, 'first'), said(T + 100, 'again'), replied(T + 110, 'second')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 120, prompt: 'again' } })), ['again', 'first']);
  } finally { cleanup(); }
});

test('words said long before the turn began are not its prompt', () => {
  const { file, cleanup } = tempFile([said(T, 'again'), replied(T + 10, 'first')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 60_000, prompt: 'again' } })), ['again', 'first']);
  } finally { cleanup(); }
});

test('a prompt is matched however its whitespace came out', () => {
  const { file, cleanup } = tempFile([said(T, 'old'), said(T + 70, 'two\n  lines')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 100, prompt: 'two lines ' } })), ['old']);
  } finally { cleanup(); }
});

test('an open turn whose prompt is not in the file yet leaves the page whole', () => {
  const { file, cleanup } = tempFile([said(T, 'old'), replied(T + 10, 'reply')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 100, prompt: 'new' } })), ['old', 'reply']);
  } finally { cleanup(); }
});

test('a turn with no prompt begins at its first event', () => {
  const { file, cleanup } = tempFile([said(T, 'old'), replied(T + 10, 'reply'), replied(T + 950, 'from a task')].join(''));
  try {
    assert.deepEqual(texts(readHistory(file, { turn: { at: T + 900 } })), ['old', 'reply']);
  } finally { cleanup(); }
});

test('a page cut off by a turn still opens where a turn does', () => {
  const call = (at, id) => stamped(at, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: {} }] } });
  const { file, cleanup } = tempFile([said(T, 'old'), call(T + 1, 't1'), call(T + 2, 't2'), said(T + 100, 'now')].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 1, turn: { at: T + 100, prompt: 'now' } })), ['old', 't1', 't2']);
  } finally { cleanup(); }
});

test('older pages carry on from where a page cut off by a turn stopped', () => {
  const { file, cleanup } = tempFile([said(T, 'a'), said(T + 1, 'b'), said(T + 2, 'c'), said(T + 100, 'now')].join(''));
  try {
    const page = readHistory(file, { limit: 1, turn: { at: T + 100, prompt: 'now' } });
    assert.deepEqual([texts(page), page.before, page.hasMore], [['c'], 2, true]);
    assert.deepEqual(texts(readHistory(file, { limit: 2, before: page.before })), ['a', 'b']);
  } finally { cleanup(); }
});

test('a session with no transcript yet has an empty history', () => {
  assert.deepEqual(readHistory('/nonexistent/venes/t.jsonl'), { items: [], before: 0, hasMore: false, model: undefined });
});

test('a reply says which model wrote it', () => {
  assert.deepEqual(
    signalsFrom({ type: 'assistant', message: { model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'hi' }] } }),
    [{ type: 'model', model: 'claude-sonnet-5-5' }],
  );
});

test('a reply Claude Code wrote itself names no model, and neither does a subagent\'s', () => {
  assert.deepEqual(signalsFrom({ type: 'assistant', message: { model: '<synthetic>', content: 'x' } }), []);
  assert.deepEqual(signalsFrom({ type: 'assistant', message: { content: 'x' } }), []);
  assert.deepEqual(signalsFrom({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5', content: 'x' } }), []);
});

test('history says which model last replied', () => {
  const reply = (model, fields = {}) => line({ type: 'assistant', ...fields, message: { model, content: [{ type: 'text', text: 'x' }] } });
  const { file, cleanup } = tempFile([
    reply('claude-haiku-5-5'), reply('claude-sonnet-5-5'), reply('<synthetic>'), reply('claude-opus-5-5', { isSidechain: true }),
  ].join(''));
  try {
    assert.equal(readHistory(file).model, 'claude-sonnet-5-5');
  } finally { cleanup(); }
});

test('history with no replies has no model to name', () => {
  const { file, cleanup } = tempFile(userText('hello'));
  try {
    assert.equal(readHistory(file).model, undefined);
  } finally { cleanup(); }
});

// What Claude Code writes for a line run with `!`, as it wrote it in a real session.
const CAVEAT_TEXT = '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request, and its output goes '
  + 'straight to the user. It\'s recorded here as context for later messages.</local-command-caveat>';
const caveatRecord = uuid => ({ type: 'user', isMeta: true, uuid, message: { role: 'user', content: CAVEAT_TEXT } });
const shellRecord = (command, { uuid, after, at } = {}) => ({
  type: 'user', uuid, parentUuid: after, timestamp: at, message: { role: 'user', content: `<bash-input>${command}</bash-input>` },
});
const printedRecord = (content, at) => ({ type: 'user', timestamp: at, message: { role: 'user', content } });

test('a line run with ! is read as Claude Code shows it: the command as typed, then what it printed', () => {
  assert.equal(shellCommand('<bash-input>ls -la</bash-input>'), 'ls -la');
  assert.equal(shellCommand(' <bash-input> ~/x update</bash-input>\n'), ' ~/x update');
  assert.equal(shellCommand('<bash-input>echo "a<b"\nls</bash-input>'), 'echo "a<b"\nls');
  assert.equal(shellCommand('<bash-input></bash-input>'), undefined);
  assert.equal(shellCommand('ls'), undefined);
  assert.deepEqual(shellOutput('<bash-stdout>a&lt;b &amp; c&gt;d &amp;lt; &quot;\noops</bash-stdout><bash-stderr></bash-stderr>'),
    { stdout: 'a<b & c>d &lt; &quot;\noops', stderr: '' });
  assert.deepEqual(shellOutput('<bash-stdout></bash-stdout><bash-stderr>one\n\ntwo\nls: x: No such file or directory\n</bash-stderr>'),
    { stdout: '', stderr: 'one\n\ntwo\nls: x: No such file or directory\n' });
  assert.deepEqual(shellOutput('<bash-stderr>Command failed: spawn /bin/zsh ENOENT</bash-stderr>'), { stdout: '', stderr: 'Command failed: spawn /bin/zsh ENOENT' });
  assert.deepEqual(shellOutput('<bash-stdout><persisted-output>Output too large &amp; saved</persisted-output></bash-stdout><bash-stderr></bash-stderr>'),
    { stdout: 'Output too large &amp; saved', stderr: '' });
  assert.equal(shellOutput('hello'), undefined);
  assert.equal(shellOutput('<local-command-stdout>x</local-command-stdout>'), undefined);
});

test('a line run with ! comes as signals, saying which record came before the command', () => {
  assert.deepEqual(signalsFrom(caveatRecord('c1')), [{ type: 'caveat', id: 'c1' }]);
  assert.deepEqual(signalsFrom(shellRecord('pwd', { uuid: 'i1', after: 'c1', at: '2026-11-08T09:30:41.259Z' })),
    [{ type: 'shellInput', command: 'pwd', at: '2026-11-08T09:30:41.259Z', after: 'c1' }]);
  assert.deepEqual(signalsFrom(printedRecord('<bash-stdout>/w</bash-stdout><bash-stderr></bash-stderr>', '2026-11-08T09:30:41.291Z')),
    [{ type: 'shellOutput', stdout: '/w', stderr: '', at: '2026-11-08T09:30:41.291Z' }]);
});

test('in history a line run with ! is the line as typed and what it printed, with whether Claude answered it', () => {
  const { file, cleanup } = tempFile([
    line(shellRecord('pwd', { uuid: 'i1', after: 'p0' })),
    line(printedRecord('<bash-stdout>/w</bash-stdout><bash-stderr></bash-stderr>')),
    assistantText('It is /w.'), turnEnd,
    line(caveatRecord('c2')),
    line(shellRecord('ls nothere', { uuid: 'i2', after: 'c2' })),
    line(printedRecord('<bash-stdout></bash-stdout><bash-stderr>ls: nothere: No such file or directory\n</bash-stderr>')),
    userText('next'),
  ].join(''));
  try {
    const { items } = readHistory(file);
    assert.deepEqual(items.map(({ at, durationMs, ...item }) => item), [
      { role: 'user', text: '!pwd', shell: true },
      { role: 'output', stdout: '/w', stderr: '', replies: true },
      { role: 'assistant', text: 'It is /w.' },
      { role: 'turn_end' },
      { role: 'user', text: '!ls nothere', shell: true },
      { role: 'output', stdout: '', stderr: 'ls: nothere: No such file or directory\n', replies: false },
      { role: 'user', text: 'next' },
    ]);
  } finally { cleanup(); }
});

test('a page that starts at what a line printed reaches back to the line', () => {
  const { file, cleanup } = tempFile([
    userText('old'), assistantText('old reply'), turnEnd,
    line(shellRecord('pwd')), line(printedRecord('<bash-stdout>/w</bash-stdout><bash-stderr></bash-stderr>')), assistantText('It is /w.'), turnEnd,
  ].join(''));
  try {
    assert.deepEqual(shown(readHistory(file, { limit: 3 })), ['!pwd', 'output', 'It is /w.', 'turn_end']);
  } finally { cleanup(); }
});
