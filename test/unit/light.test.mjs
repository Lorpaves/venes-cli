import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CALL_BUDGET, isWorthReplaying, lightened, lightPage, REPLAY_BYTES, TEXT_LIMIT } from '../../src/light.mjs';

test('what is short and has no picture stays as it came', () => {
  const response = { stdout: 'done', stderr: '', interrupted: false, code: 0, list: [1, 'two', null] };
  assert.deepEqual(lightened(response), response);
  assert.equal(lightened('words'), 'words');
  assert.equal(lightened(undefined), undefined);
});

test('a long string keeps its start and ends in an ellipsis', () => {
  const kept = lightened({ file: { filePath: '/a', content: 'x'.repeat(TEXT_LIMIT * 4) } });
  assert.equal(kept.file.filePath, '/a');
  assert.equal(kept.file.content.length, TEXT_LIMIT + 1);
  assert.ok(kept.file.content.endsWith('\u2026'));
});

test('a cut never falls between the two halves of a character', () => {
  const kept = lightened('a'.repeat(TEXT_LIMIT - 1) + '\u{1F600}' + 'b');
  assert.equal(kept, 'a'.repeat(TEXT_LIMIT - 1) + '\u2026');
});

test('a picture loses its bytes in every shape a tool hands one over in', () => {
  const bytes = 'A'.repeat(4000);
  // A tool's parts, a file read as a picture, and Code Mode's, which has each one twice.
  assert.deepEqual(lightened([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } }, { type: 'text', text: 'words' }]),
    [{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }, { type: 'text', text: 'words' }]);
  assert.deepEqual(lightened({ type: 'image', file: { base64: bytes, type: 'image/png', originalSize: 3 } }), { type: 'image', file: { type: 'image/png', originalSize: 3 } });
  assert.deepEqual(
    lightened({ result: 'ok', images: [{ base64: bytes, mediaType: 'image/png' }], media: [[{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } }]] }),
    { result: 'ok', images: [{ mediaType: 'image/png' }], media: [[{ type: 'image', source: { type: 'base64', media_type: 'image/png' } }]] },
  );
  assert.deepEqual(lightened({ type: 'image', data: bytes, mimeType: 'image/png' }), { type: 'image', mimeType: 'image/png' });
  assert.deepEqual(lightened({ shown: 'data:image/png;base64,' + bytes, said: 'kept' }), { shown: undefined, said: 'kept' });
});

test('data that is not a picture is kept', () => {
  assert.deepEqual(lightened({ data: 'rows', count: 2 }), { data: 'rows', count: 2 });
});

test('an edit comes without the file as it was', () => {
  const patch = [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }];
  assert.deepEqual(lightened({ filePath: '/a', originalFile: 'a'.repeat(100000), structuredPatch: patch }), { filePath: '/a', structuredPatch: patch });
});

test('all of a call is no more than its budget, and a list ends where the budget does', () => {
  const kept = lightened({ filenames: Array.from({ length: 100000 }, (_, index) => `/some/folder/file-${index}.txt`) });
  assert.ok(kept.filenames.length < 100000);
  assert.ok(JSON.stringify(kept).length < CALL_BUDGET * 1.5);
  const many = lightened({ a: 'x'.repeat(TEXT_LIMIT), b: 'x'.repeat(TEXT_LIMIT), c: 'x'.repeat(TEXT_LIMIT), d: 'x'.repeat(TEXT_LIMIT) });
  assert.ok(JSON.stringify(many).length <= CALL_BUDGET + 64);
  assert.equal(many.d, '\u2026');
});

test("a page's calls are cut down, and nothing else in it is touched", () => {
  const long = 'x'.repeat(TEXT_LIMIT * 2);
  const page = {
    items: [
      { role: 'user', text: long },
      { role: 'tool', toolUseId: 't', name: 'Write', input: { content: long }, result: long, isError: false },
      { role: 'tool', toolUseId: 'u', name: 'commandExecution', input: { aggregatedOutput: long }, isError: false },
    ],
    before: 0, hasMore: false,
  };
  const light = lightPage(page);
  assert.equal(light.items[0].text, long);
  assert.equal(light.items[1].input.content.length, TEXT_LIMIT + 1);
  assert.equal(light.items[1].result.length, TEXT_LIMIT + 1);
  assert.equal(light.items[2].input.aggregatedOutput.length, TEXT_LIMIT + 1);
  assert.ok(!('result' in light.items[2]));
  assert.equal(light.hasMore, false);
  assert.deepEqual(lightPage({}), {});
});

test('what a client missed is sent again only while it is less than a page', () => {
  const event = { seq: 1, kind: 'tool.end', response: 'x'.repeat(1000) };
  assert.equal(isWorthReplaying([]), true);
  assert.equal(isWorthReplaying(Array.from({ length: 10 }, () => event)), true);
  assert.equal(isWorthReplaying(Array.from({ length: Math.ceil(REPLAY_BYTES / 1000) + 1 }, () => event)), false);
});
