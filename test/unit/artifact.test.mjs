import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkedToolUse, readArtifact } from '../../src/artifact.mjs';

const folder = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-artifact-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('a published page is read as the text of its file', t => {
  const file = path.join(folder(t), 'page.html');
  fs.writeFileSync(file, '<h1>你好</h1>\n');
  assert.deepEqual(readArtifact(file), { text: '<h1>你好</h1>\n' });
});

test('a page with no file to read says which way it failed', t => {
  const dir = folder(t);
  // Nothing was found for the call.
  for (const none of [undefined, '', 7]) assert.throws(() => readArtifact(none), { code: 'unknown_artifact' });
  // The file is gone, or is a folder now.
  assert.throws(() => readArtifact(path.join(dir, 'gone.html')), { code: 'artifact_gone' });
  assert.throws(() => readArtifact(dir), { code: 'artifact_gone' });
  // It isn't text: a zero byte, or bytes that aren't UTF-8.
  fs.writeFileSync(path.join(dir, 'zero.html'), Buffer.from([0x3c, 0x00, 0x3e]));
  fs.writeFileSync(path.join(dir, 'latin.html'), Buffer.from([0x3c, 0xe9, 0x3e]));
  assert.throws(() => readArtifact(path.join(dir, 'zero.html')), { code: 'artifact_not_text' });
  assert.throws(() => readArtifact(path.join(dir, 'latin.html')), { code: 'artifact_not_text' });
  // It's bigger than a page may be.
  fs.writeFileSync(path.join(dir, 'big.html'), 'x'.repeat(65));
  assert.throws(() => readArtifact(path.join(dir, 'big.html'), { limit: 64 }), { code: 'artifact_too_big' });
  assert.deepEqual(readArtifact(path.join(dir, 'big.html'), { limit: 65 }), { text: 'x'.repeat(65) });
});

test('a call is named by its id, which is some text', () => {
  assert.equal(checkedToolUse('toolu_1'), 'toolu_1');
  for (const none of [undefined, '', 7, null]) assert.throws(() => checkedToolUse(none), { code: 'unknown_artifact' });
});
