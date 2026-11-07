// A real tmux running a small program in Claude Code's place, for tests of what the helper presses.

import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const hasTmux = (() => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

export const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// `program` gets the file to write keys to as argv[2], and `input` as JSON in argv[3]. It says it's
// ready by creating that file's name with `.ready` on the end. `keys()` gives what it wrote.
export async function startPane(t, program, input) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-tmux-'));
  const tmuxSocket = path.join(dir, 's');
  const log = path.join(dir, 'keys');
  const script = path.join(dir, 'pane.cjs');
  fs.writeFileSync(script, program);
  fs.writeFileSync(log, '');
  const tmux = (...args) => execFileSync('tmux', ['-S', tmuxSocket, '-f', '/dev/null', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const pane = tmux('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '100', '-y', '30', process.execPath, script, log, JSON.stringify(input)).trim();
  t.after(() => {
    try { tmux('kill-server'); } catch { /* it had already gone */ }
    fs.rmSync(dir, { recursive: true });
  });
  for (let tries = 0; !fs.existsSync(`${log}.ready`); tries++) {
    assert.ok(tries < 300, 'the pane never started');
    await pause(10);
  }
  await pause(50);
  return { session: { pane, tmuxSocket }, keys: async () => { await pause(80); return fs.readFileSync(log, 'utf8').trim(); } };
}
