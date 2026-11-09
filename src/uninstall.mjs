// Takes the helper off this Mac in one go: the plugin and its marketplace, the status line it stood
// in for, the helper itself, the keys phones were let in with, and its folder. Sessions that were
// open keep running the plugin's hooks until they restart, so setup checks the plugin is still
// installed first, and they don't bring the helper back.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { removePhoneKeys } from './pairing.mjs';
import { removeStatusLine } from './status.mjs';

const exec = promisify(execFile);
export const PLUGIN_ID = 'venes@venes';
export const MARKETPLACE = 'venes';
const CLAUDE_TIMEOUT_MS = 60_000;

export function claudeConfigDir(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// A path as it really is, through links such as macOS's /var to /private/var.
function realPath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// Whether Claude Code still has this plugin installed. One run from elsewhere, as with --plugin-dir,
// counts, and so does a record that can't be read.
export function isPluginInstalled({ configDir, pluginRoot }) {
  const cache = realPath(path.join(configDir, 'plugins', 'cache')) + path.sep;
  if (!realPath(pluginRoot).startsWith(cache)) return true;
  try {
    const record = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    return (record.plugins?.[PLUGIN_ID] ?? []).length > 0;
  } catch {
    return true;
  }
}

async function runClaude(args) {
  await exec('claude', args, { timeout: CLAUDE_TIMEOUT_MS });
}

// The helper's own folder, and never the home folder or the root around it.
function removeHome(home) {
  const resolved = path.resolve(home);
  if (resolved === path.parse(resolved).root || resolved === os.homedir()) throw new Error(`won't remove ${resolved}`);
  fs.rmSync(resolved, { recursive: true, force: true });
}

// Each step goes on whatever the ones before it did, and says how it went: `{ name, ok, detail }`.
export async function uninstall({ paths, authorizedKeys, stopHelper, run = runClaude }) {
  const steps = [];
  const step = async (name, action) => {
    try {
      steps.push({ name, ok: true, detail: await action() });
    } catch (error) {
      steps.push({ name, ok: false, detail: error.code === 'ENOENT' && error.path === 'claude' ? 'claude not found' : error.message });
    }
  };
  // The plugin goes first, so that no session starting meanwhile sets the helper up again.
  await step('plugin', () => run(['plugin', 'uninstall', PLUGIN_ID]));
  await step('marketplace', () => run(['plugin', 'marketplace', 'remove', MARKETPLACE]));
  await step('statusLine', () => {
    fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 }); // where it notes that it's off, until the folder goes
    removeStatusLine({ settingsFile: paths.claudeSettings, stateFile: paths.statusLineState });
  });
  await step('helper', () => stopHelper());
  await step('keys', () => removePhoneKeys(authorizedKeys));
  await step('folder', () => removeHome(paths.home));
  return steps;
}
