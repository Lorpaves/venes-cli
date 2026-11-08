import test from 'node:test';
import assert from 'node:assert/strict';
import { applySgr, paletteColor, plainText, runsOf, screenCells } from '../../src/screen.mjs';
import { statusLines } from '../../src/terminal.mjs';

const E = '\u001b';
const EDGE = '─'.repeat(60);
// Claude Code's box, as a screen has it, with whatever is under it.
const box = (...under) => [
  `${E}[0m⏺ Done.`,
  '',
  `${E}[0m${E}[38;2;136;136;136m${'─'.repeat(40)} venes-app ─${E}[0m`,
  `${E}[0m${E}[38;2;153;153;153m❯ ${E}[0m`,
  `${E}[0m${E}[38;2;136;136;136m${EDGE}${E}[0m`,
  ...under,
  '',
].join('\r\n');

test('Rex\'s screen: colours by number and by value, and the cursor moved along as spaces', () => {
  const screen = box(
    `${E}[2C${E}[0m${E}[38;5;141m◆${E}[1C${E}[0m${E}[1m${E}[38;5;141mOpus${E}[1C5.5${E}[0m${E}[38;2;153;153;153m ${E}[0m${E}[2m${E}[38;2;153;153;153m│${E}[0m${E}[38;2;153;153;153m ${E}[0m${E}[38;5;78m━━${E}[0m${E}[38;5;240m━━${E}[1C${E}[0m${E}[38;5;78m45%${E}[0m`,
    `${E}[2C${E}[0m${E}[38;2;255;107;128m⏵⏵${E}[1Cbypass${E}[1Cpermissions${E}[1Con${E}[0m${E}[38;2;153;153;153m (shift+tab${E}[1Cto${E}[1Ccycle)${E}[0m`,
    `${E}[98C${E}[0m${E}[38;2;255;193;7mUpdate${E}[1Cavailable!${E}[0m`,
  );
  const { lines, styled } = statusLines(screen);
  assert.deepEqual(lines, ['◆ Opus 5.5 │ ━━━━ 45%', '⏵⏵ bypass permissions on (shift+tab to cycle)', 'Update available!']);
  assert.deepEqual(styled[0], [
    { text: '◆ ', color: '#af87ff' },
    { text: 'Opus 5.5', bold: true, color: '#af87ff' },
    { text: ' ', color: '#999999' },
    { text: '│', dim: true, color: '#999999' },
    { text: ' ', color: '#999999' },
    { text: '━━', color: '#5fd787' },
    { text: '━━ ', color: '#585858' },
    { text: '45%', color: '#5fd787' },
  ]);
  assert.deepEqual(styled[1], [
    { text: '⏵⏵ bypass permissions on', color: '#ff6b80' },
    { text: ' (shift+tab to cycle)', color: '#999999' },
  ]);
  assert.deepEqual(styled.map(runs => runs.map(run => run.text).join('')), lines);
});

test('tmux\'s screen: spaces as spaces, and a look that lasts until something changes it', () => {
  const screen = box(
    `${E}[38;5;33m~/code/app${E}[39m on ${E}[1m${E}[35mmain${E}[0m ${E}[31m✗${E}[0m`,
    `${E}[90m? for shortcuts${E}[0m`,
  );
  assert.deepEqual(statusLines(screen).styled, [
    [{ text: '~/code/app', color: '#0087ff' }, { text: ' on ' }, { text: 'main', bold: true, color: '#cd00cd' }, { text: ' ' }, { text: '✗', color: '#cd0000' }],
    [{ text: '? for shortcuts', color: '#7f7f7f' }],
  ]);
});

test('a powerline look keeps its coloured spaces, its arrows and its icons', () => {
  const screen = box(
    `${E}[48;2;40;44;52m${E}[38;2;171;178;191m  Opus ${E}[0m${E}[38;2;40;44;52m${E}[48;5;31m${E}[38;5;231m  venes ${E}[0m${E}[38;5;31m${E}[0m     ${E}[7m 3 ${E}[27m`,
  );
  const { lines, styled } = statusLines(screen);
  assert.deepEqual(lines, ['  Opus   venes ', ' 3 ']);
  assert.deepEqual(styled[0], [
    { text: '  Opus ', background: '#282c34', color: '#abb2bf' },
    { text: '', color: '#282c34', background: '#0087af' },
    { text: '  venes ', color: '#ffffff', background: '#0087af' },
    { text: '', color: '#0087af' },
  ]);
  assert.deepEqual(styled[1], [{ text: ' 3 ', inverse: true }]);
});

test('lines of a status line come one by one, and a link is its text', () => {
  const screen = box(
    `${E}[32mOpus 5.5${E}[0m | ${E}]8;;https://github.com/o/r/pull/12${E}\\PR #12${E}]8;;${E}\\ | ${E}]8;;https://example.com\u0007site${E}]8;;\u0007`,
    `${E}[33mctx 45%${E}[0m · 🧠 思考中`,
    `${E}[3mitalic${E}[23m ${E}[4munder${E}[24m ${E}[9mgone${E}[29m ${E}[4:3mcurly${E}[4:0m done`,
  );
  const { lines, styled } = statusLines(screen);
  assert.deepEqual(lines, ['Opus 5.5 | PR #12 | site', 'ctx 45% · 🧠 思考中', 'italic under gone curly done']);
  assert.deepEqual(styled[2], [
    { text: 'italic', italic: true },
    { text: ' ' },
    { text: 'under', underline: true },
    { text: ' ' },
    { text: 'gone', strikethrough: true },
    { text: ' ' },
    { text: 'curly', underline: true },
    { text: ' done' },
  ]);
});

test('a status line with edges of its own is all there, as the box is found by what\'s typed in it', () => {
  const screen = box('Opus 5.5', '────────────────────', 'ctx 45%');
  assert.deepEqual(statusLines(screen).lines, ['Opus 5.5', '────────────────────', 'ctx 45%']);
});

test('nothing while a dialog covers the box, or with no box at all', () => {
  const dialog = [
    EDGE,
    ' Bash command',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
    EDGE,
    ' Esc to cancel',
  ].join('\n');
  assert.deepEqual(statusLines(dialog), { lines: [], styled: [] });
  assert.deepEqual(statusLines('just a shell\n$ '), { lines: [], styled: [] });
  assert.deepEqual(statusLines(box()), { lines: [], styled: [] });
});

test('the 256 colours are xterm\'s', () => {
  assert.deepEqual([0, 9, 15, 16, 21, 141, 196, 231, 232, 240, 255].map(paletteColor), [
    '#000000', '#ff0000', '#ffffff', '#000000', '#0000ff', '#af87ff', '#ff0000', '#ffffff', '#080808', '#585858', '#eeeeee',
  ]);
  assert.equal(paletteColor(256), undefined);
});

test('how text looks follows what each sequence sets and unsets', () => {
  assert.deepEqual(applySgr({}, '1;2;3;4;7;9'), { bold: true, dim: true, italic: true, underline: true, inverse: true, strikethrough: true });
  assert.deepEqual(applySgr({ bold: true, dim: true, italic: true, color: '#ffffff' }, '22;23'), { color: '#ffffff' });
  assert.deepEqual(applySgr({ color: '#ffffff', background: '#000000', bold: true }, ''), {});
  assert.deepEqual(applySgr({}, '38:2::1:2:3;48:5:196'), { color: '#010203', background: '#ff0000' });
  assert.deepEqual(applySgr({}, '38:2:1:2:3'), { color: '#010203' });
  assert.deepEqual(applySgr({}, '38;2;300;0;0;1'), { bold: true });
  assert.deepEqual(applySgr({}, '58;5;196;4'), { underline: true });
  assert.deepEqual(applySgr({}, '93;104'), { color: '#ffff00', background: '#5c5cff' });
  assert.deepEqual(applySgr({ color: '#ffffff', background: '#000000' }, '39;49'), {});
});

test('other sequences say nothing of how text looks, and are dropped', () => {
  const [line] = screenCells(`${E}[?25l${E}(B${E}7a${E}[Kb${E}8\u0007c`);
  assert.equal(plainText(line), 'abc');
  assert.deepEqual(runsOf(screenCells(`${E}[1ma${E}[0m${E}[1mb`)[0]), [{ text: 'ab', bold: true }]);
});
