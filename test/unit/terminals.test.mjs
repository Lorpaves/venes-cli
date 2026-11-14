import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capped, outputBody, plain, styleBefore, vtLines, withoutPrompt } from '../../src/output.mjs';
import { SessionStore } from '../../src/sessions.mjs';
import { ZSH_FILES, installShellFiles, shellCommand } from '../../src/shell.mjs';
import { parseStatus } from '../../src/gitstate.mjs';
import { changesTerminals } from '../../src/rex.mjs';
import {
  HIDDEN_TEXT, SCREEN_LINE, Terminals, historyPage, mirrorId, parseState, partFrom, partStarts, partTexts, shellQuoted, sizeOf, tailOf,
} from '../../src/terminals.mjs';

const ESC = '\u001b';

test('the spaces at a line\'s end go, and the colours among them stay', () => {
  assert.deepEqual(vtLines(`b      \r\n${ESC}[31mred${ESC}[0m   \r\n  ${ESC}[44m  ${ESC}[0m`), ['b', `${ESC}[31mred${ESC}[0m`, `${ESC}[44m${ESC}[0m`]);
});

test('a screen in the vt format keeps its colours and nothing else', () => {
  const vt = `~ % ls\r\n${ESC}[0m${ESC}[38;5;4mbin${ESC}[0m${ESC}[3Cetc\r\n${ESC}]8;;file:///x${ESC}\\x${ESC}]8;;${ESC}\\${ESC}[?25l\r\n~ % `;
  assert.deepEqual(vtLines(vt), ['~ % ls', `${ESC}[0m${ESC}[38;5;4mbin${ESC}[0m   etc`, 'x', '~ %']);
  assert.equal(plain(vtLines(vt)[1]), 'bin   etc');
});

test('the output starts under the command\'s own line, unless the command cleared that too', () => {
  assert.deepEqual(outputBody(['~ % echo hi', 'hi', '~ % '], 'echo hi'), ['hi', '~ % ']);
  // The hooks draw a command of many lines on one.
  assert.deepEqual(outputBody(['/tmp % for i in 1 2; do  echo $i done', '1', '2'], 'for i in 1 2; do\n echo $i\ndone'), ['1', '2']);
  assert.deepEqual(outputBody(['first', 'second'], 'clear; echo first; echo second'), ['first', 'second']);
});

test('the prompt that comes back isn\'t output, even on the line a command left without a newline', () => {
  assert.deepEqual(withoutPrompt(['hi', '~ % '], '~ % '), ['hi']);
  assert.deepEqual(withoutPrompt([`no newline${' '.repeat(70)}/tmp % `], '/tmp % '), ['no newline']);
  assert.deepEqual(withoutPrompt(['~ %'], '~ % '), []);
  assert.equal(withoutPrompt(['still going'], '~ % '), undefined, 'not until the prompt is there');
});

test('a part of the output starts in the colours the lines above it left', () => {
  const lines = [`${ESC}[34mblue`, 'still blue', `${ESC}[0mplain`];
  assert.equal(styleBefore(lines, 1), `${ESC}[34m`);
  assert.equal(styleBefore(lines, 3), `${ESC}[0m`);
  assert.equal(partFrom(lines, 1), `${ESC}[34mstill blue\n${ESC}[0mplain`);
  assert.equal(partFrom(['a', '', ''], 0), 'a', 'with no empty lines at its end');
  assert.equal(partFrom(['', ''], 0), '');
});

test('a long output keeps its end, as a terminal\'s scrollback does', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}`);
  assert.equal(capped(lines, { maxLines: 3, maxChars: 1000 }), 'line 7\nline 8\nline 9');
  assert.equal(capped(lines, { maxLines: 100, maxChars: 14 }), 'line 8\nline 9');
});

test('the hooks\' state reads as what the shell is doing', () => {
  assert.deepEqual(parseState('idle 42 3 1'), { kind: 'idle', pid: 42, seq: 3, code: 1, key: '42:3' });
  assert.deepEqual(parseState('running 42 4\n'), { kind: 'running', pid: 42, seq: 4, code: undefined, key: '42:4' });
  assert.equal(parseState('idle 4'), undefined);
  assert.equal(parseState(undefined), undefined);
});

test('a size is the client\'s, kept to what a terminal can be', () => {
  assert.deepEqual(sizeOf({ columns: 52, rows: 30 }), { columns: 52, rows: 30 });
  assert.deepEqual(sizeOf({ columns: 2, rows: 9000 }), { columns: 20, rows: 200 });
  assert.deepEqual(sizeOf({}), { columns: 80, rows: 24 });
});

test('a line sent to a running program starts a part of its output where the line shows', () => {
  assert.deepEqual(tailOf(['Python 3', '>>>', '']), { index: 1, text: '>>>' });
  assert.deepEqual(tailOf([]), { index: -1, text: '' });
  // A prompt of the program's own, which the typing shows on, goes with the line and what it printed.
  const repl = ['Python 3', '>>> 1+1', '2', '>>>'];
  assert.deepEqual(partStarts(repl, [undefined, { index: 1, text: '>>>' }]), [0, 1]);
  assert.deepEqual(partTexts(repl, [undefined, { index: 1, text: '>>>' }]), ['Python 3', '>>> 1+1\n2\n>>>']);
  // One the typing left as it was stays with what came before: the cursor was under it, as after cat's
  // last line, or the program read without showing, as for a password.
  const cat = ['hello', 'hello', 'world', 'world'];
  assert.deepEqual(partTexts(cat, [undefined, { index: -1, text: '' }, { index: 1, text: 'hello' }]), ['', 'hello\nhello', 'world\nworld']);
  assert.deepEqual(partTexts(['Password:', 'ok'], [undefined, { index: 0, text: 'Password:' }]), ['Password:', 'ok']);
  // Before the terminal has shown it, and after the screen was cleared under it.
  assert.deepEqual(partTexts(['>>>'], [undefined, { index: 0, text: '>>>' }]), ['>>>', '']);
  assert.deepEqual(partTexts(['new'], [undefined, { index: 5, text: 'gone' }]), ['new', '']);
});

test('git\'s status reads as a prompt would say it', () => {
  const status = [
    '# branch.oid 4f25ac1d0c0c4b6e9d8f1a2b3c4d5e6f70819293', '# branch.head 1.1.0', '# branch.upstream origin/1.1.0', '# branch.ab +2 -1',
    '1 M. N... 100644 100644 100644 aaa bbb staged.swift', '1 .M N... 100644 100644 100644 aaa bbb changed.swift',
    '1 MM N... 100644 100644 100644 aaa bbb both.swift', '2 R. N... 100644 100644 100644 aaa bbb R100 new.swift\told.swift',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc fought.swift', '? new file.txt', '? other.txt', '',
  ].join('\n');
  assert.deepEqual(parseStatus(status), {
    branch: '1.1.0', upstream: 'origin/1.1.0', ahead: 2, behind: 1, staged: 3, modified: 2, untracked: 2, conflicted: 1,
  });
  // With no branch checked out, the commit stands in for one. A new repository has neither yet.
  assert.deepEqual(parseStatus('# branch.oid 4f25ac1d0c0c4b6e\n# branch.head (detached)\n'), {
    branch: '4f25ac1', detached: true, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0,
  });
  assert.equal(parseStatus('# branch.oid (initial)\n# branch.head main\n').branch, 'main');
});

test('a path is typed as a shell reads it', () => {
  assert.equal(shellQuoted('/Users/me/Apps/venes-cli_2.0'), '/Users/me/Apps/venes-cli_2.0');
  assert.equal(shellQuoted('/Users/me/My Folder'), '\'/Users/me/My Folder\'');
  assert.equal(shellQuoted('/tmp/it\'s $HOME'), '\'/tmp/it\'\\\'\'s $HOME\'');
});

test('a page of what was done starts where a line does', () => {
  const items = [
    { role: 'user', text: 'a' }, { role: 'output', stdout: '1' }, { role: 'user', text: 'b' }, { role: 'output', stdout: '2' },
    { role: 'user', text: 'c', input: true }, { role: 'output', stdout: '3' },
  ];
  assert.deepEqual(historyPage(items, { limit: 3 }), { items: items.slice(2), before: 2, hasMore: true });
  assert.deepEqual(historyPage(items, { limit: 3, before: 2 }), { items: items.slice(0, 2), before: 0, hasMore: false });
});

test('the shell reads the reader\'s own files, then the hooks', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installShellFiles(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(ZSH_FILES).sort());
  assert.match(ZSH_FILES['.zshrc'], /source \$ZDOTDIR\/\.zshrc/);
  assert.match(ZSH_FILES['.zshrc'], /source "\$ZDOTDIR\/venes\.zsh"/);
  const { command, env } = shellCommand({ shellDir: dir, terminalDir: '/t', env: { HOME: '/Users/me', PATH: '/bin' } });
  assert.deepEqual(command, ['/bin/zsh', '-l', '-i']);
  assert.deepEqual(env, { ZDOTDIR: dir, VENES_USER_ZDOTDIR: '/Users/me', VENES_TERMINAL_DIR: '/t', LANG: 'en_US.UTF-8', PATH: '/bin' });
});

const until = async (check, label = 'condition', ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(resolve => { setTimeout(resolve, 5); });
  }
  throw new Error(`timed out waiting for ${label}`);
};

// A terminal whose shell is played by the test: it writes what the hooks would, and the screen.
function setUp(t, { prompt = '~ % ' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-terminals-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore({ agentParent: () => undefined });
  const events = [];
  store.on('event', event => events.push(event));
  const calls = [];
  const shell = { dir: undefined, screen: '', open: true, fullScreen: false, hidden: false, pid: 100, seq: 0, cwd: '/Users/me' };
  const write = (name, text) => fs.writeFileSync(path.join(shell.dir, name), text);
  shell.prompt = (code = 0) => {
    write('cwd', shell.cwd);
    write('prompt', prompt);
    write('state', `idle ${shell.pid} ${shell.seq} ${code}`);
  };
  shell.run = command => {
    shell.seq += 1;
    write('command', command);
    write('state', `running ${shell.pid} ${shell.seq}`);
    shell.screen = `${prompt}${command.replace(/\n/g, ' ')}\r\n`;
  };
  const backend = {
    startSession: async request => {
      calls.push(['start', request]);
      shell.dir = request.env.VENES_TERMINAL_DIR;
      shell.size = { ...request.size };
      shell.open = true;
      shell.seq = 0;
      shell.screen = prompt;
      shell.prompt();
      return { pane: '%7' };
    },
    isSessionOpen: async () => shell.open,
    // With `owned`, someone has it open in a window at the Mac, and it stays that window's size.
    resize: async (_, size) => {
      calls.push(['resize', size]);
      if (!shell.owned) shell.size = { ...size };
    },
    size: async () => ({ ...shell.size }),
    // Taking it makes it the helper's, whoever had it, until it's given back to them.
    takeSize: async (_, size) => {
      calls.push(['take', size]);
      shell.before ??= { ...shell.size };
      shell.size = { ...size };
    },
    giveBack: async () => {
      calls.push(['give']);
      if (shell.before) shell.size = shell.before;
      shell.before = undefined;
    },
    paste: async (_, text) => { calls.push(['paste', text]); shell.pasted = text; },
    // With `prompt`, the shell runs what was pasted the moment Enter comes, as a real one does.
    pressKey: async (_, key) => {
      calls.push(['key', key]);
      if (key === 'Enter' && shell.runsAtOnce && !shell.busy) shell.run(shell.pasted);
    },
    // With `gone`, its terminal has closed under it, and there's nothing to read.
    readOutput: async () => {
      if (shell.gone) throw new Error('can\'t find pane');
      return { text: shell.screen, cut: false };
    },
    readStyledScreen: async () => shell.screen,
    isFullScreen: async () => shell.fullScreen,
    hidesInput: async () => shell.hidden,
    closeSession: async () => { calls.push(['close']); shell.open = false; },
  };
  const make = () => new Terminals({
    store, root, shellDir: path.join(root, 'shell'), backends: { tmux: backend, rex: backend }, useRex: () => false,
    env: { HOME: '/Users/me', PATH: '/bin' }, tickMs: 5, liveCheckMs: 50,
    git: async cwd => (cwd === shell.cwd && shell.git ? shell.git : undefined),
  });
  const terminals = make();
  t.after(() => terminals.stop());
  const of = kind => events.filter(event => event.kind === kind);
  // What a client that subscribes now is sent, which leaves out what newer events took the place of.
  const logged = kind => store.eventsSince(0).events.filter(event => event.kind === kind);
  return { store, events, calls, shell, terminals, make, of, logged, root };
}

test('a terminal session starts at its first prompt, with the client\'s size', async t => {
  const { terminals, calls, store, of } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 50, rows: 30 });
  const [, request] = calls.find(([name]) => name === 'start');
  assert.match(request.name, /^venes-term-[0-9a-f]{8}$/);
  assert.equal(request.cwd, fs.realpathSync.native ? path.resolve(os.tmpdir()) : request.cwd);
  assert.deepEqual(request.size, { columns: 50, rows: 30 });
  assert.deepEqual(request.command, ['/bin/zsh', '-l', '-i']);
  const [session] = store.sessions();
  assert.equal(session.id, sessionId);
  assert.equal(session.terminal, true);
  assert.equal(session.status, 'idle');
  assert.equal(of('session.discovered')[0].terminal, true);
  assert.equal(store.registry().length, 0, 'it keeps its own records');
  assert.equal(store.isQuiet(), true);
});

test('a command shows as its line, then its output as it comes, then all of it with how it ended', async t => {
  const { terminals, calls, shell, of, logged } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  assert.deepEqual(await terminals.send(sessionId, { text: 'ls', clientId: 'c1', columns: 60, rows: 24 }), { queued: false });
  assert.deepEqual(calls.filter(([name]) => name !== 'start').map(([name, value]) => [name, value]), [
    ['resize', { columns: 80, rows: 24 }], ['resize', { columns: 60, rows: 24 }], ['paste', 'ls'], ['key', 'Enter'],
  ]);
  shell.run('ls');
  await until(() => of('message.user').length, 'the command');
  assert.deepEqual(of('message.user').map(({ text, shell: isShell, clientId }) => ({ text, isShell, clientId })), [{ text: 'ls', isShell: true, clientId: 'c1' }]);
  assert.equal(of('session.status').at(-1).status, 'running');
  shell.screen += `${ESC}[34mbin${ESC}[0m\r\n`;
  await until(() => of('message.output').length, 'output so far');
  assert.equal(of('message.output').at(-1).stdout, `${ESC}[34mbin${ESC}[0m`);
  assert.equal(of('message.output').at(-1).running, true);
  shell.screen += 'etc\r\n~ % ';
  shell.prompt(0);
  await until(() => of('message.output').some(event => event.running === false), 'the end');
  const outputs = logged('message.output');
  assert.equal(outputs.length, 1, 'an output that\'s been read again takes the place of what came before');
  assert.deepEqual({ stdout: outputs[0].stdout, clientId: outputs[0].clientId, exitCode: outputs[0].exitCode, replies: outputs[0].replies },
    { stdout: `${ESC}[34mbin${ESC}[0m\netc`, clientId: 'c1', exitCode: 0, replies: false });
  assert.equal(outputs[0].columns, 60, 'as wide as the terminal was');
  assert.equal(terminals.history(sessionId, {}).items[1].columns, 60);
  assert.equal(of('session.status').at(-1).status, 'idle');
  assert.deepEqual(terminals.history(sessionId, {}).items.map(({ role, text, stdout, exitCode }) => ({ role, text, stdout, exitCode })), [
    { role: 'user', text: 'ls', stdout: undefined, exitCode: undefined },
    { role: 'output', text: undefined, stdout: `${ESC}[34mbin${ESC}[0m\netc`, exitCode: 0 },
  ]);
});

test('a terminal someone has open at the Mac stays its window\'s size, and its output says how wide it was', async t => {
  const { terminals, shell, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 47, rows: 30 });
  shell.owned = true;
  shell.size = { columns: 156, rows: 70 };
  shell.runsAtOnce = true;
  await terminals.send(sessionId, { text: 'ls', clientId: 'c1', columns: 47, rows: 30 });
  assert.deepEqual(calls.filter(([name]) => name === 'resize').map(([, size]) => size), [{ columns: 47, rows: 30 }, { columns: 47, rows: 30 }], 'asked for all the same');
  shell.screen += 'a   b   c\r\n~ % ';
  shell.prompt(0);
  await until(() => of('message.output').some(event => event.running === false), 'the end');
  assert.equal(of('message.output').at(-1).columns, 156);
  // Once it's let go, the next line sent makes it the client's size again.
  shell.owned = false;
  await terminals.send(sessionId, { text: 'ls', clientId: 'c2', columns: 47, rows: 30 });
  shell.screen += 'a\r\nb\r\n~ % ';
  shell.prompt(0);
  await until(() => of('message.output').some(event => event.clientId === 'c2' && event.running === false), 'the second');
  assert.equal(of('message.output').at(-1).columns, 47);
});

test('a terminal is the size of the page a client has open, whoever else has it, until the client leaves', async t => {
  const { terminals, shell, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.owned = true;
  shell.size = { columns: 156, rows: 70 };
  const phone = {};
  const pad = {};
  assert.deepEqual(await terminals.view(sessionId, { columns: 47, rows: 30 }, phone), { columns: 47, rows: 30 });
  assert.deepEqual(calls.at(-1), ['take', { columns: 47, rows: 30 }]);
  // It's the page's already, so a line sent takes nothing again.
  shell.runsAtOnce = true;
  const takes = () => calls.filter(([name]) => name === 'take').length;
  await terminals.send(sessionId, { text: 'ls', clientId: 'c1', columns: 47, rows: 30 });
  assert.equal(takes(), 1);
  shell.screen += 'a\r\n~ % ';
  shell.prompt(0);
  await until(() => of('message.output').some(event => event.running === false), 'the end');
  assert.equal(of('message.output').at(-1).columns, 47);
  // Someone at the Mac makes it theirs again, and the next line sent takes it back.
  shell.size = { columns: 156, rows: 70 };
  await terminals.send(sessionId, { text: 'ls', clientId: 'c2', columns: 47, rows: 30 });
  assert.equal(takes(), 2);
  // With two looking, it's the last one's, and the other's again when that one goes.
  await terminals.view(sessionId, { columns: 90, rows: 40 }, pad);
  assert.deepEqual(shell.size, { columns: 90, rows: 40 });
  await terminals.leave(sessionId, pad);
  assert.deepEqual(shell.size, { columns: 47, rows: 30 });
  assert.ok(!calls.some(([name]) => name === 'give'));
  // With no one looking, it goes back to whoever had it.
  terminals.leaveAll(phone);
  await until(() => calls.some(([name]) => name === 'give'), 'it to be given back');
  assert.deepEqual(shell.size, { columns: 156, rows: 70 });
  assert.deepEqual(await terminals.leave(sessionId, phone), {}, 'leaving twice is nothing');
});

test('a command is said as soon as the shell runs it, before the send that typed it is answered', async t => {
  const { terminals, shell, of } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.runsAtOnce = true;
  await terminals.send(sessionId, { text: 'make', clientId: 'c1' });
  assert.deepEqual(of('message.user').map(event => [event.text, event.clientId]), [['make', 'c1']]);
  assert.equal(of('session.status').at(-1).status, 'running');
});

test('a command that takes its terminal with it was still sent', async t => {
  const { terminals, shell, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.runsAtOnce = true;
  const read = calls.length;
  shell.gone = true;
  assert.deepEqual(await terminals.send(sessionId, { text: 'exit', clientId: 'c1' }), { queued: false });
  assert.ok(calls.length > read);
  assert.deepEqual(of('message.user').map(event => event.text), ['exit']);
  shell.open = false;
  await until(() => of('session.ended').length, 'its end');
});

test('a command typed at the Mac shows too, and one that printed nothing says only how it ended', async t => {
  const { terminals, shell, of } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.run('false');
  shell.screen += '~ % ';
  shell.prompt(1);
  await until(() => of('session.status').some(event => event.status === 'idle') && of('message.output').length, 'it to end');
  const [user] = of('message.user');
  assert.equal(user.text, 'false');
  assert.match(user.clientId, /^[0-9a-f]{8}-100-1$/);
  const [output] = of('message.output');
  assert.deepEqual({ stdout: output.stdout, exitCode: output.exitCode, clientId: output.clientId }, { stdout: '', exitCode: 1, clientId: user.clientId });
  shell.run('true');
  shell.screen += '~ % ';
  shell.prompt(0);
  await until(() => of('message.user').length === 2 && of('session.status').at(-1).status === 'idle', 'the second');
  assert.equal(of('message.output').length, 1, 'nothing to show for one that did nothing and was fine');
  assert.equal(terminals.join(sessionId, {}).items.length, 4 - 1);
});

test('a line sent while a command runs goes to it, and what it prints after is that line\'s', async t => {
  const { terminals, shell, of, logged, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  await terminals.send(sessionId, { text: 'python3', clientId: 'c1' });
  shell.run('python3');
  shell.screen += 'Python 3.12\r\n>>> ';
  await until(() => of('message.output').length, 'the banner');
  assert.deepEqual(await terminals.send(sessionId, { text: '1+1', clientId: 'c2' }), { queued: false });
  assert.deepEqual(calls.slice(-2), [['paste', '1+1'], ['key', 'Enter']]);
  assert.deepEqual(of('message.user').map(event => [event.text, event.clientId, event.input]), [['python3', 'c1', undefined], ['1+1', 'c2', true]]);
  shell.screen += '1+1\r\n2\r\n>>> ';
  await until(() => of('message.output').some(event => event.clientId === 'c2'), 'the answer');
  assert.deepEqual(logged('message.output').map(event => [event.clientId, event.stdout, event.running]), [
    ['c1', 'Python 3.12', false], ['c2', '>>> 1+1\n2\n>>>', true],
  ]);
  // What it did so far, for a page opened now.
  assert.deepEqual(terminals.join(sessionId, {}).items.map(item => [item.role, item.text ?? item.stdout, item.input ?? item.running]), [
    ['user', 'python3', undefined], ['output', 'Python 3.12', undefined], ['user', '1+1', true], ['output', '>>> 1+1\n2\n>>>', true],
  ]);
  shell.hidden = true;
  await terminals.send(sessionId, { text: 'secret', clientId: 'c3' });
  assert.equal(of('message.user').at(-1).text, HIDDEN_TEXT, 'one read without showing isn\'t shown here either');
  shell.screen += '\r\n~ % ';
  shell.prompt(0);
  await until(() => of('session.status').at(-1).status === 'idle', 'the end');
  const record = terminals.history(sessionId, {}).items;
  assert.ok(!JSON.stringify(record).includes('secret'));
  assert.deepEqual(record.map(item => [item.role, item.text ?? item.stdout]), [
    ['user', 'python3'], ['output', 'Python 3.12'], ['user', '1+1'], ['output', '>>> 1+1\n2\n>>>'], ['user', HIDDEN_TEXT],
  ]);
});

test('a program that has the screen to itself is a page, worked with keys', async t => {
  const { terminals, shell, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir(), columns: 40, rows: 3 });
  assert.deepEqual(await terminals.page(sessionId), { page: null });
  await assert.rejects(terminals.pageKey(sessionId, 'Down'), { code: 'no_page' });
  await terminals.send(sessionId, { text: 'less x', clientId: 'c1' });
  shell.run('less x');
  shell.fullScreen = true;
  await until(() => of('terminal.screen').length, 'the full screen');
  assert.equal(of('terminal.screen')[0].fullScreen, true);
  shell.screen = `one\r\n${ESC}[7mx (END)${ESC}[0m\r\n`;
  await new Promise(resolve => { setTimeout(resolve, 60); });
  assert.equal(of('message.output').length, 0, 'what it shows is the page\'s, and none of its output');
  const { page } = await terminals.page(sessionId);
  assert.deepEqual(page.lines.map(runs => runs.map(run => run.text).join('')), ['one', 'x (END)']);
  await terminals.pageKey(sessionId, 'Down');
  await terminals.pageText(sessionId, 'q');
  assert.deepEqual(calls.slice(-2), [['key', 'Down'], ['paste', 'q']]);
  await assert.rejects(terminals.pageKey(sessionId, 'F1'), { code: 'bad_key' });
  await terminals.interrupt(sessionId);
  assert.deepEqual(calls.at(-1), ['key', 'C-c']);
});

test('a shell that moves says where it is, and can be moved from here while nothing runs', async t => {
  const { terminals, shell, of, calls, store } = setUp(t);
  const there = fs.mkdtempSync(path.join(os.tmpdir(), 'venes there '));
  t.after(() => fs.rmSync(there, { recursive: true, force: true }));
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  assert.deepEqual(await terminals.status(sessionId), { status: { cwd: '/Users/me', home: '/Users/me', running: false } });

  assert.deepEqual(await terminals.cd(sessionId, { path: there }), {});
  const typed = `cd '${fs.realpathSync(there)}'`.replace(fs.realpathSync(there), path.resolve(there));
  assert.deepEqual(calls.slice(-2), [['paste', typed], ['key', 'Enter']]);
  shell.run(typed);
  shell.cwd = there;
  shell.git = { root: there, branch: 'main', ahead: 0, behind: 0, staged: 0, modified: 1, untracked: 0, conflicted: 0 };
  shell.screen += `${there} % `;
  shell.prompt(0);
  await until(() => of('session.cwd').length, 'where it went');
  assert.deepEqual(of('session.cwd').map(event => event.cwd), [there]);
  assert.equal(store.find(sessionId).cwd, there);
  assert.equal(of('message.user').at(-1).text, typed, 'which shows as the command it was');
  assert.deepEqual((await terminals.status(sessionId)).status.git, shell.git);

  // A command that changes nothing about where it is says nothing of it.
  shell.run('true');
  shell.screen += `${there} % `;
  shell.prompt(0);
  await until(() => of('message.user').length === 2 && of('session.status').at(-1).status === 'idle', 'the second');
  assert.equal(of('session.cwd').length, 1);

  shell.run('sleep 100');
  await until(() => of('session.status').at(-1).status === 'running', 'it to run');
  await assert.rejects(terminals.cd(sessionId, { path: there }), { code: 'terminal_busy' });
  await assert.rejects(terminals.cd(sessionId, { path: '/no/such/folder' }), { code: 'no_folder' });
});

test('a shell that has gone ends its session, and a command starts it again where it was', async t => {
  const { terminals, shell, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.open = false;
  await until(() => of('session.ended').length, 'the end');
  assert.equal(of('session.status').at(-1).status, 'ended');
  await assert.rejects(terminals.interrupt(sessionId), { code: 'not_running' });
  await terminals.send(sessionId, { text: 'pwd', clientId: 'c1' });
  assert.equal(calls.filter(([name]) => name === 'start').length, 2);
  assert.equal(of('session.status').at(-1).status, 'idle');
  assert.deepEqual(calls.slice(-2), [['paste', 'pwd'], ['key', 'Enter']]);
});

test('terminal sessions come back after a restart, and go for good when deleted', async t => {
  const { terminals, make, shell, store, of, calls } = setUp(t);
  const { sessionId } = await terminals.start({ cwd: os.tmpdir() });
  shell.run('sleep 100');
  await until(() => of('session.status').at(-1)?.status === 'running', 'it to run');
  terminals.stop();
  const again = make();
  t.after(() => again.stop());
  await again.restore();
  assert.equal(store.find(sessionId).status, 'running');
  assert.equal(again.join(sessionId, {}).items[0].text, 'sleep 100');
  shell.screen += 'done\r\n~ % ';
  shell.prompt(0);
  await until(() => of('message.output').some(event => event.running === false && event.stdout === 'done'), 'its end after the restart');
  await again.remove(sessionId);
  assert.deepEqual(calls.at(-1), ['close']);
  assert.equal(store.find(sessionId), undefined);
  assert.equal(of('session.deleted').length, 1);
  assert.equal(again.has(sessionId), false);
});

// Rex with terminals of the reader's own open in it, which the test opens, changes and closes.
function setUpRex(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-mirrors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new SessionStore({ agentParent: () => undefined });
  const events = [];
  store.on('event', event => events.push(event));
  const calls = [];
  const rex = { open: [], screens: new Map(), sizes: new Map(), fullScreen: false, changed: undefined };
  const backend = {
    listTerminals: async () => rex.open.map(terminal => ({ ...terminal })),
    watchTerminals: listener => { rex.changed = listener; },
    closeLink: async () => {},
    paste: async (target, text) => { calls.push(['paste', target.pane, text]); },
    pressKey: async (target, key) => { calls.push(['key', target.pane, key]); },
    readOutput: async target => ({ text: rex.screens.get(target.pane) ?? '', cut: false }),
    readStyledScreen: async target => rex.screens.get(target.pane) ?? '',
    isFullScreen: async () => rex.fullScreen,
    hidesInput: async () => false,
    size: async target => rex.sizes.get(target.pane) ?? { columns: 156, rows: 70 },
    resize: async () => {},
    takeSize: async (target, size) => { calls.push(['take', target.pane, size]); rex.sizes.set(target.pane, { ...size }); },
    giveBack: async target => { calls.push(['give', target.pane]); rex.sizes.delete(target.pane); },
    closeSession: async (_, target) => { calls.push(['close', target.pane]); rex.open = rex.open.filter(terminal => terminal.pane !== target.pane); },
    isSessionOpen: async () => true,
  };
  const terminals = new Terminals({
    store, root, shellDir: path.join(root, 'shell'), backends: { rex: backend, tmux: backend }, useRex: () => true,
    env: { HOME: '/Users/me', PATH: '/bin' }, tickMs: 5, liveCheckMs: 50, git: async () => undefined,
  });
  t.after(() => terminals.stop());
  const of = kind => events.filter(event => event.kind === kind);
  const shell = (pane, cwd, more = {}) => ({ pane: `block:${pane}`, rexSession: 'session:1', label: 'shell', program: 'zsh', cwd, ...more });
  return { store, events, calls, rex, terminals, of, shell };
}

test('what Rex says of its terminals is a change when one opens, closes, or does something else', () => {
  const inSession = event => ({ type: 'session_event', payload: { session_id: 'session:1', event } });
  assert.equal(changesTerminals({ type: 'session_created', payload: {} }), true);
  assert.equal(changesTerminals(inSession({ type: 'block_created', payload: { block_id: 'block:1' } })), true);
  assert.equal(changesTerminals(inSession({ type: 'block_closed', payload: { block_id: 'block:1' } })), true);
  assert.equal(changesTerminals(inSession({ type: 'block_event', payload: { block_id: 'block:1', name: 'process_changed' } })), true);
  assert.equal(changesTerminals(inSession({ type: 'block_event', payload: { block_id: 'block:1', name: 'bell' } })), false);
  assert.equal(changesTerminals(inSession({ type: 'block_owner_changed', payload: {} })), false);
  assert.equal(changesTerminals({ type: 'keymap_changed' }), false);
});

test('the terminals open in Rex are sessions, for as long as they are open and the reader\'s own', async t => {
  const { terminals, rex, store, of, shell } = setUpRex(t);
  rex.open = [
    shell('a', '/Users/me/app'), shell('b', '/Users/me/notes', { program: 'vim' }),
    shell('c', '/Users/me/app', { program: 'claude' }), shell('d', '/tmp', { label: 'venes-new-1f2e3d4c' }),
  ];
  store.handleHook({ hook_event_name: 'SessionStart', session_id: '11111111-2222-4333-8444-555555555555', source: 'startup', cwd: '/w' }, { pane: 'block:e', rexSession: 'session:1' });
  rex.open.push(shell('e', '/w'));
  await terminals.restore();
  await until(() => store.sessions().some(session => session.mirror), 'the first look at Rex');
  const mirrors = store.sessions().filter(session => session.mirror);
  assert.deepEqual(mirrors.map(session => [session.id, session.terminal, session.status, session.cwd, session.pane]), [
    ['a', true, 'idle', '/Users/me/app', 'block:a'], ['b', true, 'running', '/Users/me/notes', 'block:b'],
  ], 'not the one Claude Code is in, the helper\'s own, or one a session already has');
  assert.deepEqual(of('session.discovered').filter(event => event.mirror).map(event => [event.sessionId, event.cwd, event.terminal]), [
    ['a', '/Users/me/app', true], ['b', '/Users/me/notes', true],
  ]);
  assert.equal(mirrorId('block:01a1d870-007a-7426-9f6c-760ff00593dd'), '01a1d870-007a-7426-9f6c-760ff00593dd');

  // One moves, one's program ends, one closes, and one opens.
  rex.open = [shell('a', '/Users/me/other'), shell('f', '/tmp')];
  rex.changed();
  rex.changed();
  await until(() => of('session.deleted').length, 'the closed one to go');
  assert.deepEqual(of('session.cwd').map(event => [event.sessionId, event.cwd]), [['a', '/Users/me/other']]);
  assert.deepEqual(of('session.deleted').map(event => event.sessionId), ['b']);
  assert.deepEqual(store.sessions().filter(session => session.mirror).map(session => session.id), ['a', 'f']);
  assert.equal(terminals.has('b'), false);

  // Claude Code started in one: it's that session's from then on.
  rex.open = [shell('a', '/Users/me/other', { program: 'claude' }), shell('f', '/tmp', { program: 'make' })];
  rex.changed();
  await until(() => of('session.deleted').length === 2, 'it to go');
  assert.deepEqual(store.sessions().filter(session => session.mirror).map(session => [session.id, session.status]), [['f', 'running']]);
});

test('a mirrored terminal\'s page is its screen, read while someone has it open, and typed into', async t => {
  const { terminals, rex, calls, of, shell } = setUpRex(t);
  rex.open = [shell('a', '/Users/me/app')];
  rex.screens.set('block:a', '~/app ❯ ls\r\nbin  src\r\n~/app ❯ ');
  await terminals.restore();
  await until(() => terminals.has('a'), 'the first look at Rex');
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(of('message.output').length, 0, 'not read with no one looking');

  const opened = await terminals.join('a', { limit: 60 });
  assert.deepEqual(opened.items.map(item => [item.role, item.stdout, item.clientId, item.running]), [['output', '~/app ❯ ls\nbin  src\n~/app ❯', SCREEN_LINE, false]]);
  assert.deepEqual([opened.hasMore, opened.sessions[0].mirror, opened.turn, opened.queued], [false, true, [], []]);

  const phone = {};
  assert.equal((await terminals.view('a', { columns: 47, rows: 30 }, phone)).columns, 47);
  assert.deepEqual(calls.at(-1), ['take', 'block:a', { columns: 47, rows: 30 }]);
  assert.deepEqual(await terminals.send('a', { text: 'make', clientId: 'c1' }), { queued: false });
  assert.deepEqual(calls.slice(-2), [['paste', 'block:a', 'make'], ['key', 'block:a', 'Enter']]);
  assert.equal(of('message.user').length, 0, 'a line shows only as the terminal shows it');
  rex.screens.set('block:a', '~/app ❯ make\r\ncc main.c\r\n');
  await until(() => of('message.output').some(event => /cc main/.test(event.stdout)), 'the screen');
  const shown = of('message.output').at(-1);
  assert.deepEqual([shown.stdout, shown.clientId, shown.columns, shown.replies], ['~/app ❯ make\ncc main.c', SCREEN_LINE, 47, false]);

  // What's running takes Ctrl-C, and a folder can't be changed under it.
  rex.open = [shell('a', '/Users/me/app', { program: 'make' })];
  rex.changed();
  await until(() => of('session.status').at(-1)?.status === 'running', 'it to run');
  await assert.rejects(terminals.cd('a', { path: os.tmpdir() }), { code: 'terminal_busy' });
  await terminals.interrupt('a');
  assert.deepEqual(calls.at(-1), ['key', 'block:a', 'C-c']);
  rex.open = [shell('a', '/Users/me/app')];
  rex.changed();
  await until(() => of('session.status').at(-1)?.status === 'idle', 'it to end');
  await assert.rejects(terminals.interrupt('a'), { code: 'not_running' });
  assert.deepEqual((await terminals.status('a')).status, { cwd: '/Users/me/app', home: '/Users/me', running: false });

  // No one looking: it's given back, and read no more.
  await terminals.leave('a', phone);
  assert.deepEqual(calls.at(-1), ['give', 'block:a']);
  const before = of('message.output').length;
  rex.screens.set('block:a', 'something else');
  await new Promise(resolve => { setTimeout(resolve, 40); });
  assert.equal(of('message.output').length, before);

  // Deleting it closes it in Rex.
  await terminals.remove('a');
  assert.deepEqual(calls.at(-1), ['close', 'block:a']);
  assert.equal(of('session.deleted').length, 1);
});
