import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkedOutBranch, statusItems } from '../../src/statusline.mjs';

// Lines of plain runs, and what's read off them, without the text each item came from.
const plain = lines => lines.map(text => [{ text }]);
const items = (lines, known) => statusItems(plain(lines), known).map(({ text, ...item }) => item);
// Nerd Fonts' icons and powerline's arrow, by code point, as a status line prints them.
const ARROW = String.fromCodePoint(0xe0b0);
const CHIP = String.fromCodePoint(0xf4bc);
const FOLDER = String.fromCodePoint(0xf07b);
const BRANCH = String.fromCodePoint(0xe725);

test('a status line with bars and dots between its parts, and meters', () => {
  assert.deepEqual(items([
    '◆ Opus 5.5 · max │ helper ⎇ main │ ctx ━━━━━━━━ 32% 316k↑ 4↓ │ 7d ━━━━━━━━ 53% ↻周四 07:00 │ cache 99%',
    '⏵⏵ bypass permissions on (shift+tab to cycle)',
    'Update available! Run: brew upgrade claude-code@latest',
  ], { cwd: '/Users/someone/Venes/helper' }), [
    { kind: 'model', value: 'Opus 5.5' },
    { kind: 'effort', value: 'max' },
    { kind: 'folder', value: 'helper' },
    { kind: 'branch', value: 'main' },
    { kind: 'context', percent: 32, input: '316k', output: '4' },
    { kind: 'sevenDay', percent: 53, resets: '周四 07:00' },
    { kind: 'cache', percent: 99 },
    { kind: 'mode', value: 'Bypass permissions' },
    { kind: 'update', value: 'brew upgrade claude-code@latest' },
  ]);
});

test('the status lines in Claude Code\'s own docs', () => {
  assert.deepEqual(items(['[Opus] 📁 my-project | 8% context']), [
    { kind: 'model', value: 'Opus' }, { kind: 'folder', value: 'my-project' }, { kind: 'context', percent: 8 },
  ]);
  assert.deepEqual(items(['[Opus] ▓▓▓░░░░░░░ 32%']), [{ kind: 'model', value: 'Opus' }, { kind: 'context', percent: 32 }]);
  assert.deepEqual(items(['[Opus] 📁 my-project | 🌿 main +2 ~1']), [
    { kind: 'model', value: 'Opus' }, { kind: 'folder', value: 'my-project' }, { kind: 'branch', value: 'main', status: '+2 ~1' },
  ]);
  assert.deepEqual(items(['[Opus] 💰 $0.01 | ⏱️ 0m 45s']), [
    { kind: 'model', value: 'Opus' }, { kind: 'cost', value: '$0.01' }, { kind: 'duration', value: '0m 45s' },
  ]);
  assert.deepEqual(items(['[Opus] 📁 my-project 🌿 main', '▓▓▓▓░░░░░░ 40% | $0.12 | ⏱️ 1m 2s']), [
    { kind: 'model', value: 'Opus' }, { kind: 'folder', value: 'my-project' }, { kind: 'branch', value: 'main' },
    { kind: 'context', percent: 40 }, { kind: 'cost', value: '$0.12' }, { kind: 'duration', value: '1m 2s' },
  ]);
  assert.deepEqual(items(['[Opus] | 5h: 23% 7d: 41% spend: $314.12 / $500']), [
    { kind: 'model', value: 'Opus' }, { kind: 'fiveHour', percent: 23 }, { kind: 'sevenDay', percent: 41 },
    { kind: 'spend', percent: 62.8, used: '$314.12', total: '$500' },
  ]);
});

test('a powerline status line, parted by its arrows and marked with icons', () => {
  const line = `${CHIP} Opus 4.5 ${ARROW} ${FOLDER} venes ${ARROW} ${BRANCH} main ${ARROW}`;
  assert.deepEqual(items([line]), [
    { kind: 'model', value: 'Opus 4.5' }, { kind: 'folder', value: 'venes' }, { kind: 'branch', value: 'main' },
  ]);
});

test('a repository, a worktree and a pull request; Claude Code\'s modes, shells and vim', () => {
  assert.deepEqual(items([
    '◆ Opus 5.5 · max │ Lorpaves/venes-helper › helper ⎇ main wt:feature PR#12 approved │ ctx ━━ 90% │ 5h ━━ 12% ↻15:00',
    '⏵⏵ accept edits on · 2 shells',
    '? for shortcuts',
    '-- INSERT --',
    '⏸ plan mode on (shift+tab to cycle) · esc to interrupt',
  ]), [
    { kind: 'model', value: 'Opus 5.5' }, { kind: 'effort', value: 'max' },
    { kind: 'repo', value: 'Lorpaves/venes-helper' }, { kind: 'folder', value: 'helper' }, { kind: 'branch', value: 'main' },
    { kind: 'worktree', value: 'feature' }, { kind: 'pr', value: '#12', state: 'approved' },
    { kind: 'context', percent: 90 }, { kind: 'fiveHour', percent: 12, resets: '15:00' },
    { kind: 'mode', value: 'Accept edits' }, { kind: 'background', value: '2 shells' }, { kind: 'vim', value: 'INSERT' },
    { kind: 'mode', value: 'Plan mode' },
  ]);
});

test('Claude Code\'s own footer: any marked mode, its effort, and no hints about keys or commands', () => {
  assert.deepEqual(items(['⏸ manual mode on · ← for agents · ◐ medium · /effort']), [
    { kind: 'mode', value: 'Manual mode' }, { kind: 'effort', value: 'medium' },
  ]);
  assert.deepEqual(items(['⏵⏵ bypass permissions on (shift+tab to cycle) · ctrl+t to hide tasks · → to expand · esc to interrupt']), [
    { kind: 'mode', value: 'Bypass permissions' },
  ]);
  assert.deepEqual(items(['plan mode on | /tmp/build']), [{ kind: 'mode', value: 'Plan mode' }, { kind: 'folder', value: '/tmp/build' }]);
});

test('context as a share of the window, or as what\'s left; and what isn\'t known is kept as it reads', () => {
  assert.deepEqual(items(['Context: 45% (90k/200k) | Sonnet 4.5 (high) | ~/code/app | +156 -23 | 🔥 on fire']), [
    { kind: 'context', percent: 45, used: '90k', total: '200k' }, { kind: 'model', value: 'Sonnet 4.5' }, { kind: 'effort', value: 'high' },
    { kind: 'folder', value: '~/code/app' }, { kind: 'lines', added: 156, removed: 23 }, { kind: 'other', value: '🔥 on fire' },
  ]);
  assert.deepEqual(items(['Context left: 68%']), [{ kind: 'context', percent: 32 }]);
  assert.deepEqual(items(['ctx 10% | 77% battery']), [{ kind: 'context', percent: 10 }, { kind: 'other', percent: 77, value: '77% battery' }]);
});

test('a bare branch is known by the one checked out, and a bare folder by the session\'s', () => {
  assert.deepEqual(items(['Opus | venes | feature-x'], { cwd: '/code/venes', branch: 'feature-x' }), [
    { kind: 'model', value: 'Opus' }, { kind: 'folder', value: 'venes' }, { kind: 'branch', value: 'feature-x' },
  ]);
  assert.deepEqual(items(['Opus | venes | feature-x']), [
    { kind: 'model', value: 'Opus' }, { kind: 'other', value: 'venes' }, { kind: 'other', value: 'feature-x' },
  ]);
});

test('a meter takes the colour its share is shown in', () => {
  const runs = [{ text: 'ctx ', color: '#999999' }, { text: '━━', color: '#5fd787' }, { text: ' ' }, { text: '45%', color: '#d7af00' }];
  const [context] = statusItems([runs]);
  assert.deepEqual(context, { kind: 'context', percent: 45, color: '#d7af00', text: 'ctx ━━ 45%' });
});

test('the branch checked out is asked of git, and is none outside a repository', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-branch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(await checkedOutBranch(dir), undefined);
  execFileSync('git', ['init', '-q', '-b', 'feature-x', dir]);
  assert.equal(await checkedOutBranch(dir), 'feature-x');
  assert.equal(await checkedOutBranch(undefined), undefined);
});
