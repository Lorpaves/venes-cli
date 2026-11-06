// Two local Unix sockets and no TCP ports: hook.sock receives Claude Code hook
// events, client.sock speaks newline-delimited JSON to clients. The app reaches
// client.sock through `venes attach` over SSH, so SSH handles authentication.

import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import readline from 'node:readline';
import { SessionStore, HelperError } from './sessions.mjs';
import { TranscriptTail, readAgentParent, readHistory, readTail } from './transcript.mjs';
import { findClaudePanes, parseTmuxEnv, sendEscape, sendText } from './tmux.mjs';

export const PROTOCOL_VERSION = 1;
const TRANSCRIPT_POLL_MS = 300;
const TASK_OUTPUT_BYTES = 256 * 1024;
// Started over SSH, the helper inherits a minimal PATH that misses Homebrew's tmux.
const EXTRA_PATH = ['/opt/homebrew/bin', '/usr/local/bin'];

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
    const tmux = { pane: req.headers['x-venes-pane'] || undefined, socket: parseTmuxEnv(req.headers['x-venes-tmux']) };
    try {
      const held = store.handleHook(event, tmux);
      const output = held ? await held.decision : undefined;
      res.end(output ? JSON.stringify(output) : '');
    } catch (error) {
      // One malformed event must not take the helper down with it.
      console.error(`hook ${event?.hook_event_name}: ${error.stack}`);
      res.end();
    }
  });
}

function createClientServer(store) {
  // Event numbering restarts with the helper, so a client's `since` only means
  // something within the same boot.
  const bootId = randomUUID();
  const subscribers = new Set();
  const write = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

  const deliver = async (session, { clientId, text }) => {
    if (clientId) store.expectEcho(session, clientId, text);
    try {
      await sendText({ pane: session.pane, tmuxSocket: session.tmuxSocket }, text, () => store.pendingFor(session)[0]);
    } catch (error) {
      if (clientId) store.forgetEcho(session, clientId);
      throw error;
    }
  };

  // Held messages go out one at a time, each when the turn before it has ended.
  const deliverHeld = async sessionId => {
    const session = store.get(sessionId);
    const message = store.nextHeld(session);
    if (!message) return;
    try {
      await deliver(session, message);
    } catch (error) {
      store.failSend(session, message, error);
    }
  };

  store.on('event', event => {
    for (const socket of subscribers) write(socket, { type: 'event', event });
    if (event.kind === 'session.status' && event.status === 'idle') deliverHeld(event.sessionId);
  });

  const sessionWithPane = sessionId => {
    const session = store.get(sessionId);
    if (!session.pane) throw new HelperError('no_pane', 'This session is not running in tmux.');
    if (session.status === 'ended') throw new HelperError('session_ended', 'This session has ended.');
    return session;
  };

  const listSessions = async () => {
    const sessions = store.sessions();
    const sockets = new Set([undefined, ...sessions.map(s => s.tmuxSocket ?? undefined)]);
    const known = new Set(sessions.map(s => `${s.tmuxSocket}|${s.pane}`));
    const unattached = (await findClaudePanes(sockets)).filter(p => !known.has(`${p.tmuxSocket}|${p.pane}`));
    return { sessions, unattached };
  };

  const commands = {
    ping: () => ({ protocol: PROTOCOL_VERSION }),
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
    history: msg => readHistory(store.get(msg.sessionId).transcriptPath, msg),
    respond: msg => { store.respond(msg.requestId, msg); return {}; },
    send: async msg => {
      if (typeof msg.text !== 'string' || !msg.text.trim()) throw new HelperError('bad_text', 'Nothing to send.');
      if (msg.lane !== undefined && msg.lane !== 'next' && msg.lane !== 'later') throw new HelperError('bad_lane', `Unknown lane: ${msg.lane}`);
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
      await sendEscape({ pane: session.pane, tmuxSocket: session.tmuxSocket });
      return {};
    },
  };

  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.on('close', () => subscribers.delete(socket));
    write(socket, { type: 'hello', protocol: PROTOCOL_VERSION });
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
  return { server, subscribers };
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

export async function startDaemon(paths) {
  process.env.PATH = [...EXTRA_PATH, process.env.PATH].join(':');
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (await socketIsLive(paths.clientSocket)) throw new HelperError('already_running', 'The helper is already running.');
  for (const file of [paths.hookSocket, paths.clientSocket]) fs.rmSync(file, { force: true });

  const store = new SessionStore({ agentParent: readAgentParent });
  const hookServer = createHookServer(store);
  const { server: clientServer, subscribers } = createClientServer(store);
  const stopPolling = startTranscriptPolling(store);
  await listen(hookServer, paths.hookSocket);
  await listen(clientServer, paths.clientSocket);
  fs.writeFileSync(paths.pidFile, String(process.pid));

  return {
    store,
    stop() {
      stopPolling();
      for (const socket of subscribers) socket.destroy();
      hookServer.closeAllConnections();
      hookServer.close();
      clientServer.close();
      fs.rmSync(paths.pidFile, { force: true });
    },
  };
}
