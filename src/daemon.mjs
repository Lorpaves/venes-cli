// Two local Unix sockets and no TCP ports: hook.sock receives Claude Code hook
// events, client.sock speaks newline-delimited JSON to clients. The app reaches
// client.sock through `venes attach` over SSH, so SSH handles authentication.

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { installHooks } from './agyhooks.mjs';
import { AGENT as ANTIGRAVITY, Antigravity, runsIn as runsAntigravity } from './antigravity.mjs';
import { Codex } from './codex.mjs';
import { checkedToolUse, readArtifact } from './artifact.mjs';
import { lineOf, onLines } from './lines.mjs';
import { createEntry, listAnywhere, listFolder, readChunk, readFile, trashEntry, writeFile } from './files.mjs';
import {
  branches as gitBranches, commit as gitCommit, commitStaged as gitCommitStaged, createBranch as gitCreateBranch, diff as gitDiff, discard as gitDiscard,
  log as gitLog, pull as gitPull, push as gitPush, repositoriesOf, stage as gitStage, countChanges, status as gitStatus, switchBranch as gitSwitch,
  unstage as gitUnstage,
} from './git.mjs';
import { configureSession, oneAtATime, readSwitch } from './configure.mjs';
import { readMode, switchMode } from './mode.mjs';
import { DEFAULT_PAGE_SIZE, Library, joinedStatus, mergedPage } from './library.mjs';
import { isWorthReplaying, lightPage } from './light.mjs';
import { foldedPage, foldOverOf, stretchOf } from './fold.mjs';
import { switchInPicker } from './picker.mjs';
import { removeSession, stopSession } from './remove.mjs';
import { askAgain, dialogLeft, quitInTerminal, restartSession, resumeSession } from './resume.mjs';
import { AgentCli } from './agentcli.mjs';
import { startNewSession } from './start.mjs';
import { PushDevices, notify, titleFor } from './push.mjs';
import { RECENT_SESSIONS, checkedFolder, createFile, createFolder, homeFolder, recentFolders, runningIn, subfolders } from './folders.mjs';
import { isTrusted, readClaudeConfig } from './trust.mjs';
import { SessionStore, HelperError, notTypable } from './sessions.mjs';
import { readRegistry, writeRegistry } from './registry.mjs';
import { followTranscripts, readAgentParent, readHistory, readImage, readTail } from './transcript.mjs';
import { avatarSource } from './avatar.mjs';
import {
  closePage, hasTerminal, pause, pressPageKey, readPage, readScreen, resumeTerminal, sendEscape, sendMessage, settleCommand, terminalOf, typeOnPage,
} from './terminal.mjs';
import { TerminalWatch } from './terminalwatch.mjs';
import { isConsolePane, openPanes as openConsoles } from './winconsole.mjs';
import { choicesOf, chooseRow, isAbout, knownTexts, readPrompt } from './prompt.mjs';
import {
  MAX_ATTACHMENTS, answersWithAttachments, discardUpload, findUpload, markSent, pruneIncoming, pruneUploads, removeUploads, saveReceived, saveUpload,
} from './uploads.mjs';
import { INSTALL_FOLDER as REX_FOLDER, cachedAccount, runsClaude as rexRunsClaude } from './rex.mjs';
import { screenAccess, sshAccess } from './ssh.mjs';
import { accountLimits, pruneStatus, readStatus, readWorkspace, statusFacts } from './status.mjs';
import { Prices } from './prices.mjs';
import { UsageBook, usageReply } from './usage.mjs';
import { MENTION_LIMIT, mentionFinder } from './mentions.mjs';
import { findClaudePanes } from './tmux.mjs';
import { AGENT as TERMINAL, Terminals } from './terminals.mjs';
import { startAutoUpdate } from './update.mjs';
import { VERSION, isNewer } from './version.mjs';
import { computer, isWindows } from './platform.mjs';
import { WIRE_ROOT, fromWire, toWire, windowsDrives } from './wirepaths.mjs';

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
// How long after a turn ends a restart that waited for it goes: a message queued for the next turn
// starts that turn first, and the session is at work again.
const RESTART_SETTLE_MS = 1500;
// How long a closed Claude Code's process has to go after it says it has ended, and how often it's looked for.
const CLOSE_GONE_MS = 10_000;
const CLOSE_CHECK_MS = 300;
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });
// How long a status waits for the account's per-model limits the first time they're read.
const MODEL_LIMITS_WAIT_MS = 2500;
// What may have changed a session's repository: a tool, a turn, a line for the shell, and its start, when
// nothing has been counted yet. The count waits this long, so that a run of them is counted once.
// A terminal session's shell goes from folder to folder, and each may be another repository's.
const RECOUNTED_AFTER = new Set(['tool.end', 'turn.end', 'message.output', 'session.started', 'session.discovered', 'session.attached', 'session.cwd']);
const RECOUNT_WAIT_MS = 700;
// The longest a client waits for the count with the session it asked for.
const JOIN_COUNT_MS = 1500;
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

function createHookServer(store, antigravity = undefined) {
  return http.createServer(async (req, res) => {
    let event;
    try {
      event = JSON.parse(await readBody(req));
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    // One of Antigravity's, which its plugin marks. Antigravity waits on its hooks, so it's answered
    // before anything is made of the event.
    if (req.headers['x-venes-agent'] === ANTIGRAVITY) {
      res.end();
      antigravity?.handleHook(event, await terminalOf(req.headers).catch(() => ({})));
      return;
    }
    try {
      const held = store.handleHook(event, await terminalOf(req.headers).catch(() => ({})));
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

function createClientServer(store, checkForUpdate, library, { uploads, downloads, incoming, statusDir, pushFile }, tailscaleAccount = () => undefined, codex = undefined, antigravity = undefined, usage = undefined, terminals = undefined) {
  // The agents other than Claude Code, each with sessions of its own that it runs through its own server.
  // A terminal session has no agent in it, and is kept the same way: a shell the helper runs and reads itself.
  const others = [codex, antigravity, terminals].filter(Boolean);
  const named = agent => others.find(other => other.name === agent);
  // Event numbering restarts with the helper, so a client's `since` only means
  // something within the same boot.
  const bootId = randomUUID();
  const subscribers = new Set();
  // Every connection, each with the phone it's from once that phone says, for not notifying a phone
  // that's there to see for itself.
  const clients = new Set();
  const devices = new PushDevices(pushFile);
  const isConnected = deviceId => [...clients].some(socket => socket.pushDevice === deviceId);
  // From Windows a path is said the way a client takes one apart: see wirepaths.mjs.
  const write = (socket, message) => socket.write(lineOf(isWindows ? toWire(message) : message));

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
    // A Codex session takes it through Codex's own server, as an Antigravity session does through
    // Antigravity's, and says nothing of a page.
    const other = named(session.agent);
    if (other) {
      await other.deliver(session, { clientId, text, attachments });
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

  // A session whose terminal closed with nothing said is over: see TerminalWatch.
  const terminalWatch = new TerminalWatch({
    store,
    hasTerminal,
    isRunning: async (session, asked) => {
      if (!asked.has('running')) asked.set('running', library.running());
      return (await asked.get('running')).some(found => found.id === session.id);
    },
  });
  const stopWatching = terminalWatch.start();

  store.on('event', event => {
    if (RECOUNTED_AFTER.has(event.kind)) recount(event.sessionId);
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

  // The mode a session's terminal says it's in. A hook says the mode only when the session does
  // something, so one that hasn't yet, or was switched in the terminal since, is read off its screen
  // when someone opens it.
  const noteShownMode = async session => {
    if (!session?.pane || session.status === 'ended') return;
    const mode = readMode(await readScreen(session).catch(() => ''));
    if (mode) store.noteMode(session.id, mode);
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

  // A session a client still lists that is nowhere any more: Claude Code has none stored by that id, and
  // every other agent, asked, said it has none either. It was deleted outside Venes, as a thread is that's
  // deleted in Codex's own app. Clients are told it has gone, so their lists let go of it: opened, it was an
  // empty page with whatever commands the client last had. An agent that couldn't be asked hasn't said no.
  const announceGone = (sessionId, error) => {
    if (error?.code !== 'unknown_session' || typeof sessionId !== 'string' || store.find(sessionId)) return;
    if (!others.every(other => (other.denies ? other.denies(sessionId) : true))) return;
    store.forget(sessionId);
  };

  // A Codex session's commands go to Codex's server, and any other's the way they always did.
  // The agent a session is another's than Claude Code's, if it is.
  const otherOf = async sessionId => {
    for (const other of others) if ((await other.owns(sessionId)) === true) return other;
    return undefined;
  };
  const forOther = (name, otherwise) => async (msg, socket) => {
    const other = await otherOf(msg.sessionId);
    return other ? other[name](msg) : otherwise(msg, socket);
  };
  // Where a session the helper doesn't follow ran.
  const storedFolder = async sessionId => {
    const other = await otherOf(sessionId);
    return other ? other.folderOf(sessionId) : (await library.info(sessionId).catch(() => undefined))?.cwd;
  };

  // The folder a session works in, which is where its files and its git are looked at: a session the
  // helper follows says where it is now, and a stored one where it ran.
  const folderOf = async sessionId => {
    if (typeof sessionId !== 'string') throw new HelperError('unknown_session', 'No such session.');
    const cwd = store.find(sessionId)?.cwd
      ?? await storedFolder(sessionId);
    if (!cwd) throw new HelperError('unknown_session', `No session ${sessionId}`);
    return checkedFolder(cwd);
  };

  // Where a file is looked for: in a session's folder, or with no session named, anywhere on this Mac,
  // for whoever is choosing where a session starts. A path is whole then, there being no folder for it
  // to be from.
  const isAnywhere = sessionId => sessionId === undefined || sessionId === null;
  const rootFor = async (sessionId, named) => {
    if (!isAnywhere(sessionId)) return folderOf(sessionId);
    if (typeof named !== 'string' || !path.isAbsolute(named)) throw new HelperError('bad_path', 'With no session, a path is whole.');
    return path.parse(path.resolve(named)).root;
  };

  // The repositories a session has to do with: see `repositoriesOf`. A session the helper doesn't
  // follow has only where it ran to go by.
  const repositoriesFor = async sessionId => {
    const now = await folderOf(sessionId);
    const session = store.find(sessionId);
    // Claude Code's own word for where the session started comes first: the helper may have met the
    // session part way through, as after it has started again, and then knows only where it was by then.
    const { projectDir, addedDirs } = readWorkspace(statusDir, sessionId);
    return repositoriesOf({ now, recent: [...(session?.folders ?? []), ...addedDirs], start: projectDir ?? session?.startFolder ?? now });
  };
  // The repository a git command is for: the one it names, which has to be one of the session's, or
  // with none named the first of them.
  const repositoryFor = async (sessionId, root, known) => {
    const roots = known ?? (await repositoriesFor(sessionId));
    if (root === undefined || root === null) {
      if (!roots.length) throw new HelperError('no_repository', 'This session has no git repository.');
      return roots[0];
    }
    if (!roots.includes(root)) throw new HelperError('bad_repository', 'That isn\'t one of this session\'s repositories.');
    return root;
  };

  // How much has changed in a session's repository, the first of them, which is the one its git page opens on.
  const countChangesOf = async sessionId => {
    const roots = await repositoriesFor(sessionId).catch(() => []);
    const state = roots.length ? await gitStatus(roots[0]).catch(() => undefined) : undefined;
    store.noteChanges(sessionId, countChanges(state));
  };
  // Counted a moment after what may have changed it, so that a run of tools is counted once.
  const recounting = new Map();
  function recount(sessionId) {
    if (!sessionId || recounting.has(sessionId)) return;
    const timer = setTimeout(() => {
      recounting.delete(sessionId);
      countChangesOf(sessionId).catch(error => console.error(`changes: ${error.message}`));
    }, RECOUNT_WAIT_MS);
    timer.unref();
    recounting.set(sessionId, timer);
  }
  // For a client that asks for the session: counted now, unless git takes too long over it, and then it follows.
  const countedChanges = sessionId => Promise.race([
    countChangesOf(sessionId).catch(() => {}), new Promise(resolve => { setTimeout(resolve, JOIN_COUNT_MS).unref(); }),
  ]);
  // What a client did to the repository changes the count as well.
  const thenRecount = async (sessionId, doing) => {
    try { return await doing; } finally { recount(sessionId); }
  };

  // Every agent's stored sessions as one list, the newest first, a page at a time: see mergedPage. The
  // first page had Claude Code's newest and all of every other agent's after them, over two hundred
  // sessions at once for a reader with a few of each, in no order of time.
  const listLibrary = async ({ limit, offset }, socket) => {
    const size = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_PAGE_SIZE;
    const from = Number.isInteger(offset) && offset > 0 ? offset : 0;
    const [page, threads] = await Promise.all([
      library.page({ limit: from + size, offset: 0 }),
      Promise.all(others.filter(other => shows(socket, other.name)).map(other => other.library().catch(error => {
        console.error(`${other.name} library: ${error.message}`);
        return [];
      }))).then(lists => lists.flat()),
    ]);
    return mergedPage(page, threads, { limit: size, offset: from });
  };

  const listSessions = async socket => {
    const sessions = store.sessions().filter(session => shows(socket, session.agent));
    const sockets = new Set([undefined, ...sessions.map(s => s.tmuxSocket ?? undefined)]);
    const known = new Set(sessions.map(s => `${s.tmuxSocket}|${s.pane}`));
    const unattached = (await findClaudePanes(sockets)).filter(p => !known.has(`${p.tmuxSocket}|${p.pane}`));
    return { sessions, unattached };
  };

  // What each agent's command line is on this computer, and its updates (agentcli.mjs).
  const agentCli = new AgentCli();
  // Restarts under way, and the ones asked for while a session was at work, which go once it isn't.
  const restarts = new Map();
  const restartErrors = new Map();

  // The agent a session is, and what knows it: Claude Code's sessions are the helper's own.
  const cliAgentOf = async sessionId => {
    const other = await otherOf(sessionId);
    return other ? { key: other.name, other } : { key: 'claude' };
  };

  // A Claude Code session is at work while a turn runs, something waits on the reader, a message waits
  // for its turn, or a task it started is still going.
  const claudeBusy = sessionId => {
    const s = store.find(sessionId);
    if (!s || s.status === 'ended') return false;
    return store.isBusy(s) || store.pendingFor(s).length > 0 || s.backgroundTasks > 0 || s.queued.length > 0;
  };
  const busyOf = (agent, sessionId) => (agent.other ? agent.other.isBusy(sessionId) : claudeBusy(sessionId));
  const runningOf = async (agent, sessionId) => (agent.other ? agent.other.runningVersion?.(sessionId) : statusFacts(statusDir, sessionId).version);

  const runRestart = async (sessionId, agent) => {
    restarts.set(sessionId, 'restarting');
    restartErrors.delete(sessionId);
    try {
      if (agent.other) await agent.other.restartNow(sessionId);
      else {
        const { model, effort } = statusFacts(statusDir, sessionId);
        await restartSession({ store, library, terminal: resumeTerminal() }, sessionId, { model, effort, mode: store.find(sessionId)?.permissionMode });
      }
    } catch (error) {
      restartErrors.set(sessionId, error.message);
      console.error(`restart ${sessionId}: ${error.message}`);
    } finally {
      if (restarts.get(sessionId) === 'restarting') restarts.delete(sessionId);
    }
  };

  // A restart starts at once on a session that isn't at work, and waits for one that is. Codex's is its
  // daemon's, which every Codex session here shares, so it's refused while any of them works.
  const requestRestart = async sessionId => {
    if (restarts.get(sessionId) === 'restarting') return { restart: 'restarting' };
    // Asked for after a closing that waits, it's what's wanted now.
    if (closes.get(sessionId) === 'pending') closes.delete(sessionId);
    const agent = await cliAgentOf(sessionId);
    if (await busyOf(agent, sessionId)) {
      if (agent.key === 'codex') throw new HelperError('agent_busy', 'Codex is working. Try again when it has finished.');
      restarts.set(sessionId, 'pending');
      return { restart: 'pending' };
    }
    runRestart(sessionId, agent);
    return { restart: 'now' };
  };

  // A restart that waited goes once its session has finished what it was doing. One whose session is
  // quit meanwhile goes with it: it was quit on purpose.
  store.on('event', event => {
    if (restarts.get(event.sessionId) !== 'pending') return;
    if (event.kind === 'session.ended') {
      restarts.delete(event.sessionId);
      return;
    }
    if (event.kind !== 'turn.end' && !(event.kind === 'session.status' && event.status === 'idle')) return;
    setTimeout(async () => {
      if (restarts.get(event.sessionId) !== 'pending') return;
      const agent = await cliAgentOf(event.sessionId).catch(() => undefined);
      if (!agent || await busyOf(agent, event.sessionId)) return;
      runRestart(event.sessionId, agent);
    }, RESTART_SETTLE_MS).unref();
  });

  // Closings under way, and the ones asked for while a session was at work, which go once it isn't.
  const closes = new Map();
  const closeErrors = new Map();
  const CLAUDE_CLOSE = { background: "A background session can't be closed from here.", wouldnt: "Claude Code wouldn't quit." };

  // A session has a command line to close: Claude Code running it, Antigravity open on it, or Codex's own
  // terminal on its thread, as Codex's server is every Codex session's and isn't closed.
  const closableOf = (agent, sessionId) => {
    if (agent.other) return agent.other.isClosable(sessionId);
    const s = store.find(sessionId);
    return Boolean(s && s.status !== 'ended');
  };
  // At work, for closing, which waits for it: the session, and for Codex its thread alone.
  const workingOf = (agent, sessionId) => {
    if (!agent.other) return claudeBusy(sessionId);
    return agent.other.isWorking ? agent.other.isWorking(sessionId) : agent.other.isBusy(sessionId);
  };

  const runClose = async (sessionId, agent) => {
    closes.set(sessionId, 'closing');
    closeErrors.delete(sessionId);
    try {
      if (agent.other) await agent.other.closeNow(sessionId);
      else await closeClaude(sessionId);
    } catch (error) {
      closeErrors.set(sessionId, error.message);
      console.error(`close ${sessionId}: ${error.message}`);
    } finally {
      if (closes.get(sessionId) === 'closing') closes.delete(sessionId);
    }
  };

  // Claude Code is asked to quit as /exit asks, in its terminal, or where the helper can't type, with SIGTERM.
  // One that had gone without a word is over all the same.
  const closeClaude = async sessionId => {
    const s = store.find(sessionId);
    if (s?.pane) {
      if (!(await quitInTerminal({ store, terminal: resumeTerminal() }, s))) throw new HelperError('session_running', CLAUDE_CLOSE.wouldnt);
      // It says it has ended a moment before its process has gone: closing is done once that has too.
      for (const end = Date.now() + CLOSE_GONE_MS; (await library.running().catch(() => [])).some(found => found.id === sessionId); await delay(CLOSE_CHECK_MS)) {
        if (Date.now() >= end) throw new HelperError('session_running', CLAUDE_CLOSE.wouldnt);
      }
      return;
    }
    if (!(await stopSession({ library }, sessionId, CLAUDE_CLOSE)) && store.find(sessionId)?.status !== 'ended') {
      store.report(sessionId, 'session.ended', { reason: 'closed' });
    }
  };

  // Closing goes at once for a session that isn't at work, and waits for one that is. The conversation
  // stays, and a message opens it again.
  const requestClose = async sessionId => {
    if (closes.get(sessionId) === 'closing') return { close: 'closing' };
    const agent = await cliAgentOf(sessionId);
    if (!(await closableOf(agent, sessionId))) throw new HelperError('not_open', "This session isn't open, so there's nothing to close.");
    // A restart that waited would open it again.
    if (restarts.get(sessionId) === 'pending') restarts.delete(sessionId);
    if (await workingOf(agent, sessionId)) {
      closes.set(sessionId, 'pending');
      return { close: 'pending' };
    }
    runClose(sessionId, agent);
    return { close: 'now' };
  };

  // A closing that waited goes once its session has finished. Once the session is over, so is its closing,
  // whatever ended it.
  store.on('event', event => {
    const closing = closes.get(event.sessionId);
    if (!closing) return;
    if (event.kind === 'session.ended') {
      closes.delete(event.sessionId);
      return;
    }
    if (closing !== 'pending') return;
    if (event.kind !== 'turn.end' && !(event.kind === 'session.status' && event.status === 'idle')) return;
    setTimeout(async () => {
      if (closes.get(event.sessionId) !== 'pending') return;
      const agent = await cliAgentOf(event.sessionId).catch(() => undefined);
      if (!agent || await workingOf(agent, event.sessionId)) return;
      runClose(event.sessionId, agent);
    }, RESTART_SETTLE_MS).unref();
  });

  const commands = {
    // The Tailscale account Rex is signed in with, which a phone reaches this Mac as through Rex.
    ping: () => {
      const account = tailscaleAccount();
      return { protocol: PROTOCOL_VERSION, version: VERSION, platform: process.platform, quiet: store.isQuiet(), ...(account && { tailscaleAccount: account }) };
    },
    update: async () => ({ version: VERSION, available: (await checkForUpdate()) ?? null }),
    sessions: (msg, socket) => listSessions(socket),
    subscribe: async (msg, socket) => {
      const { unattached } = await listSessions(socket);
      // Nothing below awaits, so no event can slip between the snapshot and the subscription.
      const sameBoot = !msg.bootId || msg.bootId === bootId;
      const missed = sameBoot ? store.eventsSince(msg.since ?? store.seq) : { events: [], gap: true };
      // A client that's told of a gap starts over from the snapshot and takes no event from before it, so
      // none is sent. Nor are they when what it missed is more than opening its page again would be.
      const events = missed.gap ? [] : missed.events.filter(event => showsEvent(socket, event));
      const isReplayed = isWorthReplaying(events);
      write(socket, {
        type: 'snapshot', bootId, seq: store.seq, unattached,
        sessions: store.sessions().filter(session => shows(socket, session.agent)),
        requests: store.requests().filter(request => shows(socket, request.agent)),
      });
      if (isReplayed) for (const event of events) write(socket, { type: 'event', event });
      subscribers.add(socket);
      return { gap: missed.gap || !isReplayed };
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
      // Above a drive there's nothing on Windows but the drives.
      if (isWindows && folder === WIRE_ROOT) return { path: WIRE_ROOT, name: os.hostname(), trusted: false, entries: windowsDrives(), truncated: false };
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
        ...(antigravity?.isAvailable() && { antigravity: true }),
        ...(terminals?.isAvailable() && { terminal: true }),
      };
    },
    // A new folder where the reader is looking, for a session to start in.
    folderCreate: async ({ path: folder, name }) => {
      const made = createFolder(folder, name);
      return { ...made, trusted: isTrusted(made.path, { config: readClaudeConfig(), home: homeFolder() }) };
    },
    // And an empty file there, for the session that starts in that folder to find.
    folderFileCreate: async ({ path: folder, name }) => createFile(folder, name),
    start: msg => {
      if (msg.agent === undefined || msg.agent === 'claude') return startNewSession({ store, terminal: resumeTerminal() }, msg);
      const other = named(msg.agent);
      if (!other) throw new HelperError('bad_agent', `Nothing here starts ${msg.agent}.`);
      return other.start(msg);
    },
    // What an @ in a message can name, from the session's folder: files, and folders ending in /.
    mentions: async ({ sessionId, query = '', limit = MENTION_LIMIT }) => {
      if (typeof query !== 'string' || query.length > 500) throw new HelperError('bad_query', 'That can\'t be looked for.');
      const cwd = store.find(sessionId)?.cwd
        ?? await storedFolder(sessionId);
      if (!cwd) return { items: [] };
      const wanted = Number.isInteger(limit) ? Math.max(limit, 1) : MENTION_LIMIT;
      return { items: await findMentions(cwd, query.replace(/^@/, ''), wanted) };
    },
    // What's in the session's folder, a level at a time, and what's in one of its files.
    // With no session it's a folder anywhere on this Mac, which also says whether Claude Code trusts it,
    // for a session that may start there.
    files: async ({ sessionId, path: named, hidden }) => {
      const root = await rootFor(sessionId, named);
      if (!isAnywhere(sessionId)) return listFolder(root, named);
      const listing = await listAnywhere(named, { hidden: hidden === true });
      return { ...listing, trusted: isTrusted(listing.path, { config: readClaudeConfig(), home: homeFolder() }) };
    },
    // Something new in a session's folder: an empty file, or a folder with `folder`. It's one more thing changed there.
    fileCreate: async ({ sessionId, path: named, name, folder }) => {
      const root = await folderOf(sessionId);
      try {
        return createEntry(root, named, { name, folder });
      } finally {
        recount(sessionId);
      }
    },
    // A file or a folder of the session's goes to the Trash, which changes what git counts there.
    fileDelete: async ({ sessionId, path: named }) => {
      const root = await rootFor(sessionId, named);
      try {
        // The home folder stays, and what it's in, wherever it's asked from.
        return await trashEntry(root, named, { keeps: [homeFolder()] });
      } finally {
        recount(sessionId);
      }
    },
    fileRead: async ({ sessionId, path: named }) => readFile(await rootFor(sessionId, named), named),
    // New text for one of its files, as someone edited it from afar. It's one more thing changed there.
    fileWrite: async ({ sessionId, path: named, text, was, overwrite }) => {
      const root = await rootFor(sessionId, named);
      try {
        return writeFile(root, named, { text, was, overwrite: overwrite === true });
      } finally {
        recount(sessionId);
      }
    },
    // A file of any size, a piece at a time.
    fileChunk: async ({ sessionId, path: named, offset, length }) => readChunk(await rootFor(sessionId, named), named, { offset, length }),
    // What git says of a session's repository: null for a session with none. A session can have several,
    // as it moves about, so `repositories` lists them, the first being the one told of when none is named.
    git: async ({ sessionId, root }) => {
      const roots = await repositoriesFor(sessionId);
      const chosen = roots.length || root != null ? await repositoryFor(sessionId, root, roots) : undefined;
      return { git: (chosen && (await gitStatus(chosen))) ?? null, repositories: roots.map(folder => ({ root: folder, name: path.basename(folder) })) };
    },
    gitDiff: async ({ sessionId, root, path: file, staged, commit }) => gitDiff(await repositoryFor(sessionId, root), { path: file, staged: staged === true, commit }),
    gitLog: async ({ sessionId, root, limit, skip, all }) => gitLog(await repositoryFor(sessionId, root), { limit, skip, all }),
    gitCommit: async ({ sessionId, root, commit }) => gitCommit(await repositoryFor(sessionId, root), { commit }),
    gitBranches: async ({ sessionId, root }) => gitBranches(await repositoryFor(sessionId, root)),
    // The few things that change the repository: what the next commit takes, the commit itself, and the branch.
    gitStage: async ({ sessionId, root, paths, all }) => thenRecount(sessionId, gitStage(await repositoryFor(sessionId, root), { paths, all })),
    gitUnstage: async ({ sessionId, root, paths, all }) => thenRecount(sessionId, gitUnstage(await repositoryFor(sessionId, root), { paths, all })),
    gitCommitStaged: async ({ sessionId, root, message }) => thenRecount(sessionId, gitCommitStaged(await repositoryFor(sessionId, root), { message })),
    gitSwitch: async ({ sessionId, root, branch }) => thenRecount(sessionId, gitSwitch(await repositoryFor(sessionId, root), { branch })),
    gitBranchCreate: async ({ sessionId, root, name }) => thenRecount(sessionId, gitCreateBranch(await repositoryFor(sessionId, root), { name })),
    // What's thrown away goes to the Trash, as a file deleted from here does.
    gitDiscard: async ({ sessionId, root, paths, all }) => thenRecount(sessionId, gitDiscard(await repositoryFor(sessionId, root), { paths, all }, {
      trash: (folder, name) => trashEntry(folder, name, { keeps: [homeFolder()] }), keeps: [homeFolder()],
    })),
    // The branch, to its remote and from it. A pull can change the folder's files, and a push none.
    gitPush: async ({ sessionId, root }) => gitPush(await repositoryFor(sessionId, root)),
    gitPull: async ({ sessionId, root }) => thenRecount(sessionId, gitPull(await repositoryFor(sessionId, root))),
    // The mode a session asks permission in. A Claude Code session's is changed in its terminal, as a
    // person changes it, and a Codex session's through Codex's server, from its next turn.
    setMode: forOther('setMode', async ({ sessionId, mode }) => {
      const session = sessionWithPane(sessionId);
      const { passed } = await typing(session.id, () => switchMode(session, mode, () => store.pendingFor(session)[0]));
      store.noteMode(session.id, mode, passed);
      return {};
    }),
    capabilities: forOther('capabilities', async msg => {
      const cwd = store.find(msg.sessionId)?.cwd ?? (await library.info(msg.sessionId))?.cwd;
      // A Claude Code question's answer can carry the reader's notes, which go to Claude Code beside it.
      return { ...(await library.capabilities(cwd)), answerNotes: true };
    }),
    configure: forOther('configure', configure),
    delete: async ({ sessionId }) => {
      const other = await otherOf(sessionId);
      if (other) {
        await other.remove({ sessionId });
        removeUploads(uploads, sessionId);
        return {};
      }
      await resuming.get(sessionId)?.catch(() => {});
      await typing(sessionId, () => removeSession({ store, library }, sessionId));
      chosenForResume.delete(sessionId);
      removeUploads(uploads, sessionId);
      return {};
    },
    history: forOther('history', msg => {
      const file = store.find(msg.sessionId)?.transcriptPath;
      return file ? readHistory(file, msg) : library.history(msg.sessionId, msg);
    }),
    // Empty when the account has no picture.
    avatar: async () => (await avatar()) ?? {},
    // `imageId`, because `id` is the request's own.
    image: async msg => {
      const other = await otherOf(msg.sessionId);
      if (other) return other.image(msg);
      const file = store.find(msg.sessionId)?.transcriptPath;
      const image = file ? readImage(file, msg.imageId) : await library.image(msg.sessionId, msg.imageId);
      if (!image?.data) throw new HelperError('unknown_image', 'This image is no longer in the transcript.');
      return image;
    },
    // The page an Artifact call published, as text, for a client to show where claude.ai's own is private to
    // whoever published it. The file is the one the call's record names, and no other.
    artifact: async ({ sessionId, toolUseId }) => {
      const id = checkedToolUse(toolUseId);
      const found = await library.artifact(sessionId, id, store.find(sessionId)?.transcriptPath).catch(() => undefined);
      return readArtifact(found?.path);
    },
    // Nothing here awaits for a session the helper knows, so every event is either in this
    // reply or follows it on the wire.
    join: async msg => {
      await countedChanges(msg.sessionId);
      const other = await otherOf(msg.sessionId);
      if (other) return other.join(msg);
      const session = store.find(msg.sessionId);
      await noteShownMode(session);
      if (!session?.transcriptPath) {
        return joinStored(msg).catch(error => {
          announceGone(msg.sessionId, error);
          throw error;
        });
      }
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
      if (request?.kind === 'permission' && msg.option != null && !named(request.agent)) {
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
    // In the line itself, or as a file `receive` took over SSH and wrote where it says.
    upload: msg => (msg.file === undefined ? saveUpload(uploads, msg, downloads) : saveReceived(uploads, msg, incoming, downloads)),
    // Taken back out of the composer before its message went.
    discard: ({ sessionId, uploadId }) => discardUpload(uploads, sessionId, uploadId),
    // For a phone to send files over SSH, which takes its key.
    ssh: ({ publicKey }) => sshAccess(publicKey),
    screen: () => screenAccess(),
    // What the session's status line was last told, or null before Claude Code has run it.
    // What every agent here has used, for the reader's whole account and not one session's: see usage.mjs.
    // `timeZone` is the reader's, by its name, so that a day and an hour are its own and not this computer's.
    usage: async (msg, socket) => {
      if (!usage) throw new HelperError('unsupported', 'This helper keeps no count of what is used.');
      const zone = typeof msg.timeZone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(msg.timeZone) ? msg.timeZone : undefined;
      const said = other => (other && shows(socket, other.name) ? other.limits().catch(() => undefined) : undefined);
      // Claude Code's are asked of it, as /usage is, and waited for only a moment: until they come,
      // they're as its status line was last told them, and more is said to be on its way.
      const ofClaude = async () => {
        const late = new Promise(resolve => { setTimeout(resolve, MODEL_LIMITS_WAIT_MS, 'late').unref(); });
        const asked = await Promise.race([library.accountLimits().catch(() => undefined), late]);
        // A status line isn't told the plan, so with its limits the plan is as Claude Code last said it.
        const told = () => {
          const said = accountLimits(statusDir);
          return said && library.plan ? { ...said, plan: library.plan } : said;
        };
        if (asked === 'late') return { ...told(), reading: true };
        return asked ?? told();
      };
      const [read, ofCodex, ofAntigravity, ofClaudeCode] = await Promise.all([usage.read(zone), said(codex), said(antigravity), ofClaude()]);
      return usageReply({
        read, shown: agent => agent === 'claude' || shows(socket, agent),
        limits: { claude: ofClaudeCode, codex: ofCodex, antigravity: ofAntigravity },
      });
    },
    statusLine: async ({ sessionId }) => {
      // Codex has no status line, and says what one would itself.
      const other = await otherOf(sessionId);
      if (other) return other.status({ sessionId });
      store.get(sessionId);
      const status = await readStatus(statusDir, sessionId);
      // A week's limit that's for one model, as Fable's is, isn't in what a status line is told. It's
      // asked for apart, for an account that has limits, and a first read that's slow comes with a later status.
      if (status?.fiveHour || status?.sevenDay) {
        const late = new Promise(resolve => { setTimeout(resolve, MODEL_LIMITS_WAIT_MS, []).unref(); });
        const modelLimits = await Promise.race([library.modelLimits(), late]);
        if (modelLimits.length) status.modelLimits = modelLimits;
      }
      return { status: status ?? null };
    },
    // The command line a session's agent runs here: the version the session runs, the one installed, the
    // newest there is, and whether it can be updated from here.
    cli: async ({ sessionId }) => {
      const agent = await cliAgentOf(sessionId);
      // A terminal session runs a shell, which has no version to be behind and nothing to update.
      if (agent.key === TERMINAL) {
        return {
          agent: TERMINAL, running: null, installed: null, latest: null, install: 'unknown', update: 'none', working: false,
          restart: restarts.get(sessionId) ?? null, ...(restartErrors.has(sessionId) && { restartError: restartErrors.get(sessionId) }),
          closable: await closableOf(agent, sessionId), close: closes.get(sessionId) ?? null, ...(closeErrors.has(sessionId) && { closeError: closeErrors.get(sessionId) }),
        };
      }
      const busy = agent.key === 'codex' ? await agent.other.isBusy(sessionId) : false;
      const report = await agentCli.report(agent.key, { running: await runningOf(agent, sessionId), busy });
      // At work: this session is, so a restart waits for it; for Codex, any session on its daemon is, so a
      // restart is refused.
      const working = await busyOf(agent, sessionId);
      return {
        ...report, working, restart: restarts.get(sessionId) ?? null, ...(restartErrors.has(sessionId) && { restartError: restartErrors.get(sessionId) }),
        closable: await closableOf(agent, sessionId), close: closes.get(sessionId) ?? null, ...(closeErrors.has(sessionId) && { closeError: closeErrors.get(sessionId) }),
      };
    },
    // Updates a session's agent's command line on this computer, in the background, then restarts the
    // session onto it: at once when it isn't at work, or once it isn't.
    cliUpdate: async ({ sessionId }) => {
      const agent = await cliAgentOf(sessionId);
      if (agent.key === TERMINAL) throw new HelperError('terminal_session', 'A terminal session has nothing to update.');
      const busy = agent.key === 'codex' ? await agent.other.isBusy(sessionId) : false;
      const was = await runningOf(agent, sessionId);
      return agentCli.update(agent.key, {
        busy,
        after: async ({ version }) => {
          if (agent.key !== 'codex' && was && !isNewer(version, was)) return;
          await requestRestart(sessionId).catch(error => restartErrors.set(sessionId, error.message));
        },
      });
    },
    restart: ({ sessionId }) => requestRestart(sessionId),
    close: ({ sessionId }) => requestClose(sessionId),
    // What a message had attached, for a client that didn't send it or no longer has it.
    file: ({ sessionId, uploadId }) => {
      const upload = findUpload(uploads, sessionId, uploadId);
      if (!upload) throw new HelperError('unknown_file', `This file is no longer on the ${computer}.`);
      return { name: upload.name, mediaType: upload.mediaType, data: fs.readFileSync(upload.path).toString('base64') };
    },
    send: async msg => {
      const attachments = attachmentsOf(msg);
      const text = typeof msg.text === 'string' ? msg.text : '';
      if (!text.trim() && !attachments.length) throw new HelperError('bad_text', 'Nothing to send.');
      if (msg.lane !== undefined && msg.lane !== 'next' && msg.lane !== 'later') throw new HelperError('bad_lane', `Unknown lane: ${msg.lane}`);
      const other = await otherOf(msg.sessionId);
      if (other) return other.send({ ...msg, text, attachments });
      const change = attachments.length ? undefined : readSwitch(text);
      if (change) {
        await configure({ sessionId: msg.sessionId, ...change });
        return { queued: false };
      }
      await resuming.get(msg.sessionId)?.catch(() => {});
      const known = store.find(msg.sessionId);
      if (!known || known.status === 'ended') return resume({ ...msg, text, attachments });
      // A resume that stopped at a dialog left it with no terminal: the dialog is still what's in the way,
      // or its terminal has closed and the session is resumed again.
      const left = await dialogLeft({ store, terminal: resumeTerminal() }, known);
      if (left === 'open') askAgain({ store, terminal: resumeTerminal() }, known);
      if (left === 'gone') return resume({ ...msg, text, attachments });
      const session = sessionWithPane(msg.sessionId);
      // Its terminal can have closed with nothing said, before that's been noticed. The session is over,
      // and the message picks it up again, as it would any that had ended.
      if (await terminalWatch.endIfGone(session)) return resume({ ...msg, text, attachments });
      const message = { clientId: msg.clientId, text, lane: msg.lane ?? 'next', attachments };
      if (store.mustHold(session, msg.lane)) {
        store.hold(session, message);
        return { queued: true };
      }
      const page = await deliver(session, { ...message, pages: msg.pages === true });
      return { queued: false, ...(page && { page: true }) };
    },
    // What a command opened in the terminal, to see and work from afar: null when nothing is.
    // Another agent's session has pages of its own kind, or none, and answers for them itself.
    page: forOther('page', async ({ sessionId }) => ({ page: await readPage(sessionWithPane(sessionId)) })),
    pageKey: forOther('pageKey', async ({ sessionId, key }) => {
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => pressPageKey(session, key));
      return {};
    }),
    pageText: forOther('pageText', async ({ sessionId, text }) => {
      if (typeof text !== 'string' || !text) throw new HelperError('bad_text', 'Nothing to type.');
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => typeOnPage(session, text));
      return {};
    }),
    // Closes what's open, as the reader leaves it.
    pageClose: forOther('pageClose', async ({ sessionId }) => {
      const session = sessionWithPane(sessionId);
      await typing(session.id, () => closePage(session));
      return {};
    }),
    // A key for the program a terminal session is running, which takes more than lines: Esc, Tab, the arrows.
    key: async msg => {
      const other = await otherOf(msg.sessionId);
      if (!other?.key) throw new HelperError('no_keys', 'This session takes no keys.');
      return other.key(msg);
    },
    // What the line being typed in a terminal session's field could go on to be: see Terminals.suggest.
    // A session of any other kind has nothing to suggest.
    suggest: async msg => {
      const other = await otherOf(msg.sessionId);
      return other?.suggest ? other.suggest(msg) : { suggestions: [] };
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
      const other = await otherOf(msg.sessionId);
      if (other) return other.interrupt(msg);
      const session = sessionWithPane(msg.sessionId);
      if (session.status !== 'running' && session.status !== 'waiting') throw new HelperError('not_running', 'Nothing to interrupt.');
      await sendEscape(session);
      store.interruptSent(msg.sessionId);
      return {};
    },
  };

  // A page's calls are cut down as live ones are, whoever keeps the session, and its long stretches of
  // them are folded for a client that asks: see `fold.mjs`.
  const wholeHistory = commands.history;
  for (const name of ['join', 'history']) {
    const page = commands[name];
    commands[name] = async (...given) => foldedPage(lightPage(await page(...given)), foldOverOf(given[0]));
  }
  // A stretch a page had folded, whole: all of the session is read for it, as it is for any page.
  commands.unfold = async (msg, ...rest) => {
    const { items = [] } = lightPage(await wholeHistory({ sessionId: msg.sessionId, limit: Number.MAX_SAFE_INTEGER }, ...rest));
    const stretch = typeof msg.key === 'string' ? stretchOf(items, msg.key) : undefined;
    if (!stretch) throw new HelperError('unknown_fold', 'Those steps are no longer in the session.');
    return { items: stretch };
  };

  const server = net.createServer(socket => {
    clients.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      subscribers.delete(socket);
      clients.delete(socket);
    });
    write(socket, { type: 'hello', protocol: PROTOCOL_VERSION, version: VERSION, platform: process.platform });
    onLines(socket, async line => {
      let msg;
      try {
        msg = JSON.parse(line);
        if (isWindows) msg = fromWire(msg);
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
  return { server, subscribers, heldTimer, stopWatching };
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

// A pane that has gone, or no longer runs Claude, has nothing to come back to. An Antigravity session's
// is asked whether it still runs Antigravity, and its last words are its own to read.
export async function restoreSessions(store, paths, terminal = resumeTerminal()) {
  const records = readRegistry(paths.sessionsFile);
  const panes = await findClaudePanes(new Set(records.map(record => record.tmuxSocket ?? undefined)));
  const running = new Set(panes.map(pane => `${pane.tmuxSocket}|${pane.pane}`));
  // A Windows console is there while the program it was named by still runs.
  const consoles = records.some(isConsolePane) ? await openConsoles().catch(() => undefined) : undefined;
  const isAlive = record => {
    if (isConsolePane(record)) return consoles?.has(record.pane) ?? false;
    if (record.agent === ANTIGRAVITY) return runsAntigravity(terminal, record);
    return record.rexSession ? rexRunsClaude(record) : running.has(`${record.tmuxSocket ?? null}|${record.pane}`);
  };
  const alive = await Promise.all(records.map(isAlive));
  store.restore(records.filter((_, index) => alive[index]).map(record => (record.agent ? record : { ...record, ...lastWords(record.transcriptPath) })));
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
  process.env.PATH = [...EXTRA_PATH, process.env.PATH].join(path.delimiter);
  dropParentSession(process.env);
  fs.mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  if (await socketIsLive(paths.clientSocket)) throw new HelperError('already_running', 'The helper is already running.');
  // A socket left by a helper that was killed is in the way of a new one. A pipe goes with its helper.
  if (!isWindows) {
    for (const file of [paths.hookSocket, paths.clientSocket]) fs.rmSync(file, { force: true });
  }

  const store = new SessionStore({ agentParent: readAgentParent });
  // A session missed here comes back with its next hook, but sessions.json outlives this
  // start, so a failure that stopped the helper would stop it every time.
  await restoreSessions(store, paths).catch(error => console.error(`restore: ${error.stack}`));
  const stopSaving = startRegistrySaving(store, paths);
  const updater = startAutoUpdate(store, paths);
  const library = new Library(paths);
  fs.mkdirSync(paths.sdkDir, { recursive: true, mode: 0o700 });
  // Ready before the first time it's asked for. If this fails, the next request tries again.
  library.prepare().catch(error => console.error(`library: ${error.message}`));
  // Old uploads go now, and not while the helper runs, when a message might be on its way with one.
  pruneUploads(paths.uploads);
  pruneIncoming(paths.incoming);
  pruneStatus(paths.statusDir);
  const rexAccount = cachedAccount();
  await rexAccount.refresh();
  // Codex's sessions, if its server is running on this Mac. Nothing is started for it here.
  // A Codex session the helper starts or loads is shown in a terminal at the Mac too, unless a run says not to.
  const codex = new Codex({ store, terminal: process.env.VENES_CODEX_TERMINAL === 'off' ? undefined : resumeTerminal() });
  codex.restore().catch(error => console.error(`codex: ${error.message}`));
  // On Windows, what types into consoles is started now, so that a session's first hook finds it there.
  if (process.platform === 'win32') openConsoles().catch(() => {});
  // Antigravity's, each in a terminal as Claude Code's are, and told of by the hooks of a plugin put
  // where Antigravity finds it. A Mac with no Antigravity gets none.
  const antigravity = new Antigravity({ store, terminal: resumeTerminal(), account: paths.antigravityAccount });
  try {
    installHooks(paths.antigravityPlugin, { always: Boolean(process.env.VENES_AGY_CONFIG) });
  } catch (error) {
    console.error(`antigravity hooks: ${error.message}`);
  }
  const hookServer = createHookServer(store, antigravity);
  // What the agents have used, counted from their own chats and costed by a public list of prices.
  const usage = new UsageBook({ file: paths.usageFile, pricesFile: paths.pricesFile, prices: new Prices({ file: paths.pricesFile }) });
  // Terminal sessions: the ones whose shells went on while the helper didn't are followed again.
  const terminals = new Terminals({ store, root: paths.terminals, shellDir: paths.shellDir, terminal: resumeTerminal() });
  await terminals.restore().catch(error => console.error(`terminals: ${error.stack}`));
  const { server: clientServer, subscribers, heldTimer, stopWatching } = createClientServer(store, updater.check, library, paths, () => rexAccount.current, codex, antigravity, usage, terminals);
  const transcripts = followTranscripts(store, { every: TRANSCRIPT_POLL_MS });
  await listen(hookServer, paths.hookSocket);
  await listen(clientServer, paths.clientSocket);
  fs.writeFileSync(paths.pidFile, String(process.pid));

  return {
    store,
    // Settles once an SDK install or a read of what was used going on has ended too.
    stop() {
      const installing = library.stop();
      const reading = usage.stop();
      stopSaving();
      transcripts.stop();
      codex.stop();
      antigravity.stop();
      terminals.stop();
      updater.stop();
      clearInterval(heldTimer);
      stopWatching();
      for (const socket of subscribers) socket.destroy();
      hookServer.closeAllConnections();
      hookServer.close();
      clientServer.close();
      fs.rmSync(paths.pidFile, { force: true });
      return Promise.all([installing, reading]);
    },
  };
}
