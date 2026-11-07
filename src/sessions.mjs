// The state core: turns raw hook events and transcript records into one ordered
// stream of client events. It does no I/O, so it can be tested without Claude.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalized, parseTaskNotification, signalsFrom, unwrapPasted } from './transcript.mjs';
import { HelperError } from './errors.mjs';
import { splitAttachments, uploadsRoot } from './uploads.mjs';

export { HelperError };

const EVENT_LOG_SIZE = 5000;
const REQUEST_KIND = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
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
// Stop can fire before the turn's last words reach the transcript.
const TRANSCRIPT_SETTLE_MS = 2000;
const ENDS_TURN = new Set(['turn.end', 'turn.interrupted', 'turn.error', 'session.ended']);


// Only Rex and tmux can be typed into, and a session started before the plugin was installed sends
// no hooks to say where it is, so a restart is the way out of both.
export const notTypable = () => new HelperError('no_pane', 'This session can\'t be typed into from here. Restart it in Rex or tmux.');

function permissionDecision(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function buildDecision(request, { decision, message, answers, always }) {
  if (decision === 'deny') {
    return permissionDecision({ behavior: 'deny', message: message || 'Denied from Venes.' });
  }
  if (decision !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${decision}`);
  // Questions and plans ignore a bare allow, so the input has to come back too.
  if (request.kind === 'plan') return permissionDecision({ behavior: 'allow', updatedInput: request.input });
  if (request.kind === 'question') {
    const missing = (request.input.questions ?? []).filter(q => !answers?.[q.question]).map(q => q.question);
    if (missing.length) throw new HelperError('missing_answers', 'Every question needs an answer.', { missing });
    return permissionDecision({ behavior: 'allow', updatedInput: { ...request.input, answers } });
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

// A tool that shows Claude an image hands it over whole. It stays out of events, which go to everyone
// and sit in the log, and a client fetches it from the transcript if someone looks.
function withoutImageData(response) {
  if (Array.isArray(response)) {
    return response.map(part => (part?.type === 'image' && part.source?.data ? { ...part, source: { ...part.source, data: undefined } } : part));
  }
  return response?.type === 'image' && response.file?.base64 ? { ...response, file: { ...response.file, base64: undefined } } : response;
}

function blankSession(id) {
  return {
    id, status: 'idle', tools: new Map(), tasks: new Map(), agentParents: new Map(), echoes: [], held: [], queued: [], backgroundTasks: 0,
  };
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
  #agentParent;
  #compactWaitMs;
  #compactLimitMs;
  #splitAttachments;

  // agentParent reads which tool call started a subagent, which needs the file system.
  // `splitAttachments` reads what's kept of the files a message names, which is I/O, so it's passed in.
  constructor({
    agentParent = () => undefined, compactWaitMs = COMPACT_STATS_WAIT_MS, compactLimitMs = COMPACT_LIMIT_MS,
    splitAttachments: split = text => splitAttachments(text, uploadsRoot()),
  } = {}) {
    super();
    this.#agentParent = agentParent;
    this.#splitAttachments = split;
    this.#compactWaitMs = compactWaitMs;
    this.#compactLimitMs = compactLimitMs;
  }

  get seq() { return this.#seq; }

  sessions() { return [...this.#sessions.values()].map(s => this.#sessionView(s)); }

  requests() { return [...this.#requests.values()].map(r => this.#requestView(r)); }

  liveSessions() { return [...this.#sessions.values()].filter(s => s.status !== 'ended'); }

  // Sessions a restart would lose. One outside tmux can't be found again or typed into, so it
  // comes back with its next hook, as it always did.
  registry() { return this.liveSessions().filter(s => s.pane); }

  // Sessions from before a restart. Hooks only tell the helper about a session when it does
  // something, so an idle one would otherwise stay gone.
  restore(records) {
    for (const record of records) {
      if (!this.#sessions.has(record.id)) this.#sessions.set(record.id, { ...blankSession(record.id), ...record });
    }
  }

  isBusy(s) {
    return isAtWork(s.status) || s.held.length > 0 || isCompacting(s);
  }

  // Whether the helper could restart now without losing anything in progress. Restarting
  // forgets held messages, and turns an open request back into a terminal-only prompt.
  isQuiet(now = Date.now()) {
    return this.liveSessions().every(s => now - s.lastEventAt > STALE_SESSION_MS || (!this.isBusy(s) && !this.pendingFor(s).length));
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
    const position = s.held.findIndex(message => message.clientId === clientId);
    if (position < 0) return false;
    s.held.splice(position, 1);
    return true;
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

  // This session's events that the transcript can't be relied on for yet: the turn going on
  // now, and any that ended so recently its last words may not have reached the file.
  openTurn(s, now = Date.now()) {
    const events = this.#log.filter(e => e.sessionId === s.id);
    const settled = events.findLastIndex(e => ENDS_TURN.has(e.kind) && now - e.at > TRANSCRIPT_SETTLE_MS);
    const start = events.findIndex((e, index) => index > settled && startsTurn(e));
    return start < 0 ? [] : events.slice(start);
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
        // A finished background task re-enters as a synthetic prompt; it isn't the user talking.
        if (ev.prompt?.startsWith('<task-notification>')) this.#onTaskNotification(s, ev.prompt);
        // This runs as a message is typed. During a turn, Claude only reads it later.
        else if (isAtWork(s.status)) s.queued.push(unwrapPasted(ev.prompt ?? ''));
        else this.#onUserMessage(s, unwrapPasted(ev.prompt ?? ''));
        this.#setStatus(s, 'running');
        break;
      case 'MessageDisplay':
        // Hooks run as separate processes, so the final delta can land after Stop.
        // It must not change the status, or a finished turn would look like it's running.
        this.#emit(s, 'message.assistant.delta', {
          messageId: ev.message_id, turnId: ev.turn_id, index: ev.index, text: ev.delta, final: ev.final, agentId,
        });
        break;
      case 'PreToolUse':
        this.#markRunning(s, agentId);
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
    for (const { type, ...signal } of signalsFrom(record)) {
      if (type === 'interrupted') this.#onInterrupted(s);
      else if (type === 'toolResult') this.#onToolResult(s, signal);
      else if (type === 'thinking') this.#emit(s, 'message.thinking', signal);
      else if (type === 'compacted') this.#onCompactStats(s, signal);
      else if (type === 'localOutput') this.#onLocalOutput(s, signal);
      else if (type === 'model') this.#onModelReplied(s, signal);
      else if (type === 'refusal') this.#emit(s, 'model.refusal', { ...signal, prompt: s.lastPrompt });
      else if (type === 'toolImages') this.#emit(s, 'tool.images', signal);
      else if (type === 'userImages') this.#emit(s, 'message.images', signal);
      else if (type === 'queueRead') this.#onQueueRead(s, signal.text);
      else if (type === 'queueTakenBack') this.#dropQueued(s, { code: 'taken_back', message: 'Taken back in the terminal.' });
    }
  }

  respond(requestId, answer) {
    const request = this.#requests.get(requestId);
    if (!request) throw new HelperError('request_closed', 'This request has already been answered or closed.');
    const output = buildDecision(request, answer);
    this.#closeRequest(request, { decision: answer.decision, by: 'client', output });
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
    s.transcriptPath = ev.transcript_path ?? s.transcriptPath;
    if (ev.permission_mode && ev.permission_mode !== s.permissionMode) {
      s.permissionMode = ev.permission_mode;
      this.#emit(s, 'session.mode', { permissionMode: s.permissionMode });
    }
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
    const position = s.echoes.findIndex(echo => echo.text === normalized(text));
    return position < 0 ? undefined : s.echoes.splice(position, 1)[0].clientId;
  }

  // What Venes typed ahead of the text for attachments isn't part of it: pictures come as images, and
  // files as `attachments`.
  #onUserMessage(s, typed) {
    const { text, files } = this.#splitAttachments(typed);
    s.lastPrompt = text;
    this.#emit(s, 'message.user', { text, clientId: this.#takeEcho(s, text), ...(files.length ? { attachments: files } : {}) });
  }

  // Claude has a queued message, which `text` may not name. It joins the conversation here, where
  // the transcript will have it too.
  #onQueueRead(s, text = '') {
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

  #dropQueued(s, error) {
    for (const typed of s.queued.splice(0)) {
      const clientId = this.#takeEcho(s, this.#splitAttachments(typed).text);
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
      toolUseId, name: tool.name, parentToolUseId: this.#parentOf(s, data.agentId), ...rest, ...(response !== undefined && { response: withoutImageData(response) }),
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
    if (s.status !== 'running' && s.status !== 'waiting') return;
    this.#closeRequests(s, { decision: 'deny', by: 'terminal' }, r => !r.agentId);
    for (const id of [...s.tools.keys()]) this.#endTool(s, id, { isError: true, interrupted: true });
    this.#setStatus(s, 'idle');
    this.#emit(s, 'turn.interrupted', {});
    this.#startQueued(s);
  }

  #closeRequests(s, result, filter = () => true) {
    for (const r of this.pendingFor(s).filter(filter)) this.#closeRequest(r, result);
  }

  #closeRequest(request, { decision, by, output }) {
    this.#requests.delete(request.id);
    const s = this.#sessions.get(request.sessionId);
    this.#emit(s, 'request.closed', { requestId: request.id, decision, by });
    if (s.status === 'waiting' && this.pendingFor(s).length === 0) this.#setStatus(s, 'running');
    request.finish(output);
  }

  #setStatus(s, status) {
    if (status === 'idle' || status === 'ended') this.#stopCompacting(s); // whatever became of it, the turn is over
    if (s.status === status) return;
    s.status = status;
    this.#emit(s, 'session.status', { status });
  }

  #emit(s, kind, data) {
    const event = { seq: ++this.#seq, at: Date.now(), sessionId: s.id, kind, ...data };
    this.#log.push(event);
    if (this.#log.length > EVENT_LOG_SIZE) this.#log.shift();
    this.emit('event', event);
  }

  #sessionView(s) {
    return {
      id: s.id, status: s.status, cwd: s.cwd, pane: s.pane ?? null, tmuxSocket: s.tmuxSocket ?? null,
      model: s.model, effort: s.effort, lastPrompt: s.lastPrompt, lastMessage: s.lastMessage,
      permissionMode: s.permissionMode, transcriptPath: s.transcriptPath, backgroundTasks: s.backgroundTasks,
      tasks: [...s.tasks.values()].map(taskView),
      startedAt: s.startedAt, lastEventAt: s.lastEventAt, requests: this.pendingFor(s).map(r => r.id),
    };
  }

  #requestView({ finish, ...request }) {
    return request;
  }
}
