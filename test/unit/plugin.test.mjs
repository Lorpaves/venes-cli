import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../../src/paths.mjs';
import { launcherScript, writeLauncher } from '../../src/setup.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const hookScript = path.join(root, 'scripts/hook.sh');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-test-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true }); }
}

test('the launcher needs nothing from PATH and passes its arguments on', () => {
  const script = launcherScript({ home: '/h/.venes' }, '/opt/homebrew/bin/node', "/it's/venes.mjs");
  assert.ok(script.includes(`VENES_HOME='/h/.venes' exec '/opt/homebrew/bin/node' '/it'\\''s/venes.mjs' "$@"`));
});

test('the launcher is written executable', () => {
  withTempDir(dir => {
    const paths = helperPaths(path.join(dir, 'h'));
    writeLauncher(paths);
    assert.ok(fs.statSync(paths.launcher).mode & 0o100);
    assert.equal(fs.statSync(paths.home).mode & 0o777, 0o700);
  });
});

test('the hook prints nothing and succeeds when the helper is down', () => {
  withTempDir(dir => {
    const result = spawnSync(hookScript, ['fast'], { input: '{}', env: { ...process.env, VENES_HOME: dir }, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('only PermissionRequest waits, and every hook runs the bundled script', () => {
  const { hooks } = readJson('hooks/hooks.json');
  for (const [event, groups] of Object.entries(hooks)) {
    const { command, timeout } = groups[0].hooks[0];
    assert.ok(command.startsWith('"${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" '), event);
    assert.equal(command.endsWith(' hold'), event === 'PermissionRequest', event);
    assert.ok(timeout > 0, event);
  }
  assert.ok(fs.statSync(hookScript).mode & 0o100);
});

test('the marketplace lists this plugin from the repository root', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const { plugins } = readJson('.claude-plugin/marketplace.json');
  assert.deepEqual(plugins.map(p => [p.name, p.source]), [[plugin.name, './']]);
});
