import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  ConsoleServer, PANE_PREFIX, UNREACHED, asElsewhere, consoleBackend, isConsolePane, pastedRecords, plainScreen, programFile, recordOf, recordsOf, sgrOf, styledScreen,
} from '../../src/winconsole.mjs';
import { readChoice, resumeTerminal, terminalFrom, terminalOf, typedIn } from '../../src/terminal.mjs';

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// A row as the console's server gives one: its text, and its cells' attributes in runs.
const row = (text, runs = [text.length, 7]) => ({ text, runs });

// The PowerShell that attaches to consoles, as far as the helper speaks to it: `answers` says what
// each thing asked comes to, and `asked` keeps what was.
function fakeServer(answers = {}) {
  const asked = [];
  return {
    asked,
    ask: async (op, fields = {}) => {
      asked.push({ op, ...fields });
      const answer = answers[op];
      const said = typeof answer === 'function' ? answer(fields) : answer;
      if (said instanceof Error) throw said;
      return said ?? {};
    },
  };
}

test('a key is its virtual key, its letter and what\'s held with it, by the name tmux gives it', () => {
  assert.deepEqual(recordOf('Enter'), [0x0D, 13, 0]);
  assert.deepEqual(recordOf('Escape'), [0x1B, 27, 0]);
  assert.deepEqual(recordOf('BTab'), [0x09, 9, 0x10]);
  assert.deepEqual(recordOf('Up'), [0x26, 0, 0x100]);
  assert.deepEqual(recordOf('C-u'), [0x55, 21, 0x08]);
  assert.deepEqual(recordOf('M-p'), [0x50, 112, 0x02]);
  // A letter, or a number, is typed as itself.
  assert.deepEqual(recordOf('s'), [0, 115, 0]);
  assert.deepEqual(recordOf('2'), [0, 50, 0]);
  assert.throws(() => recordOf('Hyper-x'), { code: 'bad_key' });
});

test('text is typed a letter at a time, a line\'s end as Return, and a letter past the first plane as its two halves', () => {
  assert.deepEqual(recordsOf('hi\n'), [[0, 104, 0], [0, 105, 0], [0x0D, 13, 0]]);
  assert.deepEqual(recordsOf('a\r\nb'), [[0, 97, 0], [0x0D, 13, 0], [0, 98, 0]]);
  assert.deepEqual(recordsOf('写'), [[0, 0x5199, 0]]);
  assert.deepEqual(recordsOf('😀'), [[0, 0xD83D, 0], [0, 0xDE00, 0]]);
});

test('a paste goes between the marks a terminal puts around one, its line ends inside it', () => {
  const records = pastedRecords('a\nb');
  const letters = records.map(([, letter]) => String.fromCharCode(letter)).join('');
  assert.equal(letters, '\x1b[200~a\rb\x1b[201~');
  // The line end inside is a Return that's part of the paste, as a terminal sends one.
  assert.deepEqual(records[7], [0x0D, 13, 0]);
  assert.deepEqual(records[0], [0x1B, 27, 0]);
});

test('what a console draws in place of a letter it may not have is read as that letter', () => {
  assert.equal(asElsewhere('> say hello'), '❯ say hello');
  assert.equal(asElsewhere('  > Yes, I trust this folder'), '  ❯ Yes, I trust this folder');
  assert.equal(asElsewhere('>'), '❯');
  assert.equal(asElsewhere('   Opus 5.5 √'), '   Opus 5.5 ✔');
  // Only a pointer: at the start of its line, with a space after it.
  assert.equal(asElsewhere('a > b'), 'a > b');
  assert.equal(asElsewhere('>> appended'), '>> appended');
  assert.equal(asElsewhere('❯ already'), '❯ already');
});

test('a console\'s sixteen colours are the codes a terminal draws them with, and its dark grey is dim', () => {
  assert.deepEqual(sgrOf(0x07), []);
  assert.deepEqual(sgrOf(0x08), [2]);
  assert.deepEqual(sgrOf(0x02), [32]);
  assert.deepEqual(sgrOf(0x0C), [91]);
  assert.deepEqual(sgrOf(0x17), [44]);
  assert.deepEqual(sgrOf(0x4007), [7]);
  assert.deepEqual(sgrOf(0x8007), [4]);
});

test('a screen is its rows, without what trails them, plain or with its colours', () => {
  const rows = [row('> hello   '), row('  done     ', [2, 7, 4, 2, 5, 7]), row('          ')];
  assert.equal(plainScreen(rows), '❯ hello\n  done\n\n');
  assert.equal(styledScreen(rows), '❯ hello\n  \x1b[32mdone\x1b[0m\n\n');
});

test('what\'s typed in the box is told from the hint in it by where the cursor is, on a screen read from a console', () => {
  const rule = '─'.repeat(40);
  const box = (typed, cursor) => styledScreen([row('● done'), row(rule, [40, 8]), typed, row(rule, [40, 8]), row('  ⏸ manual mode on', [2, 7, 1, 8, 1, 7, 14, 8])], cursor);
  // A console keeps no dimness, so the hint has the look of something typed. The cursor is before it, at the box's start.
  const hint = row('> Try "write a test for <filepath>"');
  assert.equal(typedIn(box(hint, [2, 2])), '');
  assert.equal(box(hint, [2, 2]).split('\n')[2], '❯ \x1b[2mTry "write a test for <filepath>"\x1b[0m');
  // Something typed has the cursor after it, or on another line of it.
  assert.equal(typedIn(box(row('> say hello to venes'), [20, 2])), 'say hello to venes');
  assert.equal(typedIn(box(row('> say hello to venes'), [0, 4])), 'say hello to venes');
  assert.equal(typedIn(box(row('>'), [2, 2])), '');
  // With no cursor told, nothing is taken for a hint.
  assert.equal(typedIn(box(hint)), 'Try "write a test for <filepath>"');
  // A hint that's coloured keeps its colour, and is dim with it.
  assert.equal(box(row('> Try this', [2, 7, 8, 2]), [2, 2]).split('\n')[2], '❯ \x1b[2;32mTry this\x1b[0m');
});

test('a question asked in a console is read with the pointer it draws there', () => {
  const screen = plainScreen([
    row('─'.repeat(30)), row(' Accessing workspace:'), row(''), row(' Is this a project you trust?'), row(''), row(' > No, exit'), row('   Yes, I trust this folder'), row(''),
    row(' Enter to confirm · Esc to cancel'),
  ]);
  assert.deepEqual(readChoice(screen).options, ['No, exit', 'Yes, I trust this folder']);
  assert.equal(readChoice(screen).pointed, 0);
});

test('a pane is a console by its name, which a hook\'s header gives it', () => {
  assert.equal(isConsolePane({ pane: 'console:4242' }), true);
  for (const pane of ['%3', 'block:1', undefined]) assert.equal(isConsolePane({ pane }), false);
  assert.deepEqual(terminalFrom({ 'x-venes-console': '4242' }), { pane: 'console:4242' });
  // tmux and Rex come first: a session in either says so, on Windows too.
  assert.deepEqual(terminalFrom({ 'x-venes-console': '4242', 'x-venes-pane': '%3', 'x-venes-tmux': '/tmp/s,1,0' }), { pane: '%3', socket: '/tmp/s' });
  assert.equal(terminalFrom({ 'x-venes-console': '4242', 'x-venes-rex-block': 'block:1', 'x-venes-rex-session': 's' }).pane, 'block:1');
  for (const none of ['', 'abc', '0', '-4']) assert.deepEqual(terminalFrom({ 'x-venes-console': none }), {});
});

test('a hook\'s console is the one of the program that ran it, and none where that can\'t be reached', async () => {
  const reached = consoleBackend(fakeServer({ where: ({ pid }) => ({ pid: pid === 700 ? 4242 : pid, program: 'claude' }) }));
  // A shell between the hook and Claude Code: the console is Claude Code's.
  assert.deepEqual(await terminalOf({ 'x-venes-console': '700' }, { console: reached }), { pane: 'console:4242' });
  assert.deepEqual(await terminalOf({ 'x-venes-console': '4242' }, { console: reached }), { pane: 'console:4242' });
  const unreached = consoleBackend(fakeServer({ where: Object.assign(new Error('that console is in another Windows session than the helper'), { code: 'out_of_reach' }) }));
  assert.deepEqual(await terminalOf({ 'x-venes-console': '4242' }, { console: unreached }), {});
  // Anything else is as it was.
  assert.deepEqual(await terminalOf({ 'x-venes-pane': '%3', 'x-venes-tmux': '/tmp/s,1,0' }, { console: unreached }), { pane: '%3', socket: '/tmp/s' });
  // A hook isn't kept waiting for it: its event goes on with no terminal, which its next one tells.
  const slow = { paneOf: () => new Promise(() => {}) };
  const started = Date.now();
  assert.deepEqual(await terminalOf({ 'x-venes-console': '4242' }, { console: slow, limit: 20 }), {});
  assert.ok(Date.now() - started < 500);
});

test('a console is read, typed into and pasted into by the process it\'s named for', async () => {
  const server = fakeServer({ read: { rows: [row('> hi')], cursor: [4, 0] } });
  const backend = consoleBackend(server);
  const target = { pane: 'console:4242' };
  assert.equal(await backend.readScreen(target), '❯ hi\n');
  await backend.pressKey(target, 'Enter');
  await backend.paste(target, 'a');
  assert.deepEqual(server.asked.map(asked => [asked.op, asked.pid]), [['read', 4242], ['write', 4242], ['write', 4242]]);
  assert.deepEqual(server.asked[1].records, [[0x0D, 13, 0]]);
  assert.equal(server.asked[2].records.length, 13);
  for (const pane of ['%3', 'console:', 'console:abc', undefined]) await assert.rejects(backend.readScreen({ pane }), { code: 'no_pane' });
});

test('what\'s in front in a console is the newest program in it', async () => {
  const backend = consoleBackend(fakeServer({ list: { processes: [{ pid: 4242, name: 'claude' }, { pid: 90, name: 'cmd' }] } }));
  assert.equal(await backend.foreground({ pane: 'console:4242' }), 'claude');
  assert.deepEqual(await backend.processOf({ pane: 'console:4242' }), { name: 'claude', pid: 4242 });
  const shell = consoleBackend(fakeServer({ list: { processes: [{ pid: 90, name: 'cmd.exe' }] } }));
  assert.equal(await shell.foreground({ pane: 'console:90' }), 'cmd');
});

test('the consoles there are are those a program still runs in, and nothing is said when that can\'t be asked', async () => {
  const backend = consoleBackend(fakeServer({ running: { pids: [4242, 5000] } }));
  assert.deepEqual([...await backend.openPanes()], ['console:4242', 'console:5000']);
  assert.equal(await consoleBackend(fakeServer({ running: new Error('no PowerShell') })).openPanes(), undefined);
});

test('a session started in a console of its own is found by its name until its program has gone', async () => {
  let alive = [777];
  const server = fakeServer({ start: { pid: 777 }, alive: ({ pids }) => ({ processes: pids.filter(pid => alive.includes(pid)).map(pid => ({ pid, name: 'claude' })) }), stop: { stopped: true } });
  const backend = consoleBackend(server, { program: name => `C:\\bin\\${name}.exe` });
  const target = await backend.startSession({ name: 'venes-new-1', cwd: 'C:\\work', command: ['claude', '--resume', 'abc'], env: { VENES_HOME: 'C:\\v' } });
  assert.deepEqual(target, { pane: 'console:777' });
  assert.deepEqual(server.asked[0], { op: 'start', file: 'C:\\bin\\claude.exe', args: ['--resume', 'abc'], cwd: 'C:\\work', env: { VENES_HOME: 'C:\\v' } });
  assert.deepEqual(await backend.findSession('venes-new-1'), target);
  assert.equal(await backend.isSessionOpen('venes-new-1', target), true);
  assert.equal(await backend.findSession('another'), undefined);
  alive = [];
  assert.equal(await backend.isSessionOpen('venes-new-1', target), false);
  assert.equal(await backend.findSession('venes-new-1'), undefined);
  // Closing ends the program, and what it started.
  const again = await backend.startSession({ name: 'venes-new-2', cwd: 'C:\\work', command: ['claude'] });
  await backend.closeSession('venes-new-2', again);
  assert.deepEqual(server.asked.at(-1), { op: 'stop', pid: 777 });
});

test('a program named without its folder is found on the PATH, or where Claude Code installs itself', () => {
  const there = files => file => files.includes(file);
  const env = { PATH: 'C:\\tools;C:\\node' };
  assert.equal(programFile('claude', { env, exists: there(['C:\\node\\claude.cmd']), home: 'C:\\Users\\ada' }), 'C:\\node\\claude.cmd');
  assert.equal(programFile('claude', { env, exists: there(['C:\\Users\\ada\\.local\\bin\\claude.exe']), home: 'C:\\Users\\ada' }), 'C:\\Users\\ada\\.local\\bin\\claude.exe');
  assert.equal(programFile('claude', { env, exists: () => false, home: 'C:\\Users\\ada' }), 'claude');
  assert.equal(programFile('C:\\x\\claude.exe', { env, exists: () => false }), 'C:\\x\\claude.exe');
});

test('with no tmux and no Rex, as on Windows, a session is started in a console', () => {
  const terminal = resumeTerminal({ VENES_TERMINAL: 'console' });
  assert.equal(terminal.canStart, true);
  assert.equal(resumeTerminal({ VENES_TERMINAL: 'tmux' }).canStart, true);
});

// The real thing, where there's a Windows to run it on: a console started, typed into, read and closed.
test('on Windows, a program is started in a console of its own, typed into, read back and ended', { skip: process.platform !== 'win32' }, async t => {
  const server = new ConsoleServer();
  t.after(() => server.stop());
  const backend = consoleBackend(server);
  const target = await backend.startSession({ name: 'venes-test', cwd: process.cwd(), command: ['cmd.exe', '/k', 'prompt $G$S'] });
  t.after(() => backend.closeSession('venes-test', target).catch(() => {}));
  assert.match(target.pane, /^console:\d+$/);
  // It takes a moment to draw its prompt.
  const until = async (what, limit = 10_000) => {
    for (const deadline = Date.now() + limit; Date.now() < deadline; await pause(200)) {
      const screen = await backend.readScreen(target);
      if (what(screen)) return screen;
    }
    throw new Error(`not on the screen:\n${await backend.readScreen(target)}`);
  };
  await until(screen => screen.includes('❯'));
  assert.equal(await backend.foreground(target), 'cmd');
  assert.equal(await backend.isSessionOpen('venes-test', target), true);
  assert.ok((await backend.openPanes()) instanceof Set);
  // Typed a letter at a time, then Return. (A paste's marks are for a program that reads them, which this shell doesn't.)
  for (const letter of 'echo') await backend.pressKey(target, letter);
  await backend.pressKey(target, 'Space');
  for (const letter of 'venes-typed-this') await backend.pressKey(target, letter);
  await backend.pressKey(target, 'Enter');
  const screen = await until(text => /^venes-typed-this$/m.test(text));
  assert.match(screen, /echo venes-typed-this/);
  // Its colours come as codes, where it has any, and its text is the same either way.
  assert.match((await backend.readStyledScreen(target)).replace(/\x1b\[[0-9;]*m/g, ''), /venes-typed-this/);
  assert.deepEqual(await backend.findSession('venes-test'), target);
  await backend.closeSession('venes-test', target);
  await pause(500);
  assert.equal(await backend.isSessionOpen('venes-test', target), false);
  await assert.rejects(backend.readScreen(target), { code: 'no_pane' });
});

// A stand-in for the PowerShell, which speaks in lines: `say` is what it prints.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => { child.emit('exit', 0); };
  child.heard = [];
  let buffer = '';
  child.stdin.on('data', said => {
    buffer += said;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      child.heard.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      child.emit('asked', child.heard.at(-1));
    }
  });
  child.say = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  return child;
}

test('the PowerShell is started when it\'s first asked something, and each answer goes to whoever asked', async () => {
  const children = [];
  const server = new ConsoleServer({
    start: () => {
      const child = fakeChild();
      children.push(child);
      child.on('asked', ask => child.say(ask.op === 'bad' ? { id: ask.id, error: 'that process has gone', code: 'gone' } : { id: ask.id, pid: ask.pid, op: ask.op }));
      setImmediate(() => child.say({ ready: true, pid: 1 }));
      return child;
    },
  });
  assert.equal(children.length, 0);
  const [first, second] = await Promise.all([server.ask('read', { pid: 1 }), server.ask('list', { pid: 2 })]);
  assert.deepEqual([first.op, first.pid, second.op, second.pid], ['read', 1, 'list', 2]);
  assert.equal(children.length, 1);
  // A process that has gone is a session with no terminal, as a closed pane is.
  await assert.rejects(server.ask('bad', { pid: 3 }), { code: 'no_pane', message: UNREACHED, details: { reason: 'that process has gone' } });
  server.stop();
});

test('a PowerShell that goes takes what was asked of it with it, and is started again for the next', async () => {
  const children = [];
  const server = new ConsoleServer({
    start: () => {
      const child = fakeChild();
      children.push(child);
      if (children.length > 1) child.on('asked', ask => child.say({ id: ask.id, ok: true }));
      setImmediate(() => child.say({ ready: true }));
      return child;
    },
  });
  const lost = server.ask('read', { pid: 1 });
  await pause(10);
  children[0].emit('exit', 1);
  await assert.rejects(lost, { code: 'console_failed' });
  assert.equal((await server.ask('read', { pid: 1 })).ok, true);
  assert.equal(children.length, 2);
  server.stop();
});

test('an answer that doesn\'t come is given up on', async () => {
  const server = new ConsoleServer({
    limit: 20,
    start: () => {
      const child = fakeChild();
      setImmediate(() => child.say({ ready: true }));
      return child;
    },
  });
  await assert.rejects(server.ask('read', { pid: 1 }), { code: 'console_failed' });
  server.stop();
});

test('a line that isn\'t an answer, or is one to nothing asked, is let go by', async () => {
  const server = new ConsoleServer({
    start: () => {
      const child = fakeChild();
      child.on('asked', ask => { child.stdout.write('not json\n'); child.say({ id: 999 }); child.say({ id: ask.id, rows: [] }); });
      setImmediate(() => child.say({ ready: true }));
      return child;
    },
  });
  assert.deepEqual((await server.ask('read', { pid: 1 })).rows, []);
  assert.equal(PANE_PREFIX, 'console:');
  server.stop();
});
