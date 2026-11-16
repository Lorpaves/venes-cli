import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginFolder } from './agyhooks.mjs';
import pipes from './pipename.cjs';

const isWindows = process.platform === 'win32';

// Where things downloaded go. A Mac has one folder for it. A Linux desktop says where its own is, which
// may be named in the person's language, in a file in the home folder.
export function downloadsFolder({ home = os.homedir(), platform = process.platform, config = process.env.XDG_CONFIG_HOME } = {}) {
  if (platform !== 'darwin') {
    try {
      const dirs = fs.readFileSync(path.join(config || path.join(home, '.config'), 'user-dirs.dirs'), 'utf8');
      const named = /^XDG_DOWNLOAD_DIR="(.+)"\s*$/m.exec(dirs)?.[1]?.replace(/^\$HOME/, home);
      // With none of its own it's given as the home folder itself, which isn't a place for these.
      if (named && path.isAbsolute(named) && path.resolve(named) !== path.resolve(home)) return named;
    } catch {
      // No such file: the usual name.
    }
  }
  return path.join(home, 'Downloads');
}

export function helperPaths(home = process.env.VENES_HOME || path.join(os.homedir(), '.venes')) {
  return {
    home,
    // Sockets in the folder, or on Windows the pipes that stand in for them.
    hookSocket: isWindows ? pipes.pipeName(home, 'hook') : path.join(home, 'hook.sock'),
    clientSocket: isWindows ? pipes.pipeName(home, 'client') : path.join(home, 'client.sock'),
    // A shell script, or on Windows a command file, which every shell there can run.
    launcher: path.join(home, isWindows ? 'venes.cmd' : 'venes'),
    pidFile: path.join(home, 'helper.pid'),
    logFile: path.join(home, 'helper.log'),
    noAutoUpdate: path.join(home, 'no-auto-update'),
    sessionsFile: path.join(home, 'sessions.json'),
    // What's known of the files clients attach to messages, by session and then by upload.
    uploads: path.join(home, 'uploads'),
    // Where those files go, so that they're as easy to find as anything else this Mac was sent.
    downloads: process.env.VENES_DOWNLOADS || downloadsFolder(),
    // The Rex session the helper starts sessions in, by id, since its label can change.
    rexSession: path.join(home, 'rex-session'),
    sdkDir: process.env.VENES_SDK_DIR || path.join(home, 'sdk'),
    // What Claude Code last told each session's status line, by session.
    statusDir: path.join(home, 'status'),
    // The status line the helper's stands in for, and whether it's switched off.
    statusLineState: path.join(home, 'statusline.json'),
    // What each agent's chats say was used, by day, as far as they've been read: see usage.mjs.
    usageFile: path.join(home, 'usage.json'),
    // The public list of what models' tokens cost, as last read: see prices.mjs.
    pricesFile: path.join(home, 'prices.json'),
    // The phones to notify while they aren't connected, each with its device token and key.
    pushFile: path.join(home, 'push.json'),
    // The plugin Antigravity runs the helper's hooks from.
    antigravityPlugin: pluginFolder(process.env, os.homedir()),
    // Claude Code's own settings, where the status line is set up.
    claudeSettings: process.env.VENES_CLAUDE_SETTINGS
      || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
  };
}
