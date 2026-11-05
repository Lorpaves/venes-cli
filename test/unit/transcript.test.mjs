import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TranscriptTail, readHistory, signalsFrom, unwrapPasted } from '../../src/transcript.mjs';

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
    const items = readHistory(file);
    assert.deepEqual(items.map(i => i.role), ['user', 'assistant', 'tool', 'system']);
    assert.equal(items[2].result, 'a.txt');
    assert.equal(readHistory(file, 1).length, 1);
  } finally { cleanup(); }
});
