import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions.mjs';
import { autoUpdateEnabled, newerInstall, startAutoUpdate } from '../../src/update.mjs';
import { VERSION, isNewer } from '../../src/version.mjs';

const NEWER = '999.0.0';
const listing = version => JSON.stringify([{ id: 'other@x', version: '1000.0.0' }, { id: 'venes@venes', version, installPath: `/cache/${version}` }]);

test('versions compare as numbers', () => {
  assert.equal(isNewer('0.10.0', '0.9.0'), true);
  assert.equal(isNewer('0.3.0', '0.3.0'), false);
  assert.equal(isNewer('0.2.9', '0.3.0'), false);
  assert.equal(isNewer('1.0', '0.9.9'), true);
});

test('a helper that reports no version is older than any', () => {
  assert.equal(isNewer('0.3.0', undefined), true);
  assert.equal(isNewer(undefined, '0.3.0'), false);
});

test('a version that isn\'t numeric never counts as newer', () => {
  assert.equal(isNewer('abc1234', '0.3.0'), false);
  assert.equal(isNewer('0.3.0', 'abc1234'), false);
});

test('every manifest carries the same version', () => {
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(version, VERSION);
});

test('only this plugin\'s install is considered, and only if it is newer', () => {
  assert.equal(newerInstall(listing(NEWER)).installPath, `/cache/${NEWER}`);
  assert.equal(newerInstall(listing(VERSION)), undefined);
  assert.equal(newerInstall('[]'), undefined, 'loaded with --plugin-dir, nothing is installed');
});

async function withPaths(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-test-'));
  try { await run({ noAutoUpdate: path.join(dir, 'no-auto-update') }); } finally { fs.rmSync(dir, { recursive: true }); }
}

test('automatic updates can be turned off, and follow Claude Code\'s own switches', async () => {
  await withPaths(paths => {
    assert.equal(autoUpdateEnabled(paths, {}), true);
    for (const name of ['DISABLE_UPDATES', 'DISABLE_AUTOUPDATER', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']) {
      assert.equal(autoUpdateEnabled(paths, { [name]: '1' }), false, name);
    }
    assert.equal(autoUpdateEnabled(paths, { DISABLE_UPDATES: '1', FORCE_AUTOUPDATE_PLUGINS: '1' }), true);
    fs.writeFileSync(paths.noAutoUpdate, '');
    assert.equal(autoUpdateEnabled(paths, { FORCE_AUTOUPDATE_PLUGINS: '1' }), false, 'the user\'s own choice wins');
  });
});

function updater({ installed = NEWER, fails = () => false, options = {} } = {}) {
  const store = new SessionStore();
  const calls = [];
  const launched = [];
  const run = async args => {
    calls.push(args.join(' '));
    if (fails(args)) throw new Error('offline');
    return args.includes('list') ? listing(installed) : '{}';
  };
  const instance = startAutoUpdate(store, { noAutoUpdate: '/nonexistent/flag' }, {
    run, launch: install => launched.push(install.version), firstCheckMs: 3_600_000, ...options,
  });
  return { store, calls, launched, instance };
}

test('the marketplace is refreshed first, or the update would never see a release', async () => {
  const { calls, instance } = updater({ installed: VERSION });
  await instance.check();
  instance.stop();
  assert.deepEqual(calls, ['plugin marketplace update venes', 'plugin update venes@venes --json', 'plugin list --json']);
});

test('a newer install takes over when nothing is in progress', async () => {
  const { launched, instance } = updater();
  assert.equal(await instance.check(), NEWER);
  instance.stop();
  assert.deepEqual(launched, [NEWER]);
});

test('nothing happens when already up to date', async () => {
  const { launched, instance } = updater({ installed: VERSION });
  assert.equal(await instance.check(), undefined);
  instance.stop();
  assert.deepEqual(launched, []);
});

test('an update waits for a running turn', async () => {
  const { store, launched, instance } = updater();
  store.handleHook({ session_id: 'a', hook_event_name: 'UserPromptSubmit', prompt: 'hi' });
  assert.equal(await instance.check(), NEWER, 'it is found, and reported');
  assert.deepEqual(launched, [], 'but not started');
  store.handleHook({ session_id: 'a', hook_event_name: 'Stop' });
  await instance.check();
  instance.stop();
  assert.deepEqual(launched, [NEWER]);
});

test('being offline is not an error, and a copy already on disk still counts', async () => {
  const { launched, instance } = updater({ fails: args => !args.includes('list') });
  assert.equal(await instance.check(), NEWER);
  instance.stop();
  assert.deepEqual(launched, [NEWER]);
});

test('a missing claude command stops nothing', async () => {
  const { launched, instance } = updater({ fails: () => true });
  assert.equal(await instance.check(), undefined);
  instance.stop();
  assert.deepEqual(launched, []);
});

test('two checks at once run the commands once', async () => {
  const { calls, instance } = updater({ installed: VERSION });
  await Promise.all([instance.check(), instance.check()]);
  instance.stop();
  assert.equal(calls.length, 3);
});

async function scheduledRuns(env) {
  const { calls, launched, instance } = updater({ options: { firstCheckMs: 1, env } });
  await new Promise(resolve => { setTimeout(resolve, 30); });
  instance.stop();
  return { calls, launched };
}

test('the first check happens by itself, and takes the new version', async () => {
  const { calls, launched } = await scheduledRuns({});
  assert.equal(calls.length, 3);
  assert.deepEqual(launched, [NEWER]);
});

test('with updates turned off, nothing is fetched', async () => {
  assert.deepEqual((await scheduledRuns({ DISABLE_UPDATES: '1' })).calls, []);
});

test('turning updates off applies to a helper that is already running', async () => {
  await withPaths(async paths => {
    fs.writeFileSync(paths.noAutoUpdate, '');
    const calls = [];
    const instance = startAutoUpdate(new SessionStore(), paths, {
      run: async args => { calls.push(args); return '[]'; }, firstCheckMs: 1, env: {},
    });
    await new Promise(resolve => { setTimeout(resolve, 20); });
    instance.stop();
    assert.deepEqual(calls, []);
  });
});

test('asking directly still works with updates turned off', async () => {
  const { launched, instance } = updater({ options: { env: { DISABLE_UPDATES: '1' } } });
  assert.equal(await instance.check(), NEWER);
  instance.stop();
  assert.deepEqual(launched, [NEWER]);
});

const hook = (store, session, name, fields = {}) => store.handleHook({ session_id: session, hook_event_name: name, ...fields });

test('a helper with sessions at rest is quiet', () => {
  const store = new SessionStore();
  assert.equal(store.isQuiet(), true);
  hook(store, 'a', 'Stop');
  assert.equal(store.isQuiet(), true);
});

test('a running turn, an open request or a held message each block a restart', () => {
  const store = new SessionStore();
  hook(store, 'a', 'UserPromptSubmit', { prompt: 'hi' });
  assert.equal(store.isQuiet(), false);
  hook(store, 'a', 'Stop');
  store.hold(store.get('a'), { clientId: 'c', text: 'later' });
  assert.equal(store.isQuiet(), false);
  store.nextHeld(store.get('a'));
  assert.equal(store.isQuiet(), true);
  hook(store, 'a', 'PermissionRequest', { tool_name: 'Bash', tool_input: {}, agent_id: 'bg' });
  hook(store, 'a', 'Stop');
  assert.equal(store.isQuiet(), false, 'a background agent can ask while the session is idle');
});

test('a session that went silent long ago cannot hold up an update for ever', () => {
  const store = new SessionStore();
  hook(store, 'a', 'UserPromptSubmit', { prompt: 'hi' });
  assert.equal(store.isQuiet(Date.now() + 30 * 60_000), false);
  assert.equal(store.isQuiet(Date.now() + 2 * 60 * 60_000), true);
});

test('a session that ended blocks nothing', () => {
  const store = new SessionStore();
  hook(store, 'a', 'UserPromptSubmit', { prompt: 'hi' });
  hook(store, 'a', 'SessionEnd', { reason: 'other' });
  assert.equal(store.isQuiet(), true);
});
