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

// Runs the hook with a `node` that only notes how it was run, so no helper starts and no setting
// of this Mac's changes.
function runHook(dir, mode, { launcher }) {
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
  if (launcher) fs.writeFileSync(path.join(home, 'venes'), '#!/bin/sh\n', { mode: 0o755 });
  const result = spawnSync(hookScript, [mode], {
    input: '{}', env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, VENES_HOME: home, CLAUDE_PLUGIN_ROOT: path.resolve(root) }, encoding: 'utf8',
  });
  return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

test('the hook prints nothing and succeeds when the helper is down', () => {
  withTempDir(dir => {
    const result = runHook(dir, 'fast', { launcher: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('a session start sets the helper up, and any event does while there\'s no launcher yet', () => {
  const setup = `${path.join(root, 'cli/venes.mjs')} setup`;
  withTempDir(dir => assert.deepEqual(runHook(dir, 'session-start', { launcher: true }).calls, [setup]));
  withTempDir(dir => assert.deepEqual(runHook(dir, 'fast', { launcher: false }).calls, [setup], 'after /reload-plugins'));
  withTempDir(dir => assert.deepEqual(runHook(dir, 'fast', { launcher: true }).calls, [], 'nothing to do'));
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

test('a model switch is heard, without waiting on the helper for long', () => {
  const { hooks } = readJson('hooks/hooks.json');
  assert.ok(hooks.PostModelSwitch[0].hooks[0].command.endsWith(' fast'));
});

test('the marketplace lists this plugin from the repository root', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const { plugins } = readJson('.claude-plugin/marketplace.json');
  assert.deepEqual(plugins.map(p => [p.name, p.source]), [[plugin.name, './']]);
});
