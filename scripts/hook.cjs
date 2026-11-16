// Forwards one Claude Code hook event to the Venes helper, on Windows, where the helper is reached
// through a named pipe that curl can't open. Git Bash runs hook.sh, which hands over to this. It does
// what that script does elsewhere: with no helper running it prints nothing, so Claude Code carries on
// as normal, and it always ends well.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pipeName } = require('../src/pipename.cjs');

const mode = process.argv[2];
const home = process.env.VENES_HOME || path.join(os.homedir(), '.venes');
const root = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const isWindows = process.platform === 'win32';
const socketPath = isWindows ? pipeName(home, 'hook') : path.join(home, 'hook.sock');
const launcher = path.join(home, isWindows ? 'venes.cmd' : 'venes');

// The plugin's path changes with each version, so the launcher is refreshed when a session starts, and
// made by any event that finds none, as a plugin picked up with /reload-plugins has none until then.
if (mode === 'session-start' || !fs.existsSync(launcher)) {
  spawnSync(process.execPath, [path.join(root, 'cli', 'venes.mjs'), 'setup'], { stdio: 'ignore', windowsHide: true });
}

// A permission request waits for its answer, while the terminal's own dialog stays usable.
const limit = mode === 'hold' ? 86_400_000 : 4000;
const env = name => process.env[name] || '';
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = http.request({
    socketPath, path: '/hook', method: 'POST', timeout: limit,
    headers: {
      'Content-Type': 'application/json',
      'X-Venes-Pane': env('TMUX_PANE'), 'X-Venes-Tmux': env('TMUX'),
      'X-Venes-Rex-Block': env('REX_BLOCK'), 'X-Venes-Rex-Session': env('REX_SESSION'), 'X-Venes-Rex-Server': env('REX_SERVER'),
    },
  }, response => {
    // Only what the helper says when all is well is passed on.
    if (response.statusCode === 200) response.pipe(process.stdout);
    else response.resume();
  });
  request.on('timeout', () => request.destroy());
  // No helper, or one that went: nothing to say.
  request.on('error', () => {});
  request.end(Buffer.concat(chunks));
});
