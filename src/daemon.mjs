// Two local Unix sockets and no TCP ports: hook.sock receives Claude Code hook
// events, client.sock speaks newline-delimited JSON to clients. The app reaches
// client.sock through `venes attach` over SSH, so SSH handles authentication.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';
import { configureSession, oneAtATime, readSwitch } from './configure.mjs';
import { Library, joinedStatus } from './library.mjs';
import { switchInPicker } from './picker.mjs';
import { removeSession } from './remove.mjs';
import { resumeSession } from './resume.mjs';
import { SessionStore, HelperError } from './sessions.mjs';
import { readRegistry, writeRegistry } from './registry.mjs';
import { TranscriptTail, readAgentParent, readHistory, readTail } from './transcript.mjs';
import { resumeTerminal, sendEscape, sendText, settleCommand, terminalFrom } from './terminal.mjs';
import { INSTALL_FOLDER as REX_FOLDER, runsClaude as rexRunsClaude } from './rex.mjs';
import { findClaudePanes } from './tmux.mjs';
import { startAutoUpdate } from './update.mjs';
import { VERSION } from './version.mjs';

export const PROTOCOL_VERSION = 1;
// What Claude Code sets for its own child processes, and the session that happened to start the
// helper left behind. They'd say the wrong thing to any Claude the helper starts.
const PARENT_SESSION_ENV = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_ENV_FILE',
  'CLAUDE_PID', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PROJECT_DIR',
];
const TRANSCRIPT_POLL_MS = 300;
const TASK_OUTPUT_BYTES = 256 * 1024;
const HELD_CHECK_MS = 300;
const REGISTRY_SAVE_MS = 2000;
// Enough of the end of a transcript to find what was last said.
const LAST_WORDS_ITEMS = 40;
// Started over SSH, the helper inherits a minimal PATH that misses Homebrew's tmux, Rex's
// command and the native installer's claude.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local/bin'), path.dirname(process.execPath), REX_FOLDER];

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
}

function socketIsLive(socketPath) {
  return new Promise(resolve => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function createHookServer(store) {
  return http.createServer(async (req, res) => {
    let event;
    try {
      event = JSON.parse(await readBody(req));
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    try {
      const held = store.handleHook(event, terminalFrom(req.headers));
      const output = held ? await held.decision : undefined;
      res.end(output ? JSON.stringify(output) : '');
    } catch (error) {
      // One malformed event must not take the helper down with it.
      console.error(`hook ${event?.hook_event_name}: ${error.stack}`);
      res.end();
    }
  });
}

function createClientServer(store, checkForUpdate, library) {
  // Event numbering restarts with the helper, so a client's `since` only means
  // something within the same boot.
  const bootId = randomUUID();
  const subscribers = new Set();
  const write = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

  const typing = oneAtATime();

  const deliver = (session, { clientId, text }) => typing(session.id, async () => {
    if (clientId) store.expectEcho(session, clientId, text);
    const isBlocked = () => store.pendingFor(session)[0];
    try {
      await sendText(session, text, isBlocked);
      if (text.trimStart().startsWith('/')) await settleCommand(session, isBlocked);
    } catch (error) {
      if (clientId) store.forgetEcho(session, clientId);
      throw error;
    }
  });

  // Checked on a timer, not when a turn ends: a local command or a failed delivery leaves
  // the status where it was, so the messages behind it would have nothing to wake them.
  const deliverHeld = async session => {
    const message = store.nextHeld(session);
    if (!message) return;
    try {
      await deliver(session, message);
    } catch (error) {
      store.failSend(session, message, error);
    }
  };

  const heldTimer = setInterval(() => { for (const session of store.liveSessions()) deliverHeld(session); }, HELD_CHECK_MS);
  heldTimer.unref();

  store.on('event', event => {
    for (const socket of subscribers) write(socket, { type: 'event', event });
  });

  const sessionWithPane = sessionId => {
    const session = store.get(sessionId);
    if (!session.pane) throw new HelperError('no_pane', 'This session is not running in tmux or Rex.');
    if (session.status === 'ended') throw new HelperError('session_ended', 'This session has ended.');
    return session;
  };

  // A message for a session that's resuming waits for it, and then goes the usual way.
  const resuming = new Map();
  // What a reader chose for a session that isn't running, for when it next is.
  const chosenForResume = new Map();
  const resume = msg => {
    const started = resumeSession({ store, library, terminal: resumeTerminal() }, msg.sessionId, msg, chosenForResume.get(msg.sessionId))
      .then(reply => { chosenForResume.delete(msg.sessionId); return reply; })
      .finally(() => resuming.delete(msg.sessionId));
    resuming.set(msg.sessionId, started);
    return started;
  };

  // A change waits for a resume on its way, or it would find a session with no pane yet.
  const configure = async msg => {
    await resuming.get(msg.sessionId)?.catch(() => {});
    const switchTo = (session, change) => typing(session.id, () => switchInPicker(session, change, () => store.pendingFor(session)[0]));
    return configureSession({ store, library, sessionWithPane, switchTo, chosenForResume }, msg);
  };

  const joinStored = async ({ sessionId, limit }) => {
    const seq = store.seq;
    const [{ model, ...page }, info, running] = await Promise.all([
      library.history(sessionId, { limit }),
      library.info(sessionId).catch(() => undefined),
      library.running().catch(() => []),
    ]);
    const status = joinedStatus(running.find(session => session.id === sessionId), page.items);
    return { ...page, turn: [], seq, requests: [], sessions: [{ id: sessionId, status, cwd: info?.cwd, model, tasks: [], backgroundTasks: 0 }] };
  };

  const listSessions = async () => {
    const sessions = store.sessions();
    const sockets = new Set([undefined, ...sessions.map(s => s.tmuxSocket ?? undefined)]);
    const known = new Set(sessions.map(s => `${s.tmuxSocket}|${s.pane}`));
    const unattached = (await findClaudePanes(sockets)).filter(p => !known.has(`${p.tmuxSocket}|${p.pane}`));
    return { sessions, unattached };
  };

  const commands = {
    ping: () => ({ protocol: PROTOCOL_VERSION, version: VERSION, quiet: store.isQuiet() }),
    update: async () => ({ version: VERSION, available: (await checkForUpdate()) ?? null }),
    sessions: listSessions,
    subscribe: async (msg, socket) => {
      const { unattached } = await listSessions();
      // Nothing below awaits, so no event can slip between the snapshot and the subscription.
      const sameBoot = !msg.bootId || msg.bootId === bootId;
      const { events, gap } = store.eventsSince(sameBoot ? msg.since ?? store.seq : 0);
      write(socket, {
        type: 'snapshot', bootId, seq: store.seq, sessions: store.sessions(), unattached, requests: store.requests(),
      });
      for (const event of events) write(socket, { type: 'event', event });
      subscribers.add(socket);
      return { gap: gap || !sameBoot };
    },
    library: msg => library.page({ limit: msg.limit, offset: msg.offset }),
    capabilities: async msg => {
      const cwd = store.find(msg.sessionId)?.cwd ?? (await library.info(msg.sessionId))?.cwd;
      return library.capabilities(cwd);
    },
    configure,
    delete: async ({ sessionId }) => {
      await resuming.get(sessionId)?.catch(() => {});
      await typing(sessionId, () => removeSession({ store, library }, sessionId));
      chosenForResume.delete(sessionId);
      return {};
    },
    history: msg => {
      const file = store.find(msg.sessionId)?.transcriptPath;
      return file ? readHistory(file, msg) : library.history(msg.sessionId, msg);
    },
    // Nothing here awaits for a session the helper knows, so every event is either in this
    // reply or follows it on the wire.
    join: msg => {
      const session = store.find(msg.sessionId);
      if (!session?.transcriptPath) return joinStored(msg);
      const turn = store.openTurn(session);
      const [first] = turn;
      const start = first && { at: first.at, prompt: first.kind === 'message.user' ? first.text : undefined };
      return {
        ...readHistory(session.transcriptPath, { limit: msg.limit, turn: start }),
        turn, seq: store.seq,
        sessions: store.sessions().filter(s => s.id === session.id),
        requests: store.requests().filter(r => r.sessionId === session.id),
      };
    },
    respond: msg => { store.respond(msg.requestId, msg); return {}; },
    send: async msg => {
      if (typeof msg.text !== 'string' || !msg.text.trim()) throw new HelperError('bad_text', 'Nothing to send.');
      if (msg.lane !== undefined && msg.lane !== 'next' && msg.lane !== 'later') throw new HelperError('bad_lane', `Unknown lane: ${msg.lane}`);
      const change = readSwitch(msg.text);
      if (change) {
        await configure({ sessionId: msg.sessionId, ...change });
        return { queued: false };
      }
      await resuming.get(msg.sessionId)?.catch(() => {});
      const known = store.find(msg.sessionId);
      if (!known || known.status === 'ended') return resume(msg);
      const session = sessionWithPane(msg.sessionId);
      const message = { clientId: msg.clientId, text: msg.text };
      if (msg.lane === 'later' && store.isBusy(session)) {
        store.hold(session, message);
        return { queued: true };
      }
      await deliver(session, message);
      return { queued: false };
    },
    cancel: msg => ({ cancelled: store.cancelHeld(store.get(msg.sessionId), msg.clientId) }),
    taskOutput: msg => {
      const task = store.task(msg.sessionId, msg.taskId);
      if (task.result !== undefined) return { output: task.result, truncated: false };
      if (!task.outputFile || task.type === 'subagent') return { output: null, truncated: false };
      return readTail(task.outputFile, TASK_OUTPUT_BYTES);
    },
    interrupt: async msg => {
      const session = sessionWithPane(msg.sessionId);
      if (session.status !== 'running' && session.status !== 'waiting') throw new HelperError('not_running', 'Nothing to interrupt.');
      await sendEscape(session);
      return {};
    },
  };

  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.on('close', () => subscribers.delete(socket));
    write(socket, { type: 'hello', protocol: PROTOCOL_VERSION, version: VERSION });
    const lines = readline.createInterface({ input: socket });
    lines.on('error', () => {}); // readline re-emits socket errors; a dropped client must not crash the helper
    lines.on('line', async line => {
      let msg;
      try {
        msg = JSON.parse(line);
        const command = commands[msg.cmd];
        if (!command) throw new HelperError('unknown_command', `Unknown command: ${msg.cmd}`);
        write(socket, { type: 'result', id: msg.id, ok: true, ...(await command(msg, socket)) });
      } catch (error) {
        write(socket, {
          type: 'result', id: msg?.id, ok: false,
          error: { code: error.code ?? 'internal', message: error.message, details: error.details },
        });
      }
    });
  });
  return { server, subscribers, heldTimer };
}

function startTranscriptPolling(store) {
  const tails = new Map();
  const timer = setInterval(() => {
    // Idle sessions too: compaction and background tasks don't need a running turn.
    for (const session of store.liveSessions()) {
      if (!session.transcriptPath) continue;
      if (!tails.has(session.id)) tails.set(session.id, new TranscriptTail(session.transcriptPath));
      for (const record of tails.get(session.id).poll()) store.handleTranscriptRecord(session.id, record);
    }
  }, TRANSCRIPT_POLL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

function lastWords(file) {
  try {
    const { items } = readHistory(file, { limit: LAST_WORDS_ITEMS });
    return {
      lastPrompt: items.findLast(item => item.role === 'user')?.text,
      lastMessage: items.findLast(item => item.role === 'assistant')?.text,
    };
  } catch {
    return {};
  }
}

// A pane that has gone, or no longer runs Claude, has nothing to come back to.
async function restoreSessions(store, paths) {
  const records = readRegistry(paths.sessionsFile);
  const panes = await findClaudePanes(new Set(records.map(record => record.tmuxSocket ?? undefined)));
  const running = new Set(panes.map(pane => `${pane.tmuxSocket}|${pane.pane}`));
  const isAlive = record => (record.rexSession ? rexRunsClaude(record) : running.has(`${record.tmuxSocket ?? null}|${record.pane}`));
  const alive = await Promise.all(records.map(isAlive));
  store.restore(records.filter((_, index) => alive[index]).map(record => ({ ...record, ...lastWords(record.transcriptPath) })));
}

function startRegistrySaving(store, paths) {
  let isDirty = false;
  const save = () => {
    if (isDirty) writeRegistry(paths.sessionsFile, store.registry());
    isDirty = false;
  };
  store.on('event', () => { isDirty = true; });
  const timer = setInterval(save, REGISTRY_SAVE_MS);
  timer.unref();
  return () => { clearInterval(timer); save(); };
}

export function dropParentSession(env) {
  for (const name of PARENT_SESSION_ENV) delete env[name];
}

export async function startDaemon(paths) {
  process.env.PATH = [...EXTRA_PATH, process.env.PATH].join(':');
  dropParentSession(process.env);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (await socketIsLive(paths.clientSocket)) throw new HelperError('already_running', 'The helper is already running.');
  for (const file of [paths.hookSocket, paths.clientSocket]) fs.rmSync(file, { force: true });

  const store = new SessionStore({ agentParent: readAgentParent });
  // A session missed here comes back with its next hook, but sessions.json outlives this
  // start, so a failure that stopped the helper would stop it every time.
  await restoreSessions(store, paths).catch(error => console.error(`restore: ${error.stack}`));
  const stopSaving = startRegistrySaving(store, paths);
  const hookServer = createHookServer(store);
  const updater = startAutoUpdate(store, paths);
  const library = new Library(paths);
  fs.mkdirSync(paths.sdkDir, { recursive: true, mode: 0o700 });
  // Ready before the first time it's asked for. If this fails, the next request tries again.
  library.prepare().catch(error => console.error(`library: ${error.message}`));
  const { server: clientServer, subscribers, heldTimer } = createClientServer(store, updater.check, library);
  const stopPolling = startTranscriptPolling(store);
  await listen(hookServer, paths.hookSocket);
  await listen(clientServer, paths.clientSocket);
  fs.writeFileSync(paths.pidFile, String(process.pid));

  return {
    store,
    stop() {
      stopSaving();
      stopPolling();
      updater.stop();
      clearInterval(heldTimer);
      for (const socket of subscribers) socket.destroy();
      hookServer.closeAllConnections();
      hookServer.close();
      clientServer.close();
      fs.rmSync(paths.pidFile, { force: true });
    },
  };
}
