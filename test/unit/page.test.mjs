import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOf } from '../../src/terminal.mjs';

const E = '\u001b';
const EDGE = '─'.repeat(60);
const text = page => page.lines.map(runs => runs.map(run => run.text).join(''));

test('nothing is open while the box is there to type in', () => {
  assert.equal(pageOf(['⏺ Done.', EDGE, '❯ ', EDGE, '  ⏸ manual mode on · ? for shortcuts', '', ''].join('\n')), null);
});

test('a page is what\'s under the last edge, with the colours it\'s shown in and no spaces at the ends of its lines', () => {
  const page = pageOf([
    '❯ /config', '', EDGE,
    `  ${E}[7m Settings ${E}[27m  Status   Config   `,
    '',
    '  ╭──────────────────╮',
    '  │ ⌕ Search settings… │',
    '  ╰──────────────────╯',
    '',
    `  ${E}[38;5;246m❯${E}[39m Auto-compact          true    `,
    '    Show tips             true',
    '    ↓ 23 more',
    '',
    '  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear',
    '', '',
  ].join('\n'));
  assert.deepEqual(text(page), [
    '   Settings   Status   Config', '', '  ╭──────────────────╮', '  │ ⌕ Search settings… │', '  ╰──────────────────╯', '',
    '  ❯ Auto-compact          true', '    Show tips             true', '    ↓ 23 more', '', '  Type to filter · Enter/↓ to select · ↑ to tabs · Esc to clear',
  ]);
  assert.deepEqual(page.lines[0][1], { text: ' Settings ', inverse: true });
  assert.deepEqual(page.lines[6][1], { text: '❯', color: '#949494' });
});

test('a dialog with no edge above it is the whole screen\'s bottom', () => {
  const page = pageOf([' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel'].join('\n'));
  assert.deepEqual(text(page), [' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']);
});
