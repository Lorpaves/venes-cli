// A terminal of the helper's third kind: a Windows console, where there's no tmux. Windows lets a
// process attach to another's console, write key presses into it and read the letters on its screen,
// which is what tmux and Rex do for the helper elsewhere. A console is named by a process that's in it:
// a session's pane is `console:<the id of its Claude Code>`.
//
// The attaching is done by one PowerShell kept running (scripts/console.ps1), which is asked a line of
// JSON at a time. It can only reach a console in the desktop session it runs in itself, which is where
// Claude Code starts the helper.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HelperError } from './errors.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/console.ps1', import.meta.url));
export const PANE_PREFIX = 'console:';
// PowerShell takes most of a second to start, and compiles what it runs the first time.
const START_LIMIT_MS = 30_000;
const ASK_LIMIT_MS = 8000;
// A program just started takes a moment to have its console, and can't be attached to before.
const CONSOLE_LIMIT_MS = 5000;
const CONSOLE_CHECK_MS = 100;
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });
// Said of a session whose console can't be reached: one that has gone, or is in another Windows session
// than the helper, or was started before the helper could tell where it is.
export const UNREACHED = 'This session can’t be controlled from here. Quit and reopen Claude Code on your computer.';
const UNREACHED_CODES = new Set(['gone', 'no_console', 'out_of_reach']);
// What's held down with a key, as Windows names it in a key press.
const ALT = 0x02;
const CONTROL = 0x08;
const SHIFT = 0x10;
// A key of the keyboard's own block of arrows, which is where a terminal's arrows are.
const ENHANCED = 0x100;

// The keys the helper presses, by the names tmux gives them: the virtual key, its letter, and what's held.
const KEYS = {
  Enter: [0x0D, 13, 0], Escape: [0x1B, 27, 0], Tab: [0x09, 9, 0], BTab: [0x09, 9, SHIFT], Space: [0x20, 32, 0], BSpace: [0x08, 127, 0],
  Up: [0x26, 0, ENHANCED], Down: [0x28, 0, ENHANCED], Left: [0x25, 0, ENHANCED], Right: [0x27, 0, ENHANCED],
  'C-k': [0x4B, 11, CONTROL], 'C-u': [0x55, 21, CONTROL], 'C-c': [0x43, 3, CONTROL], 'C-d': [0x44, 4, CONTROL], 'C-z': [0x5A, 26, CONTROL],
  'C-l': [0x4C, 12, CONTROL], 'M-p': [0x50, 112, ALT],
};

// A key by its name, or a single letter as itself.
export function recordOf(key) {
  if (KEYS[key]) return KEYS[key];
  if (typeof key === 'string' && [...key].length === 1) return recordsOf(key)[0];
  throw new HelperError('bad_key', `${key} isn't a key a console takes.`);
}

// Text as the key presses that type it, a letter at a time: Return for a line's end, as the key gives it.
export function recordsOf(text) {
  return [...String(text).replace(/\r\n?|\n/g, '\r')].flatMap(letter => {
    if (letter === '\r') return [KEYS.Enter];
    if (letter === '\t') return [KEYS.Tab];
    if (letter === '\x1b') return [KEYS.Escape];
    // A letter outside the first plane is two of the units a console's input is counted in.
    return letter.split('').map(unit => [0, unit.charCodeAt(0), 0]);
  });
}

// Text as a paste, between the marks a terminal puts around one: its line ends are then part of it, where
// typed they'd each send what was typed so far.
export function pastedRecords(text) {
  const inside = [...String(text).replace(/\r\n?|\n/g, '\r')].flatMap(letter => letter.split('').map(unit => [unit === '\r' ? 0x0D : 0, unit.charCodeAt(0), 0]));
  return [...recordsOf('\x1b[200~'), ...inside, ...recordsOf('\x1b[201~')];
}

// What Claude Code draws where a console may not have the letter: its pointer as `>`, its tick as `√`.
// The helper reads a screen by the letters a Mac's terminal shows, so they're put back. A pointer is
// one at the start of its line, which is the only place the helper looks for one.
export function asElsewhere(line) {
  return line.replace(/^(\s*)>(?=\s|$)/, '$1❯').replace(/√/g, '✔');
}

const WINDOWS_TO_ANSI = [0, 4, 2, 6, 1, 5, 3, 7];

// A cell's attributes, as a console keeps them, as the codes that would draw it in a terminal. A
// console keeps sixteen colours and no dimness: what Claude Code dims comes out dark grey, and is
// said to be dim, since that's how the helper tells a hint in the input box from something typed.
export function sgrOf(attributes) {
  const [text, back] = [attributes & 0xF, (attributes >> 4) & 0xF];
  const codes = [];
  if (text === 8) codes.push(2);
  else if (text !== 7) codes.push((text & 8 ? 90 : 30) + WINDOWS_TO_ANSI[text & 7]);
  if (back !== 0) codes.push((back & 8 ? 100 : 40) + WINDOWS_TO_ANSI[back & 7]);
  if (attributes & 0x4000) codes.push(7);
  if (attributes & 0x8000) codes.push(4);
  return codes;
}

export const plainScreen = rows => `${rows.map(row => asElsewhere(row.text.trimEnd())).join('\n')}\n`;

// Where what's typed starts on the input box's first line: past its mark and the space after it.
const BOX_START = 2;

// The screen with the escape sequences that colour it, as tmux gives one: each run of cells that look
// alike after the codes for how they look.
//
// A console doesn't keep that a letter is dimmed, which is all that tells the hint Claude Code shows in
// an empty input box from something typed there. The cursor does: it's at the box's start while the
// box is empty, so what's after it on its line is the hint, and is said to be dim. Something typed with
// the cursor then put before it reads as a hint too, which is why a console's box is emptied without
// asking (see `sendMessage`).
export function styledScreen(rows, cursor = undefined) {
  return `${rows.map((row, index) => {
    const line = [...asElsewhere(row.text)];
    const hintFrom = cursor && index === cursor[1] && cursor[0] === BOX_START && line[0] === '❯' ? BOX_START : Infinity;
    let at = 0;
    let drawn = '';
    const draw = (cells, codes) => { drawn += codes.length && cells ? `\x1b[${codes.join(';')}m${cells}\x1b[0m` : cells; };
    for (let run = 0; run + 1 < row.runs.length; run += 2) {
      const end = at + row.runs[run];
      const codes = sgrOf(row.runs[run + 1]);
      draw(line.slice(at, Math.min(end, hintFrom)).join(''), codes);
      if (end > hintFrom) draw(line.slice(Math.max(at, hintFrom), end).join(''), codes.includes(2) ? codes : [2, ...codes]);
      at = end;
    }
    return drawn.replace(/\s+$/, '');
  }).join('\n')}\n`;
}

// The PowerShell that does the attaching, started when it's first asked something and again if it goes.
export class ConsoleServer {
  #start;
  #limit;
  #child;
  #ready;
  #waiting = new Map();
  #next = 1;
  #heard = '';

  constructor({
    start = () => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
    limit = ASK_LIMIT_MS,
  } = {}) {
    this.#start = start;
    this.#limit = limit;
  }

  #up() {
    if (this.#ready) return this.#ready;
    const child = this.#start();
    this.#child = child;
    this.#heard = '';
    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new HelperError('console_failed', 'The console couldn\'t be reached: PowerShell didn\'t start.')), START_LIMIT_MS);
      timer.unref?.();
      const gone = error => {
        clearTimeout(timer);
        // Its pipes are let go of with it, so that nothing of it keeps this process from ending.
        child.stdout.destroy();
        child.stdin.destroy();
        if (this.#child === child) { this.#child = undefined; this.#ready = undefined; }
        const failure = new HelperError('console_failed', `The console couldn't be reached${error?.message ? `: ${error.message}` : '.'}`);
        for (const { fail, timer: waiting } of this.#waiting.values()) { clearTimeout(waiting); fail(failure); }
        this.#waiting.clear();
        reject(failure);
      };
      child.once('error', gone);
      child.once('exit', () => gone());
      child.stdin.on('error', () => {});
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', said => {
        this.#heard += said;
        // By line feeds alone: a screen's own letters can be ones a line reader takes for a line's end.
        for (let end = this.#heard.indexOf('\n'); end >= 0; end = this.#heard.indexOf('\n')) {
          const line = this.#heard.slice(0, end);
          this.#heard = this.#heard.slice(end + 1);
          let answer;
          try { answer = JSON.parse(line); } catch { continue; }
          if (answer.ready) { clearTimeout(timer); resolve(); continue; }
          const asked = this.#waiting.get(answer.id);
          if (!asked) continue;
          this.#waiting.delete(answer.id);
          clearTimeout(asked.timer);
          // A console that isn't there to reach is a session with no terminal, as a closed pane is.
          if (answer.error) asked.fail(UNREACHED_CODES.has(answer.code) ? new HelperError('no_pane', UNREACHED, { reason: answer.error }) : new HelperError(answer.code ?? 'console_failed', answer.error));
          else asked.done(answer);
        }
      });
    });
    this.#ready.catch(() => {});
    return this.#ready;
  }

  async ask(op, fields = {}, { limit = this.#limit } = {}) {
    await this.#up();
    const id = this.#next++;
    return new Promise((done, fail) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        fail(new HelperError('console_failed', 'The console took too long to answer.'));
      }, limit);
      timer.unref?.();
      this.#waiting.set(id, { done, fail, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, op, ...fields })}\n`);
    });
  }

  stop() {
    this.#child?.kill();
  }
}

// The program a console's process is named for, as a Mac names it: without its ending.
const programOf = name => String(name ?? '').replace(/\.exe$/i, '');

// Where a program is, for one named without its folder: on the PATH, or where Claude Code's own
// installer puts it, which a helper started from a hook may not have on its PATH.
export function programFile(name, { env = process.env, exists = fs.existsSync, home = os.homedir() } = {}) {
  if (path.win32.isAbsolute(name) || /[\\/]/.test(name)) return name;
  const endings = /\.[a-z]+$/i.test(name) ? [''] : ['.exe', '.cmd', '.bat'];
  const folders = [...String(env.PATH ?? env.Path ?? '').split(';').filter(Boolean), path.win32.join(home, '.local', 'bin')];
  for (const folder of folders) {
    for (const ending of endings) {
      const file = path.win32.join(folder, `${name}${ending}`);
      if (exists(file)) return file;
    }
  }
  return name;
}

// The terminal the rest of the helper asks, over a server that does the attaching. `names` are the
// consoles started from here, by the names they were started under.
export function consoleBackend(server, { names = new Map(), program = programFile, consoleLimit = CONSOLE_LIMIT_MS } = {}) {
  const pidOf = ({ pane } = {}) => {
    const pid = Number(String(pane ?? '').startsWith(PANE_PREFIX) ? String(pane).slice(PANE_PREFIX.length) : NaN);
    if (!Number.isInteger(pid) || pid <= 0) throw new HelperError('no_pane', UNREACHED);
    return pid;
  };
  const read = async target => server.ask('read', { pid: pidOf(target) });
  const listed = async target => (await server.ask('list', { pid: pidOf(target) })).processes;
  const backend = {
    readScreen: async target => plainScreen((await read(target)).rows),
    async readStyledScreen(target) {
      const { rows, cursor } = await read(target);
      return styledScreen(rows, cursor);
    },
    pressKey: async (target, key) => { await server.ask('write', { pid: pidOf(target), records: [recordOf(key)] }); },
    paste: async (target, text) => { await server.ask('write', { pid: pidOf(target), records: pastedRecords(text) }); },
    // The pane a hook's process is in: the console of the program that ran it, or nothing where it can't be reached.
    async paneOf(pid) {
      try {
        return `${PANE_PREFIX}${(await server.ask('where', { pid: Number(pid) })).pid}`;
      } catch {
        return undefined;
      }
    },
    // What's in front in the console: the newest of the programs in it.
    foreground: async target => programOf((await listed(target))[0]?.name),
    async processOf(target) {
      const [front] = await listed(target);
      return { name: programOf(front?.name), pid: front?.pid };
    },
    // Every console a program of the helper's kinds runs in now, by the pane each would be.
    async openPanes() {
      try {
        return new Set((await server.ask('running')).pids.map(pid => `${PANE_PREFIX}${pid}`));
      } catch {
        return undefined;
      }
    },
    async isSessionOpen(name, target) {
      const pid = pidOf(target ?? names.get(name));
      return (await server.ask('alive', { pids: [pid] })).processes.some(found => found.pid === pid);
    },
    async findSession(name) {
      const target = names.get(name);
      if (!target) return undefined;
      if (await backend.isSessionOpen(name, target).catch(() => false)) return target;
      names.delete(name);
      return undefined;
    },
    // A program in a console of its own, which Windows opens on the desktop in the reader's terminal.
    async startSession({ name, cwd, command, env = {} }) {
      const [file, ...args] = command;
      const { pid } = await server.ask('start', { file: program(file, { env: { ...process.env, ...env } }), args, cwd, env }, { limit: START_LIMIT_MS });
      const target = { pane: `${PANE_PREFIX}${pid}` };
      names.set(name, target);
      // Until its console is there to reach, or it's clear that it won't be: whoever asked then finds what became of it.
      for (const deadline = Date.now() + consoleLimit; Date.now() < deadline; await pause(CONSOLE_CHECK_MS)) {
        if (await server.ask('list', { pid }).then(() => true, () => false)) break;
      }
      return target;
    },
    async closeSession(name, target) {
      const pid = pidOf(target ?? names.get(name));
      names.delete(name);
      await server.ask('stop', { pid }, { limit: START_LIMIT_MS });
    },
  };
  return backend;
}

export const isConsolePane = session => String(session?.pane ?? '').startsWith(PANE_PREFIX);

let shared;
const sharedBackend = () => (shared ??= consoleBackend(new ConsoleServer()));

// The one the helper uses, its PowerShell started when something is first asked of it.
export const readScreen = target => sharedBackend().readScreen(target);
export const readStyledScreen = target => sharedBackend().readStyledScreen(target);
export const pressKey = (target, key) => sharedBackend().pressKey(target, key);
export const paste = (target, text) => sharedBackend().paste(target, text);
export const paneOf = pid => sharedBackend().paneOf(pid);
export const foreground = target => sharedBackend().foreground(target);
export const processOf = target => sharedBackend().processOf(target);
export const openPanes = target => sharedBackend().openPanes(target);
export const isSessionOpen = (name, target) => sharedBackend().isSessionOpen(name, target);
export const findSession = name => sharedBackend().findSession(name);
export const startSession = options => sharedBackend().startSession(options);
export const closeSession = (name, target) => sharedBackend().closeSession(name, target);
