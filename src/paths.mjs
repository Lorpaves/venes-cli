import os from 'node:os';
import path from 'node:path';

export function helperPaths(home = process.env.VENES_HOME || path.join(os.homedir(), '.venes')) {
  return {
    home,
    hookSocket: path.join(home, 'hook.sock'),
    clientSocket: path.join(home, 'client.sock'),
    launcher: path.join(home, 'venes'),
    pidFile: path.join(home, 'helper.pid'),
    logFile: path.join(home, 'helper.log'),
    noAutoUpdate: path.join(home, 'no-auto-update'),
    sessionsFile: path.join(home, 'sessions.json'),
    // What's known of the files clients attach to messages, by session and then by upload.
    uploads: path.join(home, 'uploads'),
    // Where those files go, so that they're as easy to find as anything else this Mac was sent.
    downloads: process.env.VENES_DOWNLOADS || path.join(os.homedir(), 'Downloads'),
    // The Rex session the helper starts sessions in, by id, since its label can change.
    rexSession: path.join(home, 'rex-session'),
    sdkDir: process.env.VENES_SDK_DIR || path.join(home, 'sdk'),
    // What Claude Code last told each session's status line, by session.
    statusDir: path.join(home, 'status'),
    // The status line the helper's stands in for, and whether it's switched off.
    statusLineState: path.join(home, 'statusline.json'),
    // The phones to notify while they aren't connected, each with its device token and key.
    pushFile: path.join(home, 'push.json'),
    // Terminal sessions, each with what its shell's hooks last said and what it has done.
    terminals: path.join(home, 'terminals'),
    // The startup files a terminal session's shell reads, ahead of the reader's own.
    shellDir: path.join(home, 'shell', 'zsh'),
    // Claude Code's own settings, where the status line is set up.
    claudeSettings: process.env.VENES_CLAUDE_SETTINGS
      || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'),
  };
}
