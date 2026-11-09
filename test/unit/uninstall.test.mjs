import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { helperPaths } from '../../src/paths.mjs';
import { removePhoneKeys } from '../../src/pairing.mjs';
import { isPluginInstalled, uninstall } from '../../src/uninstall.mjs';

function folder(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-uninstall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const MINE = 'ssh-ed25519 AAAAmine me@laptop';
const NEAR = 'ssh-rsa AAAAother work venes-phone-not';

test('only the keys phones were let in with go, and any one-time key left over', t => {
  const file = path.join(folder(t), 'authorized_keys');
  fs.writeFileSync(file, [MINE, 'ssh-ed25519 AAAAphone venes-phone', 'command="x enroll Ab_9-x",restrict ssh-ed25519 AAAAonce venes-pairing-Ab_9-xYz12', NEAR, ''].join('\n'));
  assert.equal(removePhoneKeys(file), 2);
  assert.equal(fs.readFileSync(file, 'utf8'), `${MINE}\n${NEAR}\n`);
  assert.equal(removePhoneKeys(file), 0, 'and a second time, nothing');
  assert.equal(removePhoneKeys(path.join(folder(t), 'none')), 0, 'nor without the file');
});

test('a copy in Claude Code\'s cache counts only while the plugin is installed', t => {
  const config = folder(t);
  const root = path.join(config, 'plugins', 'cache', 'venes', 'venes', '0.3.39');
  fs.mkdirSync(root, { recursive: true });
  const record = plugins => fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins }));
  assert.equal(isPluginInstalled({ configDir: config, pluginRoot: root }), true, 'no record to read');
  record({ 'venes@venes': [{ scope: 'user', installPath: path.join(config, 'plugins', 'cache', 'venes', 'venes', '0.3.40') }] });
  assert.equal(isPluginInstalled({ configDir: config, pluginRoot: root }), true, 'a newer version is installed');
  record({ 'other@x': [{}] });
  assert.equal(isPluginInstalled({ configDir: config, pluginRoot: root }), false, 'uninstalled');
  assert.equal(isPluginInstalled({ configDir: config, pluginRoot: '/src/venes-helper' }), true, 'run from elsewhere');
});

function installed(t) {
  const dir = folder(t);
  const paths = { ...helperPaths(path.join(dir, '.venes')), claudeSettings: path.join(dir, 'settings.json') };
  fs.mkdirSync(paths.home);
  fs.writeFileSync(paths.launcher, '#!/bin/sh\n');
  fs.writeFileSync(paths.statusLineState, JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
  fs.writeFileSync(paths.claudeSettings, JSON.stringify({ model: 'opus', statusLine: { type: 'command', command: `'${paths.launcher}' statusline` } }));
  const keys = path.join(dir, 'authorized_keys');
  fs.writeFileSync(keys, `${MINE}\nssh-ed25519 AAAAphone venes-phone\n`);
  return { paths, keys };
}

test('one go takes it all off, the plugin first, and puts the status line back', async t => {
  const { paths, keys } = installed(t);
  const ran = [];
  let stopped = false;
  const steps = await uninstall({
    paths, authorizedKeys: keys, stopHelper: async () => { stopped = true; }, run: async args => { ran.push(args.join(' ')); },
  });
  assert.deepEqual(steps.map(s => [s.name, s.ok]), [
    ['plugin', true], ['marketplace', true], ['statusLine', true], ['helper', true], ['keys', true], ['folder', true],
  ]);
  assert.deepEqual(ran, ['plugin uninstall venes@venes', 'plugin marketplace remove venes']);
  assert.equal(stopped, true);
  assert.equal(steps.find(s => s.name === 'keys').detail, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.claudeSettings, 'utf8')), { model: 'opus', statusLine: { type: 'command', command: 'my-line' } });
  assert.equal(fs.readFileSync(keys, 'utf8'), `${MINE}\n`);
  assert.equal(fs.existsSync(paths.home), false);
});

test('without claude, the rest still goes, and it says what to run', async t => {
  const { paths, keys } = installed(t);
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT', path: 'claude' });
  const steps = await uninstall({ paths, authorizedKeys: keys, stopHelper: async () => {}, run: async () => { throw missing; } });
  assert.deepEqual(steps.filter(s => !s.ok).map(s => [s.name, s.detail]), [['plugin', 'claude not found'], ['marketplace', 'claude not found']]);
  assert.equal(fs.existsSync(paths.home), false);
});

test('a folder that isn\'t the helper\'s own is never removed', async t => {
  const { paths: elsewhere, keys } = installed(t);
  // Only the folder is the home one: the status line's note stays where the test made it.
  const paths = { ...elsewhere, home: os.homedir() };
  const before = fs.readdirSync(os.homedir()).sort();
  const steps = await uninstall({ paths, authorizedKeys: keys, stopHelper: async () => {}, run: async () => {} });
  assert.deepEqual(steps.find(s => s.name === 'folder'), { name: 'folder', ok: false, detail: `won't remove ${os.homedir()}` });
  assert.deepEqual(fs.readdirSync(os.homedir()).sort(), before, 'nothing in it added or taken');
});

const ROOT = new URL('../../', import.meta.url).pathname;

// A `claude` that only notes how it was run.
function fakeClaude(dir) {
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'claude-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho "$@" >> '${calls}'\n`, { mode: 0o755 });
  return { bin, read: () => fs.readFileSync(calls, 'utf8').trim().split('\n') };
}

test('the command does it all in one go, asked with --yes', async t => {
  const { paths, keys } = installed(t);
  const claude = fakeClaude(path.dirname(paths.home));
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli/venes.mjs'), 'uninstall', '--yes'], {
    encoding: 'utf8',
    env: { PATH: `${claude.bin}:/usr/bin:/bin`, HOME: path.dirname(paths.home), VENES_HOME: paths.home, VENES_AUTHORIZED_KEYS: keys, VENES_CLAUDE_SETTINGS: paths.claudeSettings },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(claude.read(), ['plugin uninstall venes@venes', 'plugin marketplace remove venes']);
  assert.match(result.stdout, /Took 1 phone key out of/);
  assert.equal(fs.existsSync(paths.home), false);
  assert.equal(JSON.parse(fs.readFileSync(paths.claudeSettings, 'utf8')).statusLine.command, 'my-line');
});

test('without --yes and without a terminal to ask in, nothing changes', async t => {
  const { paths, keys } = installed(t);
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'cli/venes.mjs'), 'uninstall'], {
    encoding: 'utf8', input: 'y\n',
    env: { PATH: '/usr/bin:/bin', HOME: path.dirname(paths.home), VENES_HOME: paths.home, VENES_AUTHORIZED_KEYS: keys, VENES_CLAUDE_SETTINGS: paths.claudeSettings },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--yes/);
  assert.ok(fs.existsSync(paths.launcher));
});

test('an uninstalled copy still run by an open session\'s hooks sets nothing up', async t => {
  const dir = folder(t);
  const config = path.join(dir, 'claude');
  const copy = path.join(config, 'plugins', 'cache', 'venes', 'venes', '0.3.39');
  for (const part of ['cli', 'src', 'package.json', '.claude-plugin']) fs.cpSync(path.join(ROOT, part), path.join(copy, part), { recursive: true });
  fs.writeFileSync(path.join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: {} }));
  const home = path.join(dir, '.venes');
  const { spawnSync } = await import('node:child_process');
  // Should it set up after all, the helper it starts goes with the test.
  t.after(() => spawnSync('pkill', ['-f', `${copy}/cli/venes.mjs daemon`]));
  const result = spawnSync(process.execPath, [path.join(copy, 'cli/venes.mjs'), 'setup'], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: dir, VENES_HOME: home, CLAUDE_CONFIG_DIR: config, VENES_CLAUDE_SETTINGS: path.join(dir, 'settings.json') },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(home), false, 'no launcher, no helper');
  assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'nor a status line');
});
