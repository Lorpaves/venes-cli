import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { HelperClient } from '../../src/client.mjs';
import { lineOf, onLines } from '../../src/lines.mjs';

function heard(pieces) {
  const stream = new EventEmitter();
  const lines = [];
  onLines(stream, line => lines.push(line));
  for (const piece of pieces) stream.emit('data', piece);
  return lines;
}

test('a stream\'s lines are a line feed apart, however they come in pieces', () => {
  assert.deepEqual(heard([Buffer.from('{"a":1}\n{"b":2}\n')]), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(heard([Buffer.from('{"a"'), Buffer.from(':1}\n{"b'), Buffer.from('":2}'), Buffer.from('\n')]), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(heard([Buffer.from('{"a":1}')]), [], 'a line isn\'t one until it ends');
  assert.deepEqual(heard(['{"a":1}\n']), ['{"a":1}'], 'a stream that gives text is heard the same');
});

test('a character cut in two by a piece\'s end is whole again', () => {
  const bytes = Buffer.from('{"t":"文件 é"}\n');
  for (let cut = 1; cut < bytes.length; cut++) {
    assert.deepEqual(heard([bytes.subarray(0, cut), bytes.subarray(cut)]), ['{"t":"文件 é"}'], `cut at ${cut}`);
  }
});

test('a line separator in a string is part of the string, and ends no line', () => {
  const text = 'one\u2028two\u2029three\rfour';
  // As Swift's JSON has it: the separators as they are.
  const raw = `{"text":${JSON.stringify(text)}}`;
  assert.ok(raw.includes('\u2028') && raw.includes('\u2029'));
  const lines = heard([Buffer.from(`${raw}\n`)]);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).text, text);
});

test('a carriage return before the line feed isn\'t part of the line, and an empty line is passed over', () => {
  assert.deepEqual(heard([Buffer.from('{"a":1}\r\n\n\r\n{"b":2}\n')]), ['{"a":1}', '{"b":2}']);
});

test('a value\'s line has its separators escaped, for a reader that would end a line at one', () => {
  const line = lineOf({ text: 'one\u2028two\u2029three' });
  assert.equal(line, '{"text":"one\\u2028two\\u2029three"}\n');
  assert.equal(/[\u2028\u2029]/.test(line), false);
  assert.equal(JSON.parse(line).text, 'one\u2028two\u2029three');
});

test('a client and what answers it take a message with a separator in it whole, either way', async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const client = HelperClient.over(toClient, toServer);
  const asked = [];
  onLines(toServer, line => {
    const message = JSON.parse(line);
    asked.push(message);
    // As a helper before this one answered, with the separators as they are.
    toClient.write(`${JSON.stringify({ type: 'result', id: message.id, ok: true, text: `${message.text}!` })}\n`);
  });
  const reply = await client.request('fileWrite', { text: 'a\u2028b\u2029c' });
  assert.equal(asked[0].text, 'a\u2028b\u2029c');
  assert.equal(reply.text, 'a\u2028b\u2029c!');
});
