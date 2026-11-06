// The state core: turns raw hook events and transcript records into one ordered
// stream of client events. It does no I/O, so it can be tested without Claude.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseTaskNotification, signalsFrom, unwrapPasted } from './transcript.mjs';

const EVENT_LOG_SIZE = 5000;
const REQUEST_KIND = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };
const MAX_FINISHED_TASKS = 100;
// Slash commands that Claude Code runs itself never echo, so old entries have to fall off.
const MAX_ECHOES = 32;
// PostCompact fires just before the transcript gets the sizes it can't report itself.
const COMPACT_STATS_WAIT_MS = 2000;
// A session this silent has probably crashed, and must not hold up an update for ever.
const STALE_SESSION_MS = 60 * 60_000;

export class HelperError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

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

const normalized = text => text.trim().split(/\s+/).join(' ');

function taskView({ result, outputFile, ...task }) {
  // A subagent's output file is its raw transcript, so only its result counts.
  return { ...task, hasOutput: result !== undefined || (!!outputFile && task.type !== 'subagent') };
}

export class SessionStore extends EventEmitter {
  #sessions = new Map();
  #requests = new Map();
  #log = [];
  #seq = 0;
  #agentParent;
  #compactWaitMs;

  // agentParent reads which tool call started a subagent, which needs the file system.
  constructor({ agentParent = () => undefined, compactWaitMs = COMPACT_STATS_WAIT_MS } = {}) {
    super();
    this.#agentParent = agentParent;
    this.#compactWaitMs = compactWaitMs;
  }

  get seq() { return this.#seq; }

  sessions() { return [...this.#sessions.values()].map(s => this.#sessionView(s)); }

  requests() { return [...this.#requests.values()].map(r => this.#requestView(r)); }

  liveSessions() { return [...this.#sessions.values()].filter(s => s.status !== 'ended'); }

  isBusy(s) { return s.status === 'running' || s.status === 'waiting' || s.held.length > 0; }

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

  nextHeld(s) { return s.held.shift(); }

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

  // Returns undefined, or { request, decision } when the hook must wait for an answer.
  handleHook(ev, tmux = {}) {
    if (!ev.session_id) return undefined;
    const s = this.#touch(ev, tmux);
    const agentId = ev.agent_id;
    switch (ev.hook_event_name) {
      case 'SessionStart':
        this.#emit(s, 'session.started', { source: ev.source, model: ev.model, cwd: s.cwd });
        break;
      case 'SessionEnd':
        this.#endSession(s, ev.reason);
        break;
      case 'UserPromptSubmit':
        // A finished background task re-enters as a synthetic prompt; it isn't the user talking.
        if (ev.prompt?.startsWith('<task-notification>')) this.#onTaskNotification(s, ev.prompt);
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
        this.#setStatus(s, 'idle');
        this.#emit(s, 'turn.end', {
          lastMessage: ev.last_assistant_message, backgroundTasks: s.backgroundTasks,
          tasks: [...s.tasks.values()].filter(task => task.status === 'running').map(taskView),
        });
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
        this.#emit(s, 'compact.start', { trigger: ev.trigger });
        break;
      case 'PostCompact':
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
      else if (type === 'refusal') this.#emit(s, 'model.refusal', { ...signal, prompt: s.lastPrompt });
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
        id: ev.session_id, status: 'idle', tools: new Map(), tasks: new Map(), agentParents: new Map(), echoes: [], held: [],
        backgroundTasks: 0, startedAt: Date.now(), cwd: ev.cwd, permissionMode: ev.permission_mode, transcriptPath: ev.transcript_path,
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
    if (tmux.pane) this.#claimPane(s, tmux);
    return s;
  }

  // /clear and /resume start a new session id in the same pane, which retires the old one.
  #claimPane(s, { pane, socket }) {
    if (s.pane === pane && s.tmuxSocket === socket) return;
    s.pane = pane;
    s.tmuxSocket = socket;
    for (const other of this.#sessions.values()) {
      if (other !== s && other.pane === pane && other.tmuxSocket === socket && other.status !== 'ended') {
        this.#endSession(other, 'replaced');
      }
    }
    this.#emit(s, 'session.attached', { pane });
  }

  #endSession(s, reason) {
    this.#closeRequests(s, { decision: 'unknown', by: 'session_end' });
    for (const message of s.held.splice(0)) {
      this.failSend(s, message, { code: 'session_ended', message: 'This session has ended.' });
    }
    this.#setStatus(s, 'ended');
    this.#emit(s, 'session.ended', { reason });
  }

  #onUserMessage(s, text) {
    s.lastPrompt = text;
    const position = s.echoes.findIndex(echo => echo.text === normalized(text));
    const clientId = position < 0 ? undefined : s.echoes.splice(position, 1)[0].clientId;
    this.#emit(s, 'message.user', { text, clientId });
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
    if (s.compactWait) this.#finishCompact(s, stats);
    else s.compactStats = stats;
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
    this.#emit(s, 'tool.end', { toolUseId, name: tool.name, parentToolUseId: this.#parentOf(s, data.agentId), ...data });
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
      permissionMode: s.permissionMode, transcriptPath: s.transcriptPath, backgroundTasks: s.backgroundTasks,
      tasks: [...s.tasks.values()].map(taskView),
      startedAt: s.startedAt, lastEventAt: s.lastEventAt, requests: this.pendingFor(s).map(r => r.id),
    };
  }

  #requestView({ finish, ...request }) {
    return request;
  }
}
