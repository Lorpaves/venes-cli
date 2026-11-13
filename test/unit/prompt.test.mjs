import test from 'node:test';
import assert from 'node:assert/strict';
import { choicesOf, chooseRow, isAbout, readPrompt } from '../../src/prompt.mjs';

const RULE = '─'.repeat(60);
const DASHES = '╌'.repeat(60);

// As Claude Code 2.1.318 draws a Bash command's prompt in a session that can switch to auto mode.
const BASH = [
  '⏺ Bash(SP="/tmp/x" && mkdir -p "$SP")',
  '  ⎿  Waiting…',
  '',
  RULE,
  ' Bash command',
  ' Tip: auto mode handles these prompts for you — choose "switch to auto mode" below',
  ' Create scratchpad venv and install pytest',
  DASHES,
  ' │ SP="/private/tmp/claude-501/scratchpad-plan-te',
  ' │ st" && mkdir -p "$SP" && python3 -m venv "$SP/venv"',
  DASHES,
  ' This command requires approval',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to auto mode · auto mode handles these prompts for you',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend',
  '',
].join('\n');

const COMMAND = 'SP="/private/tmp/claude-501/scratchpad-plan-test" && mkdir -p "$SP" && python3 -m venv "$SP/venv"';

const EDIT = [
  RULE,
  ' Create file',
  ' notes/todo.md',
  DASHES,
  ' # Todo',
  DASHES,
  ' Do you want to create todo.md?',
  ' ❯ 1. Yes',
  '   2. Yes, allow all edits in notes/ during this session and everything',
  '      under it (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel',
].join('\n');

test('a prompt\'s rows are read in order, with notes and keys left off and wrapped rows joined', () => {
  assert.deepEqual(readPrompt(BASH).rows, [
    { number: 1, label: 'Yes', marked: true },
    { number: 2, label: 'Yes, and switch to auto mode', marked: false },
    { number: 3, label: 'No', marked: false },
  ]);
  assert.equal(readPrompt(BASH).question, 'Do you want to proceed?');
  assert.deepEqual(readPrompt(EDIT).rows.map(row => row.label), [
    'Yes', 'Yes, allow all edits in notes/ during this session and everything under it', 'No',
  ]);
});

test('what a prompt is about is what it draws under its edge, not the conversation above', () => {
  const { about } = readPrompt(BASH);
  assert.ok(about.startsWith(' Bash command'));
  assert.ok(!about.includes('Waiting'));
});

test('only a prompt at the bottom of the screen counts', () => {
  const reply = ['⏺ Do you want to know the steps?', '  1. Open it', '  2. Close it', '', '❯ ', RULE, '  ⏵⏵ accept edits on'].join('\n');
  assert.equal(readPrompt(reply), undefined);
  assert.equal(readPrompt(`${BASH}\n⏺ Done.\n\n❯ \n`), undefined, 'the prompt has gone');
  assert.equal(readPrompt(' Do you want to proceed?\n ❯ 1. Yes\n'), undefined, 'one row is no prompt');
  assert.equal(readPrompt(' Do you want to proceed?\n ❯ 1. Yes\n   3. No\n'), undefined, 'rows are numbered in order');
});

test('the rows offered are those past Yes and before No', () => {
  assert.deepEqual(choicesOf(readPrompt(BASH)), [{ number: 2, label: 'Yes, and switch to auto mode' }]);
  assert.deepEqual(choicesOf(readPrompt(BASH.replace('   2. Yes, and switch to auto mode · auto mode handles these prompts for you\n', '').replace('3. No', '2. No'))), []);
  const other = ' Do you want to proceed?\n ❯ 1. Allow\n   2. Block\n   3. Ask again\n';
  assert.deepEqual(choicesOf(readPrompt(other)), [], 'a prompt of another shape offers none');
  assert.deepEqual(choicesOf(undefined), []);
});

test('a prompt is matched to its request by what it draws of the input', () => {
  const bash = readPrompt(BASH);
  assert.ok(isAbout(bash, { command: COMMAND }), 'a command wraps and sits in a box');
  assert.ok(!isAbout(bash, { command: 'ls -la' }));
  const edit = readPrompt(EDIT);
  assert.ok(isAbout(edit, { file_path: '/w/notes/todo.md', content: '# Todo' }));
  assert.ok(!isAbout(edit, { file_path: '/w/notes/other.md' }));
  assert.ok(isAbout(edit, { query: 'anything' }), 'nothing to match by');
});

// A terminal that shows `screens` in turn, one more each time it's read after a key.
function terminal(screens) {
  const pressed = [];
  let shown = 0;
  return {
    pressed,
    read: async () => screens[Math.min(shown, screens.length - 1)],
    press: async (_, key) => { pressed.push(key); shown += 1; },
  };
}

test('a plain row is chosen by its number', async () => {
  const t = terminal([BASH, '⏺ Bash(…)\n  ⎿  Running…\n\n❯ \n']);
  await chooseRow({}, { number: 2, label: 'Yes, and switch to auto mode' }, t);
  assert.deepEqual(t.pressed, ['2']);
});

test('an input row is moved to by its number and chosen with Enter', async () => {
  const input = BASH.replace('2. Yes, and switch to auto mode · auto mode handles these prompts for you', '2. Yes, and don’t ask again for: npm run *');
  const moved = input.replace(' ❯ 1. Yes', '   1. Yes').replace('   2. Yes, and', ' ❯ 2. Yes, and');
  const screens = [input, moved, moved, '❯ \n'];
  let shown = 0;
  const pressed = [];
  const t = {
    read: async () => screens[shown],
    press: async (_, key) => { pressed.push(key); shown += 1; if (key === 'Enter') shown = 3; },
  };
  await chooseRow({}, { number: 2, label: 'Yes, and don’t ask again for: npm run *' }, { ...t, inputSettle: 0 });
  assert.deepEqual(pressed, ['2', 'Enter']);
});

test('a row no longer on the screen isn\'t pressed', async () => {
  const t = terminal(['⏺ Done.\n\n❯ \n']);
  await assert.rejects(chooseRow({}, { number: 2, label: 'Yes, and switch to auto mode' }, t), { code: 'prompt_changed' });
  const other = terminal([BASH.replace('switch to auto mode ·', 'switch to plan mode ·')]);
  await assert.rejects(chooseRow({}, { number: 2, label: 'Yes, and switch to auto mode' }, other), { code: 'prompt_changed' });
  assert.deepEqual([...t.pressed, ...other.pressed], []);
});

test('a prompt that stays after its row is pressed is reported, and Enter isn\'t pressed on another row', async () => {
  const t = terminal([BASH]);
  await assert.rejects(chooseRow({}, { number: 2, label: 'Yes, and switch to auto mode' }, { ...t, limit: 200, inputSettle: 0 }), { code: 'prompt_changed' });
  assert.deepEqual(t.pressed, ['2'], 'the mark stayed on Yes');
});
