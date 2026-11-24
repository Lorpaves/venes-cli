// The state core: turns raw hook events and transcript records into one ordered
// stream of client events. It does no I/O, so it can be tested without Claude.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isPollEvent, normalized, parseTaskNotification, signalsFrom, unwrapPasted } from './transcript.mjs';
import { HelperError } from './errors.mjs';
import { splitAttachments, uploadsRoot } from './uploads.mjs';
import { lightened } from './light.mjs';

export { HelperError };

const EVENT_LOG_SIZE = 5000;
const REQUEST_KIND = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };

// What a line sent from here comes back as. Most come back as they went, but Claude Code says one command
// its own way: `/goal X`, sent while Claude works, sets the goal at once and gives Claude "Goal set: X" to
// read (2.1.331). Its send waited under the conversation for an echo of `/goal X`, which never came, while
// "Goal set: X" showed above it as a message of its own (2026-11-24).
const echoesOf = sent => {
  const goal = /^\/goal (.+)$/.exec(sent);
  return goal ? [sent, `Goal set: ${goal[1]}`] : [sent];
};
const isEchoOf = (echo, text) => echoesOf(echo.text).includes(normalized(text));
// The ways on from a plan, as Claude Code's terminal words them (yyt in 2.1.318), by the mode each
// switches to. The clear-context and Ultraplan rows aren't here: a hook can't do either.
const PLAN_OPTION_LABELS = {
  bypassPermissions: 'Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session',
  auto: 'Yes, and use auto mode',
  acceptEdits: 'Yes, auto-accept edits',
  default: 'Yes, manually approve edits',
};
const MAX_FINISHED_TASKS = 100;
// Slash commands that Claude Code runs itself never echo, so old entries have to fall off.
const MAX_ECHOES = 32;
// PostCompact fires just before the transcript gets the sizes it can't report itself.
const COMPACT_STATS_WAIT_MS = 2000;
// A session this silent has probably crashed, and must not hold up an update for ever.
const STALE_SESSION_MS = 60 * 60_000;
// A prompt says so when it starts a turn, but a local command says nothing at all, so a
// sent message gets this long to show which it was before the next one follows.
const HELD_SETTLE_MS = 2000;
// In case a compaction ends in a way neither hooks nor the transcript show.
const COMPACT_LIMIT_MS = 30 * 60_000;
// Claude Code takes back a turn stopped before Claude has answered, and writes nothing of it, not even
// that it was stopped. One with no answer this long after Escape is over.
const TAKEN_BACK_MS = 2500;
// Stop can fire before the turn's last words reach the transcript.
const TRANSCRIPT_SETTLE_MS = 2000;
const ENDS_TURN = new Set(['turn.end', 'turn.interrupted', 'turn.error', 'session.ended']);
// A line run with `!` that Claude won't answer is over once it has printed.
const endsTurn = e => ENDS_TURN.has(e.kind) || (e.kind === 'message.output' && e.replies === false);
// When a transcript record was written, for an event that comes from one.
const writtenAt = timestamp => {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? { at } : {};
};


// Only Rex and tmux can be typed into, and a session started before the plugin was installed sends
// no hooks to say where it is, so a restart is the way out of both.
export const notTypable = () => new HelperError('no_pane', process.platform === 'win32'
  // Its console wasn't told, or couldn't be reached, when it started: Claude Code started again says where it is.
  ? 'This session can’t be controlled from here. Quit and reopen Claude Code on your computer.'
  : 'This session can\'t be typed into from here. Restart it in Rex or tmux.');

function permissionDecision(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// The terminal offers bypassing permissions where that's on offer, else auto mode where that is, else
// accepting edits, then asking for each edit. Claude Code doesn't tell a hook which modes it offers, but
// one the session has been in is on offer, so a session never seen in bypass or auto mode is offered
// what a session without them would be.
function planOptions(modes) {
  const first = modes.includes('bypassPermissions') ? 'bypassPermissions' : modes.includes('auto') ? 'auto' : 'acceptEdits';
  return [first, 'default'].map(id => ({ id, label: PLAN_OPTION_LABELS[id] }));
}

// What Claude Code's terminal tells Claude when someone says no, in its words. Given what to do
// instead, Claude carries on from that. Given nothing, the terminal stops the turn too, as Esc does,
// so Claude doesn't take the no for a failure to try again. A subagent is told the way the terminal
// tells one, and its turn isn't stopped.
const REJECTED = 'The user doesn\'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).';
const SUBAGENT_DENIED = 'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).';

function denial(request, message) {
  const said = typeof message === 'string' ? message.trim() : '';
  if (request.agentId) {
    return {
      behavior: 'deny',
      message: said ? `${SUBAGENT_DENIED} The user said:\n${said}` : `${SUBAGENT_DENIED} Try a different approach or report the limitation to complete your task.`,
    };
  }
  if (said) return { behavior: 'deny', message: `${REJECTED} To tell you how to proceed, the user said:\n${said}` };
  return { behavior: 'deny', message: `${REJECTED} STOP what you are doing and wait for the user to tell you how to proceed.`, interrupt: true };
}

// The notes a reader added to their answers, for the questions asked: Claude Code shows each with its answer.
function notesFor(request, annotations) {
  if (!annotations || typeof annotations !== 'object') return {};
  const asked = new Set((request.input.questions ?? []).map(q => q.question));
  const notes = Object.entries(annotations).flatMap(([question, said]) => {
    const words = typeof said?.notes === 'string' ? said.notes.trim() : '';
    return asked.has(question) && words ? [[question, { notes: words }]] : [];
  });
  return notes.length ? { annotations: Object.fromEntries(notes) } : {};
}

function buildDecision(request, { decision, message, answers, annotations, always, option }) {
  if (decision === 'deny') return permissionDecision(denial(request, message));
  if (decision !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${decision}`);
  if (request.kind === 'permission' && option != null) {
    throw new HelperError('bad_option', 'That choice is made in the terminal, which this request can\'t reach. Choose again.');
  }
  // Questions and plans ignore a bare allow, so the input has to come back too. A plan approved with
  // one of its options switches to that option's mode. Approved without one, it goes back to the mode
  // the session was seen in before it planned: left out, Claude Code can pick acceptEdits, which a
  // session cycled through on its way to plan mode. Not seen, it's left to Claude Code.
  if (request.kind === 'plan') {
    if (option != null && !request.options.some(o => o.id === option)) {
      throw new HelperError('bad_option', 'That choice isn\'t offered for this plan. Choose again.');
    }
    const mode = option ?? request.modeBeforePlan;
    const setMode = mode ? { updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }] } : {};
    return permissionDecision({ behavior: 'allow', updatedInput: request.input, ...setMode });
  }
  if (request.kind === 'question') {
    const missing = (request.input.questions ?? []).filter(q => !answers?.[q.question]).map(q => q.question);
    if (missing.length) throw new HelperError('missing_answers', 'Every question needs an answer.', { missing });
    return permissionDecision({ behavior: 'allow', updatedInput: { ...request.input, answers, ...notesFor(request, annotations) } });
  }
  if (!always) return permissionDecision({ behavior: 'allow' });
  if (!request.permissionSuggestions?.length) throw new HelperError('nothing_to_remember', 'This request has no rule to remember.');
  return permissionDecision({ behavior: 'allow', updatedPermissions: request.permissionSuggestions });
}

// Claude Code also suggests switching the whole session to acceptEdits, or widening its
// folders. Those do far more than "don't ask again for this", so they aren't offered here.
function rememberableRules(suggestions = []) {
  return suggestions.filter(suggestion => suggestion.type === 'addRules' && suggestion.behavior === 'allow');
}

// Includes the short wait for its sizes, so that compact.end goes out before anything
// that happened after the compaction does.
const isCompacting = s => !!(s.compacting || s.compactWait);

const isAtWork = status => status === 'running' || status === 'waiting';
// The tools that stop a background task. KillShell is the older name.
const STOP_TOOLS = new Set(['TaskStop', 'KillShell']);

// Late pieces of the turn before can sit between its end and these.
const startsTurn = e => e.kind === 'message.user' || e.kind === 'task.notification' || (e.kind === 'session.status' && isAtWork(e.status));

// The folders remembered of where a session has worked.
const RECENT_FOLDERS = 12;

// The modes a Claude Code session always comes round to with Shift+Tab, and those it only has when it
// was started with them or its plan allows them, in the order it goes round. Claude Code tells no one
// which a session has, so the optional ones are those it has been seen in.
const ALWAYS_MODES = ['default', 'acceptEdits', 'plan'];
const OPTIONAL_MODES = ['bypassPermissions', 'auto'];

// The modes a session can be switched to: what whoever follows it says, as for a Codex session, or else
// a Claude Code session's own.
export function modesOf(s) {
  return s.permissionModes ?? [...ALWAYS_MODES, ...OPTIONAL_MODES.filter(mode => s.modes.includes(mode) || s.permissionMode === mode)];
}

// When a session was last at work, after something said of it now, or as of `at`: never before what was
// known of it already.
function lastAt(s, at) {
  return at === undefined ? Date.now() : Math.max(s?.lastEventAt ?? 0, at);
}

function blankSession(id) {
  return {
    id, status: 'idle', tools: new Map(), tasks: new Map(), agentParents: new Map(), echoes: [], held: [], queued: [], pollEvents: 0, backgroundTasks: 0, modes: [],
  };
}

// Where a session started, and the folders it has worked in since, the latest first. A session moves
// about as it works, so what's looked for by where it is, such as its repositories, is looked for in
// all of these.
function noteFolder(s, cwd) {
  if (!cwd) return;
  s.startFolder ??= cwd;
  if (s.folders?.[0] === cwd) return;
  s.folders = [cwd, ...(s.folders ?? []).filter(folder => folder !== cwd)].slice(0, RECENT_FOLDERS);
}

function taskView({ result, outputFile, ...task }) {
  // A subagent's output file is its raw transcript, so only its result counts.
  return { ...task, hasOutput: result !== undefined || (!!outputFile && task.type !== 'subagent') };
}

export class SessionStore extends EventEmitter {
  #sessions = new Map();
  #requests = new Map();
  #deleted = new Set();
  #log = [];
  #seq = 0;
  // When what's being said happened, where that isn't now: see `#dated`.
  #asOf;
  #agentParent;
  #compactWaitMs;
  #compactLimitMs;
  #takenBackMs;
  #splitAttachments;

  // agentParent reads which tool call started a subagent, which needs the file system.
  // `splitAttachments` reads what's kept of the files a message names, which is I/O, so it's passed in.
  constructor({
    agentParent = () => undefined, compactWaitMs = COMPACT_STATS_WAIT_MS, compactLimitMs = COMPACT_LIMIT_MS, takenBackMs = TAKEN_BACK_MS,
    splitAttachments: split = (text, sessionId) => splitAttachments(text, { root: uploadsRoot(), sessionId }),
  } = {}) {
    super();
    this.#agentParent = agentParent;
    this.#splitAttachments = split;
    this.#compactWaitMs = compactWaitMs;
    this.#compactLimitMs = compactLimitMs;
    this.#takenBackMs = takenBackMs;
  }

  get seq() { return this.#seq; }

  sessions() { return [...this.#sessions.values()].map(s => this.#sessionView(s)); }

  requests() { return [...this.#requests.values()].map(r => this.#requestView(r)); }

  requestOf(requestId) {
    const request = this.#requests.get(requestId);
    return request && this.#requestView(request);
  }

  liveSessions() { return [...this.#sessions.values()].filter(s => s.status !== 'ended'); }

  // Sessions a restart would lose. One outside tmux can't be found again or typed into, so it
  // comes back with its next hook, as it always did.
  registry() { return this.liveSessions().filter(s => s.pane); }

  // Sessions from before a restart. Hooks only tell the helper about a session when it does
  // something, so an idle one would otherwise stay gone.
  restore(records) {
    for (const record of records) {
      // Saved before the helper kept the modes a session was in, the one it was last in is still one.
      const modes = Array.isArray(record.modes) ? record.modes : [record.permissionMode].filter(Boolean);
      if (!this.#sessions.has(record.id)) this.#sessions.set(record.id, { ...blankSession(record.id), ...record, modes });
    }
  }

  isBusy(s) {
    return isAtWork(s.status) || s.held.length > 0 || isCompacting(s);
  }

  // Whether the helper could restart now without losing anything in progress. Restarting
  // forgets held messages, and turns an open request back into a terminal-only prompt.
  // A terminal session's shell goes on without the helper, which reads what it missed when it's back.
  isQuiet(now = Date.now()) {
    return this.liveSessions().every(s => s.outlivesHelper || now - s.lastEventAt > STALE_SESSION_MS || (!this.isBusy(s) && !this.pendingFor(s).length));
  }

  get(idOrPrefix) {
    const exact = this.#sessions.get(idOrPrefix);
    if (exact) return exact;
    const matches = [...this.#sessions.values()].filter(s => s.id.startsWith(idOrPrefix));
    if (matches.length === 1) return matches[0];
    throw new HelperError(matches.length ? 'ambiguous_session' : 'unknown_session', `No single session matches ${idOrPrefix}`);
  }

  find(idOrPrefix) {
    try {
      return this.get(idOrPrefix);
    } catch (error) {
      if (error.code === 'unknown_session') return undefined;
      throw error;
    }
  }

  // A session the helper follows through something other than hooks, as it does a Codex thread through
  // Codex's own server. `agent` among its `fields` says which, and every view of it says so too. `at` is
  // when it was last at work, for one found as it was rather than seen doing something: a thread found in
  // Codex's memory is as old as its last word, not as new as the finding. Taken as the finding, fourteen
  // Codex sessions nobody had used that day stood at the top of the list as just at work, every time the
  // helper found them again (2026-11-24).
  adopt(id, fields = {}, { at = undefined } = {}) {
    let s = this.#sessions.get(id);
    this.#deleted.delete(id);
    const when = lastAt(s, at);
    return this.#dated(when, () => {
      if (!s) {
        s = { ...blankSession(id), startedAt: when, ...fields };
        this.#sessions.set(id, s);
        this.#emit(s, 'session.discovered', { cwd: s.cwd, ...(s.agent && { agent: s.agent }) });
      } else {
        Object.assign(s, fields);
        if (s.status === 'ended') this.#setStatus(s, 'idle');
      }
      s.lastEventAt = when;
      return s;
    });
  }

  // An event for such a session, after `fields` change what's known of it. A status, a model and an
  // end go the way a hook's would, so that each is said once and does all it should. `supersedes`
  // takes out earlier events this one makes stale, as a command's output so far is by its output since.
  // `at` is when it happened, where that isn't now, as `adopt` has it: what isn't something done in the
  // session, such as what it's set to run on, is said as of its last work, and leaves it where it was.
  report(id, kind, data = {}, fields = undefined, { supersedes = undefined, at = undefined } = {}) {
    const s = this.#sessions.get(id);
    if (!s) return;
    Object.assign(s, fields);
    // An end said of a session that's over already is nothing new, and doesn't make it newer.
    if (kind === 'session.ended' && s.status === 'ended') return;
    s.lastEventAt = lastAt(s, at);
    if (supersedes) this.#log = this.#log.filter(e => e.sessionId !== id || !supersedes(e));
    this.#dated(s.lastEventAt, () => {
      if (kind === 'session.status') this.#setStatus(s, data.status, data.working);
      else if (kind === 'session.model') this.#setModel(s, data.model);
      else if (kind === 'session.ended') this.#endSession(s, data.reason);
      else this.#emit(s, kind, data);
    });
  }

  // Says what `tell` says as of `at`: each event it makes is dated then, since a client puts a session
  // where its events' times say.
  #dated(at, tell) {
    const outer = this.#asOf;
    this.#asOf = at;
    try {
      return tell();
    } finally {
      this.#asOf = outer;
    }
  }

  // A request that something other than a hook waits on. `decide` turns a client's answer into what
  // that wants, and throws when the answer won't do. `decision` settles with it, or with nothing when
  // the request closes some other way.
  ask(sessionId, fields, decide) {
    const s = this.get(sessionId);
    let finish;
    const decision = new Promise(resolve => { finish = resolve; });
    const request = { id: randomUUID(), sessionId: s.id, openedAt: Date.now(), ...fields, finish, decide };
    this.#requests.set(request.id, request);
    this.#setStatus(s, 'waiting');
    this.#emit(s, 'request.opened', { request: this.#requestView(request) });
    return { request: this.#requestView(request), decision };
  }

  // A request answered somewhere else, or one nothing waits on any more.
  settle(requestId, result) {
    const request = this.#requests.get(requestId);
    if (request) this.#closeRequest(request, result);
  }

  settleAll(sessionId, result) {
    const s = this.#sessions.get(sessionId);
    if (s) this.#closeRequests(s, result);
  }

  // A session about to be resumed, so that it can expect messages before its first hook.
  reopen(id, { cwd, startedAt }) {
    let s = this.#sessions.get(id);
    if (!s) {
      s = { ...blankSession(id), startedAt: startedAt ?? Date.now(), cwd };
      this.#sessions.set(id, s);
      this.#emit(s, 'session.discovered', { cwd });
    } else if (s.status === 'ended') {
      this.#setStatus(s, 'idle');
    }
    s.pane = undefined;
    s.tmuxSocket = undefined;
    s.rexSession = undefined;
    s.rexServer = undefined;
    s.waitingAt = undefined;
    s.asking = false;
    s.lastEventAt = Date.now();
    return s;
  }

  // Resuming it didn't work out.
  abandon(s) { this.#endSession(s, 'resume_failed'); }

  // A session deleted from this Mac. Its last hooks can still be on their way, and mustn't bring
  // it back, so it stays known as deleted.
  forget(id) {
    const s = this.#sessions.get(id);
    if (s && s.status !== 'ended') this.#endSession(s, 'deleted');
    this.#sessions.delete(id);
    this.#deleted.add(id);
    this.#emit({ id }, 'session.deleted', {});
  }

  pendingFor(session) {
    return [...this.#requests.values()].filter(r => r.sessionId === session.id);
  }

  task(sessionId, taskId) {
    const task = this.get(sessionId).tasks.get(taskId);
    if (!task) throw new HelperError('unknown_task', `No task ${taskId} in this session.`);
    return task;
  }

  // Remembers a message on its way, so its echo can say which send it was.
  expectEcho(s, clientId, text) {
    s.echoes.push({ clientId, text: normalized(text) });
    if (s.echoes.length > MAX_ECHOES) s.echoes.shift();
  }

  // What's queued for Claude and not read yet, oldest first: what each says, its files, and the send it
  // came from when that was here. One typed in the terminal has none.
  queuedFor(s) {
    const echoes = [...s.echoes];
    return s.queued.map(typed => {
      const { text, files } = this.#splitAttachments(typed, s.id);
      const at = echoes.findIndex(echo => isEchoOf(echo, text));
      const clientId = at >= 0 ? echoes.splice(at, 1)[0].clientId : undefined;
      return { text, ...(clientId && { clientId }), ...(files.length ? { attachments: files } : {}) };
    });
  }

  forgetEcho(s, clientId) {
    s.echoes = s.echoes.filter(echo => echo.clientId !== clientId);
  }

  hold(s, message) { s.held.push(message); }

  // `later` waits for the turn to end. Anything else waits only for what's ahead of it, and for an
  // open request, which Enter would answer.
  mustHold(s, lane) {
    return lane === 'later' ? this.isBusy(s) : s.held.length > 0 || this.pendingFor(s).length > 0;
  }

  // The message that can go out now, if any.
  nextHeld(s, now = Date.now()) {
    const [first] = s.held;
    if (!first || isCompacting(s)) return undefined;
    if (first.lane === 'next' ? this.pendingFor(s).length > 0 : s.status !== 'idle') return undefined;
    if (now - (s.lastHeldAt ?? 0) < HELD_SETTLE_MS) return undefined;
    s.lastHeldAt = now;
    return s.held.shift();
  }

  cancelHeld(s, clientId) {
    return this.takeHeld(s, clientId) !== undefined;
  }

  // The held message taken back, with what it had attached, or undefined when there's none by that id.
  takeHeld(s, clientId) {
    const position = s.held.findIndex(message => message.clientId === clientId);
    return position < 0 ? undefined : s.held.splice(position, 1)[0];
  }

  failSend(s, { clientId }, { code = 'internal', message }) {
    this.#emit(s, 'send.failed', { clientId, code, message });
  }

  eventsSince(seq) {
    return {
      events: this.#log.filter(e => e.seq > seq),
      gap: this.#log.length > 0 && this.#log[0].seq > seq + 1,
    };
  }

  // What a session has told since `seq`, for a client that has all of it up to there and wants what's
  // new. Undefined when some of that has gone from the log, since then it can't be made up from here.
  eventsOf(s, seq) {
    const { events, gap } = this.eventsSince(seq);
    return gap ? undefined : events.filter(e => e.sessionId === s.id);
  }

  // This session's events that the transcript can't be relied on for yet: the turn going on
  // now, and any that ended so recently its last words may not have reached the file.
  openTurn(s, now = Date.now()) {
    const events = this.#log.filter(e => e.sessionId === s.id);
    const settled = events.findLastIndex(e => endsTurn(e) && now - e.at > TRANSCRIPT_SETTLE_MS);
    const start = events.findIndex((e, index) => index > settled && startsTurn(e));
    return start < 0 ? [] : events.slice(start);
  }

  // How long until the transcript can be relied on for the turn this session ended last: nothing, unless
  // it ended a moment ago. Whoever reads the transcript for what a page already shows waits this long,
  // or the turn's last words, not yet written there, would go from the page.
  settlesIn(s, now = Date.now()) {
    const last = this.#log.findLast(e => e.sessionId === s.id && endsTurn(e));
    return last ? Math.max(0, TRANSCRIPT_SETTLE_MS - (now - last.at)) : 0;
  }

  // Returns undefined, or { request, decision } when the hook must wait for an answer.
  handleHook(ev, tmux = {}) {
    if (!ev.session_id || this.#deleted.has(ev.session_id)) return undefined;
    const s = this.#touch(ev, tmux);
    const agentId = ev.agent_id;
    switch (ev.hook_event_name) {
      case 'SessionStart':
        // A resumed session can be on another model, and this doesn't always say which.
        s.model = ev.model ?? (ev.source === 'resume' ? undefined : s.model);
        this.#emit(s, 'session.started', { source: ev.source, model: ev.model, cwd: s.cwd });
        break;
      case 'PostModelSwitch':
        if (ev.to_model) this.#setModel(s, ev.to_model);
        break;
      case 'SessionEnd':
        this.#endSession(s, ev.reason);
        break;
      case 'UserPromptSubmit':
        // In Code Mode what Claude's code prints comes through here too, for Claude to read. It isn't the
        // user talking, and only says that an idle session has work again.
        if (ev.source === 'poll_event' || isPollEvent(ev.prompt)) {
          if (!isAtWork(s.status)) this.#setStatus(s, 'running');
          break;
        }
        // A finished background task re-enters as a synthetic prompt; it isn't the user talking.
        if (ev.prompt?.startsWith('<task-notification>')) this.#onTaskNotification(s, ev.prompt);
        // This runs as a message is typed. During a turn, Claude only reads it later.
        else if (isAtWork(s.status)) s.queued.push(unwrapPasted(ev.prompt ?? ''));
        else this.#onUserMessage(s, unwrapPasted(ev.prompt ?? ''));
        this.#setStatus(s, 'running');
        break;
      case 'MessageDisplay':
        // Hooks run as separate processes, so the final delta can land after Stop.
        // It must not change the status, or a finished turn would look like it's running. Nor is it an answer in
        // the turn after.
        if (!ev.final) s.replied = true;
        this.#emit(s, 'message.assistant.delta', {
          messageId: ev.message_id, turnId: ev.turn_id, index: ev.index, text: ev.delta, final: ev.final, agentId,
        });
        break;
      case 'PreToolUse':
        this.#markRunning(s, agentId);
        s.replied = true;
        s.tools.set(ev.tool_use_id, { name: ev.tool_name, input: ev.tool_input });
        this.#emit(s, 'tool.start', {
          toolUseId: ev.tool_use_id, name: ev.tool_name, input: ev.tool_input, agentId, parentToolUseId: this.#parentOf(s, agentId),
        });
        break;
      case 'PermissionRequest':
        return this.#openRequest(s, ev);
      case 'PostToolUse':
        this.#endTool(s, ev.tool_use_id, { response: ev.tool_response, durationMs: ev.duration_ms, isError: false, agentId });
        break;
      case 'PostToolUseFailure':
        this.#endTool(s, ev.tool_use_id, { response: ev.error, durationMs: ev.duration_ms, isError: true, agentId });
        break;
      case 'Stop':
        this.#closeRequests(s, { decision: 'unknown', by: 'turn_end' }, r => !r.agentId);
        this.#mergeTasks(s, ev.background_tasks);
        s.backgroundTasks = ev.background_tasks?.length ?? 0;
        s.lastMessage = ev.last_assistant_message ?? s.lastMessage;
        this.#setStatus(s, 'idle');
        this.#emit(s, 'turn.end', {
          lastMessage: ev.last_assistant_message, backgroundTasks: s.backgroundTasks,
          tasks: [...s.tasks.values()].filter(task => task.status === 'running').map(taskView),
        });
        this.#startQueued(s);
        break;
      case 'StopFailure':
        this.#setStatus(s, 'idle');
        this.#emit(s, 'turn.error', { error: ev.error, details: ev.error_details });
        break;
      case 'SubagentStart':
        this.#emit(s, 'agent.start', { agentId, agentType: ev.agent_type, parentToolUseId: this.#parentOf(s, agentId) });
        break;
      case 'SubagentStop':
        // Claude Code's internal helper agents stop with an empty type and never "start".
        if (ev.agent_type) this.#emit(s, 'agent.stop', { agentId, agentType: ev.agent_type });
        this.#mergeTasks(s, ev.background_tasks);
        break;
      case 'TaskCreated':
        this.#emit(s, 'task.created', { taskId: ev.task_id, subject: ev.task_subject });
        break;
      case 'TaskCompleted':
        this.#emit(s, 'task.completed', { taskId: ev.task_id, subject: ev.task_subject });
        break;
      case 'Notification':
        this.#emit(s, 'notification', { notificationType: ev.notification_type, message: ev.message });
        break;
      case 'PreCompact':
        this.#startCompacting(s, ev.trigger);
        this.#emit(s, 'compact.start', { trigger: ev.trigger });
        break;
      case 'PostCompact':
        this.#stopCompacting(s);
        this.#onCompactEnd(s, ev.trigger);
        break;
      default:
        break;
    }
    return undefined;
  }

  handleTranscriptRecord(sessionId, record) {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    // Claude's words in this turn: the turn before's can still be on their way here.
    if (record?.type === 'assistant' && !record.isSidechain && !(Date.parse(record.timestamp) < (s.turnStartedAt ?? 0))) s.replied = true;
    for (const { type, ...signal } of signalsFrom(record)) {
      if (type === 'interrupted') this.#onInterrupted(s);
      else if (type === 'turnStarted') this.#onTurnStarted(s, signal);
      else if (type === 'toolResult') this.#onToolResult(s, signal);
      else if (type === 'thinking') this.#emit(s, 'message.thinking', signal);
      else if (type === 'compacted') this.#onCompactStats(s, signal);
      else if (type === 'localOutput') this.#onLocalOutput(s, signal);
      else if (type === 'model') this.#onModelReplied(s, signal);
      else if (type === 'refusal') this.#emit(s, 'model.refusal', { ...signal, prompt: s.lastPrompt });
      else if (type === 'toolImages') this.#emit(s, 'tool.images', signal);
      else if (type === 'userImages') this.#emit(s, 'message.images', signal);
      // For the daemon, which asks the reader what the terminal asks then: see `limit.mjs`.
      else if (type === 'usageLimit') this.emit('limit', { sessionId: s.id, ...signal });
      else if (type === 'caveat') s.caveat = signal.id;
      else if (type === 'shellInput') this.#onShellInput(s, signal);
      else if (type === 'shellOutput') this.#onShellOutput(s, signal);
      else if (type === 'queueRead') this.#onQueueRead(s, signal.text);
      else if (type === 'pollEventQueued') s.pollEvents = (s.pollEvents ?? 0) + 1;
      else if (type === 'pollEventRead') s.pollEvents = Math.max((s.pollEvents ?? 0) - 1, 0);
      else if (type === 'queueTakenBack') this.#dropQueued(s, { code: 'taken_back', message: 'Taken back in the terminal.' });
    }
  }

  // Escape was pressed in the session's terminal to stop its turn. Claude Code takes back a turn stopped
  // before Claude has answered, putting the message back in its box, and writes nothing of it, not even
  // that it was stopped. So a turn with no answer yet, and still none a moment later, is over.
  interruptSent(sessionId) {
    const s = this.#sessions.get(sessionId);
    if (!s || !isAtWork(s.status) || s.replied !== false) return;
    const { turns } = s;
    setTimeout(() => {
      if (s.turns === turns && s.replied === false) this.#onInterrupted(s);
    }, this.#takenBackMs).unref();
  }

  respond(requestId, answer) {
    const request = this.#requests.get(requestId);
    if (!request) throw new HelperError('request_closed', 'This request has already been answered or closed.');
    const output = request.decide ? request.decide(answer) : buildDecision(request, answer);
    this.#closeRequest(request, { decision: answer.decision, by: 'client', output });
  }

  // The rows a permission prompt shows in the terminal past Yes and before No, once they're read off
  // the screen, for a client to offer as `options`.
  offerRows(requestId, rows) {
    const request = this.#requests.get(requestId);
    if (request?.kind !== 'permission') return;
    const options = rows.map(({ number, label }) => ({ id: String(number), label }));
    if (JSON.stringify(options) === JSON.stringify(request.options ?? [])) return;
    request.options = options;
    this.#emit(this.#sessions.get(request.sessionId), 'request.updated', { request: this.#requestView(request) });
  }

  // The row of a permission prompt that a client picked, to press in the terminal. Until it's
  // pressed, or found gone, the request counts as being answered from the client.
  choose(requestId, option) {
    const request = this.#requests.get(requestId);
    if (!request) throw new HelperError('request_closed', 'This request has already been answered or closed.');
    const offered = request.options?.find(o => o.id === option);
    if (!offered) throw new HelperError('bad_option', 'That choice isn\'t offered any more. Choose again.');
    request.choosing = true;
    return { number: Number(offered.id), label: offered.label };
  }

  // Pressed, so Claude Code has its answer from the terminal and the hook needs none.
  chosen(requestId) {
    const request = this.#requests.get(requestId);
    if (request) this.#closeRequest(request, { decision: 'allow', by: 'client' });
  }

  notChosen(requestId) {
    const request = this.#requests.get(requestId);
    if (request) request.choosing = false;
  }

  #setMode(s, mode) {
    if (mode === s.permissionMode) return;
    // The mode it planned from, which approving the plan goes back to.
    if (mode === 'plan' && s.permissionMode && s.permissionMode !== 'plan') s.modeBeforePlan = s.permissionMode;
    s.permissionMode = mode;
    this.#emit(s, 'session.mode', { permissionMode: mode, permissionModes: modesOf(s) });
  }

  // How much has changed in the session's repository, counted elsewhere and kept here, so that a client that
  // joins later has it. Nothing changed, and no repository, are both `null`, and told as no files.
  noteChanges(id, counted) {
    const s = this.#sessions.get(id);
    if (!s) return;
    const next = counted?.files > 0 ? { files: counted.files, added: counted.added ?? 0, removed: counted.removed ?? 0 } : null;
    const last = s.changes ?? null;
    if (next?.files === last?.files && next?.added === last?.added && next?.removed === last?.removed) {
      s.changes = next;
      return;
    }
    s.changes = next;
    this.#emit(s, 'session.changes', next ?? { files: 0, added: 0, removed: 0 });
  }

  // A session's mode was changed some other way than a hook saying so, as from afar in its terminal,
  // which passes other modes on the way to the one asked for. Those are modes it has, too.
  noteMode(id, mode, passed = []) {
    const s = this.#sessions.get(id);
    if (!s) return;
    for (const seen of [...passed, mode]) if (!s.modes.includes(seen)) s.modes.push(seen);
    this.#setMode(s, mode);
  }

  #touch(ev, tmux) {
    let s = this.#sessions.get(ev.session_id);
    if (!s) {
      s = {
        ...blankSession(ev.session_id), startedAt: Date.now(), cwd: ev.cwd, permissionMode: ev.permission_mode, transcriptPath: ev.transcript_path,
      };
      this.#sessions.set(s.id, s);
      this.#emit(s, 'session.discovered', { cwd: s.cwd });
    } else if (s.status === 'ended') {
      this.#setStatus(s, 'idle');
    }
    s.lastEventAt = Date.now();
    s.cwd = ev.cwd ?? s.cwd;
    noteFolder(s, s.cwd);
    s.transcriptPath = ev.transcript_path ?? s.transcriptPath;
    // Every mode it has been in, which says what a plan can offer and what it can be switched to. A
    // subagent can run in a mode of its own.
    if (ev.permission_mode && !ev.agent_id && !s.modes.includes(ev.permission_mode)) s.modes.push(ev.permission_mode);
    if (ev.permission_mode) this.#setMode(s, ev.permission_mode);
    // A subagent can run at a level of its own, which says nothing about the session.
    if (ev.effort?.level && !ev.agent_id && ev.effort.level !== s.effort) {
      s.effort = ev.effort.level;
      this.#emit(s, 'session.effort', { effort: s.effort });
    }
    if (tmux.pane) this.#claimPane(s, tmux);
    return s;
  }

  // /clear and /resume start a new session id in the same pane, which retires the old one.
  #claimPane(s, { pane, socket, rexSession, rexServer }) {
    if (s.pane === pane && s.tmuxSocket === socket) return;
    // It's back in a terminal, so it's no longer waiting on a dialog in one.
    s.waitingAt = undefined;
    s.pane = pane;
    s.tmuxSocket = socket;
    s.rexSession = rexSession;
    s.rexServer = rexServer;
    for (const other of this.#sessions.values()) {
      if (other !== s && other.pane === pane && other.tmuxSocket === socket && other.status !== 'ended') {
        this.#endSession(other, 'replaced');
      }
    }
    this.#emit(s, 'session.attached', { pane });
  }

  #endSession(s, reason) {
    this.#closeRequests(s, { decision: 'unknown', by: 'session_end' });
    // What it left running goes with it, and nothing will say so.
    for (const task of [...s.tasks.values()].filter(task => task.status === 'running')) {
      this.#updateTask(s, task.id, { status: 'stopped' });
    }
    const ended = { code: 'session_ended', message: 'This session has ended.' };
    for (const message of s.held.splice(0)) this.failSend(s, message, ended);
    this.#dropQueued(s, ended);
    this.#setStatus(s, 'ended');
    this.#emit(s, 'session.ended', { reason });
  }

  #takeEcho(s, text) {
    const position = s.echoes.findIndex(echo => isEchoOf(echo, text));
    return position < 0 ? undefined : s.echoes.splice(position, 1)[0].clientId;
  }

  // What Venes typed ahead of the text for attachments isn't part of it: pictures come as images, and
  // files as `attachments`.
  #onUserMessage(s, typed) {
    const { text, files } = this.#splitAttachments(typed, s.id);
    s.lastPrompt = text;
    this.#emit(s, 'message.user', { text, clientId: this.#takeEcho(s, text), ...(files.length ? { attachments: files } : {}) });
  }

  // A line run with `!`, from here or the terminal. It reaches the transcript once it has run, as the
  // command and then what it printed. Claude then answers it in a turn, unless a caveat came first.
  #onShellInput(s, { command, at, after }) {
    const text = `!${command}`;
    const replies = !after || after !== s.caveat;
    const clientId = this.#takeEcho(s, text);
    s.lastPrompt = text;
    s.shell = { replies, clientId };
    this.#emit(s, 'message.user', { text, clientId, shell: true, ...writtenAt(at) });
    if (replies) this.#setStatus(s, 'running');
  }

  #onShellOutput(s, { stdout, stderr, at }) {
    const { replies = true, clientId } = s.shell ?? {};
    s.shell = undefined;
    this.#emit(s, 'message.output', { stdout, stderr, replies, ...(clientId && { clientId }), ...writtenAt(at) });
  }

  // Claude has a queued message, which `text` may not name. It joins the conversation here, where
  // the transcript will have it too. A record that names nothing while code's output waits in the queue
  // is Poll taking that output.
  #onQueueRead(s, text) {
    if (text === undefined && s.pollEvents > 0) {
      s.pollEvents -= 1;
      return;
    }
    text ??= '';
    if (text.startsWith('<task-notification>')) return;
    const position = Math.max(s.queued.findIndex(queued => normalized(queued) === normalized(text)), 0);
    const [message] = s.queued.splice(position, 1);
    if (message !== undefined) this.#onUserMessage(s, message);
  }

  // What's queued when a turn ends goes out by itself, as the next turn, with no hook to say so.
  #startQueued(s) {
    if (!s.queued.length) return;
    this.#onUserMessage(s, s.queued.shift());
    this.#setStatus(s, 'running');
  }

  // A prompt that starts a turn, as the transcript has it. One typed while a turn seemed to be going is
  // kept as queued, for Claude to read later. Run at once instead, it says that turn was over, though
  // nothing told of its end, as with one stopped before Claude answered. The message is this turn's:
  // left queued, it would only show once this turn ended, and each message after it a turn late.
  #onTurnStarted(s, { text }) {
    const position = s.queued.findIndex(queued => normalized(queued) === normalized(text));
    if (position < 0) return;
    const [message] = s.queued.splice(position, 1);
    this.#stopTurn(s);
    this.#onUserMessage(s, message);
    this.#setStatus(s, 'running');
  }

  #dropQueued(s, error) {
    for (const typed of s.queued.splice(0)) {
      const clientId = this.#takeEcho(s, this.#splitAttachments(typed, s.id).text);
      if (clientId) this.failSend(s, { clientId }, error);
    }
  }

  #onTaskNotification(s, prompt) {
    const notification = parseTaskNotification(prompt);
    if (notification) {
      const { id, ...fields } = notification;
      this.#updateTask(s, id, fields);
    }
    this.#emit(s, 'task.notification', {
      taskId: notification?.id, status: notification?.status, summary: notification?.summary,
    });
  }

  #parentOf(s, agentId) {
    if (!agentId) return undefined;
    if (!s.agentParents.has(agentId)) {
      const parent = this.#agentParent(s.transcriptPath, agentId);
      if (parent) s.agentParents.set(agentId, parent);
    }
    return s.agentParents.get(agentId);
  }

  // Undefined fields are left out, so an update can't erase what an earlier source knew.
  #updateTask(s, id, fields) {
    const known = s.tasks.get(id);
    const update = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    const task = { id, startedAt: Date.now(), ...known, ...update };
    task.finishedAt = task.status === 'running' ? undefined : known?.finishedAt ?? Date.now();
    if (isDeepStrictEqual(task, known)) return;
    s.tasks.set(id, task);
    if (s.tasks.size > MAX_FINISHED_TASKS) {
      const oldest = [...s.tasks.values()].find(other => other.status !== 'running');
      if (oldest) s.tasks.delete(oldest.id);
    }
    this.#emit(s, 'background.task', { task: taskView(task) });
  }

  // The moment a task is launched can be reported after its end, so this never sets a
  // status over one already known.
  #noteLaunchedTask(s, id, fields) {
    this.#updateTask(s, id, { status: s.tasks.get(id)?.status ?? 'running', ...fields });
  }

  #mergeTasks(s, tasks = []) {
    for (const { id, type, status, description, command, name, agent_type: agentType } of tasks) {
      this.#updateTask(s, id, { type, status: status ?? 'running', description, command, name, agentType });
    }
  }

  // A task Claude stops sends no notification, so its stop is the only word that it ended.
  #trackStop(s, { name, input }) {
    if (!STOP_TOOLS.has(name)) return;
    const id = input?.task_id ?? input?.shell_id;
    if (s.tasks.get(id)?.status === 'running') this.#updateTask(s, id, { status: 'killed' });
  }

  #trackLaunch(s, toolUseId, { input }, response) {
    if (response?.backgroundTaskId) {
      this.#noteLaunchedTask(s, response.backgroundTaskId, {
        type: 'shell', toolUseId, description: input?.description, command: input?.command,
      });
    } else if (response?.isAsync && response.agentId) {
      this.#noteLaunchedTask(s, response.agentId, {
        type: 'subagent', toolUseId, description: response.description, agentType: input?.subagent_type, outputFile: response.outputFile,
      });
    }
  }

  // Sizes can reach the transcript on either side of PostCompact, so whichever comes
  // second ends the wait, and a transcript that never says lets the timer end it.
  #onCompactEnd(s, trigger) {
    if (s.compactStats) {
      this.#emit(s, 'compact.end', { trigger, ...s.compactStats });
      s.compactStats = undefined;
      return;
    }
    clearTimeout(s.compactWait?.timer);
    const timer = setTimeout(() => this.#finishCompact(s), this.#compactWaitMs);
    timer.unref();
    s.compactWait = { trigger, timer };
  }

  #onCompactStats(s, stats) {
    this.#stopCompacting(s);
    if (s.compactWait) this.#finishCompact(s, stats);
    else s.compactStats = stats;
  }

  #setModel(s, model) {
    if (model === s.model) return;
    s.model = model;
    this.#emit(s, 'session.model', { model });
  }

  // Only for a session that hasn't said. A reply can land after a switch and still be the old
  // model's, and a turn run on a skill's model says nothing about the session's.
  #onModelReplied(s, { model }) {
    if (!s.model) this.#setModel(s, model);
  }

  // A /compact that fails fires no PostCompact and only says so in its output. One that
  // works writes its boundary first, which has already cleared this by the time it gets here.
  #onLocalOutput(s, { text }) {
    if (s.compacting?.trigger === 'manual') this.#failCompaction(s, text);
  }

  #startCompacting(s, trigger) {
    this.#stopCompacting(s);
    const timer = setTimeout(() => this.#failCompaction(s), this.#compactLimitMs);
    timer.unref();
    s.compacting = { trigger, timer };
  }

  #stopCompacting(s) {
    clearTimeout(s.compacting?.timer);
    s.compacting = undefined;
  }

  // Without a message when it simply never reported back, so clients use their own words.
  #failCompaction(s, message) {
    const { trigger } = s.compacting;
    this.#stopCompacting(s);
    this.#emit(s, 'compact.failed', { trigger, message });
  }

  #finishCompact(s, stats) {
    const { trigger, timer } = s.compactWait;
    clearTimeout(timer);
    s.compactWait = undefined;
    this.#emit(s, 'compact.end', { trigger, ...stats });
  }

  #markRunning(s, agentId) {
    // A background agent can keep working after the main turn has ended.
    if (!agentId && s.status === 'idle') this.#setStatus(s, 'running');
  }

  #openRequest(s, ev) {
    const toolUseId = this.#matchTool(s, ev);
    let finish;
    const decision = new Promise(resolve => { finish = resolve; });
    const request = {
      id: randomUUID(), sessionId: s.id, kind: REQUEST_KIND[ev.tool_name] ?? 'permission',
      toolName: ev.tool_name, toolUseId, input: ev.tool_input, agentId: ev.agent_id,
      openedAt: Date.now(), finish,
    };
    if (request.kind === 'permission') request.permissionSuggestions = rememberableRules(ev.permission_suggestions);
    if (request.kind === 'plan') {
      request.modeBeforePlan = s.modeBeforePlan;
      request.options = planOptions(s.modes);
    }
    this.#requests.set(request.id, request);
    this.#setStatus(s, 'waiting');
    this.#emit(s, 'request.opened', { request: this.#requestView(request) });
    return { request, decision };
  }

  // PermissionRequest carries no tool_use_id, so it is paired with its PreToolUse.
  #matchTool(s, ev) {
    const taken = new Set([...this.#requests.values()].map(r => r.toolUseId));
    const candidates = [...s.tools].filter(([id, tool]) => tool.name === ev.tool_name && !taken.has(id));
    const exact = candidates.filter(([, tool]) => isDeepStrictEqual(tool.input, ev.tool_input));
    return (exact.at(-1) ?? candidates.at(-1))?.[0];
  }

  #endTool(s, toolUseId, data) {
    const tool = s.tools.get(toolUseId);
    if (!tool) return;
    s.tools.delete(toolUseId);
    // The tool got past approval, so any open request was answered in the terminal.
    const request = [...this.#requests.values()].find(r => r.toolUseId === toolUseId);
    if (request) this.#closeRequest(request, { decision: data.isError ? 'unknown' : 'allow', by: 'terminal' });
    this.#trackLaunch(s, toolUseId, tool, data.response);
    if (!data.isError) this.#trackStop(s, tool);
    const { response, ...rest } = data;
    this.#emit(s, 'tool.end', {
      toolUseId, name: tool.name, parentToolUseId: this.#parentOf(s, data.agentId), ...rest, ...(response !== undefined && { response }),
    });
  }

  #onToolResult(s, signal) {
    const { toolUseId, outputFile, isError } = signal;
    if (outputFile) this.#noteLaunchedTask(s, path.basename(outputFile, '.output'), { type: 'shell', toolUseId, outputFile });
    if (isError) this.#onRejectedTool(s, signal);
  }

  #onRejectedTool(s, { toolUseId, text }) {
    const request = [...this.#requests.values()].find(r => r.toolUseId === toolUseId);
    if (request) this.#closeRequest(request, { decision: 'deny', by: 'terminal' });
    this.#endTool(s, toolUseId, { response: text, isError: true });
  }

  #onInterrupted(s) {
    if (this.#stopTurn(s)) this.#startQueued(s);
  }

  // Ends the turn going on, as one stopped. Whether there was one.
  #stopTurn(s) {
    if (s.status !== 'running' && s.status !== 'waiting') return false;
    this.#closeRequests(s, { decision: 'deny', by: 'terminal' }, r => !r.agentId);
    for (const id of [...s.tools.keys()]) this.#endTool(s, id, { isError: true, interrupted: true });
    this.#setStatus(s, 'idle');
    this.#emit(s, 'turn.interrupted', {});
    return true;
  }

  #closeRequests(s, result, filter = () => true) {
    for (const r of this.pendingFor(s).filter(filter)) this.#closeRequest(r, result);
  }

  #closeRequest(request, { decision, by, output }) {
    this.#requests.delete(request.id);
    const s = this.#sessions.get(request.sessionId);
    // A row picked on a client gets pressed in the terminal, which can be seen to answer first.
    this.#emit(s, 'request.closed', { requestId: request.id, decision, by: request.choosing && by === 'terminal' ? 'client' : by });
    if (s.status === 'waiting' && this.pendingFor(s).length === 0) this.#setStatus(s, 'running');
    request.finish(output);
  }

  // A terminal session's program can be running and say it isn't at work, as one waiting for the
  // reader's next line does: that's `working: false`, and it's said again when it changes.
  #setStatus(s, status, working = undefined) {
    if (status === 'idle' || status === 'ended') this.#stopCompacting(s); // whatever became of it, the turn is over
    const isAtRest = status === 'running' && working === false;
    if (s.status === status && Boolean(s.isAtRest) !== isAtRest) {
      s.isAtRest = isAtRest;
      this.#emit(s, 'session.status', { status, ...(isAtRest && { working: false }) });
      return;
    }
    s.isAtRest = isAtRest;
    if (s.status === status) return;
    // A turn begins, with nothing of Claude's in it yet.
    if (isAtWork(status) && !isAtWork(s.status)) Object.assign(s, { turns: (s.turns ?? 0) + 1, replied: false, turnStartedAt: Date.now() });
    s.status = status;
    this.#emit(s, 'session.status', { status, ...(isAtRest && { working: false }) });
  }

  // A call is told without what no page shows of it, and cut where it runs long: an event goes to every
  // client, sits in the log, and comes again with the turn a page opens on. See `light.mjs`.
  #emit(s, kind, data) {
    const event = { seq: ++this.#seq, at: this.#asOf ?? Date.now(), sessionId: s.id, kind, ...data };
    if (kind === 'tool.start' && event.input !== undefined) event.input = lightened(event.input);
    if (kind === 'tool.end' && event.response !== undefined) event.response = lightened(event.response);
    this.#log.push(event);
    if (this.#log.length > EVENT_LOG_SIZE) this.#log.shift();
    this.emit('event', event);
  }

  #sessionView(s) {
    return {
      id: s.id, status: s.status, cwd: s.cwd, pane: s.pane ?? null, tmuxSocket: s.tmuxSocket ?? null,
      model: s.model, effort: s.effort, lastPrompt: s.lastPrompt, lastMessage: s.lastMessage,
      permissionMode: s.permissionMode, permissionModes: modesOf(s), transcriptPath: s.transcriptPath, backgroundTasks: s.backgroundTasks,
      tasks: [...s.tasks.values()].map(taskView),
      startedAt: s.startedAt, lastEventAt: s.lastEventAt, requests: this.pendingFor(s).map(r => r.id),
      // Always there, so that a client that joins again takes away what it showed before.
      changes: s.changes ?? null,
      ...(s.agent && { agent: s.agent }),
      ...(s.isAtRest && { working: false }),
    };
  }

  #requestView({ finish, choosing, decide, ...request }) {
    return request;
  }
}
