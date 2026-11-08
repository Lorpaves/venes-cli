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
export function gitRoot(folder) {
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (dir === path.dirname(dir)) return undefined;
  }
}

export function isTrusted(folder, { config = readClaudeConfig(), home = os.homedir() } = {}) {
  if (folder === home) return false;
  const projects = config?.projects ?? {};
  const root = gitRoot(folder);
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (projects[dir]?.hasTrustDialogAccepted === true) return true;
    if (dir === root || dir === path.dirname(dir)) return false;
  }
}
