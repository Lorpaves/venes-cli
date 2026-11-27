import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asksTrust, boxOf, hasTrustPicked, hasTyped, isIdle, isUp, modeNamed, readBar, readMode, readPlan, readPrompt, readReview, questionOf, asksWriteIn, reviewsWaiting, showsDialog, showsPage,
  showsStatusLine, withoutBar,
} from '../../src/agyscreen.mjs';
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

test('a document that waits to be looked over is a line over the box, and is answered in a panel of its own', () => {
  // As the terminal drew them after a turn in plan mode, and with /artifact opened (1.5.8).
  const hint = count => ['  I have created the plan for your review.', `${' '.repeat(80)}${count} artifact${count === 1 ? '' : 's'} · /artifact to review`, RULE, '>', RULE,
    bar('? for shortcuts', 'plan · Gemini 4 Hydrogen · medium')].join('\n');
  const panel = left => [RULE, '>', RULE, `Action required (${left} left)`, '› □ new implementation_plan.md   open  approve reject', '    │ 1. Open `note.txt`.', '    │ 2. Append a line.',
    'Keyboard: ↑/↓ Navigate  y/n Approve/reject  shift+a Approve all  p Preview  ctrl+g open in editor  esc Done', bar('', 'plan · Gemini 4 Hydrogen · medium')].join('\n');
  assert.deepEqual([reviewsWaiting(hint(1)), reviewsWaiting(hint(3)), reviewsWaiting(IDLE), reviewsWaiting(WORKING), reviewsWaiting(''), reviewsWaiting(undefined)], [1, 3, 0, 0, 0, 0]);
  // The line is there while it waits for a message, and the session is still up and at rest.
  assert.deepEqual([isIdle(hint(1)), isUp(hint(1)), readBar(hint(1)).mode, readPrompt(hint(1))], [true, true, 'plan', undefined]);
  // Said further up, as in what Antigravity wrote, it isn't the line.
  assert.equal(reviewsWaiting(['1 artifact · /artifact to review', ...Array.from({ length: 14 }, () => 'more'), RULE, '>', RULE, bar('? for shortcuts', 'Gemini 4 Hydrogen · xhigh')].join('\n')), 0);
  assert.deepEqual([readReview(panel(1)), readReview(panel(2)), readReview(hint(1)), readReview(IDLE), readReview(COMMAND), readReview(undefined)], [{ left: 1 }, { left: 2 }, undefined, undefined, undefined, undefined]);
  // The panel is Antigravity's own page: still up, not at rest, and no prompt with rows to press.
  assert.deepEqual([isUp(panel(1)), isIdle(panel(1)), readPrompt(panel(1))], [true, false, undefined]);
});

test('what\'s typed in its box is told from the line an empty box shows by the bar', () => {
  // As the terminal drew them (1.5.8): a draft, one of two lines, an empty box after a turn, and a new session's.
  const typed = (...box) => ['  ok', RULE, ...box, RULE, bar('', 'auto · Gemini 4 Hydrogen · medium')].join('\n');
  const fresh = ['  ▄▀▀      ▀▀▄', RULE, '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)', RULE, bar('? for shortcuts', 'auto · Gemini 4 Hydrogen · medium')].join('\n');
  assert.deepEqual([boxOf(typed('> draft at the mac')), boxOf(typed('> agy line one', '  agy line two')), boxOf(IDLE), boxOf(fresh)],
    ['draft at the mac', 'agy line one\nagy line two', '', 'Auto mode: edits & safe commands auto-approved (shift+tab to cycle)']);
  assert.deepEqual([hasTyped(typed('> draft at the mac')), hasTyped(typed('> agy line one', '  agy line two')), hasTyped(IDLE), hasTyped(IDLE_AUTO), hasTyped(fresh), hasTyped(WORKING)],
    [true, true, false, false, false, false]);
  // With the bar saying nothing and the box empty, as for a moment after a key, nothing's typed. Nor on a screen with no box.
  assert.deepEqual([hasTyped(typed('>')), hasTyped(COMMAND), hasTyped(''), boxOf(COMMAND), boxOf('$ ls')], [false, false, false, undefined, undefined]);
});

// As Antigravity 1.5.8 draws them: the list /model opens, and the list of commands that opens as one is typed.
const MODEL_PAGE = [
  RULE, '>', RULE, 'Switch Model', '  Search:', '          ────────────────────', '  Gemini 4 Argon', '  Gemini 4 Hydrogen',
  '> Orchestrator (Argon)  (current)', '  Gemini 3.8 Flash', 'Keyboard: ↑/↓ Navigate  enter Select  esc Go Back', bar('', 'auto · Orchestrator (Argon)'),
].join('\n');
const COMMANDS_LIST = [
  RULE, '> /', RULE, '> /add-dir             Add a directory to the workspace', '  /agents              List available custom agents',
  '   ↓ 45 more', '  ↑/↓ Navigate · enter Select · tab Complete', bar('esc to cancel', 'auto · Orchestrator (Argon)'),
].join('\n');

test('a page a command opened is a list to move in, and neither a prompt nor the question about a folder', () => {
  const prompt = [
    'Command', RULE, 'Requesting permission for:', '   echo three', 'Run this command?', '> 1. Yes, run command', '  2. No, cancel',
    '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', bar('esc to cancel', 'Gemini 4 Hydrogen · xhigh'),
  ].join('\n');
  const idle = ['> ', RULE, bar('? for shortcuts', 'Gemini 4 Hydrogen · xhigh')].join('\n');
  assert.deepEqual([MODEL_PAGE, COMMANDS_LIST, prompt, idle].map(showsPage), [true, true, false, false]);
  assert.equal(showsPage(['Do you trust the contents of this project?', '', '> Yes, I trust this folder', '  No, exit', '  ↑/↓ Navigate · enter Confirm', bar('', 'x')].join('\n')), false);
  // Either is something open, which a message mustn't be typed into: the page's line starts "Keyboard:".
  assert.deepEqual([MODEL_PAGE, COMMANDS_LIST, prompt, idle].map(showsDialog), [true, true, true, false]);
});

// What the model asks the reader, as Antigravity 1.5.8 draws it: with a question mark or without, then with the
// row that opens a line to write on chosen.
const asking = (question, rows = ['> 1. Small', '  2. Medium', '  3. Large', '  4. Write-in...'], foot = '  ↑/↓ Navigate · enter Select · esc Skip') => [
  '? Pick a size', 'Question', RULE, ...question, ...rows, foot, bar('esc to cancel', 'auto · Orchestrator (Argon)'),
].join('\n');

test('the model\'s question to the reader is read as a question, with its rows and the one to write in', () => {
  const read = questionOf(readPrompt(asking(['Question 1/1: Pick a size'])));
  assert.deepEqual([read.text, read.index, read.count], ['Pick a size', 1, 1]);
  assert.deepEqual(read.rows.map(row => [row.number, row.label, row.marked]), [[1, 'Small', true], [2, 'Medium', false], [3, 'Large', false]]);
  assert.deepEqual([read.writeIn.number, read.writeIn.label], [4, 'Write-in...']);
  // One of several, asked over two lines, with nothing to write in.
  const long = questionOf(readPrompt(asking(['Question 2/3: Which of these colours would you', 'rather have?'], ['  1. Red', '> 2. Green'])));
  assert.deepEqual([long.text, long.index, long.count, long.rows.length, long.writeIn], ['Which of these colours would you rather have?', 2, 3, 2, undefined]);
  // A prompt that asks whether something may be done isn't one.
  const permission = ['Command', RULE, 'Requesting permission for:', '   date', 'Run this command?', '> 1. Yes, run command', '  2. No, cancel',
    '  ↑/↓ Navigate · tab Amend', bar('esc to cancel', 'x')].join('\n');
  assert.equal(questionOf(readPrompt(permission)), undefined);
  assert.equal(questionOf(undefined), undefined);
  // It's something open, which a message mustn't be typed into, and not a page of the terminal's own.
  assert.deepEqual([showsDialog(asking(['Question 1/1: Pick a size'])), showsPage(asking(['Question 1/1: Pick a size']))], [true, false]);
});

test('the line to write an answer on is told from the list it opens under', () => {
  const open = asking(['Question 1/1: Pick a size'], ['  1. Small', '  2. Medium', '  3. Large', '> 4. Write-in...', '  Your answer:'], '  enter Submit · esc Back');
  assert.deepEqual([asksWriteIn(open), asksWriteIn(asking(['Question 1/1: Pick a size']))], [true, false]);
});

// The lines it greets with, as 1.5.12 drew them.
const GREETING = [
  '      ▄▀▀▄        Antigravity CLI 1.5.12', '     ▀▀▀▀▀▀       someone@example.com (Google AI Pro)', '    ▀▀▀▀▀▀▀▀      Gemini 4 Hydrogen (XHigh)',
  '   ▄▀▀    ▀▀▄     ~/w',
];

test('the plan is read beside the account on the lines it greets with, and nowhere else', () => {
  assert.equal(readPlan([...GREETING, IDLE].join('\n')), 'Google AI Pro');
  // Words like it further down are something said in the conversation.
  assert.equal(readPlan(['  write to someone@example.com (Google AI Ultra)', IDLE].join('\n')), undefined);
  // An account with no plan beside it, and a greeting cut off at the foot of the screen.
  assert.equal(readPlan([GREETING[0], '     ▀▀▀▀▀▀       someone@example.com', IDLE].join('\n')), undefined);
  assert.equal(readPlan(GREETING[0]), undefined);
  for (const none of ['', undefined, null]) assert.equal(readPlan(none), undefined);
});

// Screens as it drew them with a status line of the reader's own set in its settings (1.5.18): the line
// is where the bar would be, on as many lines as its command prints, and what's over it is as ever.
const STATUS = '◆ Gemini 4 Neon (XHigh) │ ReaderAI ⎇ dev/1.9.0 │ ctx ━━━━━━━━ 15% 158k↑ 17k↓ │ mode auto │ cache r 153k w 0';
const TWO_LINES = ['custom line one', 'line two'];
const under = (lines, status = [STATUS]) => [...lines, ...status].join('\n');
const overBar = screen => screen.trimEnd().split('\n').slice(0, -1);
const NOTICED = '> Auto mode: edits & safe commands auto-approved (shift+tab to cycle)';
const S_IDLE = ['  ok', '', RULE, '>', RULE];
const S_FRESH = ['  ▄▀▀      ▀▀▄', '', ' ┃ esc to dismiss', RULE, NOTICED, RULE];
const S_TYPING = ['  ok', RULE, '> abc def', RULE];
// The steps it's going through are listed under the line it writes while it works.
const S_WORKING = [
  '● Ran (mkdir -p /tmp/out) (ctrl+o to expand)', '⣾  2/5 steps · Constructing an interactive preview suite... 3m 0s', '  ⎿  ✓ Analyze the current design', '     ✓ Research references',
  '     ● Build prototypes in a temp folder', '     ○ Render and inspect all variants', '     ○ Document the rationale', RULE, '>', RULE,
];
const S_WRITING = ['▸ Thought for 17s', '', '  Here is what I', '⡿  ✓ 5/5 steps · Generating...', RULE, '>', RULE];
const S_PAGE = [
  '> Gemini 4 Neon         (current)', '  Gemini 4 Carbon', '', '  Effort  ◂      ●━━━━━━━━━━●━━━━━━━━━━◉      ▸', '',
  'Keyboard: ↑/↓ Navigate  ←/→ Effort  enter Select  esc Go Back', '',
];

test('under a status line of the reader\'s own, the screen says what the bar would: that it waits, what\'s open, what it asks', () => {
  for (const status of [[STATUS], TWO_LINES, []]) {
    const shown = lines => under(lines, status);
    assert.deepEqual([S_IDLE, S_FRESH, S_TYPING, S_WORKING, S_WRITING, S_PAGE].map(lines => [showsStatusLine(shown(lines)), readBar(shown(lines))]), Array.from({ length: 6 }, () => [true, undefined]), status.join('|'));
    // It waits while its box is there with nothing at work over it, whatever the box says.
    assert.deepEqual([S_IDLE, S_FRESH, S_TYPING].map(lines => isIdle(shown(lines))), [true, true, true]);
    assert.deepEqual([S_WORKING, S_WRITING, S_PAGE, overBar(COMMAND), overBar(MENU), overBar(TRUST)].map(lines => isIdle(shown(lines))), [false, false, false, false, false, false]);
    assert.deepEqual([S_IDLE, S_FRESH, S_TYPING, S_WORKING, S_PAGE, overBar(COMMAND), overBar(MENU), overBar(TRUST)].map(lines => isUp(shown(lines))), Array.from({ length: 8 }, () => true));
    // A prompt is read as it is over the bar, by the line its rows end with.
    assert.deepEqual(readPrompt(shown(overBar(COMMAND))), readPrompt(COMMAND));
    assert.deepEqual(readPrompt(shown(overBar(CREATE))), readPrompt(CREATE));
    for (const none of [S_IDLE, S_FRESH, S_TYPING, S_WORKING, S_PAGE, overBar(MENU), overBar(TRUST)]) assert.equal(readPrompt(shown(none)), undefined);
    assert.deepEqual([overBar(COMMAND), overBar(MENU), overBar(TRUST), S_PAGE].map(lines => showsDialog(shown(lines))), [true, true, true, true]);
    assert.deepEqual([overBar(COMMAND), overBar(MENU), overBar(TRUST), S_PAGE, S_IDLE, S_WORKING].map(lines => showsPage(shown(lines))), [false, true, false, true, false, false]);
    assert.equal(asksTrust(shown(overBar(TRUST))), true);
    // What's typed is told from the line an empty box shows by that line's words, with no bar to say.
    assert.deepEqual([S_IDLE, S_FRESH, S_TYPING, S_WORKING].map(lines => [hasTyped(shown(lines)), boxOf(shown(lines))]), [[false, ''], [false, NOTICED.slice(2)], [true, 'abc def'], [false, '']]);
  }
  // A document that waits, and the panel it's answered in, are over it as they are over the bar.
  const hint = ['  I have written the plan.', `${' '.repeat(60)}1 artifact · /artifact to review`, RULE, '> ', RULE];
  const panel = [RULE, '>', RULE, 'Action required (1 left)', '› □ new implementation_plan.md   open  approve reject', 'Keyboard: ↑/↓ Navigate  y/n Approve/reject  shift+a Approve all  esc Done'];
  assert.deepEqual([reviewsWaiting(under(hint, TWO_LINES)), isIdle(under(hint, TWO_LINES)), readReview(under(panel)), isIdle(under(panel)), hasTyped(under(panel))], [1, true, { left: 1 }, false, false]);
  // A rule in what a shell printed isn't Antigravity's box, and neither is one with nothing of a box under it.
  for (const other of [['$ make', RULE, 'done', 'lorpaves@mac ~ % '], [RULE, 'some output', RULE, 'lorpaves@mac ~ % '], ['lorpaves@mac ~ % ']]) {
    assert.deepEqual([isUp(other.join('\n')), isIdle(other.join('\n'))], [false, false], other.join('|'));
  }
  // The line it writes while it works is found over a list of steps as long as it gets, and not in what was said long before.
  const steps = Array.from({ length: 24 }, (_, index) => `     ○ Step ${index + 1}`);
  assert.equal(isIdle(under(['⣾  1/24 steps · Working...', ...steps, RULE, '>', RULE])), false);
  assert.equal(isIdle(under(['⣾ a spinner someone printed', ...Array.from({ length: 50 }, () => '  words'), RULE, '>', RULE])), true);
});

test('the mode is named by the bar while it waits, and under a status line by the box, of the mode just switched to', () => {
  assert.deepEqual([IDLE_AUTO, IDLE, WORKING, TYPING].map(readMode), ['auto', 'default', undefined, undefined]);
  const noticed = line => under(['  ok', RULE, line, RULE]);
  assert.deepEqual([NOTICED, '> Plan mode: research & plan only (shift+tab to cycle)', '> Accept-edits mode: file edits auto-approved (shift+tab to cycle)'].map(line => readMode(noticed(line))), ['auto', 'plan', 'acceptEdits']);
  // An empty box says nothing either way, and neither do words typed there, or a mode by no name of its own.
  assert.deepEqual(['>', '> Auto mode: is what I want', '> Turbo mode: everything (shift+tab to cycle)'].map(line => readMode(noticed(line))), [undefined, undefined, undefined]);
  assert.equal(readMode(under(overBar(COMMAND))), undefined);
  assert.deepEqual(['auto', 'Plan', 'accept-edits', 'default', 'turbo', undefined].map(modeNamed), ['auto', 'plan', 'acceptEdits', 'default', undefined, undefined]);
});

test('a screen is given without what\'s under everything, its own bar or the reader\'s status line', () => {
  assert.equal(withoutBar(MENU), overBar(MENU).join('\n'));
  assert.equal(withoutBar(under(overBar(MENU), TWO_LINES)), overBar(MENU).join('\n'));
  assert.equal(withoutBar(under(S_PAGE)), S_PAGE.slice(0, -1).join('\n'));
  // With the escape sequences that colour it, the lines are known by their words.
  const dim = line => `\x1b[2m${line}\x1b[0m`;
  assert.equal(withoutBar(under(overBar(MENU).map(dim), TWO_LINES.map(dim))), overBar(MENU).map(dim).join('\n'));
  assert.equal(withoutBar([...overBar(MENU).map(dim), dim(MENU.trimEnd().split('\n').at(-1))].join('\n')), overBar(MENU).map(dim).join('\n'));
  assert.deepEqual([withoutBar('one line'), withoutBar('')], ['one line', '']);
});
