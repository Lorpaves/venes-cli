// How Antigravity tells the helper what its sessions do: a plugin of its own, in the folder
// Antigravity keeps the plugins for every project in, with hooks that forward each event. A hook
// there is a command Antigravity runs and waits on, so the script only hands the event over and
// answers at once. It answers nothing about whether a tool may run, and isn't asked: a hook asked
// that has to say, and one that couldn't would stop every call in every session.

import fs from 'node:fs';
import path from 'node:path';
import { VERSION } from './version.mjs';

const PLUGIN = 'venes';
// The events Antigravity has, less the one before a tool call.
const FLAT_EVENTS = ['SessionStart', 'PreInvocation', 'PostInvocation', 'Stop'];
const TOOL_EVENTS = ['PostToolUse'];
// Seconds. The script gives the helper four, and Antigravity would wait thirty.
const TIMEOUT = 10;

// Where the plugin goes, in the folder Antigravity looks in for what's set up for every project on
// this Mac. A run that names another folder, as a test does, leaves Antigravity's own alone.
export const pluginFolder = (env, home) => path.join(env.VENES_AGY_CONFIG || path.join(home, '.gemini', 'config'), 'plugins', PLUGIN);

// The script each hook runs. With no helper running it says nothing was wrong and Antigravity goes on.
export function hookScript() {
  return `#!/bin/sh
# Forwards one Antigravity hook event to the Venes helper, and tells Antigravity to carry on.
home="\${VENES_HOME:-$HOME/.venes}"
curl=/usr/bin/curl
[ -x "$curl" ] || curl=$(command -v curl)
if [ -S "$home/hook.sock" ] && [ -n "$curl" ]; then
  "$curl" -s --max-time 4 --unix-socket "$home/hook.sock" \\
    -H 'Content-Type: application/json' -H 'X-Venes-Agent: antigravity' \\
    -H "X-Venes-Pane: \${TMUX_PANE:-}" -H "X-Venes-Tmux: \${TMUX:-}" \\
    -H "X-Venes-Rex-Block: \${REX_BLOCK:-}" -H "X-Venes-Rex-Session: \${REX_SESSION:-}" -H "X-Venes-Rex-Server: \${REX_SERVER:-}" \\
    --data-binary @- http://venes/hook >/dev/null 2>&1
else
  cat >/dev/null
fi
printf '{}'
exit 0
`;
}

// Antigravity runs a plugin's hooks in the plugin's folder, so the script is named from there.
export function hooksFile() {
  const handler = { type: 'command', command: './hook.sh', timeout: TIMEOUT };
  return {
    [PLUGIN]: {
      ...Object.fromEntries(FLAT_EVENTS.map(event => [event, [handler]])),
      ...Object.fromEntries(TOOL_EVENTS.map(event => [event, [{ matcher: '*', hooks: [handler] }]])),
    },
  };
}

const manifest = () => ({ name: PLUGIN, version: VERSION, description: 'Forwards session events to the local Venes helper.' });

// Written only where it differs, as this runs each time the helper is set up.
function writeIfChanged(file, text, mode) {
  let current;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== text) fs.writeFileSync(file, text, { mode });
  if (mode && (fs.statSync(file).mode & 0o777) !== mode) fs.chmodSync(file, mode);
  return current !== text;
}

// Puts the plugin in `folder`, where Antigravity finds it, on a Mac that has Antigravity's own folder
// for it to be in: the one its settings folder is in. A session started after this runs the hooks.
// One already open doesn't until it's started again.
export function installHooks(folder, { always = false } = {}) {
  const config = path.dirname(path.dirname(folder));
  if (!always && !fs.existsSync(path.dirname(config))) return { installed: false };
  fs.mkdirSync(folder, { recursive: true });
  const changed = [
    writeIfChanged(path.join(folder, 'plugin.json'), `${JSON.stringify(manifest(), null, 2)}\n`),
    writeIfChanged(path.join(folder, 'hooks.json'), `${JSON.stringify(hooksFile(), null, 2)}\n`),
    writeIfChanged(path.join(folder, 'hook.sh'), hookScript(), 0o755),
  ].some(Boolean);
  return { installed: true, changed, folder };
}

export function removeHooks(folder) {
  const was = fs.existsSync(folder);
  fs.rmSync(folder, { recursive: true, force: true });
  return was;
}
