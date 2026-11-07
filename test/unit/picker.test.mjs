import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTmux, startPane } from '../pane.mjs';
import { readPicker, switchInPicker } from '../../src/picker.mjs';

// As Claude Code 2.1.318 draws it.
const PICKER = `
 ▐▛███▛█   Claude Code v2.1.318
▝▜██████▀  Haiku 5.5 · Claude Ultra

❯ Reply with only the word READY.

⏺ READY

❯ /model

──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  Select model
  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model
  names, specify with --model.

    1.  Default (recommended)  Sonnet 5.5 · Efficient for routine tasks
    2.  Opus 5.5               For complex work and everyday tasks
    3.  Fable 5.1              For your toughest challenges
    4.  Sonnet 5.5             Most efficient for simpler tasks
  ❯ 5.  Haiku 5.5 ✔            Fastest for quick answers
    6.  Haiku 4.5              Fastest for quick answers
    7.  Sonnet 5               Efficient for routine tasks
    8.  Opus 5                 Best for everyday, complex tasks
    9.  Fable 5                Most capable for your hardest and longest-running tasks
  ↓ 10. Opus 4.8               Best for everyday, complex tasks
     … +3 models

  ◐ Medium effort (default) ←/→ to adjust

  Enter to set as default · s to use this session only · Esc to cancel
`;

test('the picker is read as Claude Code draws it', () => {
  const { number, text, effort } = readPicker(PICKER);
  assert.equal(number, 5);
  assert.match(text, /^Haiku 5\.5 ✔ +Fastest/);
  assert.equal(effort, 'medium');
});

test('a numbered message further up isn\'t the highlight', () => {
  assert.equal(readPicker(PICKER.replace('❯ Reply with only the word READY.', '❯ 1. Fix the header')).number, 5);
});

test('each level reads as itself', () => {
  for (const [line, effort] of [['○ Low effort', 'low'], ['● High effort', 'high'], ['◉ xHigh effort', 'xhigh'], ['◈ Max effort', 'max']]) {
    assert.equal(readPicker(PICKER.replace('◐ Medium effort (default)', line)).effort, effort, line);
  }
});

test('a model with no effort setting has no level', () => {
  assert.equal(readPicker(PICKER.replace('◐ Medium effort (default) ←/→ to adjust', '○ Effort not supported for Haiku 4.5')).effort, undefined);
});

test('the footer can wrap in a narrow pane', () => {
  assert.equal(readPicker(PICKER.replace('s to use this session only · Esc to cancel', 's to use this\n  session only · Esc to cancel')).number, 5);
});

test('a screen with no picker on it has none', () => {
  assert.equal(readPicker('❯ \n  ⏸ manual mode on · ? for shortcuts   Model set to sonnet (claude-sonnet-5-5) for this session only\n'), undefined);
});

test('a picker that doesn\'t offer this session alone isn\'t one to use', () => {
  assert.equal(readPicker(PICKER.replace(' · s to use this session only', '')), undefined);
});

test('a mention of the key in a reply, far above, is no picker', () => {
  assert.equal(readPicker(`⏺ Press s to use this session only.\n${'\n⏺ more'.repeat(20)}\n❯ 1. Fix it\n`), undefined);
});

// Claude Code's picker, closely enough to be driven: it writes down each key as a name.
const FAKE = `
const fs = require('node:fs');
const [log, options] = [process.argv[2], JSON.parse(process.argv[3])];
const { rows } = options;
const LEVELS = ['Low', 'Medium', 'High', 'xHigh', 'Max'];
const NAMES = {
  '\\x1bp': 'M-p', '\\x1b[A': 'Up', '\\x1bOA': 'Up', '\\x1b[B': 'Down', '\\x1bOB': 'Down',
  '\\x1b[C': 'Right', '\\x1bOC': 'Right', '\\x1b[D': 'Left', '\\x1bOD': 'Left', '\\x1b': 'Esc', '\\r': 'Enter', s: 's',
};
let row = options.start ?? rows.findIndex(item => item.current);
let open = false;
const draw = () => {
  const lines = [];
  if (open) {
    lines.push('  Select model', '');
    rows.forEach((item, index) => lines.push((index === row ? '  ❯ ' : '    ') + (index + 1) + '.  ' + item.label + (item.current ? ' ✔' : '') + '   About it'));
    const { level } = rows[row];
    lines.push('', level === undefined ? '  ○ Effort not supported' : '  ◐ ' + LEVELS[level] + ' effort ←/→ to adjust', '');
    lines.push(options.noThisSession ? '  Enter to set as default · Esc to cancel' : '  Enter to set as default · s to use this session only · Esc to cancel');
  } else {
    lines.push('❯ ', '  ⏸ manual mode on · ? for shortcuts');
  }
  process.stdout.write('\\x1b[2J\\x1b[H' + lines.join('\\r\\n') + '\\r\\n');
};
const clamp = (value, top) => Math.min(Math.max(value, 0), top);
const act = {
  'M-p': () => { open = !options.neverOpens; },
  Up: () => { if (open) row = clamp(row - 1, rows.length - 1); },
  Down: () => { if (open && !options.stuck) row = clamp(row + 1, rows.length - 1); },
  Left: () => { if (open && rows[row].level !== undefined) rows[row].level = clamp(rows[row].level - 1, 4); },
  Right: () => { if (open && rows[row].level !== undefined) rows[row].level = clamp(rows[row].level + 1, 4); },
  s: () => { if (!options.neverCloses) open = false; },
  Esc: () => { open = false; },
  Enter: () => { open = false; },
};
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  const name = NAMES[data.toString()] ?? data.toString('hex');
  fs.appendFileSync(log, name + ' ');
  act[name]?.();
  draw();
});
draw();
fs.writeFileSync(log + '.ready', '');
`;

const ROWS = [{ label: 'Default (recommended)', level: 1 }, { label: 'Sonnet 5.5', level: 1 }, { label: 'Sonnet 5', level: 2, current: true }, { label: 'Haiku 4.5' }];
const FAST = { limit: 250, check: 10, questionLimit: 30, pageSettle: 40 };
const nothingOpen = () => undefined;
const pickerWith = (t, options = {}) => startPane(t, FAKE, { rows: ROWS, ...options });

test('a model further down is reached a row at a time, and chosen for this session', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { row: { label: 'Haiku 4.5', number: 4 } }, nothingOpen, FAST);
  assert.equal(await keys(), 'M-p Down s');
});

test('a model further up is too, and "Sonnet 5" isn\'t taken for "Sonnet 5.5"', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { row: { label: 'Sonnet 5.5', number: 2 } }, nothingOpen, FAST);
  assert.equal(await keys(), 'M-p Up s');
  const again = await pickerWith(t, { start: 1 });
  await switchInPicker(again.session, { row: { label: 'Sonnet 5', number: 3 } }, nothingOpen, FAST);
  assert.equal(await again.keys(), 'M-p Down s');
});

test('the row it\'s already on needs no moving', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { row: { label: 'Sonnet 5', number: 3 } }, nothingOpen, FAST);
  assert.equal(await keys(), 'M-p s');
});

test('effort moves a level at a time, up or down', { skip: !hasTmux }, async t => {
  const up = await pickerWith(t);
  await switchInPicker(up.session, { effort: 'max' }, nothingOpen, FAST);
  assert.equal(await up.keys(), 'M-p Right Right s');
  const down = await pickerWith(t);
  await switchInPicker(down.session, { effort: 'low' }, nothingOpen, FAST);
  assert.equal(await down.keys(), 'M-p Left Left s');
});

test('a level it\'s already at needs no moving', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { effort: 'high' }, nothingOpen, FAST);
  assert.equal(await keys(), 'M-p s');
});

test('a model and an effort go together, the effort being the new row\'s', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { row: { label: 'Sonnet 5.5', number: 2 }, effort: 'xhigh' }, nothingOpen, FAST);
  assert.equal(await keys(), 'M-p Up Right Right s');
});

test('Enter is never pressed, because that would save a default', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await switchInPicker(session, { row: { label: 'Haiku 4.5', number: 4 } }, nothingOpen, FAST);
  assert.doesNotMatch(await keys(), /Enter/);
});

test('effort alone only works on the session\'s own row, or the key would switch the model too', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t, { start: 0 });
  await assert.rejects(switchInPicker(session, { effort: 'low' }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Esc');
});

test('a row with no effort setting is given up on, with nothing changed', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await assert.rejects(switchInPicker(session, { row: { label: 'Haiku 4.5', number: 4 }, effort: 'low' }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Down Esc');
});

test('a level the row can\'t reach is given up on too', { skip: !hasTmux }, async t => {
  const stuck = FAKE.replace('rows[row].level = clamp(rows[row].level + 1, 4);', 'void 0;');
  const { session, keys } = await startPane(t, stuck, { rows: [{ label: 'Sonnet 5', level: 1, current: true }] });
  await assert.rejects(switchInPicker(session, { effort: 'high' }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Right Esc');
});

test('a row that isn\'t there is given up on', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await assert.rejects(switchInPicker(session, { row: { label: 'Opus 9', number: 4 } }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Down Esc');
});

test('a highlight that won\'t move is given up on', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t, { stuck: true });
  await assert.rejects(switchInPicker(session, { row: { label: 'Haiku 4.5', number: 4 } }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Down Esc');
});

test('a picker with no way to choose for this session is closed untouched', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t, { noThisSession: true });
  await assert.rejects(switchInPicker(session, { row: { label: 'Haiku 4.5', number: 4 } }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p Esc');
});

test('if no picker opens, no Esc follows, because it would interrupt the turn', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t, { neverOpens: true });
  await assert.rejects(switchInPicker(session, { effort: 'low' }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p');
});

test('a picker that stays open after the key is closed, and reported', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t, { neverCloses: true });
  await assert.rejects(switchInPicker(session, { effort: 'high' }, nothingOpen, FAST), { code: 'picker_failed' });
  assert.equal(await keys(), 'M-p s Esc');
});

test('a request that opens partway stops everything, and Esc would refuse it, so none is pressed', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  let asked = 0;
  const isBlocked = () => { asked += 1; return asked > 2 ? { id: 'r1' } : undefined; };
  await assert.rejects(switchInPicker(session, { row: { label: 'Default (recommended)', number: 1 } }, isBlocked, FAST), { code: 'request_pending' });
  assert.match(await keys(), /^M-p( Up)*$/);
});

test('with a request open, nothing is opened', { skip: !hasTmux }, async t => {
  const { session, keys } = await pickerWith(t);
  await assert.rejects(switchInPicker(session, { effort: 'low' }, () => ({ id: 'r1' }), FAST), { code: 'request_pending' });
  assert.equal(await keys(), '');
});
