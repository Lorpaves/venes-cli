import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTmux, startPane } from '../pane.mjs';
import { closePage, hasOpenDialog, pressPageKey, readPage, settleCommand, showsDialog, typeOnPage } from '../../src/terminal.mjs';

const FAST = { limit: 400, check: 10, requestSettle: 20, pageSettle: 60 };
const screen = (...lines) => [...lines, '────', '❯ ', '────', '  ⏸ manual mode on · ? for shortcuts', '', ''].join('\n');

test('a question about the prompt cache counts as a dialog, whichever change it\'s about', () => {
  assert.ok(showsDialog(screen('  Switch model?', '  ❯ 1. Yes, switch to Sonnet 5.5', '    2. No, go back')));
  assert.ok(showsDialog(screen('  Change effort level?', '  ❯ 1. Yes, switch to low', '    2. No, go back')));
});

test('a permission prompt still counts', () => {
  assert.ok(showsDialog(screen(' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend')));
});

test('a numbered list in a message isn\'t a dialog, though the prompt marks it the same way', () => {
  assert.ok(!showsDialog(screen('❯ 1. Fix the header', '  2. Then the footer', '⏺ Done.')));
  assert.ok(!showsDialog(screen('❯ 1. Yes', '  2. No')));
});

test('every page Claude Code opens counts, however its footer ends', () => {
  for (const footer of [
    'Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear', 'Enter/Space to change · / to search · Esc to close',
    '↑/↓ to navigate · Enter to confirm · Esc to cancel', '←/→ to adjust · Enter to apply · Esc to cancel', 'Esc to dismiss', 'Esc to cancel',
  ]) assert.ok(showsDialog(screen('  Some page', footer)), footer);
});

test('a turn in progress isn\'t a dialog', () => {
  assert.ok(!showsDialog(['⏺ Working', '────', '❯ ', '────', '  ⏸ manual mode on · esc to interrupt'].join('\n')));
});

test('what has scrolled well up the screen no longer counts', () => {
  assert.ok(!showsDialog(screen('  ❯ 1. Yes, switch to low', ...Array(20).fill('⏺ more words'))));
});

// Shows each screen in turn, moving on at each Esc, and writes down every key.
const PANE = `
const fs = require('node:fs');
const [log, screens] = [process.argv[2], JSON.parse(process.argv[3])];
let index = 0;
const show = () => process.stdout.write('\\x1b[2J\\x1b[H' + screens[index] + '\\n');
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  fs.appendFileSync(log, data.toString('hex'));
  if (data[0] === 0x1b && index < screens.length - 1) { index += 1; show(); }
});
show();
fs.writeFileSync(log + '.ready', '');
`;

const paneShowing = (t, ...screens) => startPane(t, PANE, screens);
const ENTER = '0d';
const ESC = '1b';
const nothingOpen = () => undefined;

test('the question about the cache is answered for the reader who asked', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, '  ❯ 1. Yes, switch to low');
  await settleCommand(session, nothingOpen, FAST);
  assert.equal(await keys(), ENTER);
});

test('a command that leaves the screen alone gets no key', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Set effort level to low');
  await settleCommand(session, nothingOpen, FAST);
  assert.equal(await keys(), '');
});

test('a page is closed, and the reader told that it needs the terminal', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Plan usage\nEsc to cancel', 'plain');
  await assert.rejects(settleCommand(session, nothingOpen, FAST), { code: 'terminal_only' });
  assert.equal(await keys(), ESC);
});

test('a page that takes two Escs gets two, and never Enter', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Type to filter · Enter/↓ to select · Esc to clear', 'Enter/Space to change · Esc to close', 'plain');
  await assert.rejects(settleCommand(session, nothingOpen, FAST), { code: 'terminal_only' });
  assert.equal(await keys(), ESC + ESC);
});

test('a sentence about Esc stops anything being typed, but nothing gets pressed because of it', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, '⏺ Press Esc to cancel it, or Esc to close the page.');
  assert.ok(await hasOpenDialog(session));
  await settleCommand(session, nothingOpen, FAST);
  assert.equal(await keys(), '');
});

test('a command that takes its pane with it has finished, not failed', { skip: !hasTmux }, async t => {
  const { session } = await paneShowing(t, 'plain');
  await settleCommand({ ...session, pane: '%99' }, nothingOpen, FAST);
});

test('with nothing open, closing presses nothing, because Esc would interrupt the turn', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'plain');
  await closePage(session, 20);
  assert.equal(await keys(), '');
});

test('a page that won\'t close isn\'t pressed for ever', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Esc to cancel');
  await assert.rejects(settleCommand(session, nothingOpen, FAST), { code: 'terminal_only' });
  assert.equal(await keys(), ESC + ESC + ESC);
});

test('a prompt with a request behind it belongs to whoever answers that', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, ' Do you want to proceed?\n ❯ 1. Yes\n Esc to cancel');
  await settleCommand(session, () => ({ id: 'r1' }), FAST);
  assert.equal(await keys(), '');
});

test('so does one whose request lands just after it shows', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, ' Do you want to proceed?\n ❯ 1. Yes\n Esc to cancel');
  const opened = Date.now();
  await settleCommand(session, () => (Date.now() - opened > 150 ? { id: 'r1' } : undefined), { ...FAST, requestSettle: 400 });
  assert.equal(await keys(), '');
});

test('a question with a request open as well waits, since Enter could answer the wrong one', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, '  ❯ 1. Yes, switch to low');
  await settleCommand(session, () => ({ id: 'r1' }), FAST);
  assert.equal(await keys(), '');
});

test('the question shows as an open dialog on a real screen', { skip: !hasTmux }, async t => {
  const { session } = await paneShowing(t, '  ❯ 1. Yes, switch to Sonnet 5.5');
  assert.ok(await hasOpenDialog(session));
});

test('a page a reader can see from afar is left open for them, and they\'re told', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Manage MCP servers\n↑/↓ to navigate · Enter to confirm · Esc to cancel', 'plain');
  assert.equal(await settleCommand(session, nothingOpen, { ...FAST, keepPage: true }), 'page');
  assert.equal(await keys(), '');
});

test('a page\'s keys reach it, and only the keys a page takes', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'Manage MCP servers\n↑/↓ to navigate · Enter to confirm · Esc to cancel');
  for (const key of ['Down', 'Up', 'Tab', 'Space', 'Enter']) await pressPageKey(session, key);
  await assert.rejects(pressPageKey(session, 'C-c'), { code: 'bad_key' });
  await typeOnPage(session, 'gi');
  assert.equal(await keys(), `1b5b42${'1b5b41'}09200d${Buffer.from('gi').toString('hex')}`);
});

test('with nothing open, no key and no text gets there, as Esc would interrupt the turn and Enter send', { skip: !hasTmux }, async t => {
  const { session, keys } = await paneShowing(t, 'plain');
  await assert.rejects(pressPageKey(session, 'Escape'), { code: 'no_page' });
  await assert.rejects(typeOnPage(session, 'hi'), { code: 'no_page' });
  assert.equal(await keys(), '');
  assert.equal(await readPage(session), null);
});

test('what\'s open is read with its colours, from under the edge it opened under', { skip: !hasTmux }, async t => {
  const E = '\x1b';
  const { session } = await paneShowing(t, [
    '⏺ Done.', '─'.repeat(40), `  ${E}[1mManage MCP servers${E}[0m`, `  ${E}[38;5;153m❯ ✔ docs${E}[0m   8 tools`, '    ◯ computer-use', '',
    `  ${E}[2m↑/↓ to navigate · Enter to confirm · Esc to cancel${E}[0m`,
  ].join('\n'));
  const { lines } = await readPage(session);
  assert.deepEqual(lines.map(runs => runs.map(run => run.text).join('')), [
    '  Manage MCP servers', '  ❯ ✔ docs   8 tools', '    ◯ computer-use', '', '  ↑/↓ to navigate · Enter to confirm · Esc to cancel',
  ]);
  assert.ok(lines[0].some(run => run.bold && run.text === 'Manage MCP servers'));
  assert.ok(lines[1].some(run => run.color === '#afd7ff' && run.text.includes('docs')));
});

