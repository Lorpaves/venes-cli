import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInstalled, isSessionOpen, paste, pressKey, readScreen, runsClaude, startSession } from '../../src/rex.mjs';
import { resumeTerminal, sendEscape, sendText, settleCommand, terminalFrom } from '../../src/terminal.mjs';

const SESSION = { pane: 'block:1', rexSession: 'session:1' };

// Where the helper keeps which Rex session is its own, for every test here: never the real one.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-home-'));
process.env.VENES_HOME = HOME;
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
const KEPT = path.join(HOME, 'rex-session');
const keep = id => (id === undefined ? fs.rmSync(KEPT, { force: true }) : fs.writeFileSync(KEPT, `${id}\n`));
const kept = () => (fs.existsSync(KEPT) ? fs.readFileSync(KEPT, 'utf8').trim() : undefined);

// A rex command that writes down how it was called, and answers from `replies` by the words in it.
function fakeRex(t, replies = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-rex-'));
  const log = path.join(dir, 'calls');
  const script = path.join(dir, 'rex');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : undefined;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, server: process.env.REX_SERVER }) + '\\n');
const replies = ${JSON.stringify(replies)};
const reply = Object.entries(replies).find(([words]) => words.split(' ').every(word => args.includes(word)));
if (reply?.[1] === 'fail') { console.error('no such block'); process.exit(3); }
if (reply) process.stdout.write(reply[1]);
`, { mode: 0o755 });
  const { PATH } = process.env;
  process.env.PATH = `${dir}:${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    fs.rmSync(dir, { recursive: true });
  });
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []);
}

test('a short terminal comes back in one call', async t => {
  const calls = fakeRex(t, { format: JSON.stringify({ content: 'the screen\n', eof: true }) });
  assert.equal(await readScreen(SESSION), 'the screen\n');
  const [{ args }] = calls();
  assert.deepEqual(args.slice(0, 7), ['--autostart=false', 'block', 'call', '-s', 'session:1', '-b', 'block:1']);
  assert.equal(args[7], 'format');
  assert.equal(calls().length, 1);
});

test('a long one is only read from the end, where the screen is', async t => {
  const calls = fakeRex(t, {
    format: JSON.stringify({ content: 'the start', id: 4, total: 1_000_000 }),
    blob_read: JSON.stringify({ data: 'the end', id: 4, total: 1_000_000 }),
  });
  assert.equal(await readScreen(SESSION), 'the end');
  const read = calls().at(-1).args;
  assert.equal(read[7], 'blob_read');
  assert.deepEqual(JSON.parse(read[8]), { id: 4, offset: 1_000_000 - 32 * 1024, max_bytes: 32 * 1024 });
});

test('keys go by Rex\'s names', async t => {
  const calls = fakeRex(t);
  for (const key of ['Enter', 'Escape', 'Up', 'Down', 'Left', 'Right', 'M-p', 's']) await pressKey(SESSION, key);
  assert.deepEqual(calls().map(({ args }) => args.at(-1)), ['enter', 'escape', 'up', 'down', 'left', 'right', 'alt+p', 's']);
  assert.deepEqual(calls()[0].args.slice(1, 6), ['send-key', '-s', 'session:1', '-b', 'block:1']);
});

test('text is a paste, sent on stdin, so that no length or character gets in its way', async t => {
  const calls = fakeRex(t);
  const text = '- line one\n"line two" $HOME; `x`';
  await paste(SESSION, text);
  const [{ args, input }] = calls();
  assert.deepEqual(args, ['--autostart=false', 'api', 'call', 'block.event', '-']);
  assert.deepEqual(JSON.parse(input), { session_id: 'session:1', block_id: 'block:1', event: { type: 'paste', payload: { text } } });
});

test('a block on another server is reached there', async t => {
  const calls = fakeRex(t);
  await pressKey({ ...SESSION, rexServer: 'unix:///other.sock' }, 'Enter');
  assert.equal(calls()[0].server, 'unix:///other.sock');
});

const listing = sessions => JSON.stringify({ sessions });
const ran = JSON.stringify({ window_id: 'window:1', block_ids: ['block:9'] });

test('a session starts in a window of its own, with its folder and variables and no shell in the way', async t => {
  const calls = fakeRex(t, { ls: listing([{ session_id: 'session:7', label: 'Venes' }]), run: ran });
  const target = await startSession({ name: 'venes-1', cwd: '/w', command: ['claude', '--resume', 'id', '--', 'a "quoted" message'], env: { PATH: '/bin', A: 'b' } });
  assert.deepEqual(target, { pane: 'block:9', rexSession: 'session:7' });
  assert.deepEqual(calls().at(-1).args, ['run', '-s', 'session:7', '--label', 'venes-1', '--focus=false', '--json', '--cwd', '/w', '--shell=none', '--', 'env', 'PATH=/bin', 'A=b', 'claude', '--resume', 'id', '--', 'a "quoted" message']);
});

test('the first one makes the session they share, with nothing in it', async t => {
  const calls = fakeRex(t, { ls: listing([{ session_id: 'session:1', label: 'mine' }]), 'session.create': JSON.stringify({ session_id: 'session:8' }), run: ran });
  const target = await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} });
  assert.equal(target.rexSession, 'session:8');
  const create = calls().find(({ args }) => args.includes('session.create'));
  assert.deepEqual(JSON.parse(create.args.at(-1)), { label: 'Venes' });
});

test('the helper knows its session by id, and names it back after something renamed it', async t => {
  keep('session:7');
  const calls = fakeRex(t, { ls: listing([{ session_id: 'session:2', label: 'Venes' }, { session_id: 'session:7', label: 'fix-login' }]), run: ran });
  const target = await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} });
  assert.equal(target.rexSession, 'session:7');
  assert.ok(calls().some(({ args }) => args.join(' ') === 'session rename session:7 Venes'));
  assert.ok(!calls().some(({ args }) => args.includes('session.create')));
  assert.equal(kept(), 'session:7');
});

test('with nothing kept, the session called Venes is the helper\'s, and is kept from then on', async t => {
  keep(undefined);
  const calls = fakeRex(t, { ls: listing([{ session_id: 'session:1', label: 'mine' }, { session_id: 'session:3', label: 'Venes' }]), run: ran });
  assert.equal((await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} })).rexSession, 'session:3');
  assert.equal(kept(), 'session:3');
  assert.ok(!calls().some(({ args }) => args.includes('rename')), 'its name is right already');
});

test('a kept session that has gone is replaced: by one called Venes, or else by a new one', async t => {
  keep('session:9');
  fakeRex(t, { ls: listing([{ session_id: 'session:4', label: 'Venes' }]), run: ran });
  assert.equal((await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} })).rexSession, 'session:4');
  assert.equal(kept(), 'session:4');
});

test('a new session is kept', async t => {
  keep('session:9');
  fakeRex(t, { ls: listing([]), 'session.create': JSON.stringify({ session_id: 'session:5' }), run: ran });
  assert.equal((await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} })).rexSession, 'session:5');
  assert.equal(kept(), 'session:5');
});

test('a name that can\'t be put back doesn\'t stop the session from starting', async t => {
  keep('session:7');
  fakeRex(t, { ls: listing([{ session_id: 'session:7', label: 'renamed' }]), rename: 'fail', run: ran });
  assert.equal((await startSession({ name: 'venes-1', cwd: '/w', command: ['claude'], env: {} })).rexSession, 'session:7');
});

test('a session that came with no terminal is a failure to resume', async t => {
  fakeRex(t, { ls: listing([{ session_id: 'session:7', label: 'Venes' }]), run: JSON.stringify({ window_id: 'window:1' }) });
  await assert.rejects(startSession({ name: 'n', cwd: '/w', command: ['claude'], env: {} }), { code: 'resume_failed' });
});

test('it\'s open while its block is, because Rex keeps a session after its last window closes', async t => {
  fakeRex(t, { block: JSON.stringify({ blocks: [{ block_id: 'block:1' }] }) });
  assert.equal(await isSessionOpen('venes-1', SESSION), true);
  assert.equal(await isSessionOpen('venes-1', { ...SESSION, pane: 'block:2' }), false);
});

test('with no session left to look in, it has closed', async t => {
  fakeRex(t, { block: 'fail' });
  assert.equal(await isSessionOpen('venes-1', SESSION), false);
});

test('a block from before a restart is only kept if Claude is still in it', async t => {
  fakeRex(t, { process: JSON.stringify({ foreground: { pid: 7, name: 'claude' } }) });
  assert.equal(await runsClaude(SESSION), true);
});

test('a shell in the block, or no block at all, means it has gone', async t => {
  fakeRex(t, { process: JSON.stringify({ foreground: { pid: 7, name: 'zsh' } }) });
  assert.equal(await runsClaude(SESSION), false);
});

test('a block that has gone is no error here', async t => {
  fakeRex(t, { process: 'fail' });
  assert.equal(await runsClaude(SESSION), false);
});

test('Rex is installed if its command is on the PATH', async t => {
  const { PATH } = process.env;
  t.after(() => { process.env.PATH = PATH; });
  process.env.PATH = '/nowhere';
  assert.equal(isInstalled(), false);
  fakeRex(t);
  assert.equal(isInstalled(), true);
});

test('a hook from a Rex terminal says which block it\'s in', () => {
  const headers = { 'x-venes-rex-block': 'block:1', 'x-venes-rex-session': 'session:1', 'x-venes-rex-server': 'unix:///s' };
  assert.deepEqual(terminalFrom(headers), { pane: 'block:1', rexSession: 'session:1', rexServer: 'unix:///s' });
});

test('tmux inside Rex is tmux\'s, because that\'s the pane keys have to reach', () => {
  const headers = { 'x-venes-pane': '%3', 'x-venes-tmux': '/tmp/s,1,2', 'x-venes-rex-block': 'block:1', 'x-venes-rex-session': 'session:1' };
  assert.deepEqual(terminalFrom(headers), { pane: '%3', socket: '/tmp/s' });
});

test('a hook from neither has no terminal', () => {
  assert.deepEqual(terminalFrom({}), {});
});

test('a stopped session goes back in Rex where there\'s Rex, and tmux elsewhere', async t => {
  const { PATH } = process.env;
  t.after(() => { process.env.PATH = PATH; });
  process.env.PATH = '/nowhere';
  assert.equal(resumeTerminal({}).startSession.name, resumeTerminal({ VENES_TERMINAL: 'tmux' }).startSession.name);
  const tmuxStart = resumeTerminal({}).startSession;
  fakeRex(t);
  assert.notEqual(resumeTerminal({}).startSession, tmuxStart);
  assert.equal(resumeTerminal({ VENES_TERMINAL: 'tmux' }).startSession, tmuxStart);
  process.env.PATH = '/nowhere';
  assert.notEqual(resumeTerminal({ VENES_TERMINAL: 'rex' }).startSession, tmuxStart);
});

const plain = JSON.stringify({ content: '❯ \n  ⏸ manual mode on\n' });
const FAST = { limit: 60, check: 5, requestSettle: 5, pageSettle: 5 };

test('a message to a session in Rex goes the same way as one in tmux: checked, pasted, then Enter', async t => {
  const calls = fakeRex(t, { format: plain });
  await sendText(SESSION, 'hello', () => undefined);
  assert.deepEqual(calls().map(({ args }) => args.at(-1) === 'enter' ? 'enter' : args.includes('block.event') ? 'paste' : 'read'), ['read', 'paste', 'read', 'enter']);
});

test('a dialog on a Rex screen stops the message', async t => {
  const calls = fakeRex(t, { format: JSON.stringify({ content: ' Do you want to proceed?\n ❯ 1. Yes\n Esc to cancel\n' }) });
  await assert.rejects(sendText(SESSION, 'hello', () => undefined), { code: 'dialog_open' });
  assert.ok(!calls().some(({ args }) => args.includes('block.event')));
});

test('a page opened in Rex is closed the same way', async t => {
  const calls = fakeRex(t, { format: JSON.stringify({ content: 'Plan usage\nEsc to cancel\n' }) });
  await assert.rejects(settleCommand(SESSION, () => undefined, FAST), { code: 'terminal_only' });
  assert.ok(calls().some(({ args }) => args.at(-1) === 'escape'));
});

test('Esc reaches a session in Rex', async t => {
  const calls = fakeRex(t);
  await sendEscape(SESSION);
  assert.equal(calls()[0].args.at(-1), 'escape');
});
