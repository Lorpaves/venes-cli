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
    // What clients attach to messages, by session and then by upload.
    uploads: path.join(home, 'uploads'),
    sdkDir: process.env.VENES_SDK_DIR || path.join(home, 'sdk'),
  };
}
