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
import { AGENT as CODEX, Codex } from './codex.mjs';
import { configureSession, oneAtATime, readSwitch } from './configure.mjs';
import { Library, joinedStatus } from './library.mjs';
import { switchInPicker } from './picker.mjs';
import { removeSession } from './remove.mjs';
import { resumeSession } from './resume.mjs';
import { startNewSession } from './start.mjs';
import { PushDevices, notify, titleFor } from './push.mjs';
import { RECENT_SESSIONS, checkedFolder, homeFolder, recentFolders, runningIn, subfolders } from './folders.mjs';
import { isTrusted, readClaudeConfig } from './trust.mjs';
import { SessionStore, HelperError, notTypable } from './sessions.mjs';
import { readRegistry, writeRegistry } from './registry.mjs';
import { followTranscripts, readAgentParent, readHistory, readImage, readTail } from './transcript.mjs';
import { avatarSource } from './avatar.mjs';
import {
  closePage, pause, pressPageKey, readPage, readScreen, resumeTerminal, sendEscape, sendMessage, settleCommand, terminalFrom, typeOnPage,
} from './terminal.mjs';
import { choicesOf, chooseRow, isAbout, knownTexts, readPrompt } from './prompt.mjs';
import {
  MAX_ATTACHMENTS, answersWithAttachments, discardUpload, findUpload, markSent, pruneUploads, removeUploads, saveUpload,
} from './uploads.mjs';
import { INSTALL_FOLDER as REX_FOLDER, cachedAccount, runsClaude as rexRunsClaude } from './rex.mjs';
import { screenAccess, sshAccess } from './ssh.mjs';
import { pruneStatus, readStatus } from './status.mjs';
import { MENTION_LIMIT, mentionFinder } from './mentions.mjs';
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
// Claude Code draws a permission prompt as it asks the hook, so the screen is read for a moment.
const PROMPT_READ_LIMIT_MS = 2000;
const PROMPT_READ_CHECK_MS = 100;
// It can change a row after, as when it settles what not to ask about again, so it's watched a while.
const PROMPT_WATCH_MS = 15000;
const PROMPT_WATCH_CHECK_MS = 500;
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

// The rows a permission prompt shows in its terminal past Yes and before No, for a client to offer.
// Only a request on its own can be told apart on the screen, and a prompt is taken once it reads
// the same twice, so that one still being drawn, or the last one going, isn't. A row that changes
// after is offered again.
async function offerPromptRows(store, request) {
  const session = store.find(request.sessionId);
  if (!session?.pane) return;
  const known = knownTexts(request.input);
  const isAlone = () => store.requestOf(request.id) && store.pendingFor(session).length === 1;
  const read = async () => readPrompt(await readScreen(session), known);
  const end = Date.now() + PROMPT_READ_LIMIT_MS;
  let last;
  for (;;) {
    if (!isAlone() || Date.now() >= end) return;
    const prompt = await read();
    if (prompt && JSON.stringify(prompt) === JSON.stringify(last)) break;
    last = prompt;
    await pause(PROMPT_READ_CHECK_MS);
  }
  if (!isAbout(last, request.input)) return;
  store.offerRows(request.id, choicesOf(last));
  const watchEnd = Date.now() + PROMPT_WATCH_MS;
  while (Date.now() < watchEnd) {
    await pause(PROMPT_WATCH_CHECK_MS);
    if (!isAlone()) return;
    const prompt = await read();
    // Gone, or another prompt in its place, which is the next request's to read.
    if (!prompt || prompt.question !== last.question || prompt.about !== last.about) return;
    store.offerRows(request.id, choicesOf(prompt));
  }
}

// What the prompt shows now, for a client whose row had changed.
async function reofferPromptRows(store, request) {
  const session = store.find(request.sessionId);
  if (!session?.pane || store.pendingFor(session).length !== 1) return;
  const prompt = readPrompt(await readScreen(session), knownTexts(request.input));
  if (prompt && isAbout(prompt, request.input)) store.offerRows(request.id, choicesOf(prompt));
}

function createClientServer(store, checkForUpdate, library, { uploads, downloads, statusDir, pushFile }, tailscaleAccount = () => undefined, codex = undefined) {
  // Event numbering restarts with the helper, so a client's `since` only means
  // something within the same boot.
  const bootId = randomUUID();
  const subscribers = new Set();
  // Every connection, each with the phone it's from once that phone says, for not notifying a phone
  // that's there to see for itself.
  const clients = new Set();
  const devices = new PushDevices(pushFile);
  const isConnected = deviceId => [...clients].some(socket => socket.pushDevice === deviceId);
  const write = (socket, message) => socket.write(`${JSON.stringify(message)}\n`);

  // A session that isn't Claude Code's, as a Codex one, is only told to a client that says it can show
  // one: with `agents` on any command, which holds for its connection. An app from before them would
  // list such a session and make little of it.
  const agentOf = new Map();
  const shows = (socket, agent) => !agent || socket.agents?.has(agent) === true;
  // Whose a session is outlasts the session, for the word that it's gone.
  const agentFor = sessionId => agentOf.get(sessionId) ?? (typeof sessionId === 'string' ? store.find(sessionId)?.agent : undefined);
  const showsEvent = (socket, event) => shows(socket, agentFor(event.sessionId));
  const noteAgents = (socket, agents) => {
    if (Array.isArray(agents)) socket.agents = new Set(agents.filter(agent => typeof agent === 'string'));
  };

  const typing = oneAtATime();
  const avatar = avatarSource();
  const findMentions = mentionFinder();

  // A client that can show a page, which it says with `pages`, has one a command opens left open
  // for it, and is told. Otherwise it goes, as the next message would act on it.
  const deliver = (session, { clientId, text, attachments = [], pages = false }) => typing(session.id, async () => {
    // A Codex session takes it through Codex's own server, and says nothing of a page.
    if (session.agent === CODEX) {
      await codex.deliver(session, { clientId, text, attachments });
      return false;
    }
    if (clientId) store.expectEcho(session, clientId, text);
    const isBlocked = () => store.pendingFor(session)[0];
    try {
      await sendMessage(session, { text, attachments }, isBlocked);
      if (!attachments.length && text.trimStart().startsWith('/')) return (await settleCommand(session, isBlocked, { keepPage: pages })) === 'page';
      return false;
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
    if (event.kind === 'request.opened' && event.request.kind === 'permission') {
      offerPromptRows(store, event.request).catch(error => console.error(`prompt rows: ${error.message}`));
    }
    if (event.kind === 'session.discovered' && event.agent) agentOf.set(event.sessionId, event.agent);
    for (const socket of subscribers) if (showsEvent(socket, event)) write(socket, { type: 'event', event });
    const title = async () => {
      const info = await library.info(event.sessionId).catch(() => undefined);
      return titleFor({ id: event.sessionId, title: info?.summary, cwd: store.find(event.sessionId)?.cwd ?? info?.cwd });
    };
    notify({ devices, isConnected, event, title, agent: agentFor(event.sessionId) }).catch(error => console.error(`push: ${error.message}`));
  });

  const sessionWithPane = sessionId => {
    const session = store.get(sessionId);
    if (!session.pane) throw notTypable();
    if (session.status === 'ended') throw new HelperError('session_ended', 'This session has ended.');
    return session;
  };

  // The uploads a message names, in its order. Every one has to be there.
  const attachmentsOf = ({ sessionId, attachments }) => {
    if (attachments === undefined) return [];
    if (!Array.isArray(attachments) || attachments.length > MAX_ATTACHMENTS) {
      throw new HelperError('bad_attachment', `A message can have up to ${MAX_ATTACHMENTS} attachments.`);
    }
    const found = attachments.map(uploadId => {
      const upload = findUpload(uploads, sessionId, uploadId);
      if (!upload) throw new HelperError('bad_attachment', 'An attachment is gone. Attach it again.');
      return upload;
    });
    // A message has them now, so they're no longer the composer's to take back.
    for (const upload of found) markSent(uploads, sessionId, upload.uploadId);
    return found;
  };

  // A question's answer can come with files, uploaded to the request's session as a message's are. They
  // follow what was typed, as the references a message gives Claude Code.
  const attachedAnswers = ({ requestId, answers, attachments }) => {
    if (attachments === undefined) return answers;
    const sessionId = store.requests().find(request => request.id === requestId)?.sessionId;
    if (!sessionId) throw new HelperError('request_closed', 'This request has already been answered or closed.');
    return answersWithAttachments(answers, attachments, ids => attachmentsOf({ sessionId, attachments: ids }));
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
    return { ...page, turn: [], queued: [], seq, requests: [], sessions: [{ id: sessionId, status, cwd: info?.cwd, model, tasks: [], backgroundTasks: 0 }] };
  };

  // A Codex session's commands go to Codex's server, and any other's the way they always did.
  const isCodex = async sessionId => (await codex?.owns(sessionId)) === true;
  const forCodex = (name, otherwise) => async (msg, socket) => ((await isCodex(msg.sessionId)) ? codex[name](msg) : otherwise(msg, socket));

  // Codex's stored threads come with the first page, which is where what's running comes too.
  const listLibrary = async ({ limit, offset }, socket) => {
    const [page, threads] = await Promise.all([
      library.page({ limit, offset }),
      offset || !shows(socket, CODEX) ? [] : codex?.library().catch(error => { console.error(`codex library: ${error.message}`); return []; }) ?? [],
    ]);
    return threads.length ? { ...page, items: [...page.items, ...threads] } : page;
  };

  const listSessions = async socket => {
    const sessions = store.sessions().filter(session => shows(socket, session.agent));
    const sockets = new Set([undefined, ...sessions.map(s => s.tmuxSocket ?? undefined)]);
    const known = new Set(sessions.map(s => `${s.tmuxSocket}|${s.pane}`));
    const unattached = (await findClaudePanes(sockets)).filter(p => !known.has(`${p.tmuxSocket}|${p.pane}`));
    return { sessions, unattached };
  };

  const commands = {
    // The Tailscale account Rex is signed in with, which a phone reaches this Mac as through Rex.
    ping: () => {
      const account = tailscaleAccount();
      return { protocol: PROTOCOL_VERSION, version: VERSION, quiet: store.isQuiet(), ...(account && { tailscaleAccount: account }) };
    },
    update: async () => ({ version: VERSION, available: (await checkForUpdate()) ?? null }),
    sessions: (msg, socket) => listSessions(socket),
    subscribe: async (msg, socket) => {
      const { unattached } = await listSessions(socket);
      // Nothing below awaits, so no event can slip between the snapshot and the subscription.
      const sameBoot = !msg.bootId || msg.bootId === bootId;
      const { events, gap } = store.eventsSince(sameBoot ? msg.since ?? store.seq : 0);
      write(socket, {
        type: 'snapshot', bootId, seq: store.seq, unattached,
        sessions: store.sessions().filter(session => shows(socket, session.agent)),
        requests: store.requests().filter(request => shows(socket, request.agent)),
      });
      for (const event of events) if (showsEvent(socket, event)) write(socket, { type: 'event', event });
      subscribers.add(socket);
      return { gap: gap || !sameBoot };
    },
    library: (msg, socket) => listLibrary({ limit: msg.limit, offset: msg.offset }, socket),
    // A phone that wants notifications while it isn't connected, and this connection is that phone's.
    pushRegister: (msg, socket) => {
      devices.register(msg);
      socket.pushDevice = msg.deviceId;
      return {};
    },
    pushUnregister: ({ deviceId }, socket) => {
      if (typeof deviceId !== 'string') throw new HelperError('bad_device', 'That isn\'t a device.');
      devices.unregister(deviceId);
      socket.pushDevice = deviceId;
      return {};
    },
    // Where a new session can start: where sessions ran lately, with how many go on in each, or the
    // folders in one. Each says whether Claude Code trusts it already.
    folders: async ({ path: folder, hidden }) => {
      const config = readClaudeConfig();
      const home = homeFolder();
      const named = where => ({ path: where, name: path.basename(where) || where, trusted: isTrusted(where, { config, home }) });
      if (folder !== undefined && folder !== null) {
        const checked = checkedFolder(folder);
        return { ...named(checked), ...subfolders(checked, undefined, { hidden: hidden === true }) };
      }
      const [stored, running] = await Promise.all([library.recent(RECENT_SESSIONS).catch(() => []), library.running().catch(() => [])]);
      const counts = runningIn(running, store.liveSessions());
      return {
        home, recent: recentFolders(stored).map(where => ({ ...named(where), running: counts.get(where) ?? 0 })),
        // A client offers Codex for a new session only where there is one.
        ...(codex?.isAvailable() && { codex: true }),
      };
    },
    start: msg => {
      if (msg.agent === undefined || msg.agent === 'claude') return startNewSession({ store, terminal: resumeTerminal() }, msg);
      if (msg.agent !== CODEX || !codex) throw new HelperError('bad_agent', `Nothing here starts ${msg.agent}.`);
      return codex.start(msg);
    },
    // What an @ in a message can name, from the session's folder: files, and folders ending in /.
    mentions: async ({ sessionId, query = '', limit = MENTION_LIMIT }) => {
      if (typeof query !== 'string' || query.length > 500) throw new HelperError('bad_query', 'That can\'t be looked for.');
      const cwd = store.find(sessionId)?.cwd
        ?? ((await isCodex(sessionId)) ? await codex.folderOf(sessionId) : (await library.info(sessionId).catch(() => undefined))?.cwd);
      if (!cwd) return { items: [] };
      const wanted = Number.isInteger(limit) ? Math.max(limit, 1) : MENTION_LIMIT;
      return { items: await findMentions(cwd, query.replace(/^@/, ''), wanted) };
    },
    capabilities: forCodex('capabilities', async msg => {
      const cwd = store.find(msg.sessionId)?.cwd ?? (await library.info(msg.sessionId))?.cwd;
      return library.capabilities(cwd);
    }),
    configure: forCodex('configure', configure),
    delete: async ({ sessionId }) => {
      if (await isCodex(sessionId)) {
        await codex.remove({ sessionId });
        removeUploads(uploads, sessionId);
        return {};
      }
      await resuming.get(sessionId)?.catch(() => {});
      await typing(sessionId, () => removeSession({ store, library }, sessionId));
      chosenForResume.delete(sessionId);
      removeUploads(uploads, sessionId);
      return {};
    },
    history: forCodex('history', msg => {
      const file = store.find(msg.sessionId)?.transcriptPath;
      return file ? readHistory(file, msg) : library.history(msg.sessionId, msg);
    }),
    // Empty when the account has no picture.
    avatar: async () => (await avatar()) ?? {},
    // `imageId`, because `id` is the request's own.
    image: async msg => {
      const file = store.find(msg.sessionId)?.transcriptPath;
      const image = file ? readImage(file, msg.imageId) : await library.image(msg.sessionId, msg.imageId);
      if (!image?.data) throw new HelperError('unknown_image', 'This image is no longer in the transcript.');
      return image;
    },
    // Nothing here awaits for a session the helper knows, so every event is either in this
    // reply or follows it on the wire.
    join: async msg => {
      if (await isCodex(msg.sessionId)) return codex.join(msg);
      const session = store.find(msg.sessionId);
      if (!session?.transcriptPath) return joinStored(msg);
      const turn = store.openTurn(session);
      const [first] = turn;
      const start = first && { at: first.at, prompt: first.kind === 'message.user' ? first.text : undefined };
      return {
        ...readHistory(session.transcriptPath, { limit: msg.limit, turn: start }),
        turn, queued: store.queuedFor(session), seq: store.seq,
        sessions: store.sessions().filter(s => s.id === session.id),
        requests: store.requests().filter(r => r.sessionId === session.id),
      };
    },
    respond: async msg => {
      const request = store.requestOf(msg.requestId);
      // A permission prompt's own rows are pressed in the terminal, which then answers Claude Code.
      // Codex's are answers its server takes, as any other.
      if (request?.kind === 'permission' && msg.option != null && request.agent !== CODEX) {
        const row = store.choose(msg.requestId, msg.option);
        try {
          const session = sessionWithPane(request.sessionId);
          await typing(session.id, () => chooseRow(session, row));
        } catch (error) {
          store.notChosen(msg.requestId);
          if (error.code === 'prompt_changed') reofferPromptRows(store, request).catch(() => {});
          throw error;
        }
        store.chosen(msg.requestId);
        return {};
      }
      store.respond(msg.requestId, { ...msg, answers: attachedAnswers(msg) });
      return {};
    },
    upload: msg => saveUpload(uploads, msg, downloads),
    // Taken back out of the composer before its message went.
    discard: ({ sessionId, uploadId }) => discardUpload(uploads, sessionId, uploadId),
    // For a phone to send files over SSH, which takes its key.
    ssh: ({ publicKey }) => sshAccess(publicKey),
    screen: () => screenAccess(),
    // What the session's status line was last told, or null before Claude Code has run it.
    statusLine: async ({ sessionId }) => {
      // Codex has no status line, and says what one would itself.
      if (await isCodex(sessionId)) return codex.status({ sessionId });
      store.get(sessionId);
      return { status: (await readStatus(statusDir, sessionId)) ?? null };
    },
    // What a message had attached, for a client that didn't send it or no longer has it.
    file: ({ sessionId, uploadId }) => {
      const upload = findUpload(uploads, sessionId, uploadId);
      if (!upload) throw new HelperError('unknown_file', 'This file is no longer on the Mac.');
      return { name: upload.name, mediaType: upload.mediaType, data: fs.readFileSync(upload.path).toString('base64') };
    },
    send: async msg => {
      const attachments = attachmentsOf(msg);
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim() && !attachments.length) throw new HelperError('bad_text', 'Nothing to send.');
      if (msg.lane !== undefined && msg.lane !== 'next' && msg.lane !== 'later') throw new HelperError('bad_lane', `Unknown lane: ${msg.lane}`);
      if (await isCodex(msg.sessionId)) return codex.send({ ...msg, text, attachments });
      const change = attachments.length ? undefined : readSwitch(text);
      if (change) {
        await configure({ sessionId: msg.sessionId, ...change });
        return { queued: false };
      }
      await resuming.get(msg.sessionId)?.catch(() => {});
      const known = store.find(msg.sessionId);
      if (!known || known.status === 'ended') return resume({ ...msg, text, attachments });
      const session = sessionWithPane(msg.sessionId);
      const message = { clientId: msg.clientId, text, lane: msg.lane ?? 'next', attachments };
      if (store.mustHold(session, msg.lane)) {
        store.hold(session, message);
        return { queued: true };
      }
      const page = await deliver(session, { ...message, pages: msg.pages === true });
      return { queued: false, ...(page && { page: true }) };
    },
    // What a command opened in the terminal, to see and work from afar: null when nothing is.
    page: async ({ sessionId }) => ({ page: await readPage(sessionWithPane(sessionId)) }),
    pageKey: async ({ sessionId, key }) => {
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => pressPageKey(session, key));
      return {};
    },
    pageText: async ({ sessionId, text }) => {
      if (typeof text !== 'string' || !text) throw new HelperError('bad_text', 'Nothing to type.');
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => typeOnPage(session, text));
      return {};
    },
    // Closes what's open, as the reader leaves it.
    pageClose: async ({ sessionId }) => {
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => closePage(session));
      return {};
    },
    cancel: msg => {
      const taken = store.takeHeld(store.get(msg.sessionId), msg.clientId);
      // Its files go back in the composer, to go with another message or be taken out.
      for (const { uploadId } of taken?.attachments ?? []) markSent(uploads, msg.sessionId, uploadId, false);
      return { cancelled: taken !== undefined };
    },
    taskOutput: msg => {
      const task = store.task(msg.sessionId, msg.taskId);
      if (task.result !== undefined) return { output: task.result, truncated: false };
      if (!task.outputFile || task.type === 'subagent') return { output: null, truncated: false };
      return readTail(task.outputFile, TASK_OUTPUT_BYTES);
    },
    interrupt: async msg => {
      if (await isCodex(msg.sessionId)) return codex.interrupt(msg);
      const session = sessionWithPane(msg.sessionId);
      if (session.status !== 'running' && session.status !== 'waiting') throw new HelperError('not_running', 'Nothing to interrupt.');
      await sendEscape(session);
      return {};
    },
  };

  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      subscribers.delete(socket);
      clients.delete(socket);
    });
    write(socket, { type: 'hello', protocol: PROTOCOL_VERSION, version: VERSION });
    const lines = readline.createInterface({ input: socket });
    lines.on('error', () => {}); // readline re-emits socket errors; a dropped client must not crash the helper
    lines.on('line', async line => {
      let msg;
      try {
        msg = JSON.parse(line);
        const command = commands[msg.cmd];
        if (!command) throw new HelperError('unknown_command', `Unknown command: ${msg.cmd}`);
        noteAgents(socket, msg.agents);
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
  // Old uploads go now, and not while the helper runs, when a message might be on its way with one.
  pruneUploads(paths.uploads);
  pruneStatus(paths.statusDir);
  const rexAccount = cachedAccount();
  await rexAccount.refresh();
  // Codex's sessions, if its server is running on this Mac. Nothing is started for it here.
  const codex = new Codex({ store });
  codex.restore().catch(error => console.error(`codex: ${error.message}`));
  const { server: clientServer, subscribers, heldTimer } = createClientServer(store, updater.check, library, paths, () => rexAccount.current, codex);
  const transcripts = followTranscripts(store, { every: TRANSCRIPT_POLL_MS });
  await listen(hookServer, paths.hookSocket);
  await listen(clientServer, paths.clientSocket);
  fs.writeFileSync(paths.pidFile, String(process.pid));

  return {
    store,
    // Settles once an SDK install going on has ended too.
    stop() {
      const installing = library.stop();
      stopSaving();
      transcripts.stop();
      codex.stop();
      updater.stop();
      clearInterval(heldTimer);
      for (const socket of subscribers) socket.destroy();
      hookServer.closeAllConnections();
      hookServer.close();
      clientServer.close();
      fs.rmSync(paths.pidFile, { force: true });
      return installing;
    },
  };
}
