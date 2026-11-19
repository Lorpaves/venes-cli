import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FINAL, LIVE, TerminalEngine } from '../../src/termengine.mjs';

const NONCE = 'n0nce';
const mark = (...fields) => `\u001b]7773;${NONCE};${fields.join(';')}\u0007`;
const PROMPT = 'me@mac ~ % ';

function engineWith({ columns = 40, rows = 10 } = {}) {
  const events = [];
  const engine = new TerminalEngine({ columns, rows, nonce: NONCE, emit: event => events.push(event) });
  const feed = async text => {
    await engine.feed(Buffer.from(text));
    engine.flush();
  };
  const outputs = part => events.filter(event => event.type === 'output' && (part === undefined || event.part === part));
  return { engine, events, feed, outputs };
}

// A prompt, the line typed at it, and the command's mark, as a shell writes them.
const typed = (seq, command) => `${PROMPT}${command}\r\n${mark('C', seq, encodeURIComponent(command))}`;
const done = (seq, exitCode = 0, cwd = '/tmp') => mark('P', seq, exitCode, encodeURIComponent(cwd));

test('a command\'s output is what was printed between its mark and the next prompt\'s', async () => {
  const { engine, events, feed, outputs } = engineWith();
  await feed(`${mark('S', 41, '%2Fdev%2Fttys009', 'zsh')}${done(0)}`);
  assert.deepEqual(events, [{ type: 'shell', pid: 41, tty: '/dev/ttys009', name: 'zsh' }, { type: 'prompt', seq: 0, cwd: '/tmp', exitCode: 0, first: true }]);
  assert.equal(engine.isReady, true);
  await feed(`${typed(1, 'echo hi; ls')}hi\r\nfile one\r\n${done(1, 0, '/tmp/a b')}${PROMPT}`);
  assert.deepEqual(events.slice(2), [
    { type: 'command', seq: 1, command: 'echo hi; ls', part: 0 },
    { type: 'output', seq: 1, part: 0, text: 'hi\nfile one', columns: 40, running: false, exitCode: 0 },
    { type: 'finished', seq: 1, part: 0, exitCode: 0 },
    { type: 'prompt', seq: 1, cwd: '/tmp/a b', exitCode: 0 },
  ]);
  assert.equal(outputs().length, 1);
  assert.equal(engine.isRunning, false);
});

test('colours stay, and each line starts and ends plain', async () => {
  const { feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'ls')}\u001b[31mred\u001b[0m and \u001b[1;38;5;208mbold\r\nnext\u001b[0m\r\n${done(1, 3)}`);
  assert.deepEqual(outputs().at(-1), {
    type: 'output', seq: 1, part: 0, columns: 40, running: false, exitCode: 3,
    text: '\u001b[0;31mred\u001b[0m and \u001b[0;1;38;5;208mbold\u001b[0m\n\u001b[0;1;38;5;208mnext\u001b[0m',
  });
});

test('a command that ends without a newline keeps its last line', async () => {
  const { feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'printf abc')}abc${done(1)}\u001b[7m%\u001b[27m${' '.repeat(39)}\r \r${PROMPT}`);
  assert.equal(outputs().at(-1).text, 'abc');
});

test('a line drawn over itself shows as it was left', async () => {
  const { feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'make')}10%\r50%\r100%\u001b[K\r\ndone\r\n`);
  assert.equal(outputs().at(-1).text, '100%\ndone');
  assert.equal(outputs().at(-1).running, true);
  await feed(done(1));
  assert.deepEqual(outputs().map(event => [event.text, event.running]), [['100%\ndone', true], ['100%\ndone', false]]);
});

test('a running command is read again as it prints, and said only when it changes', async () => {
  const { feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'ping')}one\r\n`);
  await feed('');
  await feed('two\r\n');
  assert.deepEqual(outputs().map(event => event.text), ['one', 'one\ntwo']);
});

test('a line the terminal wrapped is one line', async () => {
  const { feed, outputs } = engineWith({ columns: 10 });
  await feed(`${done(0)}${typed(1, 'x')}${'abcdefghij'.repeat(2)}klm\r\nshort\r\n${done(1)}`);
  assert.equal(outputs().at(-1).text, `${'abcdefghij'.repeat(2)}klm\nshort`);
});

test('a program with the screen to itself shows its screen, and nothing of it once it gives the screen back', async () => {
  const { engine, feed, outputs } = engineWith({ columns: 20, rows: 4 });
  await feed(`${done(0)}${typed(1, 'vi')}\u001b[?1049h\u001b[H~\r\n~\r\n\u001b[4;1H\u001b[7m-- INSERT --       \u001b[0m`);
  assert.equal(engine.isFullScreen, true);
  assert.deepEqual(outputs().at(-1), {
    type: 'output', seq: 1, part: 0, columns: 20, running: true, screen: true, rows: 4,
    text: '~\n~\n\n\u001b[0;7m-- INSERT --       \u001b[0m',
  });
  await feed(`\u001b[?1049l${done(1)}`);
  assert.deepEqual(outputs().at(-1), { type: 'output', seq: 1, part: 0, columns: 20, running: false, exitCode: 0, text: '' });
});

test('a line typed into a running program starts a part of its own, at the row it\'s typed on', async () => {
  const { engine, events, feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'python3')}Python 3.13\r\n>>> `);
  assert.equal(outputs(0).at(-1).text, 'Python 3.13\n>>>');
  const part = engine.split();
  assert.equal(part, 1);
  assert.deepEqual(outputs(0).at(-1), { type: 'output', seq: 1, part: 0, columns: 40, running: false, text: 'Python 3.13' });
  assert.equal(outputs(1).at(-1).text, '>>>');
  await feed('1+1\r\n2\r\n>>> ');
  assert.deepEqual(outputs(1).at(-1), { type: 'output', seq: 1, part: 1, columns: 40, running: true, text: '>>> 1+1\n2\n>>>' });
  engine.split();
  await feed(`exit()\r\n${done(1)}`);
  assert.deepEqual(outputs(1).at(-1), { type: 'output', seq: 1, part: 1, columns: 40, running: false, text: '>>> 1+1\n2' });
  assert.deepEqual(outputs(2).at(-1), { type: 'output', seq: 1, part: 2, columns: 40, running: false, exitCode: 0, text: '>>> exit()' });
  assert.deepEqual(events.at(-2), { type: 'finished', seq: 1, part: 2, exitCode: 0 });
  // The first part was said for the last time when the line after it was typed.
  assert.equal(outputs(0).filter(event => !event.running).length, 1);
});

test('a part the program draws over again joins the one after it', async () => {
  const { engine, feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'tui')}title\r\n[ box ]\r\n> `);
  engine.split();
  assert.equal(outputs(0).at(-1).text, 'title\n[ box ]');
  // It goes back up two rows and draws the lot again.
  await feed('hello\u001b[2A\r\u001b[Jtitle\r\nsaid: hello\r\n[ box ]\r\n> ');
  assert.deepEqual(outputs(0).at(-1), { type: 'output', seq: 1, part: 0, columns: 40, running: false, text: '' });
  assert.equal(outputs(1).at(-1).text, 'title\nsaid: hello\n[ box ]\n>');
  assert.deepEqual(engine.running.parts, [1]);
});

test('a program that draws from the top of the screen has its output start there', async () => {
  const { feed, outputs } = engineWith({ rows: 6 });
  await feed(`${done(0)}${typed(1, 'ls')}a\r\n${done(1)}${typed(2, 'top')}\u001b[H\u001b[2JProcesses: 3\r\nLoad: 1.0\r\n`);
  assert.equal(outputs().at(-1).text, 'Processes: 3\nLoad: 1.0');
  await feed(`\u001b[HProcesses: 4\r\n\u001b[3;1H${done(2)}`);
  assert.equal(outputs().at(-1).text, 'Processes: 4\nLoad: 1.0');
});

test('marks that aren\'t this session\'s count for nothing, and aren\'t shown', async () => {
  const { events, feed, outputs } = engineWith();
  await feed(`${done(0)}${typed(1, 'cat log')}before\u001b]7773;other;P;9;0;%2F\u0007after\r\n${done(1)}`);
  assert.equal(outputs().at(-1).text, 'beforeafter');
  assert.equal(events.filter(event => event.type === 'prompt').length, 2);
});

test('the shell says who it is, and where it keeps its history when its hooks say that', async () => {
  const { events, feed } = engineWith();
  await feed(mark('S', 4242, encodeURIComponent('/dev/ttys004'), 'zsh'));
  await feed(mark('S', 4243, encodeURIComponent('/dev/ttys005'), 'zsh', '%2FUsers%2Fme%2F.zsh_history'));
  await feed(mark('S', 4244, encodeURIComponent('/dev/ttys006'), 'bash', ''));
  assert.deepEqual(events.filter(event => event.type === 'shell'), [
    { type: 'shell', pid: 4242, tty: '/dev/ttys004', name: 'zsh' },
    { type: 'shell', pid: 4243, tty: '/dev/ttys005', name: 'zsh', history: '/Users/me/.zsh_history' },
    { type: 'shell', pid: 4244, tty: '/dev/ttys006', name: 'bash' },
  ]);
});

test('a program says when it isn\'t at work, and each command starts at work', async () => {
  const { events, feed } = engineWith();
  await feed(`${done(0)}${typed(1, 'agy')}\u001b]7501;state=idle:app=agy\u001b\\`);
  await feed('\u001b]7501;state=idle:app=agy\u001b\\\u001b]7501;app=agy:state=working\u001b\\');
  await feed(`${done(1)}${typed(2, 'agy')}\u001b]7501;state=idle\u001b\\`);
  assert.deepEqual(events.filter(event => event.type === 'working'), [
    { type: 'working', seq: 1, working: false }, { type: 'working', seq: 1, working: true }, { type: 'working', seq: 2, working: false },
  ]);
});

test('a program with the screen to itself only waits, and is at work again if it gives the screen back and goes on', async () => {
  const { engine, events, feed } = engineWith({ columns: 20, rows: 4 });
  const working = () => events.filter(event => event.type === 'working').map(event => [event.seq, event.working]);
  await feed(`${done(0)}${typed(1, 'vi')}\u001b[?1049h\u001b[H~`);
  assert.deepEqual(working(), [[1, false]]);
  assert.equal(engine.isAtRest, true);
  await feed('\u001b[?1049lbuilding\r\n');
  assert.deepEqual(working(), [[1, false], [1, true]]);
  assert.equal(engine.isAtRest, false);
  // One that gives the screen back as it ends has no work to go back to, and nothing is said of any.
  await feed(`${done(1)}${typed(2, 'less')}\u001b[?1049h\u001b[Hpage`);
  await feed(`\u001b[?1049l${done(2)}`);
  assert.deepEqual(working(), [[1, false], [1, true], [2, false]]);
  assert.equal(engine.isAtRest, false);
  // What a program says of itself counts for more than what it has of the screen.
  await feed(`${typed(3, 'agy')}\u001b[?1049h\u001b]7501;state=working\u001b\\`);
  assert.deepEqual(working().filter(([seq]) => seq === 3), []);
  await feed('\u001b]7501;state=idle\u001b\\\u001b[?1049l');
  assert.deepEqual(working().filter(([seq]) => seq === 3), [[3, false]]);
});

test('a long output is its end while it runs, and more of it once it\'s over', async () => {
  const { feed, outputs } = engineWith({ columns: 20, rows: 5 });
  const lines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
  await feed(`${done(0)}${typed(1, 'seq')}${lines.join('\r\n')}\r\n`);
  const live = outputs().at(-1).text.split('\n');
  assert.equal(live.length, LIVE.maxLines);
  assert.equal(live.at(-1), 'line 999');
  await feed(done(1));
  const all = outputs().at(-1).text.split('\n');
  assert.equal(all.length, 1000);
  assert.equal(all[0], 'line 0');
  assert.ok(FINAL.maxLines >= 1000);
});

test('what scrolled away before it could be kept is left out, from the top', async () => {
  const { feed, outputs } = engineWith({ columns: 20, rows: 5 });
  const lines = Array.from({ length: 6000 }, (_, index) => `line ${index}`);
  await feed(`${done(0)}${typed(1, 'seq')}${lines.join('\r\n')}\r\n${done(1)}`);
  const all = outputs().at(-1).text.split('\n');
  assert.equal(all.length, FINAL.maxLines);
  assert.equal(all.at(-1), 'line 5999');
});

test('a terminal that changes width keeps each command\'s rows', async () => {
  const { engine, feed, outputs } = engineWith({ columns: 20 });
  await feed(`${done(0)}${typed(1, 'x')}${'0123456789'.repeat(3)}\r\n`);
  await engine.resize(12, 10);
  await feed('tail\r\n');
  assert.equal(outputs().at(-1).text, `${'0123456789'.repeat(3)}\ntail`);
  assert.equal(outputs().at(-1).columns, 12);
  await feed(done(1));
  assert.equal(outputs().at(-1).text, `${'0123456789'.repeat(3)}\ntail`);
});

test('what was printed under a place is read from it, when a prompt comes with no command before it', async () => {
  let place;
  const read = [];
  const engine = new TerminalEngine({ columns: 40, rows: 10, nonce: NONCE, emit: event => { if (event.type === 'prompt' && place) read.push(engine.since(place)); } });
  await engine.feed(Buffer.from(`${done(0)}${PROMPT}fi`));
  place = engine.here();
  await engine.feed(Buffer.from(`\r\nzsh: parse error near \`fi'\r\n${done(0, 1)}${PROMPT}`));
  assert.deepEqual(read, ["zsh: parse error near `fi'"]);
});

test('a program that clears the screen and draws again is still read from its own rows', async () => {
  const { feed, outputs } = engineWith({ rows: 6 });
  const before = Array.from({ length: 20 }, (_, index) => `old ${index}`).join('\r\n');
  await feed(`${done(0)}${typed(1, 'cat')}${before}\r\n${done(1)}${typed(2, 'watch')}one\r\n`);
  assert.equal(outputs().at(-1).text, 'one');
  await feed('\u001b[H\u001b[2Jtwo\r\nthree\r\n');
  assert.equal(outputs().at(-1).text, 'two\nthree');
  await feed(`\u001b[H\u001b[Jfour\r\n${done(2)}`);
  assert.equal(outputs().at(-1).text, 'four');
});

test('a window name written for tmux isn\'t printed, even cut in two', async () => {
  const { engine, outputs } = engineWith();
  await engine.feed(Buffer.from(`${done(0)}${PROMPT}ls\r\n\u001b]2;ls\u001b\\\u001bkl`));
  await engine.feed(Buffer.from(`s\u001b\\${mark('C', 1, 'ls')}a\r\n\u001b`));
  await engine.feed(Buffer.from(`kname\u0007b\r\n${done(1)}`));
  engine.flush();
  assert.equal(outputs().at(-1).text, 'a\nb');
});

test('a command whose end was never said ends when the next one starts', async () => {
  const { events, feed } = engineWith();
  await feed(`${done(0)}${typed(1, 'a')}one\r\n${typed(2, 'b')}two\r\n${done(2)}`);
  assert.deepEqual(events.filter(event => event.type === 'finished'), [{ type: 'finished', seq: 1, part: 0 }, { type: 'finished', seq: 2, part: 1, exitCode: 0 }]);
});
