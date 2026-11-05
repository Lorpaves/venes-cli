import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../cli/venes.mjs', import.meta.url));

const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;

// Prefers the stable PATH entry: process.execPath is Homebrew's versioned Cellar
// path, which disappears on the next node upgrade.
function nodePath() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter);
  return dirs.map(dir => path.join(dir, 'node')).find(file => fs.existsSync(file)) ?? process.execPath;
}

// A fixed entry point for a CLI whose real path changes with every plugin version.
// A command run over SSH gets a minimal PATH without node, so everything is absolute.
export function launcherScript({ home }, node = nodePath(), cli = CLI) {
  return `#!/bin/sh
VENES_HOME=${shellQuote(home)} exec ${shellQuote(node)} ${shellQuote(cli)} "$@"
`;
}

export function writeLauncher(paths) {
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.launcher, launcherScript(paths), { mode: 0o755 });
}
