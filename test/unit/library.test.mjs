import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dropParentSession } from '../../src/daemon.mjs';
import { Library, joinedStatus, libraryPage, readCapabilities, readRunning } from '../../src/library.mjs';

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
    { id: 'a', title: 'one', cwd: '/a', startedAt: 1, pid: 9, kind: 'interactive', status: 'running' },
    { id: 'b', title: 'two', cwd: '/b', startedAt: 2, pid: undefined, kind: undefined, status: 'waiting' },
    { id: 'c', title: undefined, cwd: '/c', startedAt: 3, pid: undefined, kind: undefined, status: 'idle' },
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
  const dir = configDir(t);
  const next = { type: 'user', timestamp: '2026-11-06T10:00:02.000Z', message: { role: 'user', content: 'again' } };
  fs.appendFileSync(path.join(dir, 'projects', '-Users-me-app', `${ID}.jsonl`), `\n${JSON.stringify(next)}`);
  const reply = read(dir, { op: 'history', sessionId: ID, limit: 1 });
  assert.deepEqual(reply.items.map(item => item.text), ['again']);
  assert.deepEqual([reply.before, reply.hasMore], [2, true]);
});

test('an image of a stored session comes from its transcript', t => {
  const dir = configDir(t);
  const file = path.join(dir, 'projects', '-Users-me-app', `${ID}.jsonl`);
  const image = { type: 'image', source: { media_type: 'image/png', data: 'QUJD' } };
  const before = fs.statSync(file).size + 1;
  fs.appendFileSync(file, `\n${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look' }, image] } })}`);
  assert.deepEqual(read(dir, { op: 'image', sessionId: ID, id: `${before}:0` }), { mediaType: 'image/png', data: 'QUJD' });
  assert.deepEqual(read(dir, { op: 'image', sessionId: ID, id: `${before}:1` }), {}, 'nothing there');
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

test('deleting a session that isn\'t stored says so, without touching the SDK', t => {
  const reply = read(configDir(t), { op: 'delete', sdk: '/nowhere/sdk.mjs', sessionId: '99999999-2222-4333-8444-555555555555' });
  assert.equal(reply.error.code, 'unknown_session');
});

test('an id can\'t delete anything outside the projects folder', t => {
  const dir = configDir(t);
  fs.writeFileSync(path.join(dir, 'secret.jsonl'), '{}');
  for (const sessionId of ['../../secret', '../secret', '/etc/passwd', `${ID}/../${ID}`, '*', '']) {
    assert.equal(read(dir, { op: 'delete', sdk: '/nowhere/sdk.mjs', sessionId }).error.code, 'unknown_session', sessionId);
  }
  assert.ok(fs.existsSync(path.join(dir, 'secret.jsonl')));
});

test('a stored session is deleted through the SDK', t => {
  const dir = configDir(t);
  const sdk = path.join(dir, 'sdk.mjs');
  fs.writeFileSync(sdk, `import fs from 'node:fs';
export async function deleteSession(id) { fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/deleted', id); }`);
  assert.deepEqual(read(dir, { op: 'delete', sdk, sessionId: ID }), {});
  assert.equal(fs.readFileSync(path.join(dir, 'deleted'), 'utf8'), ID);
});

test('a failure comes back as an error, not a crash', t => {
  const reply = read(configDir(t), { op: 'list', sdk: '/nowhere/sdk.mjs', limit: 1, offset: 0 });
  assert.ok(reply.error.message);
});

test('a session that isn\'t running has ended, whatever its transcript says', () => {
  assert.equal(joinedStatus(undefined, [{ role: 'assistant' }]), 'ended');
});

test('a busy process whose turn is over is only running a background shell', () => {
  assert.equal(joinedStatus({ status: 'running' }, [{ role: 'assistant' }, { role: 'turn_end' }]), 'idle');
});

test('a turn that was interrupted is over too', () => {
  assert.equal(joinedStatus({ status: 'running' }, [{ role: 'user' }, { role: 'system', kind: 'interrupted' }]), 'idle');
});

test('a busy process in the middle of a turn is running', () => {
  for (const role of ['user', 'assistant', 'thinking', 'tool']) {
    assert.equal(joinedStatus({ status: 'running' }, [{ role: 'turn_end' }, { role }]), 'running', role);
  }
  assert.equal(joinedStatus({ status: 'running' }, []), 'running');
});

test('a session waiting on someone stays that way, and an idle one stays idle', () => {
  assert.equal(joinedStatus({ status: 'waiting' }, [{ role: 'turn_end' }]), 'waiting');
  assert.equal(joinedStatus({ status: 'idle' }, [{ role: 'assistant' }]), 'idle');
});

test('a client gets each command and model in the shape it reads', () => {
  const reply = readCapabilities({
    commands: [{ name: 'model', description: 'Switch', argumentHint: '<model>' }, { name: 'review', description: 'Look', builtin: true }],
    models: [{ value: 'opus', displayName: 'Opus', description: 'Big', resolvedModel: 'claude-opus', supportedEffortLevels: ['low', 'high'], price: 1 }],
  });
  assert.deepEqual(reply, {
    commands: [{ name: 'model', description: 'Switch', argumentHint: '<model>' }, { name: 'review', description: 'Look', argumentHint: '' }],
    models: [{ value: 'opus', displayName: 'Opus', description: 'Big', resolvedModel: 'claude-opus', effortLevels: ['low', 'high'] }],
  });
});

test('Claude Code\'s own plumbing stays out of the menu', () => {
  const { commands } = readCapabilities({ commands: [{ name: '__remote-workflow' }, { name: 'compact' }] });
  assert.deepEqual(commands.map(command => command.name), ['compact']);
});

test('a model with no effort setting has no levels', () => {
  assert.deepEqual(readCapabilities({ models: [{ value: 'haiku' }] }).models[0].effortLevels, []);
});

test('an empty answer is an empty menu', () => {
  assert.deepEqual(readCapabilities({}), { commands: [], models: [] });
});

// An SDK that writes down how it was called, and holds the event loop open as the real one can.
const FAKE_SDK = `
import fs from 'node:fs';
export function query({ options }) {
  fs.appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify(options) + '\\n');
  setInterval(() => {}, 1000);
  if (process.env.FAKE_SDK_FAILS) throw Object.assign(new Error('no'), { code: 'nope' });
  return {
    initializationResult: async () => ({ commands: [{ name: 'model' }], models: [{ value: 'opus', supportedEffortLevels: ['low'] }], account: {} }),
    close() { fs.appendFileSync(process.env.FAKE_SDK_LOG, '"closed"\\n'); },
  };
}`;

function fakeSdk(t, { hasClaude = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-sdk-'));
  const entry = path.join(dir, 'sdk', '0.3.319', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, FAKE_SDK);
  const log = path.join(dir, 'log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  if (hasClaude) fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
  const { PATH } = process.env;
  Object.assign(process.env, { PATH: bin, FAKE_SDK_LOG: log });
  t.after(() => {
    process.env.PATH = PATH;
    delete process.env.FAKE_SDK_LOG;
    delete process.env.FAKE_SDK_FAILS;
    fs.rmSync(dir, { recursive: true });
  });
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
  return { library: new Library({ sdkDir: path.join(dir, 'sdk') }), dir, entry, bin, opened: () => lines().filter(line => line !== 'closed'), lines };
}

test('capabilities come from a session that runs no hooks and leaves nothing behind', async t => {
  const { library, dir, bin, opened, lines } = fakeSdk(t);
  const reply = await library.capabilities(dir);
  assert.deepEqual(reply, { commands: [{ name: 'model', description: undefined, argumentHint: '' }], models: [{ value: 'opus', displayName: undefined, description: undefined, resolvedModel: undefined, effortLevels: ['low'] }] });
  const [options] = opened();
  assert.equal(options.cwd, dir);
  assert.equal(options.pathToClaudeCodeExecutable, path.join(bin, 'claude'));
  assert.equal(options.persistSession, false);
  assert.equal(options.settings.disableAllHooks, true);
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(options.settingSources, ['user', 'project', 'local']);
  assert.equal(lines().at(-1), 'closed');
});

test('capabilities are read once for a while, then again', async t => {
  const { library, dir, opened } = fakeSdk(t);
  await library.capabilities(dir, 0);
  await library.capabilities(dir, 299_999);
  assert.equal(opened().length, 1);
  await library.capabilities(dir, 300_000);
  assert.equal(opened().length, 2);
});

test('pages opening together share one read', async t => {
  const { library, dir, opened } = fakeSdk(t);
  await Promise.all([library.capabilities(dir, 0), library.capabilities(dir, 1), library.capabilities(dir, 2)]);
  assert.equal(opened().length, 1);
});

test('each folder has its own, since skills can be a project\'s', async t => {
  const { library, dir, bin, opened } = fakeSdk(t);
  await library.capabilities(dir, 0);
  await library.capabilities(bin, 0);
  assert.deepEqual(opened().map(options => options.cwd), [dir, bin]);
});

test('a folder that has gone falls back to home', async t => {
  const { library, opened } = fakeSdk(t);
  await library.capabilities('/no/such/folder');
  assert.equal(opened()[0].cwd, os.homedir());
});

test('a failure isn\'t kept, so the next page tries again', async t => {
  const { library, dir, opened } = fakeSdk(t);
  process.env.FAKE_SDK_FAILS = '1';
  await assert.rejects(library.capabilities(dir, 0), { code: 'nope' });
  delete process.env.FAKE_SDK_FAILS;
  assert.equal((await library.capabilities(dir, 1)).models.length, 1);
  assert.equal(opened().length, 2);
});

test('with no Claude Code to ask, it says so', async t => {
  const { library, dir } = fakeSdk(t, { hasClaude: false });
  await assert.rejects(library.capabilities(dir), { code: 'no_claude' });
});

test('what the session that started the helper left behind goes, and the user\'s own settings stay', () => {
  const env = { CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_PID: '9', CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' };
  dropParentSession(env);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/c', CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' });
});
