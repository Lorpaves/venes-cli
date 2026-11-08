import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { choose, optionLines } from '../../src/choice.mjs';

const OPTIONS = [{ label: 'Rex', note: 'ready to use, nothing to download' }, { label: 'tmux, over SSH', note: 'turn on Remote Login first' }];
const plain = text => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function picker(start) {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', chunk => { shown += chunk; });
  const picked = choose({ options: OPTIONS, start, input, output });
  const press = (name, text, extra = {}) => input.emit('keypress', text, { name, ...extra });
  return { picked, press, shown: () => plain(shown) };
}

test('the option it starts on is marked, and each says what it needs in brackets', () => {
  assert.deepEqual(optionLines(OPTIONS, 0).map(plain), ['❯ Rex (ready to use, nothing to download)', '  tmux, over SSH (turn on Remote Login first)']);
  assert.deepEqual(optionLines([{ label: 'Only' }], 0).map(plain), ['❯ Only']);
});

test('Enter takes the marked option, and the arrows move the mark round', async () => {
  const { picked, press, shown } = picker(0);
  press('down');
  press('down');
  press('up');
  press('return');
  assert.equal(await picked, 1);
  assert.match(shown(), /❯ tmux, over SSH \(turn on Remote Login first\)\n$/);
});

test('a number marks that option, and Esc or Ctrl+C stops with nothing picked', async () => {
  const first = picker(0);
  first.press(undefined, '2');
  first.press('return');
  assert.equal(await first.picked, 1);
  const second = picker(1);
  second.press('escape');
  assert.equal(await second.picked, undefined);
  const third = picker(0);
  third.press('c', '\x03', { ctrl: true });
  assert.equal(await third.picked, undefined);
});
