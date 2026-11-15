// Antigravity sessions. Google's Antigravity has a command line of its own, `agy`, and a session of
// it runs in a terminal, as a Claude Code session does: in Rex or tmux at the Mac, where anyone can
// go on with it. The helper follows one the way it follows Claude Code. A plugin of the helper's in
// Antigravity's own folder forwards its hooks: a session's start, each call to the model, each
// tool's end, and the turn's end. What was said is read from the transcript Antigravity keeps of
// each conversation, which a hook names. A message is typed into the terminal, and so is everything
// else a person would do there: Esc to stop, Shift+Tab for the mode, `/model` and `/effort`.
//
// Two things a hook doesn't say are read off the screen instead. A prompt to allow a tool is one:
// Antigravity draws it and waits, with no word to a hook. A turn stopped with Esc is the other:
// nothing is told of its end.
//
// A conversation has no id until its first message, and a client needs one to open a session before
// anything is said. So a new one is made through Antigravity's own protocol server (`agy acp`), which
// makes an empty conversation and says its id, and is let go. The terminal is then opened on it.
//
// What a session does is told to a client in the shapes a Claude Code session's are, so that a client
// which shows those shows these: a file read as Read, a command as Bash, a change as Edit or Write.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AcpLink } from './acplink.mjs';
import { MODE_IDS, asksTrust, hasTrustPicked, isIdle, isUp, readBar, readPrompt, showsDialog } from './agyscreen.mjs';
import { checkedFolder } from './folders.mjs';
import { HelperError } from './errors.mjs';
import { choicesOf, chooseRow } from './prompt.mjs';
import { VERSION } from './version.mjs';

export { MODE_IDS };
export const AGENT = 'antigravity';
const COMMAND = 'agy';
// What a terminal says it's running while Antigravity is in it: the program `agy` starts, or `agy` itself.
const PROGRAMS = new Set(['antigravity', 'agy']);
// How long what was typed for a session is kept to know its message by.
const TYPED_LIFETIME_MS = 60_000;
// As much of the end of what was read of a transcript as tells whether it's still what's there.
const READ_MARK_BYTES = 64;
const CLIENT = { name: 'venes', title: 'Venes', version: VERSION };
const DEFAULT_HISTORY_LIMIT = 50;
const SESSION_ID = /^[\w-]{8,64}$/;
const SQLITE = '/usr/bin/sqlite3';
const exec = promisify(execFile);

// What a terminal started for a session is called at the Mac, and what it's given of the helper's own surroundings.
const TERMINAL_PREFIX = 'venes-agy-';
const TERMINAL_ID_LENGTH = 8;
const TERMINAL_ENV = ['PATH', 'LANG', 'LC_ALL', 'VENES_HOME', 'VENES_TMUX_SOCKET', 'VENES_REX_SERVER', 'VENES_AGY_CONFIG'];

// How often a session's screen and transcript are looked at while its turn goes on, and how often a
// session at rest is checked to still be there.
const WATCH_MS = 700;
const REST_CHECK_MS = 30_000;
// How long a terminal just opened is watched as closely as one at work, for the mode its bar comes to show.
const SETTLE_MS = 6000;
// Antigravity was up in about 3s when measured. A busy Mac takes longer.
const START_LIMIT_MS = 30_000;
const START_CHECK_MS = 300;
const KEY_SETTLE_MS = 300;
const PASTE_SETTLE_MS = 150;
// A step is in the transcript just after its hook says so.
const STEP_WAIT_MS = 1500;
const STEP_CHECK_MS = 100;
// More presses than there are modes to go round.
const MOST_MODE_PRESSES = 6;
const KEY_LIMIT_MS = 2000;
const KEY_CHECK_MS = 50;
// A command of the terminal's own said what it did within a second when measured.
const COMMAND_LIMIT_MS = 6000;
// How long the models Antigravity lists are kept, and how long it's given to list them.
const MODELS_LIFETIME_MS = 10 * 60_000;
const MODELS_LIMIT_MS = 20_000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join('|')})$`);
// How long a session just opened waits for the models Antigravity lists, to name the one its bar shows.
const MODELS_WAIT_MS = 5000;

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Where the command line keeps what it knows: its conversations, a transcript of each, a summary of
// them all, and its settings.
export const dataFolder = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli');
export const transcriptOf = (data, id) => path.join(data, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');

// Whether Antigravity's command line is on this Mac.
export function isInstalled(env = process.env) {
  return (env.PATH ?? '').split(path.delimiter).some(folder => folder && fs.existsSync(path.join(folder, COMMAND)));
}

// Whether Antigravity already trusts a folder, as its settings say. Its terminal asks about any other
// before it starts there.
export function isTrusted(folder, data = dataFolder()) {
  try {
    const trusted = JSON.parse(fs.readFileSync(path.join(data, 'settings.json'), 'utf8')).trustedWorkspaces;
    const real = fs.realpathSync(folder);
    return Array.isArray(trusted) && trusted.some(entry => entry === real || entry === folder);
  } catch {
    return false;
  }
}

// A model as a hook names it has how hard it thinks at its end: `gemini-4-hydrogen-xhigh`.
export function modelOf(name) {
  if (typeof name !== 'string' || !name) return {};
  const effort = name.match(EFFORT_SUFFIX)?.[1];
  return { model: effort ? name.slice(0, -effort.length - 1) : name, effort };
}

// The models `agy models` lists, one to a line as its id and its name, put together by what they are:
// each with the ways it can be told to think.
export function modelsFrom(listing) {
  const models = new Map();
  for (const line of listing.split('\n')) {
    const [id, label] = line.split('\t').map(part => part?.trim());
    if (!id || !label || /\s/.test(id)) continue;
    const { model, effort } = modelOf(id);
    const known = models.get(model) ?? { value: model, displayName: effort ? label.replace(/\s*\([^)]*\)\s*$/, '') : label, effortLevels: [] };
    if (effort) known.effortLevels.push(effort);
    models.set(model, known);
  }
  return [...models.values()].map(model => ({ ...model, effortLevels: EFFORTS.filter(effort => model.effortLevels.includes(effort)) }));
}

// How hard a model is told to think when it can't think the way that's wanted: the most it can short of
// that, or the least it can past it. With nothing wanted, in the middle where it can.
export function levelFor(levels, wanted) {
  if (!levels.length || levels.includes(wanted)) return levels.length ? wanted : undefined;
  const at = EFFORTS.indexOf(wanted);
  if (at < 0) return levels.includes('medium') ? 'medium' : levels[0];
  const order = level => EFFORTS.indexOf(level);
  const below = levels.filter(level => order(level) < at).sort((a, b) => order(b) - order(a));
  return below[0] ?? [...levels].sort((a, b) => order(a) - order(b))[0];
}

// The steps of a conversation, as its transcript has them: a line each. One half written is left for later.
export function stepsIn(text) {
  const steps = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const step = JSON.parse(line);
      if (Number.isInteger(step?.step_index)) steps.push(step);
    } catch {
      break;
    }
  }
  return steps;
}

const USER_REQUEST = /<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/;
// What someone said, out of what Antigravity wraps it in for the model.
export const requestOf = content => (typeof content === 'string' ? (content.match(USER_REQUEST)?.[1] ?? content) : '');

const isUserStep = step => step.type === 'USER_INPUT';
const isReplyStep = step => step.type === 'PLANNER_RESPONSE';
// The step a call's result is written as: the ones after the reply that made the calls, in their order.
const resultIndex = (reply, at) => reply.step_index + 1 + at;
export const toolUseId = index => `step-${index}`;

// A call as a client is told of it, in a Claude Code call's shape where it has one: its name, and what it was given.
export function toolOf({ name, args = {} } = {}) {
  const file = args.Path ?? args.AbsolutePath ?? args.TargetFile;
  switch (name) {
    case 'read_file':
    case 'view_file':
      return { name: 'Read', input: { file_path: file } };
    case 'write_file':
      return { name: 'Write', input: { file_path: file, content: args.Content ?? '' } };
    case 'edit_file':
      return { name: 'Edit', input: { file_path: file, old_string: args.Target ?? '', new_string: args.Replacement ?? '' } };
    case 'run_command':
      return { name: 'Bash', input: { command: args.CommandLine ?? '', ...(args.toolSummary && { description: args.toolSummary }) } };
    default:
      return { name: name ?? 'tool', input: args };
  }
}

const STAMP = /^(Created|Completed) At: .*\n/;
const EXIT_CODE = /^Command exited with code (-?\d+)\./m;
const OUTPUT_MARK = 'Command output:\n';

// What a call came to, from the step written for it: what it printed, and whether it failed. A step
// starts with when it ran, and a command's with how it ended, which isn't what it printed.
export function resultOf(step, name) {
  let said = typeof step.content === 'string' ? step.content : '';
  while (STAMP.test(said)) said = said.replace(STAMP, '');
  const code = name === 'Bash' ? said.match(EXIT_CODE)?.[1] : undefined;
  const at = name === 'Bash' ? said.indexOf(OUTPUT_MARK) : -1;
  const text = (at >= 0 ? said.slice(at + OUTPUT_MARK.length) : said).replace(/\r\n/g, '\n');
  return { text, isError: step.status === 'ERROR' || Boolean(step.error) || (code !== undefined && code !== '0') };
}

// As a Claude Code call's is told: a command's as what it printed, and anything else as its words.
const responseOf = (name, text) => (name === 'Bash' ? { stdout: text, stderr: '', interrupted: false } : text || undefined);

// What was said in a conversation, as history has it, from its steps in order: what someone said,
// what was thought and said back, each call with how it ended, and a turn's end where the next
// message, or the end of it all, shows one.
export function historyOf(steps) {
  const items = [];
  const calls = new Map();
  let hasReply = false;
  for (const step of steps) {
    if (isUserStep(step)) {
      if (hasReply) items.push({ role: 'turn_end' });
      hasReply = false;
      items.push({ role: 'user', text: requestOf(step.content) });
    } else if (isReplyStep(step)) {
      hasReply = true;
      if (step.thinking?.trim()) items.push({ role: 'thinking', text: step.thinking.trim() });
      if (step.content?.trim()) items.push({ role: 'assistant', text: step.content });
      (step.tool_calls ?? []).forEach((made, at) => {
        const call = { role: 'tool', toolUseId: toolUseId(resultIndex(step, at)), ...toolOf(made), result: undefined, isError: false };
        calls.set(resultIndex(step, at), call);
        items.push(call);
      });
    } else if (calls.has(step.step_index)) {
      const call = calls.get(step.step_index);
      const { text, isError } = resultOf(step, call.name);
      Object.assign(call, { result: text || undefined, isError });
    }
  }
  if (hasReply) items.push({ role: 'turn_end' });
  return items;
}

// A page of history that ends before `before`, or at the end, and starts where a turn does: at least
// `limit` items where there are that many, and the turn they start in whole.
export function pageOf(items, { limit = DEFAULT_HISTORY_LIMIT, before = undefined } = {}) {
  const end = Number.isInteger(before) && before > 0 ? Math.min(before, items.length) : items.length;
  let start = Math.max(end - Math.max(limit, 1), 0);
  while (start > 0 && items[start - 1].role !== 'turn_end') start--;
  return { items: items.slice(start, end), before: start, hasMore: start > 0 };
}

// A stored conversation, as the library lists one, from its row in Antigravity's summary of them all.
export function libraryItem(row, status = null) {
  let folders = [];
  try {
    folders = JSON.parse(row.workspace_uris ?? '[]');
  } catch {
    folders = [];
  }
  const first = folders.find(uri => typeof uri === 'string' && uri.startsWith('file://'));
  let cwd;
  try {
    cwd = first ? decodeURIComponent(new URL(first).pathname) : undefined;
  } catch {
    cwd = undefined;
  }
  const at = Date.parse(`${row.last_modified_time ?? ''}`.replace(' ', 'T'));
  return { id: row.conversation_id, title: row.title || undefined, cwd, lastActiveAt: Number.isNaN(at) ? undefined : at, status, agent: AGENT };
}

// A message's words and files as they're typed: a file by its path at the head of the words, as
// someone at the terminal would name it, pictures too.
export function typedText(text, attachments = []) {
  return [...attachments.map(upload => upload.path), text].filter(Boolean).join('\n');
}

const sameWords = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
const shownUpload = ({ uploadId, name, mediaType, size }) => ({ uploadId, name, mediaType, size });

// The conversations Antigravity has stored that someone started, newest first, as its summary of them
// has them. The summary is read as it is, with nothing of Antigravity's started to ask.
async function storedRows(data) {
  const file = path.join(data, 'conversation_summaries.db');
  if (!fs.existsSync(file)) return [];
  const query = 'select conversation_id, title, last_modified_time, workspace_uris, step_count from conversation_summaries '
    + 'where coalesce(parent_conversation_id, \'\') = \'\' order by last_modified_time desc limit 500';
  const read = async from => {
    const { stdout } = await exec(SQLITE, ['-readonly', '-json', from, query], { maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    return stdout.trim() ? JSON.parse(stdout) : [];
  };
  try {
    return await read(file);
  } catch {
    // With no Antigravity running there's nothing beside the file that reading it this way needs, and
    // nothing is to be written there. The file is then all there is, and is read as one that won't change.
    return read(`file:${file.split('/').map(encodeURIComponent).join('/')}?immutable=1`);
  }
}

// A new, empty conversation in a folder, made through Antigravity's protocol server, which is let go
// once it has said the conversation's id.
async function mintWith(folder) {
  const link = await AcpLink.start(COMMAND, ['acp'], { cwd: folder, env: process.env, clientInfo: CLIENT });
  try {
    return (await link.request('session/new', { cwd: folder, mcpServers: [] }, { timeout: 30_000 })).sessionId;
  } finally {
    link.close();
  }
}

async function listedModels() {
  const { stdout } = await exec(COMMAND, ['models'], { timeout: MODELS_LIMIT_MS, maxBuffer: 1024 * 1024 });
  return modelsFrom(stdout);
}

function blankSession() {
  return {
    // The turn going on, the steps of the transcript already told, and the calls under way by their step.
    turn: undefined, seen: undefined, tools: new Map(),
    // What was typed for it and hasn't been heard back yet, to know a message by.
    typed: [],
    // The prompt open in its terminal, and the request made of it.
    asked: undefined, lastPrompt: undefined,
    // Hooks and looks are taken one at a time.
    line: Promise.resolve(),
    // How many looks in a row found it waiting for a message while a turn was thought to go on.
    idleLooks: 0, lastHookAt: 0, lastLookAt: 0,
    // What's been read of its transcript: how far, the steps so far, and how what was read ends.
    read: undefined,
    // And how many found something other than Antigravity on its screen.
    goneLooks: 0, isLooking: false,
    // Until when it's looked at as often as one at work: its bar is still being drawn when it starts.
    settlesAt: 0,
  };
}

export class Antigravity {
  #store;
  #terminal;
  #installed;
  #mint;
  #rows;
  #models;
  #data;
  #env;
  #timing;
  #sessions = new Map();
  // The conversations Antigravity started for itself, to help with a turn: none is a session of its own.
  #helpers = new Set();
  // The conversations Antigravity has stored, by id, as they were last listed.
  #listed = new Map();
  #modelList = { at: 0, models: [], reading: undefined };
  #timer;
  #isStopped = false;

  constructor({
    store,
    // What a session's terminal is opened and worked with: none, and a session can be read and nothing more.
    terminal = undefined,
    installed = () => isInstalled(),
    mint = mintWith,
    data = dataFolder(),
    rows = () => storedRows(data),
    models = listedModels,
    env = process.env,
    timing = {},
  }) {
    this.#store = store;
    this.#terminal = terminal;
    this.#installed = installed;
    this.#mint = mint;
    this.#rows = rows;
    this.#models = models;
    this.#data = data;
    this.#env = env;
    this.#timing = {
      watch: WATCH_MS, rest: REST_CHECK_MS, startLimit: START_LIMIT_MS, startCheck: START_CHECK_MS, keySettle: KEY_SETTLE_MS,
      pasteSettle: PASTE_SETTLE_MS, stepWait: STEP_WAIT_MS, stepCheck: STEP_CHECK_MS, keyLimit: KEY_LIMIT_MS, keyCheck: KEY_CHECK_MS,
      commandLimit: COMMAND_LIMIT_MS, modelsWait: MODELS_WAIT_MS, ...timing,
    };
    this.#timer = setInterval(() => this.#lookAtAll(), this.#timing.watch);
    this.#timer.unref();
  }

  get name() {
    return AGENT;
  }

  stop() {
    this.#isStopped = true;
    clearInterval(this.#timer);
  }

  // Whether there's an Antigravity on this Mac to start a session with.
  isAvailable() {
    return this.#installed();
  }

  #session(id) {
    if (!this.#sessions.has(id)) this.#sessions.set(id, blankSession());
    return this.#sessions.get(id);
  }

  // One thing at a time for a session, in the order they came.
  #inLine(id, work) {
    const session = this.#session(id);
    const done = session.line.then(work);
    session.line = done.catch(error => { console.error(`antigravity ${id}: ${error.stack ?? error.message}`); });
    return done;
  }

  #transcript(id) {
    return this.#store.find(id)?.transcriptPath ?? transcriptOf(this.#data, id);
  }

  // The transcript a hook names, where it's one of Antigravity's own: in the folder its apps keep
  // theirs in, the command line's beside the desktop app's. Any other file is none of the helper's to read.
  #namedTranscript(file) {
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return undefined;
    const resolved = path.resolve(file);
    return resolved.startsWith(path.dirname(this.#data) + path.sep) ? resolved : undefined;
  }

  // A conversation's steps. For a session being followed they're read as the transcript grows: what was
  // read stays read, and only what's been added since is. A transcript that's no longer what was read,
  // as after a conversation is rewound, is read again from its start. Any other is read whole.
  #steps(id) {
    const file = this.#transcript(id);
    const session = this.#sessions.get(id);
    try {
      if (!session) return stepsIn(fs.readFileSync(file, 'utf8'));
      const { size } = fs.statSync(file);
      const handle = fs.openSync(file, 'r');
      try {
        const piece = (from, length) => {
          const bytes = Buffer.alloc(length);
          return bytes.subarray(0, fs.readSync(handle, bytes, 0, length, from));
        };
        let read = session.read;
        const isSame = read && read.file === file && size >= read.offset && piece(read.offset - read.end.length, read.end.length).equals(read.end);
        if (!isSame) read = { file, offset: 0, steps: [], end: Buffer.alloc(0) };
        if (size > read.offset) {
          const added = piece(read.offset, size - read.offset);
          // Up to the last line that's whole.
          const whole = added.subarray(0, added.lastIndexOf(0x0a) + 1);
          const more = stepsIn(whole.toString('utf8'));
          read = {
            file, offset: read.offset + whole.length, steps: more.length ? [...read.steps, ...more] : read.steps,
            end: whole.length ? Buffer.from(whole.subarray(-READ_MARK_BYTES)) : read.end,
          };
        }
        session.read = read;
        return read.steps;
      } finally {
        fs.closeSync(handle);
      }
    } catch {
      return [];
    }
  }

  // Whether a session is Antigravity's. One the helper has heard from says so itself. Any other is one
  // whose conversation Antigravity has stored, which is told by its file.
  async owns(sessionId) {
    if (typeof sessionId !== 'string') return false;
    const known = this.#store.find(sessionId);
    if (known) return known.agent === AGENT;
    if (this.#listed.has(sessionId) || this.#sessions.has(sessionId)) return true;
    return SESSION_ID.test(sessionId) && fs.existsSync(path.join(this.#data, 'conversations', `${sessionId}.db`));
  }

  // The conversations Antigravity has stored, newest first, for the library's first page. One with a
  // session of its own going says what it's doing. One with nothing said in it isn't listed.
  async library() {
    if (!this.#installed()) return [];
    const rows = await this.#rows();
    this.#listed = new Map(rows.map(row => [row.conversation_id, row]));
    return rows.filter(row => row.step_count > 0 || this.#isLive(row.conversation_id)).map(row => {
      const session = this.#store.find(row.conversation_id);
      return libraryItem(row, session && session.status !== 'ended' ? session.status : null);
    }).sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
  }

  // The folder a stored conversation ran in, for what works on a folder.
  async folderOf(sessionId) {
    const known = this.#store.find(sessionId);
    if (known?.cwd) return known.cwd;
    if (!this.#listed.has(sessionId)) await this.library().catch(() => []);
    const row = this.#listed.get(sessionId);
    return row ? libraryItem(row).cwd : undefined;
  }

  #isLive(id) {
    const known = this.#store.find(id);
    return Boolean(known && known.agent === AGENT && known.status !== 'ended');
  }

  // --- What hooks say ---

  // A hook of Antigravity's, as its plugin forwards it, and the terminal it came from.
  handleHook(payload, terminal = {}) {
    const id = payload?.conversationId;
    if (this.#isStopped || typeof id !== 'string' || !SESSION_ID.test(id)) return undefined;
    return this.#inLine(id, () => this.#onHook(id, this.#session(id), payload, terminal)).catch(() => {});
  }

  // What's known of a session from the hook, and the session made known if it wasn't. Another of
  // Antigravity's that was in the same terminal has given way to it, as after `/clear`.
  #follow(id, payload, terminal) {
    const where = terminal.pane ? { pane: terminal.pane, tmuxSocket: terminal.socket, rexSession: terminal.rexSession, rexServer: terminal.rexServer } : {};
    const before = this.#store.find(id);
    const wasLive = Boolean(before && before.status !== 'ended');
    if (this.#helpers.has(id)) return undefined;
    if (where.pane && !wasLive) {
      const others = this.#store.liveSessions().filter(other => other.id !== id && other.agent === AGENT && other.pane === where.pane
        && (other.rexSession ?? '') === (where.rexSession ?? '') && (other.tmuxSocket ?? '') === (where.tmuxSocket ?? ''));
      // A conversation that turns up in the terminal of one whose turn is going on is one Antigravity
      // started to help with that turn, which someone couldn't have: it's told of as part of that
      // turn's calls, and isn't a session of its own.
      if (others.some(other => this.#sessions.get(other.id)?.turn || other.status === 'running' || other.status === 'waiting')) {
        this.#helpers.add(id);
        return undefined;
      }
      for (const other of others) this.#end(other.id, 'replaced');
    }
    const cwd = payload.cwd ?? payload.workspacePaths?.[0] ?? before?.cwd;
    const known = this.#store.adopt(id, {
      agent: AGENT, permissionModes: MODE_IDS, permissionMode: wasLive ? before.permissionMode : 'default', cwd,
      ...(this.#namedTranscript(payload.transcriptPath) && { transcriptPath: this.#namedTranscript(payload.transcriptPath) }), ...where,
    });
    const { model, effort } = modelOf(payload.modelName);
    if (model && model !== known.model) this.#store.report(id, 'session.model', { model });
    if (effort && effort !== known.effort) this.#store.report(id, 'session.effort', { effort }, { effort });
    return { known, isNew: !wasLive };
  }

  async #onHook(id, session, payload, terminal) {
    const followed = this.#follow(id, payload, terminal);
    if (!followed) {
      this.#sessions.delete(id);
      return;
    }
    const { known, isNew } = followed;
    session.lastHookAt = Date.now();
    session.idleLooks = 0;
    const event = payload.hookEventName;
    // One the helper opened itself has been told of already.
    if (isNew) this.#store.report(id, 'session.started', { source: event === 'SessionStart' ? 'startup' : 'resume', model: known.model, cwd: known.cwd });
    switch (event) {
      case 'PreInvocation':
        // The first call to the model in a turn is the turn's start: everything before it has been said.
        if (payload.invocationNum === 0 || !session.turn) this.#beginTurn(id, session, payload);
        else this.#tell(id, session);
        break;
      case 'PostToolUse':
        await this.#endTool(id, session, payload);
        break;
      case 'PostInvocation':
        this.#tell(id, session);
        break;
      case 'Stop':
        await this.#settledSteps(id, session);
        this.#endTurn(id, session, {
          isInterrupted: /CANCEL/i.test(payload.terminationReason ?? ''),
          error: payload.error || (/ERROR/i.test(payload.terminationReason ?? '') ? 'Antigravity stopped with an error.' : undefined),
        });
        break;
      default:
        break;
    }
  }

  #beginTurn(id, session, payload) {
    // A turn before this one that nothing ended was stopped, which no hook says.
    if (session.turn) this.#endTurn(id, session, { isInterrupted: true });
    const said = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '';
    session.typed = session.typed.filter(typed => Date.now() - typed.at < TYPED_LIFETIME_MS);
    const steps = this.#steps(id);
    session.turn = { id: crypto.randomUUID(), messages: 0 };
    session.seen = Number.isInteger(payload.initialNumSteps) ? payload.initialNumSteps : steps.length;
    // Antigravity goes on by itself when something it left running ends. The step before the call to
    // the model is then something other than what someone said, and nothing new was said.
    const last = steps.find(step => step.step_index === session.seen - 1);
    if (!last || isUserStep(last)) {
      const at = session.typed.findIndex(typed => sameWords(typed.typed, said));
      const [mine] = at >= 0 ? session.typed.splice(at, 1) : [];
      const text = mine?.text ?? said;
      this.#store.report(id, 'message.user', {
        text, ...(mine?.clientId && { clientId: mine.clientId }), ...(mine?.attachments?.length ? { attachments: mine.attachments.map(shownUpload) } : {}),
      }, { lastPrompt: text });
    }
    this.#store.report(id, 'session.status', { status: 'running' });
  }

  // Tells what the transcript has that hasn't been told: what was thought, what was said, and the
  // calls made. A call's end is its hook's to tell.
  #tell(id, session) {
    if (!session.turn) return;
    const report = (kind, data, fields) => this.#store.report(id, kind, data, fields);
    for (const step of this.#steps(id)) {
      if (step.step_index < (session.seen ?? 0)) continue;
      session.seen = step.step_index + 1;
      if (!isReplyStep(step)) continue;
      if (step.thinking?.trim()) report('message.thinking', { text: step.thinking.trim() });
      if (step.content?.trim()) {
        const messageId = `${session.turn.id}-${session.turn.messages++}`;
        report('message.assistant.delta', { messageId, turnId: session.turn.id, index: 0, text: step.content, final: false });
        report('message.assistant.delta', { messageId, turnId: session.turn.id, index: 1, text: '', final: true }, { lastMessage: step.content });
      }
      (step.tool_calls ?? []).forEach((made, at) => {
        const index = resultIndex(step, at);
        const { name, input } = toolOf(made);
        session.tools.set(index, { name, at: Date.now() });
        report('tool.start', { toolUseId: toolUseId(index), name, input });
      });
    }
  }

  // The steps a hook speaks of, once they're in the transcript: `wanted` says when they are.
  async #settledSteps(id, session, wanted = steps => steps.at(-1) && isReplyStep(steps.at(-1)) && !steps.at(-1).tool_calls?.length) {
    for (const end = Date.now() + this.#timing.stepWait; ; await pause(this.#timing.stepCheck)) {
      const steps = this.#steps(id);
      if (wanted(steps) || Date.now() >= end) break;
    }
    this.#tell(id, session);
  }

  async #endTool(id, session, payload) {
    const index = payload.stepIdx;
    await this.#settledSteps(id, session, steps => steps.some(step => step.step_index === index));
    // A call the transcript didn't tell of is told by its hook.
    if (!session.tools.has(index) && session.turn) {
      const { name, input } = toolOf(payload.toolCall);
      session.tools.set(index, { name, at: Date.now() });
      this.#store.report(id, 'tool.start', { toolUseId: toolUseId(index), name, input });
    }
    const tool = session.tools.get(index);
    if (!tool) return;
    session.tools.delete(index);
    const step = this.#steps(id).find(found => found.step_index === index);
    const { text, isError } = step ? resultOf(step, tool.name) : { text: payload.error ?? '', isError: Boolean(payload.error) };
    this.#closeAsked(id, session, 'terminal');
    this.#store.report(id, 'tool.end', {
      toolUseId: toolUseId(index), name: tool.name, response: responseOf(tool.name, text), durationMs: Date.now() - tool.at, isError: isError || Boolean(payload.error),
    });
  }

  // A turn's end: what was waiting is off, what was still going won't say how it ended, and the
  // session is at rest.
  #endTurn(id, session, { isInterrupted = false, error = undefined } = {}) {
    if (!session.turn) return;
    const report = (kind, data) => this.#store.report(id, kind, data);
    session.turn = undefined;
    session.idleLooks = 0;
    this.#closeAsked(id, session, isInterrupted ? 'terminal' : 'turn_end', isInterrupted ? 'deny' : 'unknown');
    this.#store.settleAll(id, { decision: isInterrupted ? 'deny' : 'unknown', by: isInterrupted ? 'terminal' : 'turn_end' });
    for (const [index, { name }] of session.tools) report('tool.end', { toolUseId: toolUseId(index), name, isError: true, interrupted: true });
    session.tools.clear();
    report('session.status', { status: 'idle' });
    if (isInterrupted) report('turn.interrupted', {});
    else if (error) report('turn.error', { error });
    else report('turn.end', { lastMessage: this.#store.find(id)?.lastMessage, backgroundTasks: 0, tasks: [] });
  }

  #end(id, reason) {
    const session = this.#sessions.get(id);
    if (session?.turn) this.#endTurn(id, session, { isInterrupted: true });
    this.#store.report(id, 'session.ended', { reason });
    this.#sessions.delete(id);
  }

  // --- What the screen says ---

  #lookAtAll() {
    if (this.#isStopped || !this.#terminal) return;
    const now = Date.now();
    for (const known of this.#store.liveSessions()) {
      if (known.agent !== AGENT || !known.pane) continue;
      const session = this.#session(known.id);
      const isAtWork = Boolean(session.turn) || known.status === 'running' || known.status === 'waiting';
      const every = isAtWork || now < session.settlesAt ? this.#timing.watch : this.#timing.rest;
      if (now - session.lastLookAt < every - 20 || session.isLooking) continue;
      session.lastLookAt = now;
      session.isLooking = true;
      this.#inLine(known.id, () => this.#look(known.id, session)).catch(() => {}).finally(() => { session.isLooking = false; });
    }
  }

  // One look at a session's terminal: whether it's still there, what it asks, and whether a turn
  // thought to be going has stopped with no word of it.
  async #look(id, session) {
    const known = this.#store.find(id);
    if (!known || known.status === 'ended' || !known.pane) return;
    let screen;
    try {
      screen = await this.#terminal.readScreen(known);
    } catch {
      this.#end(id, 'closed'); // its terminal has gone
      return;
    }
    if (!isUp(screen)) {
      // Something else is on the screen now: a page of Antigravity's own, or its shell once it has
      // quit. The terminal says which, by what it's running, where it can.
      const running = this.#terminal.foreground ? await this.#terminal.foreground(known).catch(() => undefined) : undefined;
      session.goneLooks = PROGRAMS.has(running) ? 0 : session.goneLooks + 1;
      if (session.goneLooks >= 2) this.#end(id, 'closed');
      return;
    }
    session.goneLooks = 0;
    const prompt = readPrompt(screen);
    const bar = readBar(screen);
    this.#noteBar(id, bar);
    if (session.turn) this.#tell(id, session);
    this.#notePrompt(id, session, known, prompt);
    // Waiting for a message, twice over and with no hook since: the turn was stopped.
    const isAtWork = Boolean(session.turn) || known.status === 'running' || known.status === 'waiting';
    if (isAtWork && !prompt && isIdle(screen) && Date.now() - session.lastHookAt > this.#timing.watch) {
      session.idleLooks += 1;
      if (session.idleLooks >= 2) {
        if (session.turn) this.#endTurn(id, session, { isInterrupted: true });
        else this.#store.report(id, 'session.status', { status: 'idle' });
      }
    } else {
      session.idleLooks = 0;
    }
  }

  // A prompt is taken once it reads the same twice, so that one still being drawn isn't. One that
  // has gone was answered at the Mac.
  #notePrompt(id, session, known, prompt) {
    const same = (a, b) => Boolean(a && b) && a.question === b.question && a.about === b.about && a.rows.length === b.rows.length;
    if (session.asked) {
      if (!same(prompt, session.asked.prompt)) this.#closeAsked(id, session, 'terminal');
      else return;
    }
    if (!prompt) {
      session.lastPrompt = undefined;
      return;
    }
    if (!same(prompt, session.lastPrompt)) {
      session.lastPrompt = prompt;
      return;
    }
    const rows = prompt.rows;
    if (!/^Yes\b/.test(rows[0].label) || !/^No\b/.test(rows.at(-1).label)) return;
    // It asks about the call under way: the latest, where there are several.
    const index = Math.max(-1, ...session.tools.keys());
    const tool = session.tools.get(index);
    const made = tool ? this.#steps(id).flatMap(step => (step.tool_calls ?? []).map((call, at) => ({ call, index: resultIndex(step, at) }))).find(found => found.index === index) : undefined;
    const { name, input } = made ? toolOf(made.call) : { name: tool?.name ?? 'tool', input: { description: prompt.about } };
    const options = choicesOf(prompt).map(row => ({ id: String(row.number), label: row.label }));
    const { request, decision } = this.#store.ask(id, {
      kind: 'permission', agent: AGENT, toolName: name, ...(tool && { toolUseId: toolUseId(index) }), input, options,
    }, ({ decision: answer, option }) => {
      if (answer === 'deny') return { row: rows.at(-1) };
      if (answer !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${answer}`);
      if (option == null) return { row: rows[0] };
      const row = rows.find(found => String(found.number) === String(option) && options.some(offer => offer.id === String(option)));
      if (!row) throw new HelperError('bad_option', 'That choice isn\'t offered for this request. Choose again.');
      return { row };
    });
    session.asked = { requestId: request.id, prompt };
    decision.then(answer => {
      if (!answer?.row) return;
      if (session.asked?.requestId === request.id) session.asked = undefined;
      session.lastPrompt = undefined;
      // Pressed as a person at the Mac would, so Antigravity does all it does for that row.
      this.#inLine(id, () => chooseRow(known, answer.row, {
        parse: readPrompt, read: target => this.#terminal.readScreen(target), press: (target, key) => this.#terminal.pressKey(target, key),
      })).catch(() => {});
    });
  }

  #closeAsked(id, session, by, decision = 'unknown') {
    if (!session.asked) return;
    const { requestId } = session.asked;
    session.asked = undefined;
    session.lastPrompt = undefined;
    this.#store.settle(requestId, { decision, by });
  }

  // What the bar says of a session: its mode, which it names only while it waits for a message, and
  // what it runs on. The bar has a model's name where a hook has its id, so it's told by the models
  // Antigravity lists, once they're known. During a turn a hook's word stands.
  #noteBar(id, bar) {
    const known = this.#store.find(id);
    if (!known || !bar) return;
    if (bar.hint === 'idle' && bar.mode !== known.permissionMode) this.#noteMode(id, bar.mode);
    if (this.#sessions.get(id)?.turn) return;
    const model = this.#modelList.models.find(found => found.displayName === bar.model);
    if (!model) return;
    if (model.value !== known.model) this.#store.report(id, 'session.model', { model: model.value });
    if (model.effortLevels.includes(bar.effort) && bar.effort !== known.effort) this.#store.report(id, 'session.effort', { effort: bar.effort }, { effort: bar.effort });
  }

  #noteMode(id, permissionMode) {
    this.#store.report(id, 'session.mode', { permissionMode, permissionModes: MODE_IDS }, { permissionMode });
  }

  // --- What a client asks ---

  #typable(sessionId) {
    const known = this.#store.find(sessionId);
    if (!known || known.agent !== AGENT || known.status === 'ended') return undefined;
    return known;
  }

  #withPane(known) {
    if (!this.#terminal || !known.pane) throw new HelperError('no_pane', 'This session can\'t be typed into from here. Start it in Rex or tmux.');
    return known;
  }

  async #refuseIfOpen(known) {
    const pending = this.#store.pendingFor(known)[0];
    if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
    if (showsDialog(await this.#terminal.readScreen(known))) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
  }

  // Opens Antigravity's terminal on a conversation, and waits until it's ready for a message. It asks
  // first about a folder it doesn't trust, and the reader's word, given in the app, answers that here.
  async #open(sessionId, cwd, { trust = false } = {}) {
    if (!this.#terminal) throw new HelperError('no_tmux', 'Install tmux or Rex on your Mac to run this session.');
    const name = `${TERMINAL_PREFIX}${sessionId.slice(0, TERMINAL_ID_LENGTH)}`;
    const variables = Object.fromEntries(TERMINAL_ENV.filter(key => this.#env[key]).map(key => [key, this.#env[key]]));
    const target = await this.#terminal.startSession({ name, cwd, command: [COMMAND, '--conversation', sessionId], env: variables });
    const { startLimit, startCheck, keySettle } = this.#timing;
    let isAnswered = false;
    for (const deadline = Date.now() + startLimit; Date.now() < deadline; await pause(startCheck)) {
      if (!(await this.#terminal.isSessionOpen(name, target))) throw new HelperError('start_failed', 'Antigravity quit before the session started.');
      const screen = await this.#terminal.readScreen(target).catch(() => '');
      if (asksTrust(screen) && !isAnswered) {
        if (trust !== true) {
          // Esc is its "No, exit".
          await this.#terminal.pressKey(target, 'Escape');
          throw new HelperError('needs_trust', 'Antigravity asks whether to trust this folder first.');
        }
        if (!hasTrustPicked(screen)) {
          await this.#terminal.pressKey(target, 'Up');
          await pause(keySettle);
          if (!hasTrustPicked(await this.#terminal.readScreen(target))) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
        }
        await this.#terminal.pressKey(target, 'Enter');
        isAnswered = true;
        continue;
      }
      if (isIdle(screen)) return target;
    }
    throw new HelperError('start_failed', 'Antigravity took too long to start.');
  }

  #adopt(sessionId, cwd, target, source) {
    const known = this.#store.adopt(sessionId, {
      agent: AGENT, permissionModes: MODE_IDS, permissionMode: 'default', cwd, transcriptPath: transcriptOf(this.#data, sessionId),
      pane: target.pane, tmuxSocket: target.tmuxSocket, rexSession: target.rexSession, rexServer: target.rexServer,
    });
    this.#store.report(sessionId, 'session.started', { source, model: known.model, cwd });
    this.#store.report(sessionId, 'session.status', { status: 'idle' });
    this.#session(sessionId).settlesAt = Date.now() + SETTLE_MS;
    return known;
  }

  // What the bar says once the terminal is up: the mode it's in, which no hook tells, and what it runs
  // on, which a hook tells only once something is said. The models are waited for a while, to name its
  // model by, and what the bar says is read again each time the terminal is looked at.
  async #readBar(known) {
    await Promise.race([this.#knownModels().catch(() => []), pause(this.#timing.modelsWait)]);
    this.#noteBar(known.id, readBar(await this.#terminal.readScreen(known).catch(() => '')));
  }

  // A new conversation in a folder, in a terminal of its own at the Mac.
  async start({ cwd, trust = false }) {
    const folder = checkedFolder(cwd);
    if (!this.#installed()) throw new HelperError('no_antigravity', 'Antigravity isn\'t on this Mac.');
    if (!this.#terminal) throw new HelperError('no_tmux', 'Install tmux or Rex on your Mac to run this session.');
    if (trust !== true && !isTrusted(folder, this.#data)) throw new HelperError('needs_trust', 'Antigravity asks whether to trust this folder first.');
    // Asked for now, to be there by the time the terminal is up.
    this.#knownModels().catch(() => {});
    let sessionId;
    try {
      sessionId = await this.#mint(folder);
    } catch (error) {
      throw new HelperError('start_failed', `Antigravity wouldn't start a session: ${error.message}`);
    }
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new HelperError('start_failed', 'Antigravity didn\'t say which session it started.');
    const target = await this.#open(sessionId, folder, { trust });
    const known = this.#adopt(sessionId, folder, target, 'startup');
    await this.#readBar(known);
    return { sessionId };
  }

  // A session to type into: the one going on, or a stored one opened in a terminal again.
  async #live(sessionId) {
    const going = this.#typable(sessionId);
    if (going) return this.#withPane(going);
    const cwd = await this.folderOf(sessionId);
    if (!cwd) throw new HelperError('unknown_session', `No session ${sessionId}`);
    const folder = fs.existsSync(cwd) ? cwd : os.homedir();
    let target;
    try {
      target = await this.#open(sessionId, folder, { trust: isTrusted(folder, this.#data) });
    } catch (error) {
      if (error.code === 'needs_trust') throw error;
      throw new HelperError('resume_failed', `Antigravity couldn't open this session: ${error.message}`);
    }
    const known = this.#adopt(sessionId, cwd, target, 'resume');
    await this.#readBar(known);
    return known;
  }

  async send({ sessionId, text, clientId, lane, attachments = [] }) {
    const known = await this.#live(sessionId);
    const message = { clientId, text, lane: lane ?? 'next', attachments };
    // A turn takes nothing more once it's going: what's sent meanwhile waits for its end.
    if (this.#session(sessionId).turn || this.#store.isBusy(known) || this.#store.pendingFor(known).length) {
      this.#store.hold(known, message);
      return { queued: true };
    }
    await this.deliver(known, message);
    return { queued: false };
  }

  // A message is typed into the terminal, and starts a turn when Antigravity says so.
  async deliver(known, { text, clientId, attachments = [] }) {
    this.#withPane(known);
    const session = this.#session(known.id);
    if (session.turn) throw new HelperError('send_failed', 'Antigravity is still answering the last message.');
    const typed = typedText(text, attachments);
    if (!typed.trim()) throw new HelperError('bad_text', 'Nothing to send.');
    await this.#refuseIfOpen(known);
    const entry = { typed, text, clientId, attachments, at: Date.now() };
    session.typed.push(entry);
    try {
      await this.#terminal.paste(known, typed);
      await pause(this.#timing.pasteSettle);
      await this.#refuseIfOpen(known);
      await this.#terminal.pressKey(known, 'Enter');
    } catch (error) {
      session.typed = session.typed.filter(found => found !== entry);
      throw error;
    }
    // Until its hook says the turn has started, so that nothing else is typed behind it.
    this.#store.report(known.id, 'session.status', { status: 'running' });
    session.lastHookAt = Date.now();
  }

  // Esc, as at the Mac: on a prompt it says no, and in a turn it stops it. Nothing tells of either,
  // so the screen is watched until it waits for a message again.
  async interrupt({ sessionId }) {
    const known = this.#typable(sessionId);
    const session = this.#sessions.get(sessionId);
    if (!known || !(session?.turn || known.status === 'running' || known.status === 'waiting')) throw new HelperError('not_running', 'Nothing to interrupt.');
    this.#withPane(known);
    await this.#terminal.pressKey(known, 'Escape');
    for (const end = Date.now() + this.#timing.keyLimit; Date.now() < end; await pause(this.#timing.keyCheck)) {
      if (isIdle(await this.#terminal.readScreen(known).catch(() => ''))) {
        await this.#inLine(sessionId, async () => {
          if (session?.turn) this.#endTurn(sessionId, session, { isInterrupted: true });
          else this.#store.report(sessionId, 'session.status', { status: 'idle' });
        });
        break;
      }
    }
    return {};
  }

  // What the session may do without asking, from here on: Shift+Tab, which goes round the modes, with
  // the bar read after each press.
  async setMode({ sessionId, mode }) {
    if (!MODE_IDS.includes(mode)) throw new HelperError('bad_mode', `Not a mode an Antigravity session can be switched to: ${mode}`);
    const known = this.#withPane(await this.#live(sessionId));
    const failed = () => new HelperError('mode_failed', 'The terminal didn\'t show the session\'s mode as expected, so it was left as it is.');
    await this.#refuseIfOpen(known);
    // Its bar names the mode only between turns.
    if (this.#session(sessionId).turn) throw new HelperError('session_busy', 'Wait for the turn to end first.');
    const read = async () => {
      const bar = readBar(await this.#terminal.readScreen(known));
      return bar?.hint === 'idle' ? bar.mode : undefined;
    };
    let current = await read();
    if (!current) throw failed();
    for (let press = 0; current !== mode; press++) {
      if (press >= MOST_MODE_PRESSES) throw failed();
      await this.#terminal.pressKey(known, 'BTab');
      const before = current;
      for (const end = Date.now() + this.#timing.keyLimit; ; await pause(this.#timing.keyCheck)) {
        current = await read();
        if (current && current !== before) break;
        if (Date.now() >= end) throw failed();
      }
    }
    if (known.permissionMode !== mode) this.#noteMode(sessionId, mode);
    return {};
  }

  // A command of the terminal's own that takes hold at once, typed there. What it says back is waited for.
  async #run(known, command, said) {
    await this.#refuseIfOpen(known);
    if (this.#session(known.id).turn) throw new HelperError('session_busy', 'Wait for the turn to end first.');
    await this.#terminal.paste(known, command);
    await pause(this.#timing.pasteSettle);
    await this.#terminal.pressKey(known, 'Enter');
    for (const end = Date.now() + this.#timing.commandLimit; Date.now() < end; await pause(this.#timing.keyCheck)) {
      const screen = await this.#terminal.readScreen(known).catch(() => '');
      // The screen ends in the lines left empty under the bar.
      if (said.test(screen.trimEnd().split('\n').slice(-12).join('\n')) && isIdle(screen)) return true;
    }
    return false;
  }

  // What the session runs on, from its next turn: `/model` and `/effort`, as at the Mac. Antigravity
  // keeps the choice for the sessions started after, as it does one made there.
  async configure({ sessionId, model, effort }) {
    if (model === undefined && effort === undefined) throw new HelperError('bad_model', 'Nothing to change.');
    const known = this.#withPane(await this.#live(sessionId));
    if (model !== undefined) {
      const chosen = (await this.#knownModels()).find(found => found.value === model);
      if (!chosen) throw new HelperError('bad_model', `Antigravity has no model ${model}.`);
      // It keeps thinking the way it does, which its bar says where nothing else has.
      const wanted = effort ?? known.effort ?? readBar(await this.#terminal.readScreen(known).catch(() => ''))?.effort;
      const level = levelFor(chosen.effortLevels, wanted);
      if (effort !== undefined && level !== effort) throw new HelperError('bad_effort', `${chosen.displayName} can't be told to think that way.`);
      if (!(await this.#run(known, `/model ${level ? `${model}-${level}` : model}`, /Model set to /))) throw new HelperError('bad_model', 'Antigravity didn\'t take that model.');
      if (model !== known.model) this.#store.report(sessionId, 'session.model', { model });
      if (level && level !== known.effort) this.#store.report(sessionId, 'session.effort', { effort: level }, { effort: level });
      return {};
    }
    if (!EFFORTS.includes(effort)) throw new HelperError('bad_effort', `Not a way to think: ${effort}`);
    if (!(await this.#run(known, `/effort ${effort}`, /Effort set to /))) throw new HelperError('bad_effort', 'Antigravity didn\'t take that.');
    if (effort !== known.effort) this.#store.report(sessionId, 'session.effort', { effort }, { effort });
    return {};
  }

  async #knownModels() {
    const list = this.#modelList;
    if (Date.now() - list.at < MODELS_LIFETIME_MS && list.models.length) return list.models;
    list.reading ??= this.#models().then(models => {
      Object.assign(list, { at: Date.now(), models });
      return models;
    }, () => list.models).finally(() => { list.reading = undefined; });
    return list.reading;
  }

  // The models on offer. Its commands are its terminal's own, and none is listed.
  async capabilities() {
    return { commands: [], models: this.#installed() ? await this.#knownModels() : [], skills: [] };
  }

  // What a status sheet shows of a session the helper follows, and nothing for one it doesn't.
  async status({ sessionId }) {
    const known = this.#store.find(sessionId);
    if (!known) return { status: null };
    return { status: { model: known.model, effort: known.effort, project: known.cwd ? path.basename(known.cwd) : undefined, updatedAt: Math.floor(Date.now() / 1000) } };
  }

  // What was said before the turn going on: the steps before the message that started it.
  #past(sessionId) {
    const steps = this.#steps(sessionId);
    if (!this.#sessions.get(sessionId)?.turn) return historyOf(steps);
    const start = steps.findLastIndex(isUserStep);
    return historyOf(start >= 0 ? steps.slice(0, start) : steps);
  }

  async history({ sessionId, limit, before }) {
    return pageOf(this.#past(sessionId), { limit, before });
  }

  // Everything a client needs to open one. The turn going on comes as its events.
  async join({ sessionId, limit }) {
    const seq = this.#store.seq;
    const page = pageOf(this.#past(sessionId), { limit });
    const known = this.#typable(sessionId);
    if (known) {
      return {
        ...page, turn: this.#sessions.get(sessionId)?.turn ? this.#store.openTurn(known) : [], queued: [], seq,
        sessions: this.#store.sessions().filter(view => view.id === sessionId),
        requests: this.#store.requests().filter(request => request.sessionId === sessionId),
      };
    }
    return {
      ...page, turn: [], queued: [], seq, requests: [],
      sessions: [{ id: sessionId, status: 'ended', cwd: await this.folderOf(sessionId), agent: AGENT, tasks: [], backgroundTasks: 0 }],
    };
  }

  // Antigravity keeps its conversations itself, and has no way to be asked to drop one.
  async remove() {
    throw new HelperError('cant_delete', 'Antigravity keeps its own sessions, and this one can only be deleted there.');
  }

  image() {
    throw new HelperError('unknown_image', 'This image is no longer there.');
  }
}
