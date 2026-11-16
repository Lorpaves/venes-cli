// Whether Claude Code trusts a folder already, by its own rules: its config says so for the folder, or
// for one above it, up to the top of its git repository, or up to the top of the disk outside one. It
// asks about the home folder every time. Its config is only read here.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function claudeConfigFile(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
}

export function readClaudeConfig(file = claudeConfigFile()) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {}; // none yet, or half written: nothing is trusted
  }
}

// The folder a .git is in, at or above this one.
export function gitRoot(folder, paths = path) {
  for (let dir = folder; ; dir = paths.dirname(dir)) {
    if (fs.existsSync(paths.join(dir, '.git'))) return dir;
    if (dir === paths.dirname(dir)) return undefined;
  }
}

// How Claude Code names a folder in its config. On Windows it writes `C:/Users/me/work`, with the
// slashes the other way from the path itself, and a path there is the same in either case.
const keyOf = (folder, paths) => (paths.sep === '\\' ? folder.replaceAll('\\', '/').toLowerCase() : folder);

// `paths` is the platform's own, and Windows' for a test of its paths run anywhere.
export function isTrusted(folder, { config = readClaudeConfig(), home = os.homedir(), paths = path } = {}) {
  if (keyOf(folder, paths) === keyOf(home, paths)) return false;
  const trusted = new Set(Object.entries(config?.projects ?? {})
    .filter(([, project]) => project?.hasTrustDialogAccepted === true).map(([name]) => keyOf(name, paths)));
  const root = gitRoot(folder, paths);
  for (let dir = folder; ; dir = paths.dirname(dir)) {
    if (trusted.has(keyOf(dir, paths))) return true;
    if (dir === root || dir === paths.dirname(dir)) return false;
  }
}
