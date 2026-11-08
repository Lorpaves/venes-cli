import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  checkedOutBranch, installStatusLine, keepStatus, pruneStatus, readStatus, removeStatusLine, standInCommand, statusFile, switchOnStatusLine,
} from '../../src/status.mjs';

const STATUS = fileURLToPath(new URL('../../src/status.mjs', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-status-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// What Claude Code sends its status line, as its docs describe it.
const input = (fields = {}) => ({
  session_id: 'abc-123',
  cwd: '/code/demo-app/src',
  model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
  workspace: { current_dir: '/code/demo-app/src', project_dir: '/code/demo-app', repo: { host: 'github.com', owner: 'acme', name: 'demo' } },
  cost: { total_cost_usd: 1.2345 },
  context_window: {
    total_input_tokens: 445000, total_output_tokens: 600, context_window_size: 1000000, used_percentage: 44.5,
    current_usage: { input_tokens: 5000, output_tokens: 600, cache_creation_input_tokens: 40000, cache_read_input_tokens: 400000 },
  },
  prompt_cache: { warm: true, expires_at: 2_000_000_100, hit_ratio: 0.931 },
  effort: { level: 'max' },
  rate_limits: { five_hour: { used_percentage: 23.46, resets_at: 2_000_007_200 }, seven_day: { used_percentage: 41.2, resets_at: 2_000_300_000 } },
  ...fields,
});
const NOW = 2_000_000_000 * 1000;

function settingsIn(dir, settings) {
  const files = { settingsFile: path.join(dir, 'claude/settings.json'), stateFile: path.join(dir, 'venes/statusline.json'), launcher: path.join(dir, 'venes/venes') };
  if (settings !== undefined) {
    fs.mkdirSync(path.dirname(files.settingsFile), { recursive: true });
    fs.writeFileSync(files.settingsFile, typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  }
  return files;
}
const readSettings = files => JSON.parse(fs.readFileSync(files.settingsFile, 'utf8'));
const readState = files => JSON.parse(fs.readFileSync(files.stateFile, 'utf8'));

test('the helper stands in for the status line, keeping the one that was there and everything else as it was', t => {
  const dir = tempDir(t);
  const original = { type: 'command', command: '~/.claude/statusline.sh', padding: 0, refreshInterval: 5 };
  const files = settingsIn(dir, { model: 'opus', statusLine: original, permissions: { allow: [] } });
  assert.equal(installStatusLine(files), 'installed');
  const settings = readSettings(files);
  assert.deepEqual(Object.keys(settings), ['model', 'statusLine', 'permissions']);
  assert.deepEqual(settings.statusLine, { type: 'command', command: standInCommand(files.launcher), padding: 0, refreshInterval: 5 });
  assert.deepEqual(readState(files), { statusLine: original });
  // Again, it's the same, and what it stands in for stays the one that was there.
  assert.equal(installStatusLine(files), 'installed');
  assert.deepEqual(readState(files), { statusLine: original });
});

test('with no status line, or no settings at all, it stands in for none', t => {
  const dir = tempDir(t);
  const files = settingsIn(dir);
  assert.equal(installStatusLine(files), 'installed');
  assert.deepEqual(readSettings(files), { statusLine: { type: 'command', command: standInCommand(files.launcher) } });
  assert.deepEqual(readState(files), { statusLine: null });
});

test('settings it can\'t read are left alone, and so is a status line switched back', t => {
  const dir = tempDir(t);
  const files = settingsIn(dir, '{ "model": "opus", // a comment\n}');
  assert.equal(installStatusLine(files), 'unreadable');
  assert.equal(fs.readFileSync(files.settingsFile, 'utf8'), '{ "model": "opus", // a comment\n}');

  const other = settingsIn(tempDir(t), { statusLine: { type: 'command', command: 'ccstatusline' } });
  installStatusLine(other);
  removeStatusLine(other);
  assert.deepEqual(readSettings(other), { statusLine: { type: 'command', command: 'ccstatusline' } });
  assert.equal(installStatusLine(other), 'off', 'it stays off');
  assert.deepEqual(readSettings(other).statusLine.command, 'ccstatusline');
  assert.equal(switchOnStatusLine(other), 'installed');
  assert.equal(readSettings(other).statusLine.command, standInCommand(other.launcher));
  assert.deepEqual(readState(other).statusLine, { type: 'command', command: 'ccstatusline' });
});

test('switched back with none before, there\'s none again; another home\'s stand-in isn\'t taken for the original', t => {
  const files = settingsIn(tempDir(t), {});
  installStatusLine(files);
  removeStatusLine(files);
  assert.deepEqual(readSettings(files), {});

  const moved = settingsIn(tempDir(t), { statusLine: { type: 'command', command: '~/.claude/statusline.sh' } });
  installStatusLine(moved);
  fs.writeFileSync(moved.settingsFile, JSON.stringify({ statusLine: { type: 'command', command: `'/elsewhere/.venes/venes' statusline` } }));
  installStatusLine(moved);
  assert.deepEqual(readState(moved).statusLine, { type: 'command', command: '~/.claude/statusline.sh' });
});

// Runs the stand-in as Claude Code would: a process given the input on stdin, whose output shows.
function runStandIn(dir, stateFile, text, shell = '/bin/sh') {
  return new Promise((resolve, reject) => {
    const script = `import(${JSON.stringify(STATUS)}).then(async m => { process.exitCode = await m.runStatusLine({ stdin: process.stdin, dir: ${JSON.stringify(dir)}, stateFile: ${JSON.stringify(stateFile)}, shell: ${JSON.stringify(shell)} }); });`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, out }));
    child.stdin.end(text);
  });
}

test('as the status line it keeps what it\'s told, and the one it stands in for runs with the same, as it did', async t => {
  const dir = tempDir(t);
  const stateFile = path.join(dir, 'statusline.json');
  fs.writeFileSync(stateFile, JSON.stringify({ statusLine: { type: 'command', command: 'cat; printf " [shown]"; exit 3' } }));
  const text = JSON.stringify(input());
  const { code, out } = await runStandIn(path.join(dir, 'status'), stateFile, text);
  assert.equal(out, `${text} [shown]`);
  assert.equal(code, 3);
  assert.equal(fs.readFileSync(statusFile(path.join(dir, 'status'), 'abc-123'), 'utf8'), text);

  fs.writeFileSync(stateFile, JSON.stringify({ statusLine: null }));
  assert.deepEqual(await runStandIn(path.join(dir, 'status'), stateFile, text), { code: 0, out: '' }, 'with none, it shows nothing');
});

test('only a session\'s own input is kept, under its own name', t => {
  const dir = tempDir(t);
  assert.equal(keepStatus(dir, 'not json'), false);
  assert.equal(keepStatus(dir, JSON.stringify({ session_id: '../../escape' })), false);
  assert.equal(keepStatus(dir, JSON.stringify({ cwd: '/x' })), false);
  assert.equal(keepStatus(dir, JSON.stringify(input())), true);
  assert.deepEqual(fs.readdirSync(dir), ['abc-123.json']);
});

test('what the phone shows: model, effort, project, branch, context, limits with when they reset, cache and cost', async t => {
  const dir = tempDir(t);
  const repo = path.join(dir, 'demo-app');
  execFileSync('git', ['init', '-q', '-b', 'feature/login', repo]);
  keepStatus(dir, JSON.stringify(input({ workspace: { current_dir: repo, project_dir: repo, repo: { owner: 'acme', name: 'demo' } } })));
  const { updatedAt, ...status } = await readStatus(dir, 'abc-123', NOW);
  assert.ok(Math.abs(updatedAt * 1000 - Date.now()) < 60_000);
  assert.deepEqual(status, {
    model: 'Opus 5.5', effort: 'max', project: 'demo-app', repo: 'acme/demo', branch: 'feature/login',
    context: { percent: 44.5, used: 445000, size: 1000000 },
    fiveHour: { percent: 23.5, resetsAt: 2_000_007_200 },
    sevenDay: { percent: 41.2, resetsAt: 2_000_300_000 },
    cache: { percent: 93.1, warm: true, expiresAt: 2_000_000_100 },
    cost: 1.2345,
  });
  assert.equal(await readStatus(dir, 'nobody'), undefined, 'none before Claude Code has run it');
});

test('with an API that has no limits there\'s the cost; before a first reply, the account\'s last limits', async t => {
  const dir = tempDir(t);
  keepStatus(dir, JSON.stringify(input({ session_id: 'api', rate_limits: undefined })));
  const api = await readStatus(dir, 'api', NOW);
  assert.equal(api.fiveHour, undefined);
  assert.equal(api.sevenDay, undefined);
  assert.equal(api.cost, 1.2345);

  keepStatus(dir, JSON.stringify(input({ session_id: 'older' })));
  keepStatus(dir, JSON.stringify(input({
    session_id: 'new', rate_limits: undefined, cost: { total_cost_usd: 0 }, prompt_cache: undefined,
    context_window: { total_input_tokens: 0, context_window_size: 200000, used_percentage: null, current_usage: null },
  })));
  const fresh = await readStatus(dir, 'new', NOW);
  assert.deepEqual(fresh.fiveHour, { percent: 23.5, resetsAt: 2_000_007_200 });
  assert.deepEqual(fresh.context, { used: 0, size: 200000 });
  assert.equal(fresh.cache, undefined);
});

test('a limit that has reset since starts again from nothing', async t => {
  const dir = tempDir(t);
  keepStatus(dir, JSON.stringify(input()));
  const later = await readStatus(dir, 'abc-123', 2_000_010_000 * 1000);
  assert.deepEqual(later.fiveHour, { percent: 0 });
  assert.deepEqual(later.sevenDay, { percent: 41.2, resetsAt: 2_000_300_000 });
});

test('what\'s kept of a session goes a week after it last ran its status line', t => {
  const dir = tempDir(t);
  keepStatus(dir, JSON.stringify(input()));
  keepStatus(dir, JSON.stringify(input({ session_id: 'recent' })));
  const old = statusFile(dir, 'abc-123');
  const weekAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(old, weekAgo, weekAgo);
  pruneStatus(dir);
  assert.deepEqual(fs.readdirSync(dir), ['recent.json']);
  pruneStatus(path.join(dir, 'missing'));
});

test('the branch checked out is asked of git, and is none outside a repository', async t => {
  const dir = tempDir(t);
  assert.equal(await checkedOutBranch(dir), undefined);
  execFileSync('git', ['init', '-q', '-b', 'feature-x', dir]);
  assert.equal(await checkedOutBranch(dir), 'feature-x');
  assert.equal(await checkedOutBranch(undefined), undefined);
});
