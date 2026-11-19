// Terminal sessions: a shell of the reader's own, in Rex or tmux as any session is, read and typed into
// from a client. A message is a command, or a line for the program that's running, and what's shown
// under it is what the terminal printed.
//
// The shell runs under script(1), which keeps everything written to the terminal in a file. That file is
// read here as it grows, through a terminal emulator (termengine.mjs), with the shell's own marks saying
// where each command starts and ends (shellmarks.mjs). So nothing is asked of Rex or tmux but a place to
// run in and keys to press, the terminal at the computer shows what any terminal would, and a command
// typed there is told to clients like one sent from them.
//
// A session's folder holds what has to outlast the helper: what it is (session.json), what was run in it
// (history.jsonl), and the terminal's own writing (stream), from which the screen is drawn again when
// the helper starts while the shell goes on.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';
import { checkedFolder } from './folders.mjs';
import { computer } from './platform.mjs';
import { hidesInput, installShellFiles, recorded, settingsCommand, shellCommand, shellFor, sizeCommand } from './shellmarks.mjs';
import { TerminalEngine } from './termengine.mjs';
import { plain } from './termtext.mjs';

export const AGENT = 'terminal';
const NAME_PREFIX = 'venes-term-';
const NAME_ID_LENGTH = 8;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const META = 'session.json';
const HISTORY = 'history.jsonl';
const STREAM = 'stream';
// What a test run says where its terminals are with.
const PASSED_ENV = ['VENES_TMUX_SOCKET', 'VENES_REX_SERVER'];
// What stands for a line a program read without showing it, as a password.
const MASKED = '••••••';
// The keys a program can be sent besides lines, by the names tmux knows them by.
export const KEYS = ['Escape', 'Tab', 'BTab', 'Up', 'Down', 'Left', 'Right', 'Enter', 'Space', 'BSpace', 'C-c', 'C-d', 'C-z', 'C-l'];
const DEFAULT_SIZE = { columns: 80, rows: 24 };
const SIZE_RANGE = { columns: [20, 400], rows: [5, 200] };
const READ_BYTES = 256 * 1024;
const LIMITS = {
  // The terminal's own writing is started afresh past this, at a prompt, when nothing of it is still wanted.
  stream: 8 * 1024 * 1024,
  // And past this whatever is going on, so that a command that prints for days doesn't fill the disk. What
  // it costs is the helper's memory of that command, should the helper start again before it ends.
  streamAtAll: 64 * 1024 * 1024,
  // The oldest half of what was run goes once the record is this long.
  history: 16 * 1024 * 1024,
};
const DEFAULT_HISTORY_LIMIT = 60;
// A line that was sent and not yet seen to run is forgotten after this, so that a later command isn't taken for it.
const SENT_LIMIT_MS = 10_000;
const SIZES_KEPT = 48;
// How much of what a shell that never got to a prompt last said is told.
const START_SAID_CHARS = 200;

const TIMING = {
  // How often the terminal's writing is read: while something goes on, and once it has been quiet a while.
  poll: 40, quietPoll: 250, quietAfter: 10_000,
  // How often a running command's output is said again: one of more than a few lines less often, as a
  // program's screen is, which a spinner in it would otherwise send a dozen times a second.
  flush: 80, busyFlush: 250, busyChars: 2 * 1024,
  pasteSettle: 80, sizeSettle: 120,
  startLimit: 20_000, startCheck: 100,
  // How long a send waits to see its command start, so that its reply comes after the command's own line.
  commandWait: 1500, commandCheck: 20,
  aliveCheck: 1000, closeLimit: 4000, closeCheck: 50,
};

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Someone else's process is still a process.
    return error.code === 'EPERM';
  }
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

// A size a client asked for, when it's one a terminal can be.
export function sizeOf({ columns, rows } = {}) {
  if (!Number.isInteger(columns) || !Number.isInteger(rows)) return undefined;
  const within = (value, [least, most]) => Math.min(Math.max(value, least), most);
  return { columns: within(columns, SIZE_RANGE.columns), rows: within(rows, SIZE_RANGE.rows) };
}

// What was run, in the order it's shown: each line with what it printed under it. The record has a
// command's lines as they were typed and their output once the command was over, which is later.
export function ordered(records) {
  const lines = new Set(records.filter(record => record.role === 'user' && record.clientId).map(record => record.clientId));
  const printed = new Map();
  for (const record of records) if (record.role === 'output' && lines.has(record.clientId)) printed.set(record.clientId, record);
  const items = [];
  for (const record of records) {
    if (record.role === 'output' && lines.has(record.clientId)) continue;
    items.push(record);
    if (record.role === 'user' && printed.has(record.clientId)) items.push(printed.get(record.clientId));
  }
  return items;
}

// A page of what was run, up to `before`. It starts at a command, with every line typed into it after.
export function historyPage(items, { limit = DEFAULT_HISTORY_LIMIT, before } = {}) {
  const end = Number.isInteger(before) ? Math.min(Math.max(before, 0), items.length) : items.length;
  let start = Math.max(end - Math.max(Number.isInteger(limit) ? limit : DEFAULT_HISTORY_LIMIT, 1), 0);
  while (start > 0 && !(items[start].role === 'user' && !items[start].input)) start -= 1;
  return { items: items.slice(start, end), before: start, hasMore: start > 0 };
}

const outputItem = (clientId, { stdout, columns, exitCode }, at) => ({
  role: 'output', clientId, stdout, stderr: '', replies: false, columns, ...(exitCode !== undefined && { exitCode }), at,
});

export class Terminals {
  #store;
  #root;
  #shellDir;
  #terminal;
  #env;
  #timing;
  #exec;
  #isAlive;
  #kill;
  #shell;
  #limits;
  #sessions = new Map();
  // Whether every session kept on this computer has been read. One made after that is made here.
  #isLoaded = false;
  #isStopped = false;

  constructor({
    store, root, shellDir,
    // What a session's terminal is started in and typed into: none, and nothing can be started.
    terminal = undefined, env = process.env, timing = {}, exec = promisify(execFile),
    isAlive = isRunning, kill = (pid, signal) => process.kill(pid, signal), shell = () => shellFor(env), limits = {},
  }) {
    this.#limits = { ...LIMITS, ...limits };
    this.#store = store;
    this.#root = root;
    this.#shellDir = shellDir;
    this.#terminal = terminal;
    this.#env = env;
    this.#timing = { ...TIMING, ...timing };
    this.#exec = exec;
    this.#isAlive = isAlive;
    this.#kill = kill;
    this.#shell = shell;
  }

  get name() {
    return AGENT;
  }

  // Whether a terminal session can be started here: somewhere to run one, and a shell the hooks are written for.
  isAvailable() {
    if (!this.#terminal?.canStart || process.platform === 'win32') return false;
    try {
      this.#shell();
      return true;
    } catch {
      return false;
    }
  }

  // --- What's kept ---

  #remember(meta) {
    const t = {
      id: meta.id, dir: path.join(this.#root, meta.id), name: meta.name, cwd: meta.cwd, startedAt: meta.startedAt,
      lastActiveAt: meta.lastActiveAt ?? meta.startedAt, mark: meta.mark, opens: meta.opens ?? 0,
      columns: meta.columns ?? DEFAULT_SIZE.columns, rows: meta.rows ?? DEFAULT_SIZE.rows,
      shell: meta.shell, sizes: meta.sizes ?? [], last: meta.last, endedAt: meta.endedAt, lastCommand: meta.lastCommand,
      target: undefined, engine: undefined, offset: 0, sent: [], run: undefined, line: Promise.resolve(), items: undefined,
    };
    this.#sessions.set(t.id, t);
    return t;
  }

  #save(t) {
    const meta = {
      id: t.id, name: t.name, cwd: t.cwd, startedAt: t.startedAt, lastActiveAt: t.lastActiveAt, mark: t.mark, opens: t.opens,
      columns: t.columns, rows: t.rows, shell: t.shell, sizes: t.sizes, last: t.last, endedAt: t.endedAt, lastCommand: t.lastCommand,
    };
    try {
      fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
      const temporary = path.join(t.dir, `${META}.tmp`);
      fs.writeFileSync(temporary, JSON.stringify(meta), { mode: 0o600 });
      fs.renameSync(temporary, path.join(t.dir, META));
    } catch (error) {
      console.error(`terminal ${t.id}: ${error.message}`);
    }
  }

  // Every session kept on this computer, whether or not its shell still runs. Read once: nothing else
  // makes one.
  #loadAll() {
    if (this.#isLoaded) return;
    this.#isLoaded = true;
    let ids = [];
    try {
      ids = fs.readdirSync(this.#root);
    } catch {
      return;
    }
    for (const id of ids) {
      if (!SESSION_ID.test(id) || this.#sessions.has(id)) continue;
      const meta = readJSON(path.join(this.#root, id, META));
      if (meta?.id === id) this.#remember(meta);
    }
  }

  #find(sessionId) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    // Asked of every session any command is for, so it's answered from memory.
    this.#loadAll();
    return this.#sessions.get(sessionId);
  }

  #get(sessionId) {
    const t = this.#find(sessionId);
    if (!t) throw new HelperError('unknown_session', `No session ${sessionId}`);
    return t;
  }

  #isLive(t) {
    return Boolean(t.target && t.engine && !t.endedAt);
  }

  #records(t) {
    if (!t.items) {
      let text = '';
      try {
        text = fs.readFileSync(path.join(t.dir, HISTORY), 'utf8');
      } catch {
        text = '';
      }
      t.items = text.split('\n').filter(Boolean).flatMap(line => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    }
    return t.items;
  }

  #record(t, item) {
    const records = this.#records(t);
    records.push(item);
    const file = path.join(t.dir, HISTORY);
    try {
      fs.appendFileSync(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
      if (fs.statSync(file).size <= this.#limits.history) return;
      // The older half goes, from a command on.
      let start = Math.floor(records.length / 2);
      while (start < records.length && !(records[start].role === 'user' && !records[start].input)) start += 1;
      t.items = records.slice(start);
      fs.writeFileSync(file, t.items.map(kept => `${JSON.stringify(kept)}\n`).join(''), { mode: 0o600 });
    } catch (error) {
      console.error(`terminal ${t.id}: ${error.message}`);
    }
  }

  // What was run, with what the command going on shows so far under its lines.
  #items(t) {
    const records = this.#records(t);
    if (!t.run) return ordered(records);
    const going = [...t.run.outputs].map(([clientId, output]) => ({ ...outputItem(clientId, output, Date.now()), ...(output.running && { running: true }) }));
    return ordered([...records, ...going]);
  }

  #passed() {
    return Object.fromEntries(PASSED_ENV.filter(key => this.#env[key]).map(key => [key, this.#env[key]]));
  }

  // --- The agent's part, as the daemon asks it of each ---

  async owns(sessionId) {
    return this.#find(sessionId) !== undefined;
  }

  denies(sessionId) {
    return this.#find(sessionId) === undefined;
  }

  // A command going on is the shell's business, and nothing a restart or a closing waits for.
  isBusy() {
    return false;
  }

  isWorking() {
    return false;
  }

  isClosable(sessionId) {
    const t = this.#find(sessionId);
    return Boolean(t && this.#isLive(t));
  }

  runningVersion() {
    return undefined;
  }

  async folderOf(sessionId) {
    return this.#find(sessionId)?.cwd;
  }

  // The sessions kept here, newest first, for the library's first page.
  async library() {
    this.#loadAll();
    return [...this.#sessions.values()].map(t => {
      const known = this.#store.find(t.id);
      return {
        id: t.id, title: t.lastCommand || undefined, cwd: t.cwd, lastActiveAt: t.lastActiveAt,
        status: known && known.agent === AGENT && known.status !== 'ended' ? known.status : null, agent: AGENT,
      };
    }).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }

  // The sessions from before the helper started. A shell that still runs is followed again from the start
  // of what its terminal has written, and one that has gone is a session that ended.
  async restore() {
    this.#loadAll();
    for (const t of this.#sessions.values()) {
      if (t.endedAt || !t.name) continue;
      const target = this.#terminal ? await this.#terminal.findSession?.(t.name, this.#passed()).catch(() => undefined) : undefined;
      if (!target || !t.shell?.pid || !this.#isAlive(t.shell.pid)) {
        t.endedAt = Date.now();
        this.#save(t);
        continue;
      }
      t.target = target;
      this.#adopt(t, 'resume');
      await this.#replay(t).catch(error => console.error(`terminal ${t.id}: ${error.message}`));
      this.#follow(t);
    }
  }

  stop() {
    this.#isStopped = true;
    for (const t of this.#sessions.values()) {
      t.following = undefined;
      clearTimeout(t.timer);
      this.#closeStream(t);
    }
  }

  #adopt(t, source) {
    this.#store.adopt(t.id, { agent: AGENT, cwd: t.cwd, startedAt: t.startedAt, permissionModes: [], lastPrompt: t.lastCommand, outlivesHelper: true });
    this.#store.report(t.id, 'session.started', { source, cwd: t.cwd });
    this.#store.report(t.id, 'session.status', { status: 'idle' });
  }

  // --- The shell ---

  #engine(t, size = t) {
    return new TerminalEngine({ columns: size.columns, rows: size.rows, nonce: t.mark, emit: event => this.#onEvent(t, event) });
  }

  // Starts the session's shell in a terminal of its own, and waits for its first prompt.
  async #open(t, source) {
    if (!this.#terminal?.canStart) throw new HelperError('no_tmux', `Install tmux or Rex on your ${computer} to run a terminal session.`);
    const shell = this.#shell();
    fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
    installShellFiles(this.#shellDir);
    const stream = path.join(t.dir, STREAM);
    fs.writeFileSync(stream, '', { mode: 0o600 });
    this.#closeStream(t);
    t.engine?.dispose();
    t.opens += 1;
    Object.assign(t, {
      mark: randomBytes(8).toString('hex'), name: `${NAME_PREFIX}${t.id.slice(0, NAME_ID_LENGTH)}-${t.opens}`,
      shell: undefined, last: undefined, offset: 0, sizes: [[0, t.columns, t.rows]], sent: [], run: undefined, endedAt: undefined,
    });
    t.engine = this.#engine(t);
    const { command, env } = shellCommand({ shellDir: this.#shellDir, mark: t.mark, env: this.#env, shell });
    // A folder that has gone since is no place to start in.
    const cwd = fs.existsSync(t.cwd) ? t.cwd : os.homedir();
    t.target = await this.#terminal.startSession({
      name: t.name, cwd, command: recorded(command, stream), env: { ...env, ...this.#passed() }, size: { columns: t.columns, rows: t.rows },
    });
    this.#save(t);
    this.#adopt(t, source);
    this.#follow(t);
    const { startLimit, startCheck } = this.#timing;
    for (const deadline = Date.now() + startLimit; !t.engine?.isReady; await pause(startCheck)) {
      if (!this.#isLive(t)) throw new HelperError('start_failed', 'The shell quit before it was ready.');
      if (Date.now() < deadline) continue;
      // What it stopped at is on its terminal: a question its setup asks, more often than not.
      await this.#drain(t);
      const said = t.engine?.screen().map(line => plain(line).trim()).filter(Boolean).at(-1);
      throw new HelperError('start_failed', said
        ? `The shell didn't get to a prompt. Its terminal says: ${said.slice(0, START_SAID_CHARS)}`
        : 'The shell took too long to start.');
    }
  }

  // A session to type into: the one whose shell runs, or one that ended, with a new shell where it was.
  async #live(sessionId) {
    const t = this.#get(sessionId);
    if (this.#isLive(t)) return t;
    t.opening ??= this.#open(t, 'resume').finally(() => { t.opening = undefined; });
    try {
      await t.opening;
    } catch (error) {
      if (error.code === 'no_tmux' || error.code === 'no_shell') throw error;
      throw new HelperError('resume_failed', `This session's shell couldn't be started again: ${error.message}`);
    }
    return t;
  }

  #closeStream(t) {
    if (t.fd === undefined) return;
    try {
      fs.closeSync(t.fd);
    } catch {
      // Closed already.
    }
    t.fd = undefined;
  }

  // Reads what the terminal has written as it's written, and looks now and then for whether the shell
  // still runs.
  #follow(t) {
    const token = {};
    Object.assign(t, { following: token, readAt: Date.now(), checkedAt: Date.now(), flushedAt: 0, flushGap: this.#timing.flush });
    const tick = async () => {
      if (t.following !== token || this.#isStopped) return;
      try {
        await this.#drain(t);
        if (t.following !== token) return;
        if (Date.now() - t.checkedAt >= this.#timing.aliveCheck) {
          t.checkedAt = Date.now();
          if (await this.#hasGone(t)) {
            await this.#drain(t);
            if (t.following === token) this.#end(t, 'exited');
            return;
          }
        }
      } catch (error) {
        console.error(`terminal ${t.id}: ${error.message}`);
      }
      const isQuiet = !t.run && !t.sent.length && Date.now() - t.readAt > this.#timing.quietAfter;
      t.timer = setTimeout(tick, isQuiet ? this.#timing.quietPoll : this.#timing.poll);
      t.timer.unref?.();
    };
    tick();
  }

  async #hasGone(t) {
    if (t.shell?.pid) return !this.#isAlive(t.shell.pid);
    // Before the shell has said which process it is, its terminal is asked.
    return !(await this.#terminal.isSessionOpen(t.name, t.target).catch(() => true));
  }

  // One read at a time, each from where the last one stopped.
  #drain(t) {
    t.draining = (t.draining ?? Promise.resolve()).then(() => this.#read(t)).catch(error => { console.error(`terminal ${t.id}: ${error.message}`); });
    return t.draining;
  }

  async #read(t) {
    if (!t.engine) return;
    const file = path.join(t.dir, STREAM);
    if (t.fd === undefined) {
      try {
        t.fd = fs.openSync(file, 'r');
      } catch {
        return;
      }
    }
    const { size } = fs.fstatSync(t.fd);
    if (size < t.offset) t.offset = 0;
    let isMore = false;
    while (t.offset < size && t.engine) {
      const buffer = Buffer.allocUnsafe(Math.min(size - t.offset, READ_BYTES));
      const read = fs.readSync(t.fd, buffer, 0, buffer.length, t.offset);
      if (!read) break;
      t.offset += read;
      await t.engine.feed(buffer.subarray(0, read));
      isMore = true;
    }
    if (!t.engine) return;
    const now = Date.now();
    if (isMore) {
      t.readAt = now;
      t.isDirty = true;
    }
    if (t.isDirty && now - t.flushedAt >= t.flushGap) {
      t.isDirty = false;
      t.flushedAt = now;
      t.flushGap = this.#timing.flush;
      t.engine.flush();
    }
    // Past its limit, the file starts again: at a prompt, with all of it read, nothing in it is still wanted.
    // Past a greater one it starts again whatever is going on. script(1) adds to the file's end wherever
    // that is, so what it writes next is the file's start.
    const isAtPrompt = !t.run && !t.sent.length && t.engine.isReady && !t.engine.isRunning;
    if (t.offset === size && (size > this.#limits.streamAtAll || (isAtPrompt && size > this.#limits.stream))) {
      fs.truncateSync(file, 0);
      t.offset = 0;
      t.sizes = [[0, t.columns, t.rows]];
      // The start of the command going on went with it, and where its lines were typed.
      if (t.last && !t.last.done) t.last = { ...t.last, inputs: [], cut: true };
      this.#save(t);
    }
  }

  // The shell has gone, and its terminal with it. The session stays, with what was run in it, and a
  // message starts a new shell where it was.
  #end(t, reason) {
    t.following = undefined;
    clearTimeout(t.timer);
    t.engine?.end();
    this.#closeStream(t);
    t.engine?.dispose();
    Object.assign(t, { engine: undefined, target: undefined, sent: [], run: undefined, endedAt: Date.now() });
    this.#save(t);
    this.#store.report(t.id, 'session.ended', { reason });
  }

  // --- What the terminal says ---

  #onEvent(t, event) {
    if (event.type === 'shell') {
      t.shell = { pid: event.pid, tty: event.tty, name: event.name };
      if (t.isReplaying) return;
      this.#save(t);
      // The terminal it started in may be another size than the page it's read on.
      this.#applySize(t).catch(error => console.error(`terminal ${t.id}: ${error.message}`));
    } else if (event.type === 'prompt') {
      this.#onPrompt(t, event);
    } else if (event.type === 'command') {
      this.#onCommand(t, event);
    } else if (event.type === 'output') {
      this.#onOutput(t, event);
    } else if (event.type === 'working') {
      if (t.run?.seq === event.seq && !t.isReplaying) this.#store.report(t.id, 'session.status', { status: 'running', working: event.working });
    } else if (event.type === 'finished') {
      this.#onFinished(t, event);
    }
  }

  // The lines sent that could still be what the shell is about to run.
  #awaited(t) {
    const now = Date.now();
    t.sent = t.sent.filter(sent => now - sent.at < SENT_LIMIT_MS);
    return t.sent;
  }

  #onPrompt(t, event) {
    if (event.cwd && event.cwd !== t.cwd) {
      t.cwd = event.cwd;
      if (!t.isReplaying) this.#save(t);
      this.#store.report(t.id, 'session.cwd', { cwd: t.cwd }, { cwd: t.cwd });
    }
    if (t.isReplaying || event.first) return;
    // A command whose start the helper no longer has is over all the same.
    if (!t.run) this.#store.report(t.id, 'session.status', { status: 'idle' });
    // A prompt with no command before it: the line that was sent ran nothing, as one the shell couldn't
    // read doesn't. What the shell said of it is shown under it.
    const [sent] = this.#awaited(t);
    if (!sent) return;
    t.sent.shift();
    const clientId = sent.clientId ?? randomUUID();
    const at = Date.now();
    const stdout = t.engine.since(sent.here);
    this.#record(t, { role: 'user', text: sent.text, shell: true, clientId, at });
    this.#store.report(t.id, 'message.user', { text: sent.text, clientId, shell: true }, { lastPrompt: sent.text });
    if (!stdout && !event.exitCode) return;
    const output = { stdout, columns: t.engine.columns, ...(event.exitCode && { exitCode: event.exitCode }) };
    this.#record(t, outputItem(clientId, output, at));
    this.#say(t, clientId, { ...output, running: false });
  }

  #onCommand(t, event) {
    const blank = clientId => ({ seq: event.seq, key: clientId, keys: new Map([[event.part, clientId]]), outputs: new Map(), said: new Set(), order: [clientId] });
    if (t.isReplaying) {
      // What the record already has isn't said again: a command that was over, or the one that was going
      // on, which goes on under the line it has.
      const { last } = t;
      const isKnown = last && last.pid === t.shell?.pid && event.seq <= last.seq;
      if (isKnown && (event.seq < last.seq || last.done)) return;
      if (isKnown) {
        t.run = blank(last.key);
        return;
      }
    }
    const sent = this.#awaited(t).shift();
    const clientId = sent?.clientId ?? randomUUID();
    // As the shell read it, which is what ran: a line can be changed on its way, as !! is.
    const text = event.command || sent?.text || '';
    const at = Date.now();
    t.run = blank(clientId);
    Object.assign(t, { last: { pid: t.shell?.pid, seq: event.seq, key: clientId, done: false, inputs: [] }, lastCommand: text, lastActiveAt: at });
    this.#save(t);
    this.#record(t, { role: 'user', text, shell: true, clientId, at });
    this.#store.report(t.id, 'message.user', { text, clientId, shell: true }, { lastPrompt: text });
    this.#store.report(t.id, 'session.status', { status: 'running' });
  }

  #onOutput(t, event) {
    const { run } = t;
    if (!run || run.seq !== event.seq) return;
    const clientId = run.keys.get(event.part);
    if (!clientId) return;
    const output = {
      stdout: event.text, columns: event.columns, running: event.running,
      ...(event.exitCode !== undefined && { exitCode: event.exitCode }), ...(event.screen && { screen: true, rows: event.rows }),
    };
    // Nothing printed, and nothing gone wrong, shows nothing: said only to take away what was shown.
    const isBlank = !event.text && !event.exitCode;
    if (isBlank) run.outputs.delete(clientId);
    else run.outputs.set(clientId, output);
    if (isBlank && !run.said.has(clientId)) return;
    if (isBlank) run.said.delete(clientId);
    else run.said.add(clientId);
    if (t.isReplaying) return;
    if (event.text.length > this.#timing.busyChars) t.flushGap = this.#timing.busyFlush;
    this.#say(t, clientId, output);
  }

  // What a line printed, in place of what was said of it before.
  #say(t, clientId, { stdout, columns, running, exitCode, screen, rows }) {
    this.#store.report(t.id, 'message.output', {
      clientId, stdout, stderr: '', replies: false, running, columns,
      ...(exitCode !== undefined && { exitCode }), ...(screen && { screen: true, rows }),
    }, undefined, { supersedes: earlier => earlier.kind === 'message.output' && earlier.clientId === clientId });
  }

  #onFinished(t, event) {
    const { run } = t;
    if (!run || run.seq !== event.seq) return;
    const at = Date.now();
    for (const clientId of run.order) {
      const output = run.outputs.get(clientId);
      if (output) this.#record(t, outputItem(clientId, output, at));
    }
    Object.assign(t, { run: undefined, last: { ...t.last, done: true, inputs: [] }, lastActiveAt: at });
    this.#save(t);
    this.#store.report(t.id, 'session.status', { status: 'idle' });
  }

  // Draws the screen again from what the terminal has written, for a shell that went on while the helper
  // didn't: the same bytes, the terminal's size changed where it was changed, and the lines typed into
  // the command going on typed where they were.
  async #replay(t) {
    const [first = [0, t.columns, t.rows]] = t.sizes;
    t.engine = this.#engine(t, { columns: first[1], rows: first[2] });
    t.isReplaying = true;
    t.run = undefined;
    let data = Buffer.alloc(0);
    try {
      data = fs.readFileSync(path.join(t.dir, STREAM));
    } catch {
      // Nothing written yet.
    }
    const inputs = t.last && !t.last.done ? t.last.inputs ?? [] : [];
    const steps = [
      ...t.sizes.slice(1).map(([offset, columns, rows]) => ({ offset, size: { columns, rows } })),
      ...inputs.map(input => ({ offset: input.offset, input })),
    ].sort((a, b) => a.offset - b.offset);
    let at = 0;
    try {
      for (const step of steps) {
        const upTo = Math.min(step.offset, data.length);
        if (upTo > at) await t.engine.feed(data.subarray(at, upTo));
        at = Math.max(at, upTo);
        if (step.size) {
          await t.engine.resize(step.size.columns, step.size.rows);
        } else if (t.run) {
          t.run.keys.set(t.engine.nextPart, step.input.key);
          t.run.order.push(step.input.key);
          t.engine.split();
        }
      }
      if (data.length > at) await t.engine.feed(data.subarray(at));
      t.engine.flush();
    } finally {
      t.isReplaying = false;
    }
    t.offset = data.length;
    if (t.run) {
      for (const clientId of t.run.outputs.keys()) t.run.said.add(clientId);
      this.#store.report(t.id, 'session.status', { status: 'running' });
    } else if (t.last && !t.last.done && t.last.cut) {
      // A command whose start is no longer in the terminal's writing still runs, until a prompt says otherwise.
      this.#store.report(t.id, 'session.status', { status: 'running' });
    }
  }

  // --- What a client asks ---

  // A new shell in a folder, in a terminal of its own at the computer.
  async start({ cwd, columns, rows }) {
    const folder = checkedFolder(cwd);
    const size = sizeOf({ columns, rows }) ?? DEFAULT_SIZE;
    const t = this.#remember({ id: randomUUID(), cwd: folder, startedAt: Date.now(), ...size });
    try {
      await this.#open(t, 'startup');
    } catch (error) {
      await this.#discard(t);
      throw error;
    }
    return { sessionId: t.id };
  }

  // A session that never got as far as a prompt leaves nothing behind.
  async #discard(t) {
    const wasKnown = this.#store.find(t.id) !== undefined;
    if (t.target) await this.#terminal.closeSession?.(t.name, t.target).catch(() => {});
    t.following = undefined;
    clearTimeout(t.timer);
    this.#closeStream(t);
    t.engine?.dispose();
    this.#sessions.delete(t.id);
    fs.rmSync(t.dir, { recursive: true, force: true });
    if (wasKnown) this.#store.forget(t.id);
  }

  // One thing typed at a time, in the order asked.
  #inLine(t, work) {
    const next = t.line.then(work);
    t.line = next.catch(() => {});
    return next;
  }

  // Makes the terminal the size of the page it's read on, when that's another size than it is.
  async #fit(t, wanted) {
    const size = sizeOf(wanted);
    if (!size || (size.columns === t.columns && size.rows === t.rows)) return;
    Object.assign(t, size);
    await this.#applySize(t);
    // The shell draws its prompt again at the new width.
    await pause(this.#timing.sizeSettle);
  }

  // The terminal at the computer first, where it can be told, then the one the shell is on, which is
  // inside it, and the screen kept here.
  async #applySize(t) {
    if (!this.#isLive(t)) return;
    const size = { columns: t.columns, rows: t.rows };
    t.sizes.push([t.offset, size.columns, size.rows]);
    if (t.sizes.length > SIZES_KEPT) t.sizes = [t.sizes[0], ...t.sizes.slice(-SIZES_KEPT / 2)];
    this.#save(t);
    await Promise.resolve(this.#terminal.resize?.(t.target, size)).catch(() => {});
    if (t.shell?.tty) {
      const [command, ...args] = sizeCommand(t.shell.tty, size);
      await this.#exec(command, args, { timeout: 5000 }).catch(error => console.error(`terminal ${t.id}: ${error.message}`));
    }
    await t.engine?.resize(size.columns, size.rows);
  }

  // A command, or a line for the command going on.
  async send({ sessionId, text, clientId, columns, rows, attachments = [] }) {
    if (attachments.length) throw new HelperError('bad_attachment', 'A terminal session takes no files.');
    // Enter is pressed after it, so a line's own end isn't typed as well.
    const line = String(text ?? '').replace(/[\r\n]+$/, '');
    if (!line.trim()) throw new HelperError('bad_text', 'Nothing to send.');
    const t = await this.#live(sessionId);
    return this.#inLine(t, async () => {
      if (!this.#isLive(t)) throw new HelperError('session_ended', 'This session has ended.');
      await this.#fit(t, { columns, rows });
      await this.#drain(t);
      try {
        if (t.run) await this.#typeInput(t, line, clientId);
        else await this.#typeCommand(t, line, clientId);
      } catch (error) {
        // A terminal closed at the computer takes a moment to be missed: nothing can be typed into it,
        // and the next message starts a new shell.
        if (error instanceof HelperError || !this.#isLive(t) || await this.#terminal.isSessionOpen(t.name, t.target).catch(() => true)) throw error;
        this.#end(t, 'exited');
        throw new HelperError('session_ended', "This session's terminal was closed. Send again to start a new shell.");
      }
      return { queued: false };
    });
  }

  // What a message the store held is delivered with. Nothing is held for a terminal, which takes a line
  // whenever it's sent.
  async deliver(session, { text, clientId }) {
    await this.send({ sessionId: session.id, text, clientId });
  }

  // Typed at the prompt, then Enter. The command's own line comes from the shell, when it starts.
  async #typeCommand(t, line, clientId) {
    const { pasteSettle, commandWait, commandCheck } = this.#timing;
    await this.#terminal.paste(t.target, line);
    await pause(pasteSettle);
    await this.#drain(t);
    const sent = { clientId, text: line, at: Date.now(), here: t.engine.here() };
    t.sent.push(sent);
    await this.#terminal.pressKey(t.target, 'Enter');
    t.readAt = Date.now();
    for (const deadline = Date.now() + commandWait; t.sent.includes(sent) && Date.now() < deadline && this.#isLive(t); await pause(commandCheck)) await this.#drain(t);
  }

  // Typed into the program going on, then Enter. What it prints from here on is this line's.
  async #typeInput(t, line, clientId) {
    const { run } = t;
    const key = clientId ?? randomUUID();
    const shown = (await this.#hidesInput(t)) ? MASKED : line;
    const at = Date.now();
    this.#record(t, { role: 'user', text: shown, shell: true, input: true, clientId: key, at });
    this.#store.report(t.id, 'message.user', { text: shown, clientId: key, shell: true, input: true });
    run.keys.set(t.engine.nextPart, key);
    run.order.push(key);
    t.last?.inputs.push({ offset: t.offset, key });
    this.#save(t);
    t.engine.split();
    await this.#terminal.paste(t.target, line);
    await pause(this.#timing.pasteSettle);
    await this.#terminal.pressKey(t.target, 'Enter');
    t.readAt = Date.now();
  }

  async #hidesInput(t) {
    if (!t.shell?.tty) return false;
    try {
      const [command, ...args] = settingsCommand(t.shell.tty);
      return hidesInput((await this.#exec(command, args, { timeout: 5000 })).stdout);
    } catch {
      return false;
    }
  }

  #typable(sessionId) {
    const t = this.#get(sessionId);
    if (!this.#isLive(t)) throw new HelperError('not_open', "This session's shell isn't running.");
    return t;
  }

  // A key for the program going on, as an editor or a list takes them.
  async key({ sessionId, key }) {
    if (!KEYS.includes(key)) throw new HelperError('bad_key', `${key} isn't a key a terminal session takes.`);
    const t = this.#typable(sessionId);
    return this.#inLine(t, async () => {
      await this.#terminal.pressKey(t.target, key);
      t.readAt = Date.now();
      return {};
    });
  }

  // Ctrl-C, for the command going on.
  async interrupt({ sessionId }) {
    const t = this.#typable(sessionId);
    if (!t.run) throw new HelperError('not_running', 'Nothing to interrupt.');
    await this.#terminal.pressKey(t.target, 'C-c');
    t.readAt = Date.now();
    return {};
  }

  // Everything a client needs to open one. A command going on comes with what it shows so far, and goes
  // on as events. The page's size is the terminal's from here on.
  async join({ sessionId, limit, columns, rows }) {
    const t = this.#get(sessionId);
    if (this.#isLive(t)) {
      await this.#inLine(t, () => this.#fit(t, { columns, rows })).catch(() => {});
      await this.#drain(t);
    }
    const seq = this.#store.seq;
    const page = historyPage(this.#items(t), { limit });
    const known = this.#store.find(sessionId);
    const sessions = known && known.status !== 'ended'
      ? this.#store.sessions().filter(view => view.id === sessionId)
      : [{ id: sessionId, status: 'ended', cwd: t.cwd, agent: AGENT, lastPrompt: t.lastCommand, startedAt: t.startedAt, tasks: [], backgroundTasks: 0 }];
    return { ...page, turn: [], queued: [], seq, sessions, requests: [] };
  }

  async history({ sessionId, limit, before }) {
    return historyPage(this.#items(this.#get(sessionId)), { limit, before });
  }

  // A terminal has no model, no modes and no commands of its own.
  async capabilities() {
    return { commands: [], models: [], skills: [] };
  }

  async configure() {
    throw new HelperError('terminal_session', 'A terminal session has no model.');
  }

  async setMode() {
    throw new HelperError('terminal_session', 'A terminal session has no modes.');
  }

  async status({ sessionId }) {
    const t = this.#get(sessionId);
    return { status: { project: path.basename(t.cwd) || t.cwd, updatedAt: Math.floor(Date.now() / 1000) } };
  }

  image() {
    throw new HelperError('unknown_image', 'This image is no longer there.');
  }

  // A program's screen is in the list, so there's no page to open over it. The keys are taken all the same.
  async page() {
    return { page: null };
  }

  async pageKey({ sessionId, key }) {
    return this.key({ sessionId, key });
  }

  async pageText({ sessionId, text }) {
    const t = this.#typable(sessionId);
    return this.#inLine(t, async () => {
      await this.#terminal.paste(t.target, String(text ?? ''));
      return {};
    });
  }

  async pageClose() {
    return {};
  }

  // Tells the shell to go, and waits for it. What it left running is told by the shell, and its terminal
  // is closed if it's still there.
  async #quit(t) {
    const { closeLimit, closeCheck, startLimit, startCheck } = this.#timing;
    // One that hasn't said which process it is yet will in a moment.
    for (const deadline = Date.now() + startLimit; this.#isLive(t) && !t.shell?.pid && Date.now() < deadline; await pause(startCheck));
    if (!this.#isLive(t)) return;
    const { pid } = t.shell ?? {};
    const { name, target } = t;
    const signal = kind => {
      try {
        if (pid) this.#kill(pid, kind);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    signal('SIGHUP');
    for (const deadline = Date.now() + closeLimit; pid && this.#isAlive(pid) && Date.now() < deadline; await pause(closeCheck));
    if (pid && this.#isAlive(pid)) signal('SIGKILL');
    for (const deadline = Date.now() + closeLimit; pid && this.#isAlive(pid) && Date.now() < deadline; await pause(closeCheck));
    if (pid && this.#isAlive(pid)) throw new HelperError('session_running', "The shell wouldn't quit.");
    await this.#drain(t);
    if (this.#isLive(t)) this.#end(t, 'closed');
    await this.#terminal.closeSession?.(name, target).catch(() => {});
  }

  // Closes the session's shell. What was run stays, and a message starts a new shell where it was.
  async closeNow(sessionId) {
    const t = this.#get(sessionId);
    if (!this.#isLive(t)) throw new HelperError('not_open', "This session isn't open, so there's nothing to close.");
    await this.#quit(t);
  }

  // A new shell where the old one was, with what the reader's setup is now.
  async restartNow(sessionId) {
    const t = this.#get(sessionId);
    await this.#quit(t);
    await this.#open(t, 'resume');
  }

  // Deletes a session from this computer: its shell is closed, and what was run in it goes.
  async remove({ sessionId }) {
    const t = this.#get(sessionId);
    await this.#quit(t);
    this.#sessions.delete(t.id);
    fs.rmSync(t.dir, { recursive: true, force: true });
    this.#store.forget(t.id);
    return {};
  }
}
