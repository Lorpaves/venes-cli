import test from 'node:test';
import assert from 'node:assert/strict';
import { hasTmux, startPane } from '../pane.mjs';
import { readMode, switchMode } from '../../src/mode.mjs';

// The bottom of the terminal as Claude Code 2.1.323 draws it, in each mode its docs list.
const SCREEN = bar => `
❯ Reply with only the word READY.

⏺ READY

──────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ 
──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ${bar}
`;

test('the mode is read from the status bar as Claude Code words each', () => {
  for (const [bar, mode] of [
    ['⏸ manual mode on · ? for shortcuts · ← for agents                                       ◐ medium · /effort', 'default'],
    ['⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', 'acceptEdits'], ['⏸ plan mode on (shift+tab to cycle)', 'plan'],
    ['⏵⏵ auto mode on (shift+tab to cycle)', 'auto'], ['⏵⏵ don\'t ask on (shift+tab to cycle)', 'dontAsk'], ['⏵⏵ don’t ask on', 'dontAsk'],
    ['⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt', 'bypassPermissions'],
  ]) assert.equal(readMode(SCREEN(bar)), mode, bar);
});

test('a screen with no status bar on it says no mode, and words further up aren\'t one', () => {
  assert.equal(readMode(SCREEN('? for shortcuts')), undefined);
  assert.equal(readMode(''), undefined);
  assert.equal(readMode(`⏺ The bar says ⏵⏵ bypass permissions on when it's on.\n${'\n⏺ more'.repeat(20)}\n❯ \n  ? for shortcuts\n`), undefined);
  // The bar is under everything, so a reply that quotes another mode just above it doesn't count.
  assert.equal(readMode(`⏺ It was ⏸ plan mode on before.\n❯ \n  ⏵⏵ accept edits on (shift+tab to cycle)\n`), 'acceptEdits');
});

// Claude Code's status bar, closely enough to be driven: Shift+Tab goes round the modes it's given.
const FAKE = `
const fs = require('node:fs');
const [log, options] = [process.argv[2], JSON.parse(process.argv[3])];
const BARS = {
  default: '⏸ manual mode on · ? for shortcuts', acceptEdits: '⏵⏵ accept edits on (shift+tab to cycle)', plan: '⏸ plan mode on (shift+tab to cycle)',
  bypassPermissions: '⏵⏵ bypass permissions on (shift+tab to cycle)', auto: '⏵⏵ auto mode on (shift+tab to cycle)',
};
let at = options.modes.indexOf(options.start ?? options.modes[0]);
let presses = 0;
const draw = () => {
  const bar = options.hidesAfter !== undefined && presses >= options.hidesAfter ? '  ' + (options.shows ?? 'Usage · Status · Config') : '  ' + BARS[options.modes[at]];
  process.stdout.write('\\x1b[2J\\x1b[H' + ['❯ ', bar].join('\\r\\n') + '\\r\\n');
};
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  const name = data.toString() === '\\x1b[Z' ? 'BTab' : data.toString('hex');
  fs.appendFileSync(log, name + ' ');
  if (name === 'BTab') {
    presses += 1;
    if (!options.stuck) at = (at + 1) % options.modes.length;
  }
  draw();
});
draw();
fs.writeFileSync(log + '.ready', '');
`;

const FAST = { limit: 250, check: 10 };
const nothingOpen = () => undefined;
const ALL = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];

test('a mode is gone round to, and those passed on the way are told', { skip: !hasTmux }, async t => {
  const { session, keys } = await startPane(t, FAKE, { modes: ALL });
  assert.deepEqual(await switchMode(session, 'plan', nothingOpen, FAST), { mode: 'plan', passed: ['acceptEdits', 'plan'] });
  assert.equal(await keys(), 'BTab BTab');
  assert.deepEqual(await switchMode(session, 'default', nothingOpen, FAST), { mode: 'default', passed: ['bypassPermissions', 'auto', 'default'] });
  assert.equal(await keys(), 'BTab BTab BTab BTab BTab');
});

test('the mode it\'s in already takes no key', { skip: !hasTmux }, async t => {
  const { session, keys } = await startPane(t, FAKE, { modes: ALL, start: 'bypassPermissions' });
  assert.deepEqual(await switchMode(session, 'bypassPermissions', nothingOpen, FAST), { mode: 'bypassPermissions', passed: [] });
  assert.equal(await keys(), '');
});

test('a mode the session doesn\'t come round to isn\'t one it has, and it\'s left where it was', { skip: !hasTmux }, async t => {
  const { session, keys } = await startPane(t, FAKE, { modes: ['default', 'acceptEdits', 'plan'], start: 'acceptEdits' });
  await assert.rejects(switchMode(session, 'bypassPermissions', nothingOpen, FAST), { code: 'mode_unavailable' });
  assert.equal(await keys(), 'BTab BTab BTab');
  assert.deepEqual(await switchMode(session, 'acceptEdits', nothingOpen, FAST), { mode: 'acceptEdits', passed: [] });
});

test('a bar that doesn\'t change, or goes, is given up on', { skip: !hasTmux }, async t => {
  const stuck = await startPane(t, FAKE, { modes: ALL, stuck: true });
  await assert.rejects(switchMode(stuck.session, 'plan', nothingOpen, FAST), { code: 'mode_failed' });
  assert.equal(await stuck.keys(), 'BTab');
  const gone = await startPane(t, FAKE, { modes: ALL, hidesAfter: 1 });
  await assert.rejects(switchMode(gone.session, 'plan', nothingOpen, FAST), { code: 'mode_failed' });
  assert.equal(await gone.keys(), 'BTab');
  const never = await startPane(t, FAKE, { modes: ALL, hidesAfter: 0 });
  await assert.rejects(switchMode(never.session, 'plan', nothingOpen, FAST), { code: 'mode_failed' });
  assert.equal(await never.keys(), '');
  // A dialog on the screen takes the keys, so none is pressed into it.
  const asking = await startPane(t, FAKE, { modes: ALL, hidesAfter: 0, shows: 'Do you want to proceed?' });
  await assert.rejects(switchMode(asking.session, 'plan', nothingOpen, FAST), { code: 'dialog_open' });
  assert.equal(await asking.keys(), '');
});

test('nothing is pressed for a mode that\'s never gone round to, or while a request is open', { skip: !hasTmux }, async t => {
  const { session, keys } = await startPane(t, FAKE, { modes: ALL });
  for (const mode of ['dontAsk', 'custom', undefined]) await assert.rejects(switchMode(session, mode, nothingOpen, FAST), { code: 'bad_mode' });
  await assert.rejects(switchMode(session, 'plan', () => ({ id: 'r' }), FAST), error => error.code !== 'mode_failed');
  assert.equal(await keys(), '');
});
