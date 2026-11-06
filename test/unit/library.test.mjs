import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropParentSession } from '../../src/daemon.mjs';
import { libraryPage, readRunning } from '../../src/library.mjs';

const WORKER = fileURLToPath(new URL('../../src/library-worker.mjs', import.meta.url));
const ID = '11111111-2222-4333-8444-555555555555';

const stored = (id, fields = {}) => ({ sessionId: id, summary: `about ${id}`, cwd: '/w', lastModified: 2000, createdAt: 1000, ...fields });

test('what claude agents prints becomes sessions with the helper\'s statuses', () => {
  const output = JSON.stringify([
    { sessionId: 'a', name: 'one', cwd: '/a', startedAt: 1, status: 'busy', pid: 9, kind: 'interactive' },
    { sessionId: 'b', name: 'two', cwd: '/b', startedAt: 2, status: 'waiting', waitingFor: 'permission prompt' },
    { sessionId: 'c', cwd: '/c', startedAt: 3, status: 'idle' },
  ]);
  assert.deepEqual(readRunning(output), [
    { id: 'a', title: 'one', cwd: '/a', startedAt: 1, status: 'running' },
    { id: 'b', title: 'two', cwd: '/b', startedAt: 2, status: 'waiting' },
    { id: 'c', title: undefined, cwd: '/c', startedAt: 3, status: 'idle' },
  ]);
});

test('a background session with no process goes by its state', () => {
  const output = JSON.stringify([
    { sessionId: 'a', state: 'working' }, { sessionId: 'b', state: 'blocked' }, { sessionId: 'c', state: 'done' }, { sessionId: 'd', state: 'failed' },
  ]);
  assert.deepEqual(readRunning(output).map(session => session.status), ['running', 'waiting', 'idle', 'idle']);
});

test('an entry with no session id can\'t be opened, so it\'s left out', () => {
  assert.deepEqual(readRunning(JSON.stringify([{ kind: 'background', state: 'working', id: '7c5dcf5d' }])), []);
});

test('a stored session shows what claude agents says about it', () => {
  const page = libraryPage([stored('a'), stored('b')], [{ id: 'b', status: 'running' }], { limit: 50, offset: 0 });
  assert.deepEqual(page.items.map(item => [item.id, item.status]), [['a', null], ['b', 'running']]);
  assert.deepEqual(page.items[0], { id: 'a', title: 'about a', cwd: '/w', lastActiveAt: 2000, startedAt: 1000, status: null });
});

test('what runs but isn\'t on the page goes first, on the first page only', () => {
  const running = [{ id: 'new', title: 'new-3f', cwd: '/n', startedAt: 5, status: 'idle' }];
  const first = libraryPage([stored('a')], running, { limit: 50, offset: 0 });
  assert.deepEqual(first.items.map(item => item.id), ['new', 'a']);
  assert.equal(first.items[0].lastActiveAt, 5);
  assert.deepEqual(libraryPage([stored('a')], running, { limit: 50, offset: 50 }).items.map(item => item.id), ['a']);
});

test('a full page says there may be more, and where it goes on', () => {
  assert.deepEqual(
    (({ offset, hasMore }) => ({ offset, hasMore }))(libraryPage([stored('a'), stored('b')], [], { limit: 2, offset: 4 })),
    { offset: 6, hasMore: true },
  );
  assert.equal(libraryPage([stored('a')], [], { limit: 2, offset: 0 }).hasMore, false);
  assert.equal(libraryPage([], [], { limit: 2, offset: 0 }).hasMore, false);
});

function configDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const project = path.join(dir, 'projects', '-Users-me-app');
  fs.mkdirSync(project, { recursive: true });
  const records = [
    { type: 'user', timestamp: '2026-11-06T10:00:00.000Z', message: { role: 'user', content: 'hello' } },
    { type: 'assistant', timestamp: '2026-11-06T10:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
  ];
  fs.writeFileSync(path.join(project, `${ID}.jsonl`), records.map(record => JSON.stringify(record)).join('\n'));
  return dir;
}

const read = (dir, request) => JSON.parse(execFileSync(process.execPath, [WORKER, JSON.stringify(request)], {
  encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir },
}));

test('a stored session is read from wherever its project keeps it', t => {
  const reply = read(configDir(t), { op: 'history', sessionId: ID, limit: 10 });
  assert.deepEqual(reply.items.map(item => [item.role, item.text]), [['user', 'hello'], ['assistant', 'hi']]);
  assert.equal(reply.hasMore, false);
});

test('a page of a stored session stops where it was asked to', t => {
  const reply = read(configDir(t), { op: 'history', sessionId: ID, limit: 1 });
  assert.deepEqual(reply.items.map(item => item.text), ['hi']);
  assert.deepEqual([reply.before, reply.hasMore], [1, true]);
});

test('a session that isn\'t stored is reported as unknown', t => {
  const reply = read(configDir(t), { op: 'history', sessionId: '99999999-2222-4333-8444-555555555555' });
  assert.equal(reply.error.code, 'unknown_session');
});

test('an id can\'t reach outside the projects folder', t => {
  const dir = configDir(t);
  fs.writeFileSync(path.join(dir, 'secret.jsonl'), '{"type":"user","message":{"content":"secret"}}');
  for (const sessionId of ['../../secret', '../secret', '/etc/passwd', `${ID}/../${ID}`]) {
    assert.equal(read(dir, { op: 'history', sessionId }).error.code, 'unknown_session', sessionId);
  }
});

test('a failure comes back as an error, not a crash', t => {
  const reply = read(configDir(t), { op: 'list', sdk: '/nowhere/sdk.mjs', limit: 1, offset: 0 });
  assert.ok(reply.error.message);
});

test('what the session that started the helper left behind goes, and the user\'s own settings stay', () => {
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' };
  dropParentSession(env);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' });
});
