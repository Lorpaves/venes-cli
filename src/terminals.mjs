// Terminal sessions: a shell of the reader's own, in Rex or tmux as Claude Code's sessions are, that a
// client types commands into and reads each one's output back from, as a chat. The shell's hooks
// (shell.mjs) clear the screen before each command and leave what it's doing in files, so a command's
// output is the screen under its own line until the prompt comes back. Output streams while a command
// runs. A line sent while it runs goes to it, and what it prints after that is that line's.
//
// A program that takes the screen for itself, as an editor or a pager does, shows on the terminal's
// other screen, which has nothing above it. What it shows is the output of the last line sent, the
// command's own or one sent to the program since, drawn again as it changes. It stays there when the
// program gives the screen back, with what's printed after it underneath.
//
// A terminal the reader opened in Rex themselves is a session too, a mirrored one. Its shell has none of
// the hooks and its screen is never cleared, so a command sent to it is found by where it was typed:
// the line the prompt was on. That line stays as far from the start of all the terminal holds while
// more is printed under it, until the terminal is full and lets go of its oldest lines, and then it's
// known by what it says and what's above it. The command's output is what's under that line, until the
// shell is in front again with its prompt drawn. A command typed at the Mac isn't followed, but a
// program that's running there is, while a client has the terminal's page open: under a line that
// names it, as a command sent from a client would be.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkedFolder } from './folders.mjs';
import { gitState } from './gitstate.mjs';
import { capped, outputBody, plain, screenLines, squashed, styleBefore, trimEnd, vtLines, withoutPrompt } from './output.mjs';
import * as rex from './rex.mjs';
import { runsOf, screenCells } from './screen.mjs';
import { HelperError } from './sessions.mjs';
import { installShellFiles, shellCommand } from './shell.mjs';
import { PAGE_KEYS } from './terminal.mjs';
import * as tmux from './tmux.mjs';

export const TERMINAL_KIND = 'terminal';
const NAME_PREFIX = 'venes-term-';
const TICK_MS = 250;
// How often a running command's output is read again: often enough to follow, and no more. One that
// has printed nothing new for a while, as a server waiting for requests hasn't, is read less often.
const READ_EVERY_MS = 400;
const QUIET_AFTER_MS = 10_000;
const QUIET_READ_EVERY_MS = 2000;
const LIVE_CHECK_MS = 10_000;
// A send checks that the terminal is still there, unless it was just seen to be.
const LIVE_FRESH_MS = 1000;
// A login shell with a framework like oh-my-zsh was ready in about a second when measured.
const START_LIMIT_MS = 20_000;
const START_CHECK_MS = 150;
// The prompt follows the hook that says a command is done, so it's waited for a moment.
const PROMPT_WAIT_MS = 1500;
// A shell reads what's pasted and the Enter after it in the order they come, so this is only for a
// program that takes its time over a paste.
const PASTE_SETTLE_MS = 30;
// A shell runs a command the moment Enter reaches it, which its hooks then say. It's looked for at once,
// for a client that shows the command only once it's told of it, and no longer than a look would take to
// come round anyway.
const SOON_LIMIT_MS = 300;
const SOON_CHECK_MS = 15;
// As much of one output as a client is sent, from its end, as a terminal's scrollback keeps it.
const MAX_LINES = 2000;
const MAX_CHARS = 200_000;
const MAX_PENDING = 8;
// A sent command that hasn't shown up in the shell by then was typed over, or never ran.
const PENDING_LIFETIME_MS = 30_000;
const HISTORY_LIMIT_BYTES = 8 * 1024 * 1024;
const DEFAULT_SIZE = { columns: 80, rows: 24 };
const SIZE_RANGE = { columns: [20, 400], rows: [5, 200] };
// What a line shows when the program read it without showing it, as a password prompt does.
export const HIDDEN_TEXT = '••••••';
const META = 'session.json';
const HISTORY = 'history.jsonl';
// A mirrored terminal's prompt is learned: Ctrl-C at it draws it again underneath, and how far down the
// last line went is how many lines it takes. It's drawn at once, and waited for in case it isn't.
const MEASURE_LIMIT_MS = 1000;
const MEASURE_CHECK_MS = 40;
// A command just typed there is read at every look for a moment, as most are over at once, and one is
// over only once it has been read twice the same.
const EAGER_FOR_MS = 1500;
// A shell draws its prompt again when its terminal changes size, which is waited for before a command's
// place is noted.
const RESIZE_SETTLE_MS = 150;
// A line sent right after a command may find it over, but not yet seen to be: it's looked at this many
// times first, so that the line is the command it is, and not a line for the one before.
const SETTLE_READS = 3;
const SETTLE_CHECK_MS = 120;
// How many lines above a line it's known by, and how far up from the end a prompt is looked for.
const CONTEXT_LINES = 3;
const TAIL_LINES = 64;
// How long after Rex says its terminals changed they're looked at, so that a burst is one look.
const MIRROR_SETTLE_MS = 300;
// And how often anyway, in case a change was missed while the connection to Rex was down.
const MIRROR_SYNC_MS = 30_000;
// A program in front that's one of these is a shell at its prompt, and anything else is running.
const SHELLS = new Set(['zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'xonsh', 'pwsh', 'elvish', 'login']);
// What the helper starts in Rex itself, which is no terminal of the reader's own.
const OWN_LABEL = /^venes-/;
const CLAUDE = 'claude';

// A mirrored terminal's session id: its block's own, without what says it's a block.
export const mirrorId = pane => pane.replace(/^block:/, '');

// The program in front of a mirrored terminal's shell, by name: none while the shell is at its prompt.
const frontOf = program => (!program || SHELLS.has(program) ? undefined : program);

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

// What the hooks last wrote: `idle <pid> <seq> <status>` at a prompt, `running <pid> <seq>` while a
// command runs. A nested shell has a pid of its own, and counts from zero.
export function parseState(text) {
  const match = /^(idle|running) (\d+) (\d+)(?: (\d+))?\s*$/.exec(text ?? '');
  if (!match) return undefined;
  const [, kind, pid, seq, code] = match;
  return { kind, pid: Number(pid), seq: Number(seq), code: code === undefined ? undefined : Number(code), key: `${pid}:${seq}` };
}

const clamp = (value, [low, high], fallback) => (Number.isInteger(value) ? Math.min(Math.max(value, low), high) : fallback);

export function sizeOf({ columns, rows } = {}, fallback = DEFAULT_SIZE) {
  return { columns: clamp(columns, SIZE_RANGE.columns, fallback.columns), rows: clamp(rows, SIZE_RANGE.rows, fallback.rows) };
}

// A path as a shell reads it: as it is when nothing in it means anything to a shell, and in single
// quotes otherwise.
export function shellQuoted(text) {
  return /^[A-Za-z0-9_./@%+=:,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// The output from line `from` on, in the colours it starts in, and no longer than a client is sent.
export function partFrom(lines, from) {
  const part = trimEnd(lines.slice(from));
  return part.length ? styleBefore(lines, from) + capped(part, { maxLines: MAX_LINES, maxChars: MAX_CHARS }) : '';
}

// The last line a running command has printed on, and what it says: where a line sent to it now may
// show, when that line is the program's own prompt.
export function tailOf(lines) {
  const index = trimEnd(lines).length - 1;
  return { index, text: index < 0 ? '' : plain(lines[index]) };
}

// Where each part of a command's output starts. The first is the command's own. Each one after is a
// line sent to it while it ran, with where the output ended when it was sent: it starts on that line
// when the line has changed since, as a prompt the typing shows on has, and under it otherwise, as
// when the program read the line without showing it, or the cursor was already on the next one.
export function partStarts(lines, marks) {
  let from = 0;
  return marks.map(mark => {
    if (!mark) return from;
    const line = mark.index >= 0 ? lines[mark.index] : undefined;
    const typedOn = line !== undefined && plain(line) !== mark.text;
    from = Math.min(Math.max(typedOn ? mark.index : mark.index + 1, from), lines.length);
    return from;
  });
}

// What each part says, for the marks of `partStarts`.
export function partTexts(lines, marks) {
  const starts = partStarts(lines, marks);
  return starts.map((from, index) => partFrom(lines.slice(0, starts[index + 1] ?? lines.length), from));
}

// Where each line of what was read starts, in bytes from the start of all the terminal holds: a line
// stays there as more is printed under it, which is how it's found again in a later read. Counted back
// from where the read ends, since one that's cut may start in the middle of a character. Empty when the
// lines aren't the text's own, so that nothing is found by it.
export function lineStarts(text, lineCount, end = Buffer.byteLength(text)) {
  const raw = text.split('\n');
  if (raw.length !== lineCount) return [];
  const starts = new Array(raw.length);
  let at = end;
  for (let i = raw.length - 1; i >= 0; i--) {
    at -= Buffer.byteLength(raw[i]);
    starts[i] = at;
    at -= 1;
  }
  return starts;
}

const lastWord = text => text.trim().split(/\s+/).at(-1) ?? '';

// Whether a line is the shell's prompt with nothing typed at it: what the prompt last said, or a line
// that ends as it did, since a prompt may name a folder or a branch, which change.
export function promptLike(text, known) {
  if (known === undefined) return false;
  if (text === known) return true;
  const end = lastWord(known);
  return end !== '' && text.endsWith(end);
}

// The last lines of what a terminal holds, as they read, with none that show nothing at the end.
export const tailLines = lines => trimEnd(lines).slice(-TAIL_LINES).map(plain);

// How many lines have come under what was the last one, going by the lines above it, which stay as
// they were: the fewest that put those lines where they are now. A terminal that's full lets go of its
// oldest lines as new ones come, so counting from the top wouldn't do. Zero when they aren't there.
export function linesAdded(before, after) {
  const context = before.slice(-(CONTEXT_LINES + 1), -1);
  if (!context.length) return Math.max(after.length - before.length, 0);
  for (let added = 1; added + context.length < after.length; added++) {
    const from = after.length - 1 - added - context.length;
    if (context.every((line, index) => after[from + index] === line)) return added;
  }
  return 0;
}

// How many of the lines a prompt was drawn on are counted as the prompt: those from the first that shows
// anything. An empty line above them is only there under output that ended with a line's end: after
// output that didn't, the shell goes on to the next line by filling the one it's on, which is then one
// line with it. And what's empty at the end of an output is taken off it anyway.
export function promptHeight(tail, added) {
  const first = tail.slice(-added).findIndex(line => line.trim() !== '');
  return Math.max(added - Math.max(first, 0), 1);
}

// The lines above line `index`, as they read, which it's known by when it isn't where it was.
export const contextOf = (lines, index) => lines.slice(Math.max(index - CONTEXT_LINES, 0), Math.max(index, 0)).map(plain);

// Where the line a mirrored terminal's command was typed on is, in what's read now. It's where it was,
// by `starts`, when the command is on it under the lines that were above it. Failing that, as when the
// terminal was cleared since or has let go of older lines, it's the last line that's the prompt with
// the command after it, or the last one with the command on it under those lines. Undefined when it's
// nowhere to be found. With no command, as for a program that was already running, it's the line that
// was the last one then, known by where it was or by the lines above it.
export function anchorLine(lines, starts, { offset, text, typed, context = [] }) {
  const hasCommand = at => typed === undefined || squashed(plain(lines[at])).includes(typed);
  const isUnder = at => context.every((line, index) => {
    const above = at - context.length + index;
    return above < 0 || plain(lines[above]) === line;
  });
  const at = offset === undefined ? -1 : starts.indexOf(offset);
  if (at >= 0 && hasCommand(at) && isUnder(at)) return at;
  if (typed !== undefined) {
    const whole = squashed(text) + typed;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (squashed(plain(lines[i])) === whole) return i;
    }
  }
  if (!context.length) return undefined;
  for (let i = lines.length - 1; i >= context.length; i--) {
    if (hasCommand(i) && isUnder(i)) return i;
  }
  return undefined;
}

// The line a command was typed on, and what was typed, in a terminal whose prompt reads `prompt` with
// nothing typed at it: the last line that starts with it and has something after. Lines the terminal
// has let go of went from the top, so one that's still there is never older than the one looked for.
export function commandLineOf(lines, prompt) {
  if (!prompt) return undefined;
  for (let index = lines.length - 1; index >= 0; index--) {
    const text = plain(lines[index]);
    const command = text.startsWith(`${prompt} `) ? text.slice(prompt.length).trim() : '';
    if (command) return { index, command };
  }
  return undefined;
}

// How many of the lines above a prompt's own line are the prompt's too, going by two places it was
// drawn: above the line a command was typed on, and above the line the shell waits on now. A prompt of
// several lines starts with an empty one, as most are set up to, and it's those lines when they read
// the same in both places, down from an empty one. Anything else is taken for a prompt of one line:
// what's above could as well be the ends of what two commands printed alike. Used only where the
// prompt was never measured, as it is before a command is sent from a client.
export function promptLinesAbove(lines, typedAt, waitingAt) {
  for (let above = 1; above <= CONTEXT_LINES; above++) {
    const [typed, waiting] = [lines[typedAt - above], lines[waitingAt - above]].map(line => (line === undefined ? undefined : plain(line)));
    if (typed === undefined || typed !== waiting) return 0;
    if (typed.trim() === '') return above;
  }
  return 0;
}

// A page of what a terminal session did, as `history` gives Claude Code's: it starts where a command
// or a line sent to one does, so that an output never comes without the line it's under.
export function historyPage(items, { limit = 60, before } = {}) {
  const end = Number.isInteger(before) ? Math.min(Math.max(before, 0), items.length) : items.length;
  let start = Math.max(0, end - Math.max(limit, 1));
  while (start > 0 && items[start].role !== 'user') start -= 1;
  return { items: items.slice(start, end), before: start, hasMore: start > 0 };
}

export class Terminals {
  #store;
  #root;
  #shellDir;
  #backends;
  #useRex;
  #env;
  #tickMs;
  #liveCheckMs;
  #git;
  #mirrors;
  #syncing;
  #settling;
  #syncedAt = 0;
  // What's kept of mirrored terminals from before a restart, until Rex says which are still open.
  #strays = new Set();
  #timer;
  #ticking = false;
  #terminals = new Map();

  constructor({
    store, root, shellDir, backends = { rex, tmux }, env = process.env,
    useRex = () => (env.VENES_TERMINAL ? env.VENES_TERMINAL === 'rex' : rex.isInstalled()), tickMs = TICK_MS,
    liveCheckMs = LIVE_CHECK_MS, git = gitState, mirrors = true,
  }) {
    this.#store = store;
    this.#root = root;
    this.#shellDir = shellDir;
    this.#backends = backends;
    this.#useRex = useRex;
    this.#env = env;
    this.#tickMs = tickMs;
    this.#liveCheckMs = liveCheckMs;
    this.#git = git;
    this.#mirrors = mirrors;
  }

  has(id) { return typeof id === 'string' && this.#terminals.has(id); }

  // Those from before a restart. Their shells went on in Rex or tmux, and are followed again from where
  // they are. One whose terminal has gone has ended, and keeps what it did.
  async restore() {
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    for (const id of fs.readdirSync(this.#root)) {
      const meta = readJSON(path.join(this.#root, id, META));
      // What a mirrored terminal did is kept with no record of the terminal, which is Rex's to give.
      if (!fs.existsSync(path.join(this.#root, id, META))) this.#strays.add(id);
      if (!meta?.id || meta.id !== id) continue;
      const t = { ...meta, pending: [], fullScreen: false, checkedAt: Date.now() };
      t.folder = this.#cwdOf(t);
      const alive = !meta.ended && meta.target && (await this.#backend(t).isSessionOpen(meta.name, meta.target).catch(() => false));
      t.ended = !alive;
      // One started before the terminal's own width was kept, or sized since by whoever has it open.
      if (alive) t.columns = (await this.#backend(t).size(t.target).catch(() => undefined))?.columns ?? t.columns;
      t.status = t.ended ? 'ended' : t.running ? 'running' : 'idle';
      this.#terminals.set(id, t);
      this.#adopt(t);
      // A command that was running when its terminal went is over, with what was last read of it.
      if (t.ended && t.running) this.#finishUnseen(t, null);
    }
    this.#timer ??= setInterval(() => { this.#tick(); }, this.#tickMs);
    this.#timer.unref?.();
    this.#watchMirrors();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    clearTimeout(this.#settling);
    for (const backend of Object.values(this.#backends)) {
      backend.watchTerminals?.(undefined);
      backend.closeLink?.()?.catch(() => {});
    }
  }

  // The terminals the reader has open in Rex are sessions too, for as long as they're open: Rex says
  // when they change, and they're looked at then. Settles once they've been looked at the first time.
  #watchMirrors() {
    const backend = this.#backends.rex;
    if (!this.#mirrors || !backend?.listTerminals || !this.#useRex()) return Promise.resolve();
    backend.watchTerminals?.(() => this.#mirrorsChanged());
    return this.syncMirrors();
  }

  #mirrorsChanged() {
    if (this.#settling || !this.#timer) return;
    this.#settling = setTimeout(() => {
      this.#settling = undefined;
      this.syncMirrors();
    }, MIRROR_SETTLE_MS);
    this.#settling.unref?.();
  }

  // Makes the mirrored sessions what Rex's open terminals are now: a new one for each terminal in a
  // window that's the reader's own, and none any more for one that has closed. A terminal Claude Code
  // runs in is that session's, and one the helper started is already a session of another kind.
  syncMirrors() {
    this.#syncing = (this.#syncing ?? Promise.resolve()).then(async () => {
      this.#syncedAt = Date.now();
      let listed;
      try {
        listed = await this.#backends.rex.listTerminals();
      } catch {
        return; // Rex isn't there to ask, and what's known stays until it is
      }
      const taken = new Set([
        ...[...this.#terminals.values()].filter(t => !t.mirror && !t.ended).map(t => t.target?.pane),
        ...this.#store.sessions().filter(session => !session.terminal && session.status !== 'ended').map(session => session.pane),
      ]);
      const open = new Map(listed
        .filter(found => !taken.has(found.pane) && found.program !== CLAUDE && !OWN_LABEL.test(found.label ?? ''))
        .map(found => [mirrorId(found.pane), found]));
      // A terminal the helper started is in Rex too, where the program a command started can say it's
      // at rest.
      for (const t of [...this.#terminals.values()].filter(t => !t.mirror && !t.ended && t.running)) {
        const found = listed.find(terminal => terminal.pane === t.target?.pane);
        if (found) this.#setAtRest(t, Boolean(frontOf(found.program)) && found.working === false);
      }
      for (const t of [...this.#terminals.values()].filter(t => t.mirror && !open.has(t.id))) this.#dropMirror(t);
      // One that closed while the helper was away has nothing to keep either.
      for (const id of this.#strays) {
        if (!open.has(id)) fs.rmSync(path.join(this.#root, id), { recursive: true, force: true });
      }
      this.#strays.clear();
      for (const [id, found] of open) {
        const known = this.#terminals.get(id);
        if (known) this.#updateMirror(known, found);
        else this.#addMirror(id, found);
      }
    }).catch(error => console.error(`mirrors: ${error.message}`));
    return this.#syncing;
  }

  #addMirror(id, { pane, rexSession, label, program, cwd, working }) {
    const now = Date.now();
    const front = frontOf(program);
    const t = {
      id, mirror: true, name: label, cwd, folder: cwd, startedAt: now, lastActiveAt: now, backend: 'rex', target: { pane, rexSession },
      status: front ? 'running' : 'idle', front, saidFront: front, lastCommand: front, size: { ...DEFAULT_SIZE }, pending: [], fullScreen: false,
      checkedAt: now,
    };
    this.#terminals.set(id, t);
    this.#adopt(t);
    this.#store.report(id, 'session.discovered', { cwd, terminal: true, mirror: true, ...(front && { program: front }) });
    this.#store.report(id, 'session.attached', { pane });
    // A program that's waiting for its next line was running before anyone looked, and isn't at work.
    if (front && working === false) this.#setAtRest(t, true);
  }

  // Where its shell is, and what's in front of it, as Rex now has them. The folder is the shell's own,
  // and not that of a program it's running, which may work somewhere else.
  #updateMirror(t, { program, cwd, working }) {
    const front = frontOf(program);
    if (cwd && cwd !== t.folder && !front) {
      t.cwd = cwd;
      t.folder = cwd;
      this.#store.report(t.id, 'session.cwd', { cwd }, { fields: { cwd } });
    }
    t.front = front;
    this.#sayFront(t);
    const isAtRest = Boolean(front) && working === false;
    const status = t.running || front ? 'running' : 'idle';
    if (status === t.status && isAtRest === Boolean(t.isAtRest)) return;
    t.isAtRest = isAtRest;
    this.#setStatus(t, status);
  }

  // The program in front of a terminal session says it's at rest, or at work again: waiting for the
  // reader's next line isn't running anything, though the program is still there.
  #setAtRest(t, isAtRest) {
    if (Boolean(t.isAtRest) === isAtRest) return;
    t.isAtRest = isAtRest;
    if (t.status === 'running') this.#setStatus(t, 'running');
  }

  // The program in front is what a list has to say of a mirrored terminal that was sent no command. One
  // that a command sent from here started is that command's, which the list already has.
  #sayFront(t) {
    if (t.running?.command || t.front === t.saidFront) return;
    t.saidFront = t.front;
    t.lastCommand = t.front;
    this.#store.report(t.id, 'terminal.program', t.front ? { program: t.front } : {}, { fields: { lastPrompt: t.front } });
  }

  // What's in front of a mirrored terminal's shell, asked now: what Rex said last may be a moment old,
  // which is long enough for a command to have started or ended.
  async #frontNow(t) {
    const found = await this.#backend(t).front?.(t.target)?.catch(() => undefined);
    if (found) this.#updateMirror(t, found);
    return t.front;
  }

  // It has closed in Rex, or isn't the reader's own any more, so it's no session.
  #dropMirror(t) {
    if (t.running) this.#finishUnseen(t, null);
    t.ended = true;
    this.#terminals.delete(t.id);
    fs.rmSync(this.#dir(t), { recursive: true, force: true });
    this.#store.report(t.id, 'session.ended', { reason: 'exited' });
    this.#store.forget(t.id);
  }

  // A shell in `cwd`, ready for its first command: the reply waits for its first prompt.
  async start({ cwd, columns, rows } = {}) {
    const folder = checkedFolder(cwd);
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = {
      id, name: `${NAME_PREFIX}${id.slice(0, 8)}`, cwd: folder, folder, startedAt: now, lastActiveAt: now, size: sizeOf({ columns, rows }),
      pending: [], fullScreen: false, checkedAt: now, status: 'idle',
    };
    fs.mkdirSync(this.#dir(t), { recursive: true, mode: 0o700 });
    try {
      await this.#launch(t, folder);
    } catch (error) {
      fs.rmSync(this.#dir(t), { recursive: true, force: true });
      throw error;
    }
    this.#terminals.set(id, t);
    this.#adopt(t);
    this.#store.report(id, 'session.discovered', { cwd: folder, terminal: true });
    this.#store.report(id, 'session.attached', { pane: t.target.pane });
    this.#save(t);
    this.#timer ??= setInterval(() => { this.#tick(); }, this.#tickMs);
    this.#timer.unref?.();
    return { sessionId: id };
  }

  // A command, typed at the prompt, or a line for the command that's running. A shell that has gone is
  // started again where it last was. A line for a program that has the screen to itself says so, with
  // `page`, for a client to show it again: one that takes it from now on says so with `terminal.screen`.
  send(id, { text, clientId, columns, rows }) {
    const t = this.#get(id);
    if (typeof text !== 'string' || !text.trim()) throw new HelperError('bad_text', 'Nothing to send.');
    return this.#exclusive(t, async () => {
      await this.#ready(t);
      const hasResized = await this.#fit(t, { columns, rows });
      if (t.mirror) {
        if (hasResized) await pause(RESIZE_SETTLE_MS);
        const front = await this.#frontNow(t);
        if (t.running && !front) await this.#settle(t);
        // At its shell's prompt, a line is a command. With a program in front that was started at the
        // Mac, it's a line for that program, which is followed from here on.
        if (!t.running && !front) {
          await this.#run(t, { text, clientId });
          return { queued: false };
        }
        // With its page open somewhere, the program has a line of its own first, as it has there.
        if (!t.running && t.viewers?.size) await this.#watch(t);
        if (!t.running) await this.#attach(t);
      }
      if (t.running) {
        try {
          const reply = await this.#input(t, { text, clientId });
          return { ...reply, ...((await this.#isFullScreen(t)) && { page: true }) };
        } catch (error) {
          // A program at the Mac that the line never reached isn't followed.
          if (t.mirror && !t.running.segments.length) t.running = undefined;
          throw error;
        }
      }
      t.pending = [...t.pending.filter(sent => Date.now() - sent.at < PENDING_LIFETIME_MS), { clientId, text, at: Date.now() }].slice(-MAX_PENDING);
      await this.#type(t, text);
      await this.#followSoon(t);
      return { queued: false };
    });
  }

  // Moves the shell to another folder, by typing `cd` at its prompt, so it shows as the command it is.
  // A command that's running would take the line for itself, so it has to end first.
  async cd(id, { path: folder } = {}) {
    const t = this.#get(id);
    const target = checkedFolder(folder);
    return this.#exclusive(t, async () => {
      await this.#ready(t);
      const isBusy = t.mirror ? Boolean((await this.#frontNow(t)) || t.running) : this.#isBusy(t);
      if (isBusy) throw new HelperError('terminal_busy', 'A command is running. Wait for it to end, or stop it.');
      const command = `cd ${shellQuoted(target)}`;
      if (t.mirror) {
        await this.#run(t, { text: command });
      } else {
        await this.#type(t, command);
        await this.#followSoon(t);
      }
      return {};
    });
  }

  // Where its shell is, and what git says of that folder, as a shell's prompt would.
  async status(id) {
    const t = this.#get(id);
    const cwd = this.#cwdOf(t);
    const git = await this.#git(cwd);
    return { status: { cwd, home: this.#env.HOME || os.homedir(), running: this.#isBusy(t), ...(git && { git }) } };
  }

  // A client has this terminal's page open, with this much room: the terminal is that size from now on,
  // whoever else has it open, until the client leaves. With several looking, it's the last one's.
  view(id, { columns, rows } = {}, viewer) {
    const t = this.#get(id);
    return this.#exclusive(t, async () => {
      t.viewers ??= new Map();
      t.viewers.delete(viewer);
      t.viewers.set(viewer, sizeOf({ columns, rows }, t.size));
      if (!t.ended) await this.#fit(t, { columns, rows });
      if (t.mirror && !t.ended && !t.running) await this.#lookAtMirror(t).catch(() => {});
      return { columns: t.columns ?? t.size.columns, rows: t.size.rows };
    });
  }

  // A client has just opened a mirrored terminal's page, with nothing being followed there. A program
  // running in it, which was started at the Mac, is followed from now, and read at once for the page to
  // open on. At a prompt, what the prompt reads is kept, for finding a command typed at the Mac later.
  async #lookAtMirror(t) {
    if (await this.#frontNow(t)) {
      await this.#watch(t);
      await this.#readMirror(t);
      return;
    }
    t.promptSeen = tailOf((await this.#look(t)).lines).text || undefined;
  }

  // The client has gone from the page. With no one left looking, the terminal is whoever else's has it.
  leave(id, viewer) {
    const t = this.has(id) ? this.#terminals.get(id) : undefined;
    if (!t?.viewers?.delete(viewer)) return {};
    return this.#exclusive(t, async () => {
      if (t.ended) return {};
      const [last] = [...t.viewers.values()].slice(-1);
      if (last) await this.#fit(t, last);
      else await this.#backend(t).giveBack?.(t.target)?.catch(() => {});
      return {};
    });
  }

  // A client's connection has closed, and with it every page it had open.
  leaveAll(viewer) {
    for (const t of this.#terminals.values()) {
      if (t.viewers?.has(viewer)) Promise.resolve(this.leave(t.id, viewer)).catch(() => {});
    }
  }

  // Ctrl-C, as at the terminal.
  async interrupt(id) {
    const t = this.#get(id);
    if (t.ended || !this.#isBusy(t)) throw new HelperError('not_running', 'Nothing to interrupt.');
    await this.#backend(t).pressKey(t.target, 'C-c');
    return {};
  }

  // Everything needed to open a terminal session, as `join` gives a Claude Code session's: what it did,
  // with the output of a command still running as far as it has got. Nothing here waits, so every
  // event after `seq` follows on the wire.
  join(id, { limit } = {}) {
    const t = this.#get(id);
    const page = historyPage(this.#items(t), { limit });
    return {
      ...page, turn: [], queued: [], seq: this.#store.seq, requests: [],
      sessions: this.#store.sessions().filter(session => session.id === id),
    };
  }

  history(id, { limit, before } = {}) {
    return historyPage(this.#items(this.#get(id)), { limit, before });
  }

  // What a program that has the screen to itself shows, as a page: null while none has.
  async page(id) {
    const t = this.#get(id);
    if (t.ended || !(await this.#isFullScreen(t))) return { page: null };
    // Such a program's screen has nothing above it, so what's read is the screen.
    const lines = screenCells(await this.#backend(t).readStyledScreen(t.target)).map(cells => {
      let last = cells.length;
      while (last > 0 && cells[last - 1].char === ' ' && !cells[last - 1].style.background && !cells[last - 1].style.inverse) last -= 1;
      return runsOf(cells.slice(0, last));
    });
    while (lines.length && !lines.at(-1).length) lines.pop();
    return { page: { lines } };
  }

  async pageKey(id, key) {
    if (!PAGE_KEYS.includes(key)) throw new HelperError('bad_key', `${key} isn't a key a page takes.`);
    const t = await this.#fullScreen(id);
    await this.#backend(t).pressKey(t.target, key);
    this.#readSoon(t);
    return {};
  }

  async pageText(id, text) {
    const t = await this.#fullScreen(id);
    await this.#backend(t).paste(t.target, text);
    this.#readSoon(t);
    return {};
  }

  // What a key or some text did to the program that has the screen shows in its output at the next look.
  #readSoon(t) {
    if (!t.running) return;
    t.running.changedAt = Date.now();
    t.running.readAt = 0;
  }

  // The program goes on: only it knows how it's left, which may lose work, so that's for the reader.
  pageClose(id) {
    this.#get(id);
    return {};
  }

  // Its shell ends, and what it did goes from this Mac.
  async remove(id) {
    const t = this.#get(id);
    await this.#exclusive(t, async () => {
      if (!t.ended && t.target) await this.#backend(t).closeSession(t.name, t.target).catch(() => {});
      t.ended = true;
    });
    this.#terminals.delete(id);
    fs.rmSync(this.#dir(t), { recursive: true, force: true });
    this.#store.forget(id);
    return {};
  }

  // Its shell at hand, and what it's doing known: one closed at the Mac since it was last looked at
  // has ended, like any other, and one that has ended is started again.
  async #ready(t) {
    // A mirrored terminal is there for as long as Rex has it, and has no shell of the helper's to start.
    if (t.mirror) return;
    if (!t.ended && Date.now() - t.checkedAt >= LIVE_FRESH_MS && !(await this.#isOpen(t))) this.#end(t);
    if (t.ended) await this.#relaunch(t);
    else await this.#follow(t);
  }

  #get(id) {
    const t = this.has(id) ? this.#terminals.get(id) : undefined;
    if (!t) throw new HelperError('unknown_session', `No terminal session ${id}`);
    return t;
  }

  #dir(t) { return path.join(this.#root, t.id); }

  #backend(t) { return this.#backends[t.backend ?? 'tmux']; }

  // One thing at a time for each terminal, so that a read and a send never cross.
  #exclusive(t, work) {
    const run = (t.lock ?? Promise.resolve()).then(work);
    t.lock = run.catch(() => {});
    return run;
  }

  #adopt(t) {
    this.#store.adopt({
      id: t.id, kind: TERMINAL_KIND, status: t.status, cwd: this.#cwdOf(t), pane: t.ended ? undefined : t.target?.pane,
      startedAt: t.startedAt, lastEventAt: t.lastActiveAt, lastPrompt: t.lastCommand, ...(t.mirror && { mirror: true }),
    });
  }

  // Where its shell is: as its hooks last wrote, or for a mirrored terminal, as Rex last said.
  #cwdOf(t) { return t.mirror ? t.cwd : readText(path.join(this.#dir(t), 'cwd')) || t.cwd; }

  // Something is running in it, which a line typed now would go to.
  #isBusy(t) { return t.mirror ? t.status === 'running' : Boolean(t.running); }

  #save(t) {
    if (t.mirror) return;
    const { id, name, cwd, folder, startedAt, lastActiveAt, backend, target, ended, lastCommand, seen, size, running } = t;
    const kept = running && { ...running, tail: undefined, main: undefined };
    const meta = { id, name, cwd, folder, startedAt, lastActiveAt, backend, target, ended, lastCommand, seen, size, columns: t.columns, running: kept };
    fs.writeFileSync(path.join(this.#dir(t), META), JSON.stringify(meta), { mode: 0o600 });
  }

  // A shell with the hooks, in a terminal of its own, once it's at its first prompt.
  async #launch(t, cwd) {
    installShellFiles(this.#shellDir);
    for (const name of ['state', 'command', 'prompt', 'cwd']) fs.rmSync(path.join(this.#dir(t), name), { force: true });
    const { command, env } = shellCommand({ shellDir: this.#shellDir, terminalDir: this.#dir(t), env: this.#env });
    t.backend = this.#useRex() ? 'rex' : 'tmux';
    const backend = this.#backend(t);
    const socket = this.#env.VENES_TMUX_SOCKET;
    t.target = await backend.startSession({ name: t.name, cwd, command, env: { ...env, ...(socket && { VENES_TMUX_SOCKET: socket }) }, size: t.size });
    // In Rex it starts at Rex's own size, and is this one's only if no one has its window open.
    await backend.resize(t.target, t.size).catch(() => {});
    t.columns = (await backend.size(t.target).catch(() => undefined))?.columns ?? t.size.columns;
    for (const deadline = Date.now() + START_LIMIT_MS; Date.now() < deadline; await pause(START_CHECK_MS)) {
      const state = parseState(readText(path.join(this.#dir(t), 'state')));
      if (state) {
        t.seen = state.key;
        t.ended = false;
        t.running = undefined;
        return;
      }
      if (!(await backend.isSessionOpen(t.name, t.target).catch(() => false))) throw new HelperError('start_failed', 'The shell quit before it was ready.');
    }
    await backend.closeSession(t.name, t.target).catch(() => {});
    throw new HelperError('start_failed', 'The shell took too long to start.');
  }

  // A shell that has gone, started again where it last was, as a stopped Claude Code session is resumed.
  async #relaunch(t) {
    const last = this.#cwdOf(t);
    await this.#launch(t, last && fs.existsSync(last) ? last : t.cwd);
    t.status = 'idle';
    this.#noteFolder(t);
    this.#store.report(t.id, 'session.attached', { pane: t.target.pane }, { fields: { pane: t.target.pane } });
    this.#store.report(t.id, 'session.status', { status: 'idle' });
    this.#save(t);
  }

  // The client's size, so that what a program lays out fits where it's read. The terminal is asked what
  // size it really is, before and after: one that someone has open in a window is that window's size
  // whatever is asked of it, and its output is as wide as it is. True when it had to change.
  async #fit(t, size) {
    const wanted = sizeOf(size, t.size);
    const backend = this.#backend(t);
    t.size = wanted;
    let real = await backend.size(t.target).catch(() => undefined);
    const fits = Boolean(real) && real.columns === wanted.columns && real.rows === wanted.rows;
    if (!fits) {
      // For a client with its page open, the terminal is taken from whoever has it. Otherwise it's only
      // asked, which someone with it open at the Mac overrules.
      const taken = t.viewers?.size && backend.takeSize ? await backend.takeSize(t.target, wanted).then(() => true, () => false) : false;
      if (!taken) await backend.resize(t.target, wanted).catch(() => {});
      real = await backend.size(t.target).catch(() => real);
    }
    t.columns = real?.columns ?? wanted.columns;
    return !fits;
  }

  async #type(t, text) {
    const backend = this.#backend(t);
    await backend.paste(t.target, text);
    await pause(PASTE_SETTLE_MS);
    await backend.pressKey(t.target, 'Enter');
  }

  // What was just typed is said as soon as the shell runs it, without waiting for the next look. A
  // command can take its terminal with it, as `exit` does, and the line was still sent: the next look
  // finds that the shell has gone.
  async #followSoon(t) {
    const before = t.seen;
    for (const deadline = Date.now() + SOON_LIMIT_MS; Date.now() < deadline && !t.running && t.seen === before;) {
      await pause(SOON_CHECK_MS);
      try {
        await this.#follow(t);
      } catch {
        return;
      }
    }
  }

  async #isFullScreen(t) {
    return this.#backend(t).isFullScreen(t.target).catch(() => false);
  }

  async #fullScreen(id) {
    const t = this.#get(id);
    if (t.ended || !(await this.#isFullScreen(t))) throw new HelperError('no_page', 'Nothing is open in the terminal.');
    return t;
  }

  async #tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      // Each by itself, so that one that's slow, as a shell starting again is, doesn't hold up the rest.
      if (this.#mirrors && Date.now() - this.#syncedAt >= MIRROR_SYNC_MS && this.#backends.rex?.listTerminals && this.#useRex()) this.syncMirrors();
      await Promise.all([...this.#terminals.values()].filter(t => !t.ended).map(t => this.#exclusive(t, async () => {
        if (t.ended) return;
        // A mirrored terminal is read while what was sent to it runs, and Rex says when it closes. A
        // program started at the Mac is read while someone has the page open, and once more when it's
        // over, to say so.
        if (t.mirror) {
          if (!t.running && t.front && t.viewers?.size) await this.#watch(t);
          const running = t.running;
          const isFollowed = running && (!running.isWatched || t.viewers?.size > 0 || !t.front);
          if (isFollowed && Date.now() - running.readAt >= this.#readEvery(running)) await this.#readMirror(t);
          return;
        }
        if (Date.now() - t.checkedAt >= this.#liveCheckMs && !(await this.#isOpen(t))) {
          this.#end(t);
          return;
        }
        await this.#follow(t);
      }).catch(error => {
        // Most likely its terminal has gone, which the next look checks first.
        t.checkedAt = 0;
        console.error(`terminal ${t.id}: ${error.message}`);
      })));
    } finally {
      this.#ticking = false;
    }
  }

  async #isOpen(t) {
    t.checkedAt = Date.now();
    return this.#backend(t).isSessionOpen(t.name, t.target).catch(() => true);
  }

  // Its shell has gone, with the terminal it was in. A command it was running ends with what it showed.
  #end(t) {
    if (t.running) this.#finishUnseen(t, null);
    t.ended = true;
    t.status = 'ended';
    this.#store.report(t.id, 'session.status', { status: 'ended' }, { fields: { pane: undefined } });
    this.#store.report(t.id, 'session.ended', { reason: 'exited' });
    this.#save(t);
  }

  // What the hooks say now, against what was last heard.
  async #follow(t) {
    const state = parseState(readText(path.join(this.#dir(t), 'state')));
    if (!state) return;
    if (state.kind === 'running') {
      if (t.running && t.running.key !== state.key) this.#finishUnseen(t, 'idle');
      if (!t.running && state.key !== t.seen) this.#begin(t, state);
      if (t.running && Date.now() - t.running.readAt >= this.#readEvery(t.running)) await this.#readRunning(t);
      return;
    }
    if (t.running?.key === state.key) {
      await this.#finishWhenPrompted(t, state);
      return;
    }
    // The shell went on without a word, as a nested one does when it exits.
    if (t.running) this.#finishUnseen(t, 'idle');
    if (state.key === t.seen) return;
    // A new shell's first prompt is no command.
    if (state.seq === 0) {
      t.seen = state.key;
      this.#save(t);
      return;
    }
    // One that came and went between two looks.
    this.#begin(t, state);
    await this.#finishWhenPrompted(t, state);
  }

  // A command started, from here or typed at the Mac. One sent from here keeps its send's id. Its
  // output comes in parts: its own, then one for each line sent to it while it runs.
  #begin(t, state) {
    const command = readText(path.join(this.#dir(t), 'command')) ?? '';
    const sent = this.#takeSent(t, command);
    const line = sent?.clientId ?? `${t.id.slice(0, 8)}-${state.pid}-${state.seq}`;
    const now = Date.now();
    t.running = { key: state.key, pid: state.pid, seq: state.seq, command, at: now, segments: [{ line }], readAt: 0 };
    t.isAtRest = false;
    t.lastCommand = command;
    t.lastActiveAt = now;
    this.#append(t, { role: 'user', text: command, shell: true, at: now });
    this.#store.report(t.id, 'message.user', { text: command, shell: true, clientId: line }, { fields: { lastPrompt: command } });
    this.#setStatus(t, 'running');
    this.#save(t);
  }

  // The send a command came from: the one with its text, or else the oldest still on its way.
  #takeSent(t, command) {
    const fresh = t.pending.filter(sent => Date.now() - sent.at < PENDING_LIFETIME_MS);
    const index = Math.max(fresh.findIndex(sent => sent.text.trim() === command.trim()), 0);
    const [sent] = fresh.splice(index, 1);
    t.pending = fresh;
    return sent?.clientId ? sent : undefined;
  }

  async #readBody(t) {
    if (t.mirror) return this.#bodyOf(t, await this.#look(t));
    const { text, cut } = await this.#backend(t).readOutput(t.target);
    const lines = vtLines(text);
    // The start of what was read is the middle of a line, and the command's own is long gone.
    return cut ? { lines: lines.slice(1), cut } : { lines: outputBody(lines, t.running?.command ?? ''), cut };
  }

  #readEvery(running) {
    if (running.anchor && Date.now() - running.at < EAGER_FOR_MS) return 0;
    return Date.now() - (running.changedAt ?? running.at) < QUIET_AFTER_MS ? READ_EVERY_MS : QUIET_READ_EVERY_MS;
  }

  // What a running command has printed, sent when it has changed. While a program it started has the
  // screen to itself, what that shows is read in its place.
  async #readRunning(t) {
    const running = t.running;
    running.readAt = Date.now();
    const full = await this.#isFullScreen(t);
    if (full !== t.fullScreen) {
      t.fullScreen = full;
      running.changedAt = Date.now();
      this.#store.report(t.id, 'terminal.screen', { fullScreen: full });
    }
    if (full) {
      await this.#readScreen(t);
      return;
    }
    const { lines, cut } = await this.#readBody(t);
    running.tail = cut ? undefined : tailOf(lines);
    running.main = { lines, cut };
    if (this.#sendParts(t, lines, cut, {})) running.changedAt = Date.now();
  }

  // What a program that has the screen to itself shows now, in the form a command's output is sent in.
  // Only the lines at its foot that show nothing at all go: one of nothing but a background is a bar.
  async #screenText(t) {
    const lines = screenLines(await this.#backend(t).readStyledScreen(t.target));
    let end = lines.length;
    while (end > 0 && plain(lines[end - 1]) === '') end -= 1;
    return capped(lines.slice(0, end), { maxLines: MAX_LINES, maxChars: MAX_CHARS });
  }

  // A program has the screen to itself. What it shows is the last line's to show, over what that line
  // printed before: the command's own, or the last one sent to the program, which takes the screen
  // from the line before it. What was printed is as it was last read, since nothing more is while the
  // program has the screen.
  async #readScreen(t) {
    const running = t.running;
    const last = running.segments.at(-1);
    if (!last) return;
    last.screen = await this.#screenText(t);
    const { lines = [], cut = false } = running.main ?? {};
    if (this.#sendParts(t, lines, cut, {})) running.changedAt = Date.now();
  }

  // Each part of the running command's output that isn't what a client was last sent, sent again whole.
  // Only the last can still grow. With `done`, that one is over too, and says how the command ended.
  // Output too long to read from its start can't be parted, so all that's read is the last part's.
  // What a program showed with the screen to itself comes first in its line's part, as it was shown
  // before anything printed after it.
  #sendParts(t, lines, cut, { done = false, code } = {}) {
    const { segments } = t.running;
    const withScreen = (segment, part) => [segment.screen, part].filter(Boolean).join('\n');
    const texts = cut
      ? segments.map((segment, index) => (index === segments.length - 1 ? withScreen(segment, partFrom(lines, 0)) : segment.sent?.text ?? ''))
      : partTexts(lines, segments.map(segment => segment.mark)).map((part, index) => withScreen(segments[index], part));
    let changed = false;
    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;
      const text = texts[index];
      const running = isLast && !done;
      const sent = segment.sent ?? { text: '', running: false };
      const ends = isLast && done && (text !== '' || code);
      if (text === sent.text && (running === sent.running || text === '') && !ends) return;
      segment.sent = { text, running };
      changed = true;
      this.#store.report(
        t.id, 'message.output',
        { stdout: text, stderr: '', replies: false, clientId: segment.line, running, ...this.#width(t), ...(ends && code !== undefined && { exitCode: code }) },
        { supersedes: event => event.kind === 'message.output' && event.clientId === segment.line },
      );
    });
    return changed;
  }

  // What a mirrored terminal holds now, and where each of its lines starts among all it has held.
  async #look(t) {
    const { text, cut, end } = await this.#backend(t).readOutput(t.target);
    const lines = vtLines(text);
    return { text, cut, lines, starts: lineStarts(text, lines.length, end) };
  }

  // What's under a mirrored terminal's running command, in what's read of the terminal now. When its
  // own line can't be found, as when more has been printed since than is read, all that's read is its,
  // and can't be parted. A program that had the screen to itself when it was first sent a line has
  // nowhere to start from, and what it prints then is no line's.
  #bodyOf(t, look) {
    const { anchor } = t.running;
    if (anchor.isPlaceless) return { lines: [], cut: false, isPlaceless: true };
    const at = anchorLine(look.lines, look.starts, anchor);
    if (at === undefined) return { lines: look.cut ? look.lines.slice(1) : look.lines, cut: true };
    return { lines: look.lines.slice(at + anchor.span), cut: false, ...(anchor.typed !== undefined && { typedAt: at }) };
  }

  // The shell's prompt, which only the shell knows: Ctrl-C at it draws it again under itself, and how
  // far down the last line has gone is how many lines it takes, of which those that show something
  // count. Its last line is what the shell says while it waits. Ctrl-C also takes away anything typed
  // there, which a command would be added to.
  async #measure(t, before) {
    const was = tailLines(before.lines);
    await this.#backend(t).pressKey(t.target, 'C-c');
    let last;
    for (const deadline = Date.now() + MEASURE_LIMIT_MS; ;) {
      await pause(MEASURE_CHECK_MS);
      const look = await this.#look(t);
      const now = tailLines(look.lines);
      const added = linesAdded(was, now);
      // Drawn, once it's there and has stopped changing.
      if ((added > 0 && look.text === last?.text) || Date.now() >= deadline) {
        t.prompt = { height: promptHeight(now, Math.max(added, 1)), text: tailOf(look.lines).text };
        return look;
      }
      last = look;
    }
  }

  // A command for a mirrored terminal's shell, typed at its prompt. Where the prompt's line is, is noted
  // first, as what the command prints is what comes under it. It's said at once, as nothing in the shell
  // says when it runs.
  async #run(t, { text, clientId }) {
    let look = await this.#look(t);
    // A prompt that isn't known yet, or has something typed at it, is drawn afresh.
    if (!promptLike(tailOf(look.lines).text, t.prompt?.text)) look = await this.#measure(t, look);
    const tail = tailOf(look.lines);
    const command = text.trim();
    const anchor = {
      offset: look.starts[Math.max(tail.index, 0)], text: tail.text, context: contextOf(look.lines, tail.index),
      typed: squashed(command.split('\n')[0]), span: text.replace(/\n+$/, '').split('\n').length,
    };
    await this.#type(t, text);
    const now = Date.now();
    const line = clientId ?? `${t.id.slice(0, 8)}-${now.toString(36)}`;
    t.running = { command, at: now, readAt: 0, segments: [{ line }], before: look.text, anchor };
    t.lastCommand = command;
    t.lastActiveAt = now;
    this.#append(t, { role: 'user', text: command, shell: true, at: now });
    this.#store.report(t.id, 'message.user', { text: command, shell: true, clientId: line }, { fields: { lastPrompt: command } });
    if (t.status !== 'running') this.#setStatus(t, 'running');
  }

  // A program that was started at the Mac is in front of a mirrored terminal's shell, and a line is on
  // its way to it. What it prints from here on is followed as a command's is, under the lines sent to
  // it: from the last line it has printed on, which the line sent may show on.
  async #attach(t) {
    const look = (await this.#isFullScreen(t)) ? undefined : await this.#look(t);
    const tail = look && tailOf(look.lines);
    const anchor = look
      ? { offset: look.starts[Math.max(tail.index, 0)], text: tail.text, context: contextOf(look.lines, tail.index), span: 0 }
      : { isPlaceless: true, span: 0 };
    t.running = { at: Date.now(), readAt: 0, segments: [], before: look?.text, anchor };
  }

  // A program that was started at the Mac is in front of a mirrored terminal's shell, and a client has
  // the terminal's page open. It's followed as a command sent from a client is, under a line of its own.
  // With the screen to itself, what it shows is all there is to it, and the line is its name. Otherwise
  // its output starts under the line it was typed on, when the prompt is known and that line can be
  // found, and the line is what was typed. Failing that, it's the program's name, with what it prints
  // from now on.
  async #watch(t) {
    const now = Date.now();
    let text = t.front;
    let anchor = { isPlaceless: true, span: 0 };
    if (!(await this.#isFullScreen(t))) {
      const look = await this.#look(t);
      const prompt = t.prompt?.text ?? t.promptSeen;
      const typed = commandLineOf(look.lines, prompt);
      const tail = tailOf(look.lines);
      const index = typed ? typed.index : Math.max(tail.index, 0);
      anchor = {
        offset: look.starts[index], text: typed ? prompt : tail.text, context: contextOf(look.lines, index), span: 1,
        ...(typed && { typed: squashed(typed.command) }),
      };
      if (typed) text = typed.command;
    }
    t.running = { at: now, readAt: 0, isWatched: true, segments: [{ line: `${t.id.slice(0, 8)}-${now.toString(36)}` }], anchor };
    this.#append(t, { role: 'user', text, shell: true, at: now });
    this.#store.report(t.id, 'message.user', { text, shell: true, clientId: t.running.segments[0].line }, { fields: { lastPrompt: text } });
    if (t.status !== 'running') this.#setStatus(t, 'running');
  }

  // The command before may be over without having been seen to be.
  async #settle(t) {
    for (let reads = 0; reads < SETTLE_READS && t.running; reads++) {
      if (reads) await pause(SETTLE_CHECK_MS);
      await this.#readMirror(t).catch(() => {});
    }
  }

  // What a mirrored terminal's command has printed, as far as it has got, and whether it's over. No
  // hook says so here: it's over once the shell is in front again, a whole prompt is under what the
  // command printed, and nothing has changed since the last look. A prompt that reads as it did before
  // is taken at once, and one that doesn't, as it may after a `cd`, once it has stayed a while.
  async #readMirror(t) {
    const running = t.running;
    running.readAt = Date.now();
    const full = await this.#isFullScreen(t);
    if (full !== t.fullScreen) {
      t.fullScreen = full;
      running.changedAt = Date.now();
      this.#store.report(t.id, 'terminal.screen', { fullScreen: full });
    }
    // What a program that has the screen to itself shows is read in place of what was printed.
    if (full) {
      running.seen = undefined;
      await this.#readScreen(t);
      return;
    }
    const look = await this.#look(t);
    // Nothing has come of what was typed yet.
    if (look.text === running.before) return;
    const isStill = look.text === running.seen;
    running.seen = look.text;
    if (!isStill) running.stillSince = Date.now();
    const body = this.#bodyOf(t, look);
    const lines = trimEnd(body.lines);
    const tail = tailOf(look.lines);
    // A prompt that was never measured, as before any command is sent from a client, is as many lines
    // as it shows above the command's own line and above the line it's on now.
    const height = t.prompt?.height ?? Math.max(body.typedAt === undefined ? 0 : promptLinesAbove(look.lines, body.typedAt, tail.index), 1);
    const isPrompted = promptLike(tail.text, t.prompt?.text ?? t.promptSeen);
    const hasPrompt = body.isPlaceless || lines.length >= height;
    const output = lines.slice(0, Math.max(lines.length - height, 0));
    const hasWaited = Date.now() - running.stillSince >= PROMPT_WAIT_MS;
    if (isStill && hasPrompt && (isPrompted || hasWaited) && !(await this.#frontNow(t))) {
      if (t.prompt) t.prompt.text = tail.text;
      this.#sendParts(t, output, body.cut, { done: true });
      this.#finish(t, undefined);
      return;
    }
    running.tail = body.cut ? undefined : tailOf(body.lines);
    // A prompt under the output is the shell's, back already, and none of what the command printed.
    const shown = isPrompted && hasPrompt && !t.front ? output : lines;
    running.main = { lines: shown, cut: body.cut };
    if (this.#sendParts(t, shown, body.cut, {})) running.changedAt = Date.now();
  }

  // How wide the terminal was when its output was read, which is where its lines broke.
  #width(t) {
    return t.columns ? { columns: t.columns } : {};
  }

  // Done once the prompt is back, as everything the command printed comes before it.
  async #finishWhenPrompted(t, state) {
    const running = t.running;
    const { lines, cut } = await this.#readBody(t);
    const done = withoutPrompt(lines, readText(path.join(this.#dir(t), 'prompt')) ?? '');
    if (done === undefined) {
      running.promptSince ??= Date.now();
      if (Date.now() - running.promptSince < PROMPT_WAIT_MS) return;
    }
    this.#sendParts(t, done ?? lines, cut, { done: true, code: state.code });
    this.#finish(t, state.code);
  }

  // The command is over without its end having been seen, as when its shell went: what was last read
  // of it is all there is. A `status` of null leaves the session's as it is, for whoever ends it.
  #finishUnseen(t, status) {
    const last = t.running.segments.at(-1);
    if (last?.sent?.running) {
      last.sent.running = false;
      this.#store.report(
        t.id, 'message.output', { stdout: last.sent.text, stderr: '', replies: false, clientId: last.line, running: false, ...this.#width(t) },
        { supersedes: event => event.kind === 'message.output' && event.clientId === last.line },
      );
    }
    this.#finish(t, undefined, status);
  }

  // What it did goes in the record: each line sent to it, under the output before it.
  #finish(t, code, status = 'idle') {
    const running = t.running;
    const now = Date.now();
    running.segments.forEach((segment, index) => {
      const isLast = index === running.segments.length - 1;
      if (segment.shown !== undefined) this.#append(t, { role: 'user', text: segment.shown, shell: true, input: true, at: segment.at ?? now });
      const text = segment.sent?.text ?? '';
      const exitCode = isLast ? code : undefined;
      if (text || exitCode) this.#append(t, { role: 'output', stdout: text, stderr: '', replies: false, at: now, ...this.#width(t), ...(exitCode !== undefined && { exitCode }) });
    });
    if (t.fullScreen) {
      t.fullScreen = false;
      this.#store.report(t.id, 'terminal.screen', { fullScreen: false });
    }
    t.seen = running.key;
    t.running = undefined;
    t.lastActiveAt = now;
    this.#noteFolder(t);
    // A mirrored terminal's shell may have something else in front by now, started at the Mac.
    if (status) this.#setStatus(t, t.mirror && t.front ? 'running' : status);
    if (t.mirror) this.#sayFront(t);
    this.#save(t);
  }

  // Where the shell is now, said when it has moved, as after a `cd`.
  #noteFolder(t) {
    const cwd = this.#cwdOf(t);
    if (cwd === t.folder) return;
    t.folder = cwd;
    this.#store.report(t.id, 'session.cwd', { cwd }, { fields: { cwd } });
  }

  // A line for the program that's running, which starts a part of its output. One the program reads
  // without showing is hidden here too. Where the output ended is read now, unless a program has the
  // screen, which leaves the output where it was last read: what the program shows from here on is
  // this line's.
  async #input(t, { text, clientId }) {
    const running = t.running;
    const backend = this.#backend(t);
    const hidden = await backend.hidesInput(t.target).catch(() => false);
    let mark = running.tail;
    const isFull = await this.#isFullScreen(t);
    if (!isFull) {
      const { lines, cut } = await this.#readBody(t);
      mark = cut ? undefined : tailOf(lines);
    }
    const of = running.key ? `${running.pid}-${running.seq}` : running.at.toString(36);
    const line = clientId ?? `${t.id.slice(0, 8)}-${of}-${running.segments.length}`;
    const shown = hidden ? HIDDEN_TEXT : text;
    const before = running.segments.at(-1);
    const segment = { line, shown, at: Date.now(), mark: mark ?? { index: -1, text: '' } };
    // What a program with the screen to itself shows is one screen, under the last line sent: it moves
    // here from under the line before.
    if (isFull && before?.screen !== undefined) {
      segment.screen = before.screen;
      before.screen = undefined;
    }
    running.segments.push(segment);
    // Its answer is on its way, so it's read as often as a command just started.
    running.changedAt = Date.now();
    this.#store.report(t.id, 'message.user', { text: shown, shell: true, input: true, clientId: line });
    if (segment.screen !== undefined) this.#sendParts(t, running.main?.lines ?? [], running.main?.cut ?? false, {});
    this.#save(t);
    await this.#type(t, text);
    return { queued: false };
  }

  #setStatus(t, status, fields) {
    t.status = status;
    this.#store.report(t.id, 'session.status', { status, ...(status === 'running' && t.isAtRest && { working: false }) }, { fields });
  }

  #append(t, item) {
    const file = path.join(this.#dir(t), HISTORY);
    // A mirrored terminal has no folder here until it has done something to keep.
    if (t.mirror) fs.mkdirSync(this.#dir(t), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    try {
      if (fs.statSync(file).size > HISTORY_LIMIT_BYTES) this.#shorten(file);
    } catch { /* gone with its session */ }
  }

  // The older half goes, from where a command starts.
  #shorten(file) {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    let start = Math.floor(lines.length / 2);
    while (start < lines.length && !/"role":"user"/.test(lines[start])) start += 1;
    fs.writeFileSync(file, `${lines.slice(start).join('\n')}\n`, { mode: 0o600 });
  }

  // What it did, with a running command's output and the lines sent to it as far as they've got.
  #items(t) {
    const items = (readText(path.join(this.#dir(t), HISTORY)) ?? '').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    (t.running?.segments ?? []).forEach((segment, index, segments) => {
      if (segment.shown !== undefined) items.push({ role: 'user', text: segment.shown, shell: true, input: true, at: segment.at });
      const text = segment.sent?.text;
      if (text) items.push({ role: 'output', stdout: text, stderr: '', replies: false, at: t.running.readAt, ...this.#width(t), ...(index === segments.length - 1 && { running: true }) });
    });
    return items;
  }
}
