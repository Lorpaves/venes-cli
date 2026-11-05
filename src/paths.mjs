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
  };
}
