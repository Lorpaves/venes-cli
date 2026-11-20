import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shimOf } from './status.mjs';

const CLI = fileURLToPath(new URL('../cli/venes.mjs', import.meta.url));

const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

// Prefers the stable PATH entry: process.execPath is Homebrew's versioned Cellar
// path, which disappears on the next node upgrade.
function nodePath() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  const name = process.platform === 'win32' ? 'node.exe' : 'node';
  return dirs.map(dir => path.join(dir, name)).find(file => fs.existsSync(file)) ?? process.execPath;
}

// A fixed entry point for a CLI whose real path changes with every plugin version.
// A command run over SSH gets a minimal PATH without node, so everything is absolute.
export function launcherScript({ home }, node = nodePath(), cli = CLI, platform = process.platform) {
  if (platform === 'win32') return windowsLauncher({ home }, node, cli);
  return `#!/bin/sh
VENES_HOME=${shellQuote(home)} exec ${shellQuote(node)} ${shellQuote(cli)} "$@"
`;
}

// The same for Windows, as a command file: cmd runs it, and so do PowerShell and Git Bash by its name.
// A percent sign in a path would be read as a variable's, so each is doubled.
export function windowsLauncher({ home }, node, cli) {
  const plain = value => value.replace(/%/g, '%%');
  return `@echo off\r\nset "VENES_HOME=${plain(home)}"\r\n"${plain(node)}" "${plain(cli)}" %*\r\n`;
}

// The same again as JavaScript, for Windows: what Claude Code runs as its status line goes to whichever
// shell it uses there, and `node` with a file is the one command they all read alike.
export function launcherShim({ home }, cli = CLI) {
  return `process.env.VENES_HOME ??= ${JSON.stringify(home)};\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`;
}

export function writeLauncher(paths, platform = process.platform) {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.launcher, launcherScript(paths), { mode: 0o755 });
  if (platform === 'win32') fs.writeFileSync(shimOf(paths.launcher), launcherShim(paths));
}
