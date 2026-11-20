import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../../src/paths.mjs';
import { launcherScript, launcherShim, writeLauncher } from '../../src/setup.mjs';

// What's tried here of the launcher and of hook.sh is a Mac's and Linux's: Windows has its own of each,
// which test/smoke.mjs runs.
const posix = { skip: process.platform === 'win32' };

const root = fileURLToPath(new URL('../../', import.meta.url));
const hookScript = path.join(root, 'scripts/hook.sh');
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-test-'));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true }); }
}

test('the launcher needs nothing from PATH and passes its arguments on', posix, () => {
  const script = launcherScript({ home: '/h/.venes' }, '/opt/homebrew/bin/node', "/it's/venes.mjs");
  assert.ok(script.includes(`VENES_HOME='/h/.venes' exec '/opt/homebrew/bin/node' '/it'\\''s/venes.mjs' "$@"`));
});

test('on Windows the launcher is there as JavaScript too, which runs the same command line from the same home', () => {
  withTempDir(dir => {
    const home = path.join(dir, 'h');
    const paths = { home, launcher: path.join(home, 'venes.cmd') };
    writeLauncher(paths, 'win32');
    const shim = fs.readFileSync(path.join(home, 'venes.mjs'), 'utf8');
    assert.equal(shim, launcherShim(paths));
    assert.match(shim, /^process\.env\.VENES_HOME \?\?= ".*";\nawait import\("file:\/\/.*\/cli\/venes\.mjs"\);\n$/);
    assert.ok(shim.includes(JSON.stringify(home)));
    // Elsewhere there's none: the launcher is a script any shell runs.
    const other = { home: path.join(dir, 'o'), launcher: path.join(dir, 'o', 'venes') };
    writeLauncher(other, 'darwin');
    assert.equal(fs.existsSync(path.join(dir, 'o', 'venes.mjs')), false);
  });
});

test('the launcher is written executable', posix, () => {
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

test('the hook prints nothing and succeeds when the helper is down', posix, () => {
  withTempDir(dir => {
    const result = runHook(dir, 'fast', { launcher: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  });
});

test('a session start sets the helper up, and any event does while there\'s no launcher yet', posix, () => {
  const setup = `${path.join(root, 'cli/venes.mjs')} setup`;
  withTempDir(dir => assert.deepEqual(runHook(dir, 'session-start', { launcher: true }).calls, [setup]));
  withTempDir(dir => assert.deepEqual(runHook(dir, 'fast', { launcher: false }).calls, [setup], 'after /reload-plugins'));
  withTempDir(dir => assert.deepEqual(runHook(dir, 'fast', { launcher: true }).calls, [], 'nothing to do'));
});

test('only PermissionRequest waits, and every hook runs the bundled script', () => {
  const { hooks } = readJson('hooks/hooks.json');
  for (const [event, groups] of Object.entries(hooks)) {
    const { command, timeout } = groups[0].hooks[0];
    const mode = command.match(/hook\.sh" ([a-z-]+);/)?.[1];
    assert.equal(command, hookLine(mode), event);
    assert.equal(mode === 'hold', event === 'PermissionRequest', event);
    assert.ok(timeout > 0, event);
  }
  if (process.platform !== 'win32') assert.ok(fs.statSync(hookScript).mode & 0o100);
});

// One line for three shells. sh and Git Bash become the script and never read on. PowerShell, which
// Claude Code gives the line to on Windows with no Git Bash, has no `exec`, says so, and runs the Node
// script. A hook that fails there stops the tool it was told of, so the line ends well whatever happened.
const hookLine = mode => `exec "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh" ${mode}; node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.cjs" ${mode}; exit 0`;

function runHookLine(dir, { script }) {
  const plugin = path.join(dir, 'plugin');
  const ran = path.join(dir, 'ran');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  if (script) fs.writeFileSync(path.join(plugin, 'scripts/hook.sh'), `#!/bin/sh\necho "sh $1" >> '${ran}'\nexit 3\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(plugin, 'scripts/hook.cjs'), `require('node:fs').appendFileSync('${ran}', 'node\\n');\n`);
  const result = spawnSync('/bin/sh', ['-c', hookLine('fast')], { input: '{}', env: { PATH: process.env.PATH, CLAUDE_PLUGIN_ROOT: plugin }, encoding: 'utf8' });
  return { status: result.status, ran: fs.existsSync(ran) ? fs.readFileSync(ran, 'utf8').trim().split('\n') : [] };
}

test('sh becomes the script, whose word is the hook\'s, and never starts Node', posix, () => {
  withTempDir(dir => assert.deepEqual(runHookLine(dir, { script: true }), { status: 3, ran: ['sh fast'] }));
});

test('with no script to become, sh stops there', posix, () => {
  withTempDir(dir => {
    const { status, ran } = runHookLine(dir, { script: false });
    assert.deepEqual([status !== 0, ran], [true, []]);
  });
});

test('a model switch is heard, without waiting on the helper for long', () => {
  const { hooks } = readJson('hooks/hooks.json');
  assert.equal(hooks.PostModelSwitch[0].hooks[0].command, hookLine('fast'));
});

test('the marketplace lists this plugin from the repository root', () => {
  const plugin = readJson('.claude-plugin/plugin.json');
  const { plugins } = readJson('.claude-plugin/marketplace.json');
  assert.deepEqual(plugins.map(p => [p.name, p.source]), [[plugin.name, './'], ['venes-windows', './']]);
  assert.equal(plugins[0].hooks, undefined, 'the plugin\'s own hooks are its file\'s');
});

// On Windows a hook that goes through a shell takes a fifth of a second in Git Bash and a second in
// PowerShell, and Node started by Claude Code itself takes a fifteenth. hooks.json is the same file on
// every system, so the marketplace lists the plugin once more for Windows, with hooks of its own, which
// Claude Code runs in place of the file's, event by event.
test('for Windows the marketplace gives every event a hook that starts Node itself, as the file\'s would', () => {
  const { hooks } = readJson('hooks/hooks.json');
  const entry = readJson('.claude-plugin/marketplace.json').plugins[1].hooks;
  assert.deepEqual(Object.keys(entry), Object.keys(hooks), 'an event left out would run the file\'s hook, through a shell');
  for (const [event, groups] of Object.entries(hooks)) {
    const { command, timeout } = groups[0].hooks[0];
    const mode = command.match(/hook\.sh" ([a-z-]+);/)[1];
    assert.deepEqual(entry[event], [{ hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/scripts/hook.cjs', mode], timeout }] }], event);
  }
});
