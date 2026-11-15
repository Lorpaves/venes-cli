import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyBox, typedIn } from '../../src/terminal.mjs';

// The foot of Claude Code's screen as tmux gave it with its colours (2.1.323): the box between its two
// edges, and the line under it.
const ESC = '\x1b';
const EDGE = `${ESC}[38;5;244m${'─'.repeat(120)}`;
const UNDER = `${ESC}[39m  ${ESC}[38;5;220m⏵⏵ auto mode on${ESC}[38;5;246m (shift+tab to cycle)${ESC}[39m`;
const screen = (...box) => [`${ESC}[38;5;246m⏺ Done.${ESC}[39m`, '', EDGE, ...box, EDGE, UNDER, ''].join('\n');
const DRAFT = screen(`${ESC}[39m❯ mac draft one`, '  mac draft two');
const EMPTY = screen(`${ESC}[39m❯ `);
const SUGGESTED = screen(`${ESC}[39m❯ ${ESC}[2mTry "fix lint errors"${ESC}[0m`);
const DIALOG = [`${ESC}[39m⏺ Bash(ls)`, EDGE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n');

test('what\'s typed in Claude Code\'s box is read without its mark, and without what an empty box suggests', () => {
  assert.equal(typedIn(DRAFT), 'mac draft one\nmac draft two');
  assert.equal(typedIn(screen(`${ESC}[39m❯ [Image #1] look`)), '[Image #1] look');
  assert.deepEqual([typedIn(EMPTY), typedIn(SUGGESTED)], ['', '']);
  // A screen with no box to read, as with a dialog open or nothing of Claude Code's on it, says nothing.
  assert.deepEqual([typedIn(DIALOG), typedIn('zsh: command not found\n$ '), typedIn('')], [undefined, undefined, undefined]);
  // The box is the last two edges': an edge further up, as over what a command opened earlier, isn't its top.
  assert.equal(typedIn([EDGE, ' Plan usage', DRAFT].join('\n')), 'mac draft one\nmac draft two');
});

test('the box is emptied with its own keys, a few times over, until nothing\'s typed in it', async () => {
  // Three lines, which a run of the keys takes one at a time.
  const lines = ['one', 'two', 'three'];
  const keys = [];
  const press = async (_, key) => {
    keys.push(key);
    if (key === 'C-u' && keys.filter(pressed => pressed === 'C-u').length % 6 === 0) lines.pop();
  };
  const read = async () => lines.join('\n');
  assert.equal(await emptyBox({}, read, { press, settle: 1 }), true);
  assert.deepEqual([lines, keys.length, [...new Set(keys)], keys.slice(0, 12).join(' ')], [[], 36, ['C-k', 'C-u'], `${'C-k '.repeat(6)}${'C-u '.repeat(6)}`.trim()]);

  // An empty box, and one that can't be read, are left alone.
  for (const typed of ['', undefined]) {
    const pressed = [];
    assert.equal(await emptyBox({}, async () => typed, { press: async (_, key) => { pressed.push(key); }, settle: 1 }), true);
    assert.deepEqual(pressed, []);
  }
  // One the keys do nothing to is said to be still full, once they've been tried enough.
  let tries = 0;
  assert.equal(await emptyBox({}, async () => 'stuck', { press: async () => { tries += 1; }, settle: 1 }), false);
  assert.equal(tries, 12 * 12);
});
