import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UNINSTALL = path.join(ROOT, 'scripts/brew-uninstall.sh');
const WRAPPER = path.join(ROOT, 'bin/venes');

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-brew-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A launcher and a `claude` that only note how they were run.
function noting(dir, { launcher = true } = {}) {
  const home = path.join(dir, '.venes');
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'calls');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  const note = name => `#!/bin/sh\necho "${name} $*" >> '${calls}'\n`;
  if (launcher) fs.writeFileSync(path.join(home, 'venes'), note('venes'), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'claude'), note('claude'), { mode: 0o755 });
  return {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, VENES_HOME: home },
    calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []),
  };
}

// Runs the uninstall script under a process that looks like Homebrew running `command`.
function underBrew(command, env) {
  return spawnSync('/bin/sh', ['-c', `'${UNINSTALL}'; true`], {
    argv0: `ruby /opt/homebrew/Library/Homebrew/brew.rb ${command} --cask venes`, env, encoding: 'utf8',
  });
}

test('brew uninstall takes it all off, with the CLI\'s own uninstall', t => {
  const run = noting(folder(t));
  assert.equal(underBrew('uninstall', run.env).status, 0);
  assert.deepEqual(run.calls(), ['venes uninstall --yes']);
});

test('an upgrade or a reinstall only stops the helper, so phones stay paired', t => {
  for (const command of ['upgrade', 'reinstall']) {
    const run = noting(folder(t));
    assert.equal(underBrew(command, run.env).status, 0);
    assert.deepEqual(run.calls(), ['venes stop'], command);
  }
});

test('never set up, uninstalling takes the plugin out of Claude Code', t => {
  const run = noting(folder(t), { launcher: false });
  assert.equal(underBrew('uninstall', run.env).status, 0);
  assert.deepEqual(run.calls(), ['claude plugin uninstall venes@venes', 'claude plugin marketplace remove venes']);
});

test('`venes` on the PATH runs the launcher, and says what to do without one', t => {
  const run = noting(folder(t));
  assert.equal(spawnSync(WRAPPER, ['pair', '--ssh'], { env: run.env }).status, 0);
  assert.deepEqual(run.calls(), ['venes pair --ssh']);
  const bare = noting(folder(t), { launcher: false });
  const result = spawnSync(WRAPPER, ['pair'], { env: bare.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /brew reinstall venes/);
});

test('claude is found on the PATH Homebrew keeps, as Homebrew runs the script without it', t => {
  const run = noting(folder(t), { launcher: false });
  const brewPath = run.env.PATH.split(':')[0];
  assert.equal(underBrew('uninstall', { ...run.env, PATH: '/usr/bin:/bin', HOMEBREW_PATH: brewPath }).status, 0);
  assert.deepEqual(run.calls(), ['claude plugin uninstall venes@venes', 'claude plugin marketplace remove venes']);
});
