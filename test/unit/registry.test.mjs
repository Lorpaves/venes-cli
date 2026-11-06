import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRegistry, writeRegistry } from '../../src/registry.mjs';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-registry-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  return path.join(dir, 'sessions.json');
}

test('sessions come back as they were saved', t => {
  const file = tempDir(t);
  writeRegistry(file, [{ id: 'a', cwd: '/w', pane: '%1', tmuxSocket: '/s', transcriptPath: '/t', model: 'm', startedAt: 1, lastEventAt: 2 }]);
  assert.deepEqual(readRegistry(file), [{ id: 'a', cwd: '/w', pane: '%1', tmuxSocket: '/s', transcriptPath: '/t', model: 'm', startedAt: 1, lastEventAt: 2 }]);
});

test('nothing said in a session reaches the disk', t => {
  const file = tempDir(t);
  writeRegistry(file, [{ id: 'a', pane: '%1', lastPrompt: 'my secret plan', lastMessage: 'a reply', tools: new Map(), held: [{ text: 'held' }] }]);
  const text = fs.readFileSync(file, 'utf8');
  for (const word of ['secret', 'reply', 'held']) assert.ok(!text.includes(word), word);
});

test('the file is only readable by its owner', t => {
  const file = tempDir(t);
  writeRegistry(file, []);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a missing or damaged file means no sessions', t => {
  const file = tempDir(t);
  assert.deepEqual(readRegistry(file), []);
  fs.writeFileSync(file, '{ broken');
  assert.deepEqual(readRegistry(file), []);
  fs.writeFileSync(file, '{"not":"a list"}');
  assert.deepEqual(readRegistry(file), []);
});

test('a record with no id or pane is left out', t => {
  const file = tempDir(t);
  fs.writeFileSync(file, JSON.stringify([{ id: 'a' }, { pane: '%1' }, null, { id: 'b', pane: '%2' }]));
  assert.deepEqual(readRegistry(file).map(record => record.id), ['b']);
});
