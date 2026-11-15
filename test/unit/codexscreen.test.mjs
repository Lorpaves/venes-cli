import test from 'node:test';
import assert from 'node:assert/strict';
import { readPlanQuestion } from '../../src/codexscreen.mjs';

// The foot of Codex's terminal as it drew it after a turn that ended on a plan (0.169.0).
const QUESTION = [
  '• Proposed Plan',
  '',
  '  1. Add print("Hello again!") after the existing print statement in hi.py.',
  '',
  '  Worked for 10s • 15:16',
  '',
  '  Implement this plan?',
  '',
  '› 1. Yes, implement this plan          Switch to Default and start coding',
  '  2. Yes, clear context and implement  Start a fresh thread (current context: 5% used)',
  '  3. No, stay in Plan mode             Continue planning with the model',
  '',
  '  enter select · esc back',
  '',
].join('\n');
const WAITING = ['■ Conversation interrupted - use /feedback if something went wrong', '', '› Ask Codex to do anything', '', '  ws-plan · GPT-6-Astra xhigh Fast · Context 5% used', '  ← for agents · ? for shortcuts'].join('\n');

test('the question Codex\'s terminal asks about a plan is read with its rows, and the one that changes nothing', () => {
  const asked = readPlanQuestion(QUESTION);
  assert.deepEqual(asked.rows.map(row => [row.number, row.marked, row.label.split(/\s{2,}/)[0]]),
    [[1, true, 'Yes, implement this plan'], [2, false, 'Yes, clear context and implement'], [3, false, 'No, stay in Plan mode']]);
  assert.equal(asked.stay, 3);
  // Wherever that row is, it's known by its words, and a question without it has no row to press.
  const moved = QUESTION.replace('  3. No, stay in Plan mode ', '  2. No, stay in Plan mode ').replace('  2. Yes, clear context and implement', '  3. Yes, clear context and implement');
  assert.equal(readPlanQuestion(moved).stay, 2);
  assert.equal(readPlanQuestion(QUESTION.replace('No, stay in Plan mode', 'No, something else  ')).stay, undefined);
});

test('nothing else on the screen is taken for the question', () => {
  // The terminal waiting for a message, the same words in what Codex wrote, a list that isn't the question's,
  // the question with something typed under it, and no screen.
  for (const screen of [
    WAITING, `• You asked: Implement this plan?\n\n${WAITING}`, QUESTION.replace('  Implement this plan?', '  Pick a model'),
    `${QUESTION}\n› typed since`, QUESTION.replace('  enter select · esc back', ''), '', undefined,
  ]) assert.equal(readPlanQuestion(screen), undefined, JSON.stringify(screen)?.slice(0, 80));
  // Far up the screen, it's been answered and scrolled away.
  assert.equal(readPlanQuestion(`${QUESTION}\n${Array.from({ length: 14 }, (_, index) => `line ${index}`).join('\n')}`), undefined);
});
