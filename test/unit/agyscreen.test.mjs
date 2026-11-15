import test from 'node:test';
import assert from 'node:assert/strict';
import { asksTrust, hasTrustPicked, isIdle, isUp, readBar, readPrompt, showsDialog } from '../../src/agyscreen.mjs';
import { choicesOf } from '../../src/prompt.mjs';

// Screens as Antigravity's terminal drew them (1.5.8), 110 columns across.
const RULE = '─'.repeat(110);
const bar = (hint, settings) => `${hint}${' '.repeat(110 - hint.length - settings.length)}${settings}`;
const IDLE_AUTO = ['  HERON', RULE, '>', RULE, bar('? for shortcuts', 'auto · Gemini 4 Hydrogen · xhigh')].join('\n');
const IDLE = ['  ok', RULE, '>', RULE, bar('? for shortcuts', 'Gemini 4 Hydrogen · xhigh')].join('\n');
const WORKING = ['⣾  Generating...', RULE, '>', RULE, bar('esc to cancel', 'Gemini 4 Hydrogen · xhigh')].join('\n');
const TYPING = ['> /effort xhigh', RULE, bar('', 'Gemini 4 Hydrogen · high')].join('\n');
const COMMAND = [
  '● Ran (echo three) (ctrl+o to expand)', 'Command', RULE, '', 'Requesting permission for:', '   echo three', '', 'Run this command?', '> 1. Yes, run command',
  '  2. Yes, and always allow in this conversation for commands that start with \'echo\'',
  '  3. Yes, and always allow for commands that start with \'echo\' (Persist to settings.json)', '  4. No, cancel', '',
  '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', bar('esc to cancel', 'Gemini 4 Hydrogen · xhigh'), '', '', '', '',
].join('\n');
const CREATE = [
  '● Edited 1 file (a.txt) (ctrl+o to expand)', 'Create file', RULE, '/w/a.txt', '  1  +  one', 'Allow creation of this file?', '> 1. Yes, allow creation',
  '  2. No, deny creation', '  ↑/↓ Navigate · f full diff', bar('esc to cancel', 'Gemini 4 Hydrogen · xhigh'),
].join('\n');
const MENU = [
  RULE, '> /mo', RULE, '> /model               Set a model, or run a single prompt on another model', '  /remote-control      Turn on remote control',
  '  ↑/↓ Navigate · enter Select · tab Complete', bar('esc to cancel', 'Gemini 4 Hydrogen · xhigh'),
].join('\n');
const TRUST = [
  'Accessing workspace:', '', '/w/project', '', 'Do you trust the contents of this project?', '', 'Antigravity CLI requires permission to read, edit, and execute files here.', '',
  '> Yes, I trust this folder', '  No, exit', '', '  ↑/↓ Navigate · enter Confirm', bar('', 'auto · Gemini 4 Hydrogen · xhigh'), '', '',
].join('\n');

test('the bar says whether it waits, its mode, and what it runs on', () => {
  assert.deepEqual(readBar(IDLE_AUTO), { hint: 'idle', mode: 'auto', model: 'Gemini 4 Hydrogen', effort: 'xhigh' });
  assert.deepEqual(readBar(IDLE), { hint: 'idle', mode: 'default', model: 'Gemini 4 Hydrogen', effort: 'xhigh' });
  assert.deepEqual(readBar(WORKING), { hint: 'busy', mode: 'default', model: 'Gemini 4 Hydrogen', effort: 'xhigh' });
  assert.deepEqual(readBar(TYPING), { hint: undefined, mode: 'default', model: 'Gemini 4 Hydrogen', effort: 'high' });
  assert.deepEqual(readBar(`${RULE}\n${bar('? for shortcuts', 'accept-edits · Gemini 4 Hydrogen · xhigh')}`).mode, 'acceptEdits');
  assert.deepEqual(readBar(`${RULE}\n${bar('? for shortcuts', 'plan · Orchestrator (Argon)')}`), { hint: 'idle', mode: 'plan', model: 'Orchestrator (Argon)', effort: undefined });
  for (const other of ['lorpaves@mac ~ % ', '', 'some · words · here', '? for shortcuts']) assert.equal(readBar(other), undefined, other);
});

test('a prompt is its question, what it\'s about, and its rows', () => {
  const command = readPrompt(COMMAND);
  assert.deepEqual([command.question, command.about], ['Run this command?', 'Requesting permission for:\n   echo three']);
  assert.deepEqual(command.rows.map(row => [row.number, row.marked]), [[1, true], [2, false], [3, false], [4, false]]);
  assert.deepEqual(choicesOf(command).map(row => row.number), [2, 3]);
  assert.equal(command.rows[2].label, 'Yes, and always allow for commands that start with \'echo\' (Persist to settings.json)');
  const create = readPrompt(CREATE);
  assert.deepEqual([create.question, create.about, create.rows.map(row => row.label)], ['Allow creation of this file?', '/w/a.txt\n  1  +  one', ['Yes, allow creation', 'No, deny creation']]);
  assert.deepEqual(choicesOf(create), []);
  // A row too long for its line goes on to the next.
  const wrapped = COMMAND.replace('commands that start with \'echo\' (Persist', 'commands that start with\n     \'echo\' (Persist');
  assert.equal(readPrompt(wrapped).rows[2].label, 'Yes, and always allow for commands that start with \'echo\' (Persist to settings.json)');
  // Drawn close, it reads the same.
  assert.deepEqual(readPrompt(COMMAND.split('\n').filter(line => line.trim()).join('\n')), command);
  for (const none of [IDLE, WORKING, MENU, TRUST, TYPING, '']) assert.equal(readPrompt(none), undefined);
});

test('what\'s open, what waits, and what isn\'t Antigravity at all', () => {
  assert.deepEqual([COMMAND, CREATE, MENU, TRUST].map(showsDialog), [true, true, true, true]);
  assert.deepEqual([IDLE, IDLE_AUTO, WORKING, TYPING].map(showsDialog), [false, false, false, false]);
  assert.deepEqual([IDLE, IDLE_AUTO].map(isIdle), [true, true]);
  assert.deepEqual([WORKING, COMMAND, MENU, TYPING, TRUST, 'lorpaves@mac ~ % '].map(isIdle), [false, false, false, false, false, false]);
  // Its last words can be on the screen above the box while it works again.
  assert.equal(isIdle(['⣾  Generating...', RULE, '>', RULE, bar('? for shortcuts', 'Gemini 4 Hydrogen · xhigh')].join('\n')), false);
  assert.deepEqual([IDLE, WORKING, COMMAND, MENU, TRUST, TYPING].map(isUp), [true, true, true, true, true, true]);
  assert.deepEqual(['lorpaves@mac ~ % ', '', 'zsh: command not found: agy'].map(isUp), [false, false, false]);
  assert.deepEqual([asksTrust(TRUST), hasTrustPicked(TRUST), hasTrustPicked(TRUST.replace('> Yes', '  Yes').replace('  No', '> No')), asksTrust(IDLE)], [true, true, false, false]);
});
