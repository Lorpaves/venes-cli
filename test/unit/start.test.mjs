import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions.mjs';
import { startNewSession } from '../../src/start.mjs';
import { recentFolders, runningIn, subfolders } from '../../src/folders.mjs';
import { gitRoot, isTrusted } from '../../src/trust.mjs';

const ID = '11111111-2222-4333-8444-555555555555';
const FAST = { limit: 300, check: 5, settle: 1 };
const QUESTION = ' Accessing workspace:\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter confirm · Esc cancel';
const ANSWERED = ' Accessing workspace:\n\n   No, exit\n ❯ Yes, I trust this folder\n\n Enter confirm · Esc cancel';

function folder(t) {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-start-'));
  t.after(() => fs.rmSync(made, { recursive: true, force: true }));
  return fs.realpathSync(made);
}

// A terminal whose Claude shows `screens` in turn, and starts the session once `startsAfter` keys.
function setUp({ screens = [''], startsAfter = 0, open = () => true, trusts = () => true } = {}) {
  const store = new SessionStore({ agentParent: () => undefined });
  const keys = [];
  const started = [];
  let screen = 0;
  const start = () => store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source: 'startup', cwd: '/tmp' }, { pane: '%9' });
  const terminal = {
    startSession: async request => {
      started.push(request);
      if (startsAfter === 0) start();
      return { pane: '%9' };
    },
    isSessionOpen: async () => open(),
    hasOpenDialog: async () => screens[screen].includes('Esc cancel'),
    readScreen: async () => screens[screen],
    pressKey: async (_, key) => {
      keys.push(key);
      screen = Math.min(screen + 1, screens.length - 1);
      if (keys.length === startsAfter) start();
    },
  };
  return { deps: { store, terminal, env: { PATH: '/bin' }, trusts, ...FAST }, keys, started, store };
}

test('a session starts in the folder picked, and its id comes back once its hook has', async t => {
  const where = folder(t);
  const { deps, started } = setUp();
  assert.deepEqual(await startNewSession(deps, { cwd: where }), { sessionId: ID });
  assert.equal(started[0].cwd, where);
  assert.deepEqual(started[0].command, ['claude']);
  assert.match(started[0].name, /^venes-new-[0-9a-f]{8}$/);
  assert.deepEqual(started[0].env, { PATH: '/bin' });
});

test('a session from another terminal isn\'t taken for it', async t => {
  const { deps, store } = setUp({ startsAfter: 99 });
  deps.terminal.startSession = async () => {
    store.handleHook({ hook_event_name: 'SessionStart', session_id: ID, source: 'startup', cwd: '/tmp' }, { pane: '%3' });
    return { pane: '%9' };
  };
  await assert.rejects(startNewSession(deps, { cwd: folder(t) }), { code: 'start_failed' });
});

test('a folder Claude Code doesn\'t trust waits for the reader\'s word, and nothing starts', async t => {
  const { deps, started } = setUp({ trusts: () => false });
  await assert.rejects(startNewSession(deps, { cwd: folder(t) }), { code: 'needs_trust' });
  assert.equal(started.length, 0);
});

test('with the reader\'s word, its question is answered yes, which is the second of two', async t => {
  const { deps, keys } = setUp({ screens: [QUESTION, ANSWERED, ''], startsAfter: 2, trusts: () => false });
  assert.deepEqual(await startNewSession(deps, { cwd: folder(t), trust: true }), { sessionId: ID });
  assert.deepEqual(keys, ['Down', 'Enter']);
});

test('asked about a folder thought trusted, it says no for now, and the reader is asked', async t => {
  const { deps, keys } = setUp({ screens: [QUESTION, ''], startsAfter: 99 });
  await assert.rejects(startNewSession(deps, { cwd: folder(t) }), { code: 'needs_trust' });
  assert.deepEqual(keys, ['Escape'], "Esc is its 'No, exit', so Claude Code goes and leaves nothing running");
});

test('when the answer can\'t be picked, Enter isn\'t pressed on something else', async t => {
  const { deps, keys } = setUp({ screens: [QUESTION], startsAfter: 99, trusts: () => false });
  await assert.rejects(startNewSession(deps, { cwd: folder(t), trust: true }), { code: 'dialog_open' });
  assert.deepEqual(keys, ['Down', 'Down']);
});

test('Claude Code quitting before the session starts says so', async t => {
  const { deps } = setUp({ startsAfter: 99, open: () => false });
  await assert.rejects(startNewSession(deps, { cwd: folder(t) }), { code: 'start_failed' });
});

test('a dialog still open at the end is for someone at the Mac', async t => {
  const { deps } = setUp({ screens: ['Do you want to use this API key?\n Enter to confirm · Esc cancel'], startsAfter: 99 });
  await assert.rejects(startNewSession(deps, { cwd: folder(t) }), { code: 'dialog_open' });
});

test('only a folder that\'s there can be picked', async () => {
  const { deps, started } = setUp();
  await assert.rejects(startNewSession(deps, { cwd: '/no/such/folder' }), { code: 'no_folder' });
  await assert.rejects(startNewSession(deps, { cwd: 'relative/path' }), { code: 'bad_folder' });
  await assert.rejects(startNewSession(deps, {}), { code: 'bad_folder' });
  assert.equal(started.length, 0);
});

test('a folder lists the folders in it, hidden ones left out, by name as Finder sorts them', t => {
  const where = folder(t);
  for (const name of ['b', 'A', 'a10', 'a9', '.git', 'node_modules']) fs.mkdirSync(path.join(where, name));
  fs.writeFileSync(path.join(where, 'file.txt'), 'x');
  fs.symlinkSync(path.join(where, 'b'), path.join(where, 'link'));
  fs.symlinkSync(path.join(where, 'file.txt'), path.join(where, 'filelink'));
  const { entries, truncated } = subfolders(where);
  assert.deepEqual(entries.map(entry => entry.name), ['A', 'a9', 'a10', 'b', 'link', 'node_modules']);
  assert.equal(entries[0].path, path.join(where, 'A'));
  assert.equal(truncated, false);
  assert.deepEqual(subfolders(where, 2), { entries: entries.slice(0, 2), truncated: true });
});

test('recent folders are newest first, once each, and only those still there', t => {
  const one = folder(t);
  const two = folder(t);
  const sessions = [{ cwd: one }, { cwd: `${one}/` }, { cwd: '/no/such/folder' }, {}, { cwd: two }, { cwd: one }];
  assert.deepEqual(recentFolders(sessions), [one, two]);
  assert.deepEqual(recentFolders(sessions, 1), [one]);
});

test('each session going counts once, in its folder', () => {
  const going = new Map([['a', { cwd: '/x' }], ['b', { cwd: '/x/' }], ['c', { cwd: '/y' }], ['d', {}]]);
  assert.deepEqual([...runningIn(going)], [['/x', 2], ['/y', 1]]);
});

test('trust is the folder\'s, or a folder\'s above it, but not past the top of its git repository', t => {
  const top = folder(t);
  const repo = path.join(top, 'repo');
  const inner = path.join(repo, 'src', 'deep');
  fs.mkdirSync(inner, { recursive: true });
  fs.mkdirSync(path.join(repo, '.git'));
  const plain = path.join(top, 'plain', 'below');
  fs.mkdirSync(plain, { recursive: true });
  const home = '/Users/nobody';
  const trusted = (...dirs) => ({ projects: Object.fromEntries(dirs.map(dir => [dir, { hasTrustDialogAccepted: true }])) });
  assert.equal(gitRoot(inner), repo);
  assert.equal(isTrusted(inner, { config: trusted(repo), home }), true, 'trust in a repository is its top folder\'s');
  assert.equal(isTrusted(inner, { config: trusted(top), home }), false, 'a folder above the repository doesn\'t count');
  assert.equal(isTrusted(plain, { config: trusted(top), home }), true, 'outside one, a folder above counts');
  assert.equal(isTrusted(plain, { config: { projects: { [top]: { hasTrustDialogAccepted: false } } }, home }), false);
  assert.equal(isTrusted(plain, { config: {}, home }), false);
  assert.equal(isTrusted(top, { config: trusted(top), home: top }), false, 'the home folder is asked about every time');
});
