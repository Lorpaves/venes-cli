// What a terminal session's shell runs on top of the reader's own setup, and what it runs in.
//
// The shell is the reader's own, started the way their terminal starts it, with their prompt and all
// they've set up. Two hooks are added (the files in ../shell): one writes a mark before each command
// runs, with the command, and one before each prompt, with how the command ended and where the shell
// is. The marks are escape sequences no terminal shows. The shell runs under script(1), which keeps
// everything written to the terminal in a file as well, marks and all, and that file is what the helper
// reads (termengine.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HelperError } from './errors.mjs';

// The files as they're kept here, and the names a shell looks for them by.
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'shell');
export const SHELL_FILES = {
  zsh: { zshenv: '.zshenv', zprofile: '.zprofile', zshrc: '.zshrc', zlogin: '.zlogin', 'venes.zsh': 'venes.zsh' },
  bash: { bashrc: 'bashrc' },
};

// Written each time a terminal starts, so that a new version's hooks are the ones it gets.
export function installShellFiles(dir, source = SOURCE) {
  for (const [shell, files] of Object.entries(SHELL_FILES)) {
    fs.mkdirSync(path.join(dir, shell), { recursive: true, mode: 0o700 });
    for (const [kept, read] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, shell, read), fs.readFileSync(path.join(source, shell, kept)), { mode: 0o600 });
    }
  }
  return dir;
}

const SHELLS = ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh', '/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];

// The shell a terminal session runs: the reader's own when the hooks are written for it, and otherwise
// the first of zsh and bash that's here.
export function shellFor(env = process.env, exists = fs.existsSync) {
  const own = env.SHELL;
  const candidates = own && /^(zsh|bash)$/.test(path.basename(own)) ? [own, ...SHELLS] : SHELLS;
  const found = candidates.find(file => exists(file));
  if (!found) throw new HelperError('no_shell', 'A terminal session needs zsh or bash.');
  return { file: found, kind: path.basename(found) };
}

// The shell's command line and what it's started with. A login shell, so that it has what the reader's
// own terminal would: Homebrew's PATH comes from a .zprofile.
export function shellCommand({ shellDir, mark, env = process.env, shell = shellFor(env) }) {
  const shared = {
    VENES_TERMINAL_MARK: mark,
    // A helper started over SSH may have none, and the shell would read UTF-8 as bytes.
    LANG: env.LANG || 'en_US.UTF-8',
    ...(env.LC_ALL && { LC_ALL: env.LC_ALL }),
    ...(env.PATH && { PATH: env.PATH }),
  };
  if (shell.kind === 'zsh') {
    return {
      command: [shell.file, '-l', '-i'],
      env: {
        ...shared, ZDOTDIR: path.join(shellDir, 'zsh'), VENES_USER_ZDOTDIR: env.ZDOTDIR || env.HOME,
        // oh-my-zsh asks, every couple of weeks, whether to update itself before the first prompt, which
        // nobody is at this terminal to answer. Its own switch for that, for this shell alone.
        DISABLE_AUTO_UPDATE: 'true',
      },
    };
  }
  return { command: [shell.file, '--rcfile', path.join(shellDir, 'bash', 'bashrc'), '-i'], env: shared };
}

const quoted = word => `'${String(word).replace(/'/g, `'\\''`)}'`;

let flushes;

// Whether this computer's script(1) takes -F, which writes each thing to the file as it's printed. One
// that doesn't is told to write after every character instead.
function takesFlush() {
  if (flushes === undefined) {
    try {
      execFileSync('script', ['-q', '-F', '/dev/null', 'true'], { stdio: 'ignore', timeout: 5000 });
      flushes = true;
    } catch {
      flushes = false;
    }
  }
  return flushes;
}

// A command run under script(1), which keeps everything it writes to the terminal in `file` too, added
// to what's there. Linux's script takes the command as one line for a shell, and BSD's, a Mac's, as it is.
export function recorded(command, file, { platform = process.platform, flush = takesFlush } = {}) {
  if (platform === 'linux') return ['script', '-q', '-a', '-f', '-e', '-c', command.map(quoted).join(' '), file];
  return ['script', '-q', '-a', ...(flush() ? ['-F'] : ['-t', '0']), file, ...command];
}

const sttyFile = platform => (platform === 'linux' ? '-F' : '-f');

// The size of the terminal a shell is on, set from outside it: every program on it is told, as when a
// window is resized. script(1) on a Mac doesn't pass a window's own size on, so this is how a session
// is made the width of the page it's read on.
export function sizeCommand(tty, { columns, rows }, platform = process.platform) {
  return ['stty', sttyFile(platform), tty, 'cols', String(columns), 'rows', String(rows)];
}

// What a terminal's settings say of what's typed on it.
export function settingsCommand(tty, platform = process.platform) {
  return ['stty', sttyFile(platform), tty, '-a'];
}

// A program reading a line without showing it is asking for something secret, as a password. One that
// reads each key for itself, as an editor does, shows what it likes.
export function hidesInput(settings) {
  const flags = new Set(String(settings).split(/[\s;]+/));
  return flags.has('icanon') && flags.has('-echo');
}

// The size a terminal's settings say it is.
export function sizeIn(settings) {
  const text = String(settings);
  const rows = /(\d+) rows|rows (\d+)/.exec(text);
  const columns = /(\d+) columns|columns (\d+)/.exec(text);
  if (!rows || !columns) return undefined;
  return { columns: Number(columns[1] ?? columns[2]), rows: Number(rows[1] ?? rows[2]) };
}
