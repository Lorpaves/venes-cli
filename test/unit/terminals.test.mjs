import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionStore } from '../../src/sessions.mjs';
import { resumeTerminal } from '../../src/terminal.mjs';
import { AGENT, Terminals, historyPage, ordered, sizeOf } from '../../src/terminals.mjs';
import { hasTmux, pause } from '../pane.mjs';

// zsh unless a run says otherwise, as one on a computer with only bash does: VENES_TEST_SHELL=/bin/bash.
const SHELL = process.env.VENES_TEST_SHELL || '/bin/zsh';
const isBash = path.basename(SHELL) === 'bash';
const real = { skip: !(hasTmux && fs.existsSync(SHELL)) && `needs tmux and ${SHELL}` };
// What the two shells say differently.
const readsAKey = isBash ? 'read -n1 key' : 'read -k1 key';
const cantRead = isBash ? /syntax error near unexpected token `fi'/ : /parse error near `fi'/;

// A real tmux of the test's own, a real zsh with nobody's setup, and a helper's terminal sessions over them.
function setup(t, { timing = {}, limits = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-term-'));
  const tmuxSocket = path.join(dir, 's');
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const tmux = (...args) => execFileSync('tmux', ['-S', tmuxSocket, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // Its server is up before the helper asks anything of it, with no settings of anyone's.
  tmux('new-session', '-d', '-s', 'keep', '-x', '80', '-y', '24', 'sleep', '600');
  const env = { HOME: home, SHELL, PATH: process.env.PATH, LANG: 'en_US.UTF-8', VENES_TMUX_SOCKET: tmuxSocket };
  const make = () => {
    const store = new SessionStore();
    const events = [];
    store.on('event', event => events.push(event));
    const terminals = new Terminals({
      store, root: path.join(dir, 'terminals'), shellDir: path.join(dir, 'shell'), terminal: resumeTerminal({ VENES_TERMINAL: 'tmux' }), env,
      timing: { poll: 20, commandWait: 3000, ...timing }, limits,
    });
    const of = kind => events.filter(event => event.kind === kind);
    // The last thing said of what a line printed.
    const printed = clientId => of('message.output').findLast(event => event.clientId === clientId);
    return { store, events, terminals, of, printed };
  };
  const made = [];
  t.after(() => {
    for (const { terminals } of made) terminals.stop();
    try { tmux('kill-server'); } catch { /* it had already gone */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const helper = () => {
    const one = make();
    made.push(one);
    return one;
  };
  return { dir, tmux, home, helper, ...helper() };
}

async function until(what, said, limit = 10_000) {
  for (const deadline = Date.now() + limit; ; await pause(20)) {
    const found = what();
    if (found) return found;
    assert.ok(Date.now() < deadline, `never happened: ${said}`);
  }
}

const isIdle = (store, sessionId) => () => store.find(sessionId)?.status === 'idle';

test('a command is a line, and what it printed is under it, with how it ended', real, async t => {
  const { store, terminals, of, printed, events } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 60, rows: 20 });
  assert.equal(store.find(sessionId).agent, AGENT);
  assert.equal(store.find(sessionId).status, 'idle');
  assert.deepEqual(of('session.started').map(({ source }) => source), ['startup']);
  assert.equal(await terminals.owns(sessionId), true);

  assert.deepEqual(await terminals.send({ sessionId, text: 'echo hi; echo there', clientId: 'c1' }), { queued: false });
  await until(() => printed('c1')?.running === false, 'the command ended');
  const kinds = events.filter(event => ['message.user', 'message.output', 'session.status'].includes(event.kind)).map(event => [event.kind, event.status ?? event.text ?? event.stdout]);
  assert.deepEqual(kinds, [
    ['message.user', 'echo hi; echo there'], ['session.status', 'running'], ['message.output', 'hi\nthere'], ['session.status', 'idle'],
  ]);
  const { seq, at, ...said } = printed('c1');
  assert.deepEqual(said, { sessionId, kind: 'message.output', clientId: 'c1', stdout: 'hi\nthere', stderr: '', replies: false, running: false, columns: 60, exitCode: 0 });
  assert.deepEqual(of('message.user')[0].shell, true);
  assert.equal(store.find(sessionId).lastPrompt, 'echo hi; echo there');

  // One that fails says so, and one that prints nothing and goes well says nothing.
  await terminals.send({ sessionId, text: 'false', clientId: 'c2' });
  await until(() => printed('c2'), 'the failure was said');
  assert.deepEqual([printed('c2').stdout, printed('c2').exitCode], ['', 1]);
  await terminals.send({ sessionId, text: 'true', clientId: 'c3' });
  await until(() => of('message.user').length === 3 && store.find(sessionId).status === 'idle', 'the quiet command ended');
  assert.equal(printed('c3'), undefined);
});

test('the session is where its shell is', real, async t => {
  const { store, terminals, of } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'cd /usr', clientId: 'c1' });
  await until(() => of('session.cwd').length, 'the folder was said');
  assert.equal(of('session.cwd')[0].cwd, '/usr');
  assert.equal(store.find(sessionId).cwd, '/usr');
  assert.equal(await terminals.folderOf(sessionId), '/usr');
});

test('a line the shell couldn\'t read is shown with what the shell said of it', real, async t => {
  const { store, terminals, of, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'fi', clientId: 'c1' });
  await until(() => printed('c1'), 'the shell\'s answer');
  assert.match(printed('c1').stdout, cantRead);
  assert.equal(printed('c1').running, false);
  assert.deepEqual(of('message.user').map(({ text, clientId }) => [text, clientId]), [['fi', 'c1']]);
  assert.equal(store.find(sessionId).status, 'idle');
});

test('a line sent while a program runs is typed into it, and what it prints next is that line\'s', real, async t => {
  const { store, terminals, of, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'echo first; cat', clientId: 'c1' });
  await until(() => printed('c1')?.stdout === 'first', 'cat was running');
  assert.equal(printed('c1').running, true);
  assert.equal(store.find(sessionId).status, 'running');
  await terminals.send({ sessionId, text: 'hello', clientId: 'c2' });
  await until(() => printed('c2')?.stdout === 'hello\nhello', 'cat said it back');
  assert.deepEqual(of('message.user').at(-1), { ...of('message.user').at(-1), text: 'hello', clientId: 'c2', shell: true, input: true });
  // The part before is over, though the program isn't.
  assert.deepEqual([printed('c1').stdout, printed('c1').running], ['first', false]);
  assert.equal(printed('c2').running, true);
  await terminals.key({ sessionId, key: 'C-d' });
  await until(isIdle(store, sessionId), 'cat ended');
  assert.deepEqual([printed('c2').stdout, printed('c2').running, printed('c2').exitCode], ['hello\nhello', false, 0]);
});

test('a line a program reads without showing isn\'t shown', real, async t => {
  const { store, terminals, of, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'read -s word; echo got ${#word}', clientId: 'c1' });
  await until(() => store.find(sessionId).status === 'running', 'read was waiting');
  await pause(300);
  await terminals.send({ sessionId, text: 'secret', clientId: 'c2' });
  await until(isIdle(store, sessionId), 'read ended');
  assert.deepEqual(of('message.user').map(({ text }) => text), ['read -s word; echo got ${#word}', '••••••']);
  assert.equal(printed('c2').stdout, 'got 6');
  assert.ok(!JSON.stringify(of('message.output')).includes('secret'));
});

test('a program with the screen to itself shows its screen, and takes keys', real, async t => {
  const { store, terminals, printed, of } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 40, rows: 10 });
  await terminals.send({ sessionId, text: `printf '\\e[?1049h\\e[HTOP\\e[10;1H\\e[7mBAR\\e[0m'; ${readsAKey}; printf '\\e[?1049l'; echo pressed $key`, clientId: 'c1' });
  await until(() => printed('c1')?.screen, 'the screen was shown');
  const screen = printed('c1');
  assert.deepEqual([screen.running, screen.rows, screen.columns], [true, 10, 40]);
  assert.equal(screen.stdout, `TOP${'\n'.repeat(9)}\u001b[0;7mBAR\u001b[0m`);
  // It only waits there, and the session is said to: running, and not at work.
  await until(() => of('session.status').at(-1)?.working === false, 'the session was said to wait');
  assert.equal(of('session.status').at(-1).status, 'running');
  await terminals.key({ sessionId, key: 'Tab' });
  await until(isIdle(store, sessionId), 'the program ended');
  assert.deepEqual([printed('c1').stdout, printed('c1').screen, printed('c1').exitCode], ['pressed', undefined, 0]);
  await assert.rejects(terminals.key({ sessionId, key: 'F13' }), { code: 'bad_key' });
});

test('a command is stopped with Ctrl-C', real, async t => {
  const { store, terminals, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await assert.rejects(terminals.interrupt({ sessionId }), { code: 'not_running' });
  await terminals.send({ sessionId, text: 'sleep 30', clientId: 'c1' });
  await until(() => store.find(sessionId).status === 'running', 'sleep was running');
  await terminals.interrupt({ sessionId });
  await until(isIdle(store, sessionId), 'sleep ended');
  assert.equal(printed('c1').exitCode, 130);
});

test('the terminal is as wide as the page it\'s read on', real, async t => {
  const { store, terminals, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 80, rows: 24 });
  await terminals.send({ sessionId, text: 'tput cols; tput lines', clientId: 'c1', columns: 47, rows: 30 });
  await until(() => printed('c1')?.running === false, 'the size was printed');
  assert.deepEqual([printed('c1').stdout, printed('c1').columns], ['47\n30', 47]);
  // A line longer than the page is one line, however the terminal wrapped it.
  await terminals.send({ sessionId, text: `printf '%s' {1..40}; echo`, clientId: 'c2' });
  await until(() => printed('c2')?.running === false, 'the long line was printed');
  assert.equal(printed('c2').stdout, Array.from({ length: 40 }, (_, index) => index + 1).join(''));
  assert.equal(store.find(sessionId).status, 'idle');
});

test('a command typed at the computer is told like one that was sent', real, async t => {
  const { store, terminals, tmux, of } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  const pane = tmux('list-panes', '-a', '-F', '#{session_name} #{pane_id}').split('\n').find(line => line.startsWith('venes-term-')).split(' ')[1];
  tmux('send-keys', '-t', pane, '-l', 'echo typed here');
  tmux('send-keys', '-t', pane, 'Enter');
  await until(() => of('message.output').length && store.find(sessionId).status === 'idle', 'the command was told');
  const [line] = of('message.user');
  assert.equal(line.text, 'echo typed here');
  assert.ok(line.clientId);
  assert.deepEqual([of('message.output').at(-1).stdout, of('message.output').at(-1).clientId], ['typed here', line.clientId]);
});

test('a page has each line with what it printed under it, and the command going on as it stands', real, async t => {
  const { store, terminals, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'echo one', clientId: 'c1' });
  await until(() => printed('c1')?.running === false, 'the first ended');
  await terminals.send({ sessionId, text: 'echo two; cat', clientId: 'c2' });
  await until(() => printed('c2')?.stdout === 'two', 'cat was running');
  await terminals.send({ sessionId, text: 'line', clientId: 'c3' });
  await until(() => printed('c3')?.stdout === 'line\nline', 'cat said it back');
  const joined = await terminals.join({ sessionId, limit: 50 });
  const shape = item => [item.role, item.clientId, item.role === 'user' ? item.text : item.stdout, ...(item.input ? ['input'] : []), ...(item.running ? ['running'] : [])];
  assert.deepEqual(joined.items.map(shape), [
    ['user', 'c1', 'echo one'], ['output', 'c1', 'one'],
    ['user', 'c2', 'echo two; cat'], ['output', 'c2', 'two'],
    ['user', 'c3', 'line', 'input'], ['output', 'c3', 'line\nline', 'running'],
  ]);
  assert.deepEqual([joined.hasMore, joined.turn, joined.queued, joined.requests], [false, [], [], []]);
  assert.deepEqual(joined.sessions.map(({ id, status, agent }) => [id, status, agent]), [[sessionId, 'running', AGENT]]);
  // A page starts at a command, with the lines typed into it.
  const page = await terminals.history({ sessionId, limit: 1 });
  assert.deepEqual([page.items.map(item => item.clientId), page.before, page.hasMore], [['c2', 'c2', 'c3', 'c3'], 2, true]);
  await terminals.key({ sessionId, key: 'C-d' });
  await until(isIdle(store, sessionId), 'cat ended');
  assert.deepEqual((await terminals.join({ sessionId })).items.map(shape).slice(2), [
    ['user', 'c2', 'echo two; cat'], ['output', 'c2', 'two'], ['user', 'c3', 'line', 'input'], ['output', 'c3', 'line\nline'],
  ]);
});

test('a shell goes on while the helper doesn\'t, and is read again from where it was', real, async t => {
  const first = setup(t);
  const { sessionId } = await first.terminals.start({ cwd: os.tmpdir(), columns: 50, rows: 12 });
  await first.terminals.send({ sessionId, text: 'echo before', clientId: 'c1' });
  await until(() => first.printed('c1')?.running === false, 'the first ended');
  await first.terminals.send({ sessionId, text: 'echo going; cat', clientId: 'c2' });
  await until(() => first.printed('c2')?.stdout === 'going', 'cat was running');
  await first.terminals.send({ sessionId, text: 'kept', clientId: 'c3' });
  await until(() => first.printed('c3')?.stdout === 'kept\nkept', 'cat said it back');
  first.terminals.stop();

  // Something is typed at the computer meanwhile.
  const pane = first.tmux('list-panes', '-a', '-F', '#{session_name} #{pane_id}').split('\n').find(line => line.startsWith('venes-term-')).split(' ')[1];
  first.tmux('send-keys', '-t', pane, '-l', 'missed');
  first.tmux('send-keys', '-t', pane, 'Enter');
  await pause(300);

  const second = first.helper();
  await second.terminals.restore();
  assert.equal(second.store.find(sessionId).status, 'running');
  assert.deepEqual(second.of('message.user'), []);
  const shape = item => [item.role, item.clientId, item.role === 'user' ? item.text : item.stdout, ...(item.running ? ['running'] : [])];
  assert.deepEqual((await second.terminals.join({ sessionId })).items.map(shape), [
    ['user', 'c1', 'echo before'], ['output', 'c1', 'before'],
    ['user', 'c2', 'echo going; cat'], ['output', 'c2', 'going'],
    ['user', 'c3', 'kept'], ['output', 'c3', 'kept\nkept\nmissed\nmissed', 'running'],
  ]);
  await second.terminals.send({ sessionId, text: 'more', clientId: 'c4' });
  await until(() => second.printed('c4')?.stdout === 'more\nmore', 'cat went on');
  await second.terminals.key({ sessionId, key: 'C-d' });
  await until(isIdle(second.store, sessionId), 'cat ended');
  await second.terminals.send({ sessionId, text: 'echo after', clientId: 'c5' });
  await until(() => second.printed('c5')?.running === false, 'a new command ran');
  assert.equal(second.printed('c5').stdout, 'after');
  assert.deepEqual((await second.terminals.join({ sessionId })).items.map(item => item.clientId), ['c1', 'c1', 'c2', 'c2', 'c3', 'c3', 'c4', 'c4', 'c5', 'c5']);
});

test('a session is closed and opened again, with what was run in it', real, async t => {
  const { store, terminals, of, printed } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'echo kept', clientId: 'c1' });
  await until(() => printed('c1')?.running === false, 'the command ended');
  assert.equal(terminals.isClosable(sessionId), true);
  await terminals.closeNow(sessionId);
  assert.equal(store.find(sessionId).status, 'ended');
  assert.deepEqual(of('session.ended').map(({ reason }) => reason), ['closed']);
  assert.equal(terminals.isClosable(sessionId), false);
  await assert.rejects(terminals.key({ sessionId, key: 'Enter' }), { code: 'not_open' });
  const closed = await terminals.join({ sessionId });
  assert.deepEqual(closed.sessions.map(({ status, agent }) => [status, agent]), [['ended', AGENT]]);
  assert.deepEqual(closed.items.map(item => item.clientId), ['c1', 'c1']);
  assert.deepEqual((await terminals.library()).map(({ id, title, status, agent }) => [id, title, status, agent]), [[sessionId, 'echo kept', null, AGENT]]);

  // A message starts a new shell where the old one was.
  await terminals.send({ sessionId, text: 'echo again', clientId: 'c2' });
  await until(() => printed('c2')?.running === false, 'the new shell ran it');
  assert.deepEqual(of('session.started').map(({ source }) => source), ['startup', 'resume']);
  assert.deepEqual((await terminals.join({ sessionId })).items.map(item => item.clientId), ['c1', 'c1', 'c2', 'c2']);

  await terminals.restartNow(sessionId);
  assert.equal(store.find(sessionId).status, 'idle');
  await terminals.send({ sessionId, text: 'echo thrice', clientId: 'c3' });
  await until(() => printed('c3')?.running === false, 'the restarted shell ran it');
});

test('a shell that\'s left ends its session, and a deleted session leaves nothing', real, async t => {
  const { dir, store, terminals, of } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send({ sessionId, text: 'exit', clientId: 'c1' });
  await until(() => store.find(sessionId)?.status === 'ended', 'the session ended');
  assert.deepEqual(of('session.ended').map(({ reason }) => reason), ['exited']);
  await terminals.remove({ sessionId });
  assert.equal(store.find(sessionId), undefined);
  assert.equal(of('session.deleted').length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'terminals', sessionId)), false);
  assert.equal(await terminals.owns(sessionId), false);
  await assert.rejects(terminals.join({ sessionId }), { code: 'unknown_session' });

  const other = await terminals.start({ cwd: os.tmpdir() });
  await terminals.remove({ sessionId: other.sessionId });
  assert.equal(fs.existsSync(path.join(dir, 'terminals', other.sessionId)), false);
});

test('the terminal\'s writing starts again past its limit, and goes on being read', real, async t => {
  const { dir, store, terminals, printed } = setup(t, { limits: { stream: 4000 } });
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  const stream = path.join(dir, 'terminals', sessionId, 'stream');
  await terminals.send({ sessionId, text: 'seq 1 2000', clientId: 'c1' });
  await until(() => printed('c1')?.running === false, 'the long command ended');
  assert.equal(printed('c1').stdout.split('\n').length, 2000);
  await until(() => fs.statSync(stream).size < 4000, 'the file started again');
  // What's written next is written at its start, and read from there.
  await terminals.send({ sessionId, text: 'echo after', clientId: 'c2' });
  await until(() => printed('c2')?.running === false, 'the next command ended');
  assert.equal(printed('c2').stdout, 'after');
  assert.ok(fs.statSync(stream).size < 4000);
  assert.ok(!fs.readFileSync(stream).includes(0), 'nothing was left where the old writing was');
  assert.equal(store.find(sessionId).status, 'idle');
});

test('a terminal closed at the computer ends its session, and a message opens a new one', real, async t => {
  const { store, terminals, tmux, of, printed } = setup(t, { timing: { aliveCheck: 60_000 } });
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  const name = tmux('list-sessions', '-F', '#{session_name}').split('\n').find(line => line.startsWith('venes-term-'));
  tmux('kill-session', '-t', name);
  // Before the helper has looked again, a message finds the terminal gone.
  await assert.rejects(terminals.send({ sessionId, text: 'echo lost', clientId: 'c1' }), { code: 'session_ended' });
  assert.equal(store.find(sessionId).status, 'ended');
  await terminals.send({ sessionId, text: 'echo found', clientId: 'c2' });
  await until(() => printed('c2')?.running === false, 'the new shell ran it');
  assert.deepEqual(of('session.started').map(({ source }) => source), ['startup', 'resume']);
});

test('a session that isn\'t a terminal\'s is nobody\'s here', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-term-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const terminals = new Terminals({ store: new SessionStore(), root: path.join(dir, 'terminals'), shellDir: path.join(dir, 'shell') });
  assert.equal(await terminals.owns('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'), false);
  assert.equal(await terminals.owns('../../etc'), false);
  assert.equal(await terminals.owns(undefined), false);
  assert.equal(terminals.denies('0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'), true);
  assert.deepEqual(await terminals.library(), []);
  assert.equal(terminals.isAvailable(), false);
  await assert.rejects(terminals.start({ cwd: os.tmpdir() }), { code: 'no_tmux' });
});

test('its status is the folder its shell is in, with the branch checked out there', real, async t => {
  const { dir, terminals, of } = setup(t);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['-C', repo, 'init', '-q']);
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  const { sessionId } = await terminals.start({ cwd: repo });
  const { status } = await terminals.status({ sessionId });
  assert.deepEqual([status.project, status.branch], ['repo', 'trunk']);
  assert.ok(Math.abs(status.updatedAt - Date.now() / 1000) < 5);
  // Out of the repository there's no branch to tell.
  await terminals.send({ sessionId, text: 'cd ..', clientId: 'c1' });
  await until(() => of('session.cwd').length, 'the folder was said');
  const moved = (await terminals.status({ sessionId })).status;
  assert.deepEqual([moved.project, 'branch' in moved], [path.basename(dir), false]);
  await assert.rejects(terminals.status({ sessionId: 'nobody' }), error => error.code !== undefined);
});

test('a terminal session takes no files, and has no model or modes', real, async t => {
  const { terminals } = setup(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await assert.rejects(terminals.send({ sessionId, text: 'ls', attachments: [{ uploadId: 'u' }] }), { code: 'bad_attachment' });
  await assert.rejects(terminals.send({ sessionId, text: '  \n' }), { code: 'bad_text' });
  await assert.rejects(terminals.configure({ sessionId, model: 'x' }), { code: 'terminal_session' });
  assert.deepEqual(await terminals.capabilities({ sessionId }), { commands: [], models: [], skills: [] });
  assert.deepEqual(await terminals.page({ sessionId }), { page: null });
  assert.equal(terminals.isAvailable(), true);
  await assert.rejects(terminals.start({ cwd: '/no/such/folder' }), error => error.code !== undefined);
});

test('what was run is ordered with each line\'s output under it', () => {
  const records = [
    { role: 'user', clientId: 'a', text: 'cat' }, { role: 'user', clientId: 'b', text: 'x', input: true },
    { role: 'output', clientId: 'a', stdout: '1' }, { role: 'output', clientId: 'b', stdout: '2' },
    { role: 'user', clientId: 'c', text: 'ls' }, { role: 'output', clientId: 'gone', stdout: '3' },
  ];
  assert.deepEqual(ordered(records).map(item => [item.role, item.clientId]), [['user', 'a'], ['output', 'a'], ['user', 'b'], ['output', 'b'], ['user', 'c'], ['output', 'gone']]);
});

test('a page of what was run starts at a command', () => {
  const items = [
    { role: 'user', clientId: 'a' }, { role: 'output', clientId: 'a' },
    { role: 'user', clientId: 'b' }, { role: 'user', clientId: 'c', input: true }, { role: 'output', clientId: 'c' },
    { role: 'user', clientId: 'd' },
  ];
  assert.deepEqual(historyPage(items, { limit: 2 }), { items: items.slice(2), before: 2, hasMore: true });
  assert.deepEqual(historyPage(items, { limit: 2, before: 2 }), { items: items.slice(0, 2), before: 0, hasMore: false });
  assert.deepEqual(historyPage([], {}), { items: [], before: 0, hasMore: false });
});

test('a size is one a terminal can be', () => {
  assert.deepEqual(sizeOf({ columns: 47, rows: 30 }), { columns: 47, rows: 30 });
  assert.deepEqual(sizeOf({ columns: 3, rows: 9000 }), { columns: 20, rows: 200 });
  assert.equal(sizeOf({ columns: '47', rows: 30 }), undefined);
  assert.equal(sizeOf(), undefined);
});
