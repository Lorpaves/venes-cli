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
import {
  MODE_IDS, REVIEW_COMMAND, REVIEW_NO, REVIEW_YES, asksTrust, asksWriteIn, hasTrustPicked, hasTyped, isIdle, isUp, readBar, questionOf, readPrompt, readReview, reviewsWaiting, showsDialog, showsPage,
} from './agyscreen.mjs';
import { mediaTypeOf, moveToTrash } from './files.mjs';
import { imageSize } from './imagesize.mjs';
import { checkedFolder } from './folders.mjs';
import { HelperError } from './errors.mjs';
import { choicesOf, chooseRow } from './prompt.mjs';
import { PAGE_KEYS, emptyBox, pageOf as openPageOf } from './terminal.mjs';
import { VERSION } from './version.mjs';
import { versionIn } from './agentcli.mjs';
import { computer } from './platform.mjs';

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
// A Mac has it there. Elsewhere it's wherever the system put it.
const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
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
// How long the box takes to show what a run of its keys did.
const BOX_SETTLE_MS = 120;
// A turn rarely leaves more than a document or two to look over.
const MOST_REVIEW_PRESSES = 12;
const KEY_LIMIT_MS = 2000;
const KEY_CHECK_MS = 50;
// A command of the terminal's own said what it did within a second when measured.
const COMMAND_LIMIT_MS = 6000;
// How long a command the reader sent is given to open its page or start its turn, as a Claude Code
// session's is, and how many times Esc is pressed to close a page that opened others.
const COMMAND_SETTLE_MS = 1500;
const PAGE_CLOSE_PRESSES = 3;
// How long the models Antigravity lists are kept, and how long it's given to list them.
const MODELS_LIFETIME_MS = 10 * 60_000;
const MODELS_LIMIT_MS = 20_000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join('|')})$`);
// As big a picture as is read for a client, as for a Codex session's.
const PICTURE_BYTES = 20 * 1024 * 1024;
// A picture's id, as a page is given it: whether it's one a call gave back or one a message came with,
// the step it's of, and which of that step's it is.
const PICTURE_ID = /^(step|said)-(\d+):(\d+)$/;

// How long Antigravity is given to go once it's told to, before a conversation of its is deleted. It
// had gone within a second when measured.
const QUIT_LIMIT_MS = 5000;
const QUIT_CHECK_MS = 100;
const VERSION_LIMIT_MS = 10_000;
// How long another writer of Antigravity's summary of its conversations is waited for.
const ROWS_WAIT_MS = 3000;

// How long a session just opened waits for the models Antigravity lists, to name the one its bar shows.
const MODELS_WAIT_MS = 5000;
// How long what Antigravity says of the account's limits is kept, how soon it's asked again after it
// wouldn't say, how long it's given to, and how long a status waits for it: it takes several seconds.
const USAGE_LIFETIME_MS = 3 * 60_000;
const USAGE_RETRY_MS = 30_000;
const USAGE_LIMIT_MS = 40_000;
const USAGE_WAIT_MS = 2500;
// The windows Antigravity's limits are for, by the names a status has for them.
const USAGE_WINDOWS = { '5h': 'fiveHour', weekly: 'sevenDay' };

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

// Where the command line keeps what it knows: its conversations, a transcript of each, a summary of
// them all, and its settings.
export const dataFolder = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli');
export const transcriptOf = (data, id) => path.join(data, 'brain', id, '.system_generated', 'logs', 'transcript_full.jsonl');

// Whether a terminal is running Antigravity now, as one a session was in is asked after the helper starts again.
export async function runsIn(terminal, where) {
  try {
    return PROGRAMS.has(await terminal.foreground(where));
  } catch {
    return false; // the terminal has gone
  }
}

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

// The account's limits, from what Antigravity's own `/usage` reports: the models share limits in
// groups, each with a limit for the week and one for five hours, or one of them. Each is told by its
// group's name, with how much of it is used, where Antigravity says how much is left, and when it starts again.
export function limitsFrom(report) {
  const groups = report?.command?.data?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.flatMap(group => (Array.isArray(group?.buckets) ? group.buckets : []).flatMap(bucket => {
    const left = bucket?.remaining_fraction;
    if (typeof group.name !== 'string' || !group.name || typeof left !== 'number' || !Number.isFinite(left)) return [];
    const at = Date.parse(bucket.reset_time);
    return [{
      name: group.name, ...(USAGE_WINDOWS[bucket.window] && { window: USAGE_WINDOWS[bucket.window] }),
      percent: Math.round((1 - Math.min(Math.max(left, 0), 1)) * 1000) / 10, ...(Number.isNaN(at) ? {} : { resetsAt: Math.floor(at / 1000) }),
    }];
  }));
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
// In plan mode Antigravity puts its own command before what's typed, "/plan ", and keeps the message
// and shows it that way. What was said is what follows it.
const PLAN_COMMAND = /^\/plan[ \t]+(?=\S)/;
export const saidOf = text => `${text ?? ''}`.replace(PLAN_COMMAND, '');
// What someone said, out of what Antigravity wraps it in for the model.
export const requestOf = content => (typeof content === 'string' ? saidOf((content.match(USER_REQUEST)?.[1] ?? content).trim()) : '');

const isUserStep = step => step.type === 'USER_INPUT';
const isReplyStep = step => step.type === 'PLANNER_RESPONSE';
// The step a call's result is written as: the ones after the reply that made the calls, in their order.
const resultIndex = (reply, at) => reply.step_index + 1 + at;
export const toolUseId = index => `step-${index}`;

// The pictures a message was sent with: the files its first lines name, where each is a picture that's
// there, as a client's attachments are typed at its head. With them, the message's own words.
export function saidPictures(text) {
  const lines = text.split('\n');
  const paths = [];
  for (const line of lines) {
    const named = line.trim();
    if (!path.isAbsolute(named) || !mediaTypeOf(named).startsWith('image/')) break;
    try {
      if (!fs.statSync(named).isFile()) break;
    } catch {
      break;
    }
    paths.push(named);
  }
  return { paths, rest: lines.slice(paths.length).join('\n') };
}

// Where a step's pictures are. A call that looked at a picture, or made one, has it as a file among the
// conversation's own, which its step names (`media`): only one inside `root`, where Antigravity keeps
// what's its own, is one. A message's are the files its first lines name.
export function pictureSourcesOf(step, root) {
  if (isUserStep(step)) return saidPictures(requestOf(step.content)).paths.map(file => ({ path: file, isSaid: true }));
  return (Array.isArray(step?.media) ? step.media : []).flatMap(media => {
    if (typeof media?.uri !== 'string' || !media.uri.startsWith('file://') || !`${media.mime_type}`.startsWith('image/')) return [];
    let file;
    try {
      file = path.resolve(decodeURIComponent(new URL(media.uri).pathname));
    } catch {
      return [];
    }
    return root && file.startsWith(path.resolve(root) + path.sep) ? [{ path: file, mediaType: media.mime_type }] : [];
  });
}

// A picture read for a client, or nothing when it has gone or is too big. One a message names has to be
// a picture by what's in it too, and not only by its name.
export function readPicture(source, { limit = PICTURE_BYTES } = {}) {
  try {
    if (fs.statSync(source.path).size > limit) return undefined;
    const data = fs.readFileSync(source.path).toString('base64');
    if (source.isSaid && !imageSize(data).width) return undefined;
    return { mediaType: source.mediaType ?? mediaTypeOf(source.path), data };
  } catch {
    return undefined; // gone, or out of reach
  }
}

// What a page is told of a step's pictures, as of a Claude Code session's: each by the id to ask for it
// by, its kind, how big it is, and its size in pixels where that can be told.
export function picturesOf(step, root) {
  const kind = isUserStep(step) ? 'said' : 'step';
  return pictureSourcesOf(step, root).flatMap((source, index) => {
    const picture = readPicture(source);
    if (!picture) return [];
    return [{ id: `${kind}-${step.step_index}:${index}`, mediaType: picture.mediaType, bytes: Math.floor(picture.data.length * 3 / 4), ...imageSize(picture.data) }];
  });
}

// A call as a client is told of it, in a Claude Code call's shape where it has one: its name, and what it was given.
// A document Antigravity writes for the reader to look over before it goes on, as the plan it writes
// in plan mode is (implementation_plan.md): it says so with the file, and waits for an answer to it.
export const PLAN_TOOL = 'ExitPlanMode';
export const asksReview = ({ name, args } = {}) => name === 'write_file' && args?.ArtifactMetadata?.RequestFeedback === true;
// Its own words for a yes, in the panel a document is answered in.
const REVIEW_OPTION = { id: 'approve', label: 'Approve' };

// What's asked about a document that waits: to approve it, which Antigravity goes on from, or not,
// with what to change said or not. `key` is the panel's key for the answer, where the panel is how
// it's given: what to change is typed as a message, which Antigravity plans again from.
export function reviewRequest(call, index) {
  return {
    fields: { kind: 'plan', agent: AGENT, toolName: PLAN_TOOL, toolUseId: toolUseId(index), input: { plan: call.args?.Content ?? '' }, options: [REVIEW_OPTION] },
    decide({ decision, option, message }) {
      if (decision === 'deny') {
        const said = typeof message === 'string' ? message.trim() : '';
        return said ? { followUp: said } : { key: REVIEW_NO };
      }
      if (decision !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${decision}`);
      if (option != null && option !== REVIEW_OPTION.id) throw new HelperError('bad_option', 'That choice isn\'t offered for this request. Choose again.');
      return { key: REVIEW_YES };
    },
  };
}

// The document that waits for an answer, from a conversation's steps: the last one written to be
// looked over, unless something's been said since, which is how it's answered.
export function reviewIn(steps) {
  const said = steps.findLastIndex(step => isUserStep(step));
  const calls = steps.slice(said + 1).flatMap(step => (step.tool_calls ?? []).map((call, at) => ({ call, index: resultIndex(step, at) })));
  return calls.findLast(({ call }) => asksReview(call));
}

export function toolOf({ name, args = {} } = {}) {
  const file = args.Path ?? args.AbsolutePath ?? args.TargetFile;
  switch (name) {
    case 'read_file':
    case 'view_file':
      return { name: 'Read', input: { file_path: file } };
    case 'write_file':
      // A document for the reader to look over first is told as Claude Code's own call that ends its
      // planning, which a client already shows as a proposed plan.
      if (asksReview({ name, args })) return { name: PLAN_TOOL, input: { plan: args.Content ?? '' } };
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
// message, or the end of it all, shows one. With `root`, where Antigravity keeps its own, a message
// and a call have their pictures too, and a message's words are then without the lines that named them.
export function historyOf(steps, { root = undefined } = {}) {
  const items = [];
  const calls = new Map();
  let hasReply = false;
  for (const step of steps) {
    if (isUserStep(step)) {
      if (hasReply) items.push({ role: 'turn_end' });
      hasReply = false;
      const text = requestOf(step.content);
      const images = root ? picturesOf(step, root) : [];
      items.push({ role: 'user', text: images.length ? saidPictures(text).rest : text, ...(images.length && { images }) });
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
      const images = root ? picturesOf(step, root) : [];
      Object.assign(call, { result: text || undefined, isError, ...(images.length && { images }) });
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

// What Antigravity keeps of a conversation in files, as its own picker's Delete takes them away (F4 in
// `/resume`, 1.5.8): the conversation itself, with what a database leaves beside it, the folder of its
// transcript and what it made, and its notes.
export function conversationFiles(data, id) {
  const conversation = path.join(data, 'conversations', `${id}.db`);
  return [conversation, `${conversation}-journal`, `${conversation}-wal`, `${conversation}-shm`, path.join(data, 'brain', id), path.join(data, 'annotations', `${id}.pbtxt`)];
}

// Takes a conversation out of Antigravity's summary of them all and out of what it searches, as its own
// Delete does. Its id is only letters, digits and hyphens, which `SESSION_ID` saw to.
async function dropRows(data, id) {
  const file = path.join(data, 'conversation_summaries.db');
  if (!fs.existsSync(file)) return;
  const sql = ['conversation_summaries', 'conversations_fts', 'conversation_parents'].map(table => `delete from ${table} where conversation_id = '${id}';`).join(' ');
  await exec(SQLITE, ['-cmd', `.timeout ${ROWS_WAIT_MS}`, file, sql], { timeout: 10_000 });
}

// What's deleted of a conversation goes to the Trash in one folder named for it, so that it can be put
// back. On a Mac with no way to the Trash from here it's deleted for good, as Antigravity's own Delete does.
async function trashFiles(files, id, trash = moveToTrash) {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-antigravity-'));
  try {
    const folder = path.join(staging, `Antigravity session ${id.slice(0, TERMINAL_ID_LENGTH)}`);
    fs.mkdirSync(folder);
    for (const file of files) fs.renameSync(file, path.join(folder, path.basename(file)));
    try {
      await trash(folder);
    } catch (error) {
      if (error.code !== 'no_trash') throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
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

// The commands a conversation in `folder` can be given, as Antigravity's protocol server lists them for a
// session made there: it says them unasked once the session is. Nothing is written down here of what they
// are, and nothing is said to a model. The session is an empty conversation, which is taken away again.
const COMMANDS_WAIT_MS = 5000;
const COMMANDS_KEPT_MS = 10 * 60_000;
const COMMANDS_RETRY_MS = 30_000;
async function listedCommands(folder, { data, forget, wait = COMMANDS_WAIT_MS }) {
  const link = await AcpLink.start(COMMAND, ['acp'], { cwd: folder, env: process.env, clientInfo: CLIENT });
  let sessionId;
  try {
    const listed = new Promise(resolve => {
      link.onNotification = message => {
        const update = message.params?.update;
        if (message.method === 'session/update' && update?.sessionUpdate === 'available_commands_update') resolve(update.availableCommands ?? []);
      };
    });
    ({ sessionId } = await link.request('session/new', { cwd: folder, mcpServers: [] }, { timeout: 30_000 }));
    return commandsFrom(await Promise.race([listed, pause(wait).then(() => [])]));
  } finally {
    link.close();
    if (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) {
      // Once the server has let go of its files.
      await pause(300);
      for (const file of conversationFiles(data, sessionId)) fs.rmSync(file, { recursive: true, force: true });
      await forget(sessionId).catch(() => {});
    }
  }
}

// A client's list of commands, from the protocol's: each by its name, with what it does and what it takes.
export function commandsFrom(listed) {
  return (Array.isArray(listed) ? listed : [])
    .filter(command => typeof command?.name === 'string' && /^[^\s/]+$/.test(command.name))
    .map(command => ({ name: command.name, description: String(command.description ?? '').trim(), argumentHint: String(command.input?.hint ?? '').trim() }));
}

// What `/usage` reports, asked of the command line itself with nothing said to a model: it prints it
// and quits, in the home folder, which it needn't trust for this.
async function usageReport() {
  const asked = exec(COMMAND, ['-p', '/usage', '--output-format', 'json'], { cwd: os.homedir(), timeout: USAGE_LIMIT_MS, maxBuffer: 1024 * 1024 });
  asked.child.stdin?.end();
  return JSON.parse((await asked).stdout);
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
    // The request made of a document that waits to be looked over, and how many looks found none waiting.
    review: undefined, reviewLooks: 0,
  };
}

export class Antigravity {
  #store;
  #terminal;
  #installed;
  #mint;
  #rows;
  #models;
  #readUsage;
  #trash;
  #forget;
  #kill;
  #version;
  #usage = { at: 0, limits: [], reading: undefined };
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
  #listCommands;
  #commands = new Map();

  constructor({
    store,
    // What a session's terminal is opened and worked with: none, and a session can be read and nothing more.
    terminal = undefined,
    installed = () => isInstalled(),
    mint = mintWith,
    data = dataFolder(),
    rows = () => storedRows(data),
    models = listedModels,
    // The commands a conversation in a folder can be given, asked of Antigravity itself.
    commands = undefined,
    usage = usageReport,
    // What a deleted conversation's files are moved to the Trash with, what takes it out of Antigravity's
    // own lists, and what tells Antigravity to go.
    trash = moveToTrash,
    forget = id => dropRows(data, id),
    kill = pid => process.kill(pid, 'SIGTERM'),
    // The version of Antigravity installed now.
    version = () => exec(COMMAND, ['--version'], { timeout: VERSION_LIMIT_MS }).then(({ stdout }) => versionIn(stdout)),
    env = process.env,
    timing = {},
  }) {
    this.#store = store;
    this.#terminal = terminal;
    this.#installed = installed;
    this.#mint = mint;
    this.#rows = rows;
    this.#models = models;
    this.#listCommands = commands ?? (folder => listedCommands(folder, { data, forget }));
    this.#readUsage = usage;
    this.#trash = trash;
    this.#forget = forget;
    this.#kill = kill;
    this.#version = version;
    this.#data = data;
    this.#env = env;
    this.#timing = {
      watch: WATCH_MS, rest: REST_CHECK_MS, startLimit: START_LIMIT_MS, startCheck: START_CHECK_MS, keySettle: KEY_SETTLE_MS,
      pasteSettle: PASTE_SETTLE_MS, stepWait: STEP_WAIT_MS, stepCheck: STEP_CHECK_MS, keyLimit: KEY_LIMIT_MS, keyCheck: KEY_CHECK_MS,
      commandLimit: COMMAND_LIMIT_MS, commandSettle: COMMAND_SETTLE_MS, modelsWait: MODELS_WAIT_MS, usageWait: USAGE_WAIT_MS, quitLimit: QUIT_LIMIT_MS, quitCheck: QUIT_CHECK_MS,
      boxSettle: BOX_SETTLE_MS, ...timing,
    };
    this.#timer = setInterval(() => this.#lookAtAll(), this.#timing.watch);
    this.#timer.unref();
  }

  get name() {
    return AGENT;
  }

  // At work while a turn goes on in it, or something waits on the reader.
  isBusy(sessionId) {
    const known = this.#store.find(sessionId);
    if (!known || known.status === 'ended') return false;
    return Boolean(this.#sessions.get(sessionId)?.turn) || known.status === 'running' || known.status === 'waiting' || this.#store.pendingFor(known).length > 0;
  }

  // The version of Antigravity a session runs: the one installed when it was first seen, since
  // Antigravity updates itself while it runs.
  runningVersion(sessionId) {
    return this.#sessions.get(sessionId)?.cliVersion;
  }

  // Restarts a session so that it runs the Antigravity installed now: the one open on it is told to go,
  // and it's opened again in a terminal, as a stored session is.
  async restartNow(sessionId) {
    await this.#quit(sessionId, this.#store.find(sessionId));
    const cwd = await this.folderOf(sessionId);
    if (!cwd) throw new HelperError('unknown_session', `No session ${sessionId}`);
    const folder = fs.existsSync(cwd) ? cwd : os.homedir();
    const target = await this.#open(sessionId, folder, { trust: isTrusted(folder, this.#data) });
    const known = this.#adopt(sessionId, cwd, target, 'resume');
    this.#session(sessionId).cliVersion = await this.#version().catch(() => undefined);
    await this.#readBar(known);
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
    if (!this.#sessions.has(id)) {
      const session = blankSession();
      this.#sessions.set(id, session);
      this.#version().then(version => { session.cliVersion ??= version; }, () => {});
    }
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

  // Where Antigravity keeps what's its own, the command line's beside the desktop app's: a picture a
  // step names is read only from in here.
  get #root() {
    return path.dirname(this.#data);
  }

  // The transcript a hook names, where it's one of Antigravity's own: in the folder its apps keep
  // theirs in, the command line's beside the desktop app's. Any other file is none of the helper's to read.
  #namedTranscript(file) {
    if (typeof file !== 'string' || !file.endsWith('.jsonl')) return undefined;
    const resolved = path.resolve(file);
    return resolved.startsWith(this.#root + path.sep) ? resolved : undefined;
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
    if (this.#sessions.has(sessionId)) return true;
    // Not by what Antigravity's summary lists: a deleted conversation can still have a row there.
    return SESSION_ID.test(sessionId) && fs.existsSync(path.join(this.#data, 'conversations', `${sessionId}.db`));
  }

  // The conversations Antigravity has stored, newest first, for the library's first page. One with a
  // session of its own going says what it's doing. One with nothing said in it isn't listed.
  async library() {
    if (!this.#installed()) return [];
    const rows = await this.#rows();
    this.#listed = new Map(rows.map(row => [row.conversation_id, row]));
    // A conversation whose file has gone was deleted, whatever Antigravity's summary still says of it.
    const isThere = row => fs.existsSync(path.join(this.#data, 'conversations', `${row.conversation_id}.db`));
    return rows.filter(row => this.#isLive(row.conversation_id) || (row.step_count > 0 && isThere(row))).map(row => {
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
    // As Antigravity kept it, and as it was said: in plan mode those aren't the same.
    const kept = typeof payload.lastUserInput === 'string' ? payload.lastUserInput : '';
    const said = saidOf(kept.trim());
    // Whatever started the turn, a document that waited has been answered, or left behind.
    this.#closeReview(id, session);
    session.typed = session.typed.filter(typed => Date.now() - typed.at < TYPED_LIFETIME_MS);
    const steps = this.#steps(id);
    session.turn = { id: crypto.randomUUID(), messages: 0 };
    session.seen = Number.isInteger(payload.initialNumSteps) ? payload.initialNumSteps : steps.length;
    // Antigravity goes on by itself when something it left running ends. The step before the call to
    // the model is then something other than what someone said, and nothing new was said.
    const last = steps.find(step => step.step_index === session.seen - 1);
    if (!last || isUserStep(last)) {
      const at = session.typed.findIndex(typed => sameWords(typed.typed, said) || sameWords(typed.typed, kept));
      const [mine] = at >= 0 ? session.typed.splice(at, 1) : [];
      const text = mine?.text ?? said;
      this.#store.report(id, 'message.user', {
        text, ...(mine?.clientId && { clientId: mine.clientId }), ...(mine?.attachments?.length ? { attachments: mine.attachments.map(shownUpload) } : {}),
      }, { lastPrompt: text });
      // The pictures it came with, as a Claude Code session tells of a message's.
      const images = last ? picturesOf(last, this.#root) : [];
      if (images.length) this.#store.report(id, 'message.images', { images });
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
    // What it looked at, or made, as a Claude Code session tells of a tool's pictures.
    const images = step ? picturesOf(step, this.#root) : [];
    if (images.length) this.#store.report(id, 'tool.images', { toolUseId: toolUseId(index), images });
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
    // A document it wrote to be looked over is asked about once the screen says it waits, which is
    // a moment after the turn's end.
    session.settlesAt = Date.now() + SETTLE_MS;
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
      // One that only waits for a document to be looked over is at rest: nothing's going on in its terminal.
      const isAtWork = Boolean(session.turn) || known.status === 'running' || (known.status === 'waiting' && !session.review);
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
    // While an answer is being written on a question's own line, the question is as good as answered: it
    // isn't asked again from under whoever is writing, here or at the terminal.
    const prompt = asksWriteIn(screen) ? undefined : readPrompt(screen);
    const bar = readBar(screen);
    this.#noteBar(id, bar);
    if (session.turn) this.#tell(id, session);
    this.#notePrompt(id, session, known, prompt);
    this.#noteReview(id, session, screen);
    // Waiting for a message, twice over and with no hook since: the turn was stopped.
    const isAtWork = Boolean(session.turn) || known.status === 'running' || (known.status === 'waiting' && !session.review);
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
    const question = questionOf(prompt);
    if (question) {
      this.#askQuestion(id, session, known, prompt, question);
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

  // What the model asks the reader, with rows to choose from, is asked of them as a question Claude asks
  // is: the same card, answered by one of its rows or in words of their own. The answer is pressed in the
  // terminal as a person there would press it: the row's number, or the row that opens a line to write on
  // and then the words. Left unanswered, it's skipped with Esc, as the terminal's own line offers.
  #askQuestion(id, session, known, prompt, question) {
    const header = question.count > 1 ? `Question ${question.index}/${question.count}` : 'Question';
    const { request, decision } = this.#store.ask(id, {
      kind: 'question', agent: AGENT, toolName: 'AskUserQuestion',
      input: { questions: [{ question: question.text, header, options: question.rows.map(row => ({ label: row.label })), multiSelect: false }] },
    }, ({ decision: answer, answers }) => {
      if (answer === 'deny') return { skip: true };
      if (answer !== 'allow') throw new HelperError('bad_decision', `Unknown decision: ${answer}`);
      const said = answers?.[question.text];
      if (typeof said !== 'string' || !said.trim()) throw new HelperError('missing_answers', 'Choose an answer first.');
      const row = question.rows.find(found => found.label === said);
      if (row) return { row };
      if (!question.writeIn) throw new HelperError('bad_option', 'That choice isn\'t offered for this question. Choose again.');
      return { row: question.writeIn, text: said.trim() };
    });
    session.asked = { requestId: request.id, prompt };
    decision.then(answer => {
      if (!answer?.row && !answer?.skip) return;
      if (session.asked?.requestId === request.id) session.asked = undefined;
      session.lastPrompt = undefined;
      const read = target => this.#terminal.readScreen(target);
      const press = (target, key) => this.#terminal.pressKey(target, key);
      this.#inLine(id, async () => {
        if (answer.skip) {
          if (questionOf(readPrompt(await read(known)))) await press(known, 'Escape');
          return;
        }
        if (answer.text === undefined) {
          await chooseRow(known, answer.row, { parse: readPrompt, read, press });
          return;
        }
        // Its number opens the line to write on, which is waited for before anything is typed.
        if (!questionOf(readPrompt(await read(known)))) return;
        await press(known, String(answer.row.number));
        for (const end = Date.now() + this.#timing.keyLimit; Date.now() < end; await pause(this.#timing.keyCheck)) {
          if (asksWriteIn(await read(known).catch(() => ''))) break;
        }
        if (!asksWriteIn(await read(known).catch(() => ''))) return;
        await this.#terminal.paste(known, answer.text);
        await pause(this.#timing.pasteSettle);
        await press(known, 'Enter');
      }).catch(() => {});
    });
  }

  // A document Antigravity wrote to be looked over, as its plan in plan mode, waits behind a line on
  // the screen and nothing else: no hook tells of it, and no prompt opens. So while the session rests
  // with that line showing, the document is asked about, as a plan is: the last one the conversation
  // has that nothing's been said since. It's asked once, and again if the helper starts over.
  #noteReview(id, session, screen) {
    if (session.turn || !isIdle(screen)) return;
    const waits = reviewsWaiting(screen) > 0;
    if (session.review) {
      // Twice without the line, it was answered or put away at the Mac, with no turn to say so.
      session.reviewLooks = waits ? 0 : session.reviewLooks + 1;
      if (session.reviewLooks >= 2) {
        this.#closeReview(id, session);
        this.#store.report(id, 'session.status', { status: 'idle' });
      }
      return;
    }
    const found = waits ? reviewIn(this.#steps(id)) : undefined;
    if (!found) return;
    const { fields, decide } = reviewRequest(found.call, found.index);
    const { request, decision } = this.#store.ask(id, fields, decide);
    session.review = request.id;
    session.reviewLooks = 0;
    decision.then(async answer => {
      if (session.review === request.id) session.review = undefined;
      const known = this.#typable(id);
      if (!known) return;
      let isSent = false;
      try {
        // Answered where a person at the Mac answers it, so Antigravity does all it does for that.
        if (answer?.key) isSent = await this.#inLine(id, () => this.#answerReview(known, answer.key));
        else if (answer?.followUp) {
          await this.deliver(known, { text: answer.followUp });
          isSent = true;
        }
      } catch (error) {
        // What goes wrong in line is said there.
        if (!answer?.key) console.error(`antigravity ${id}: ${error.message}`);
      }
      // With nothing sent and no turn going, the session is at rest, where the turn left it.
      if (!isSent && !session.turn) this.#store.report(id, 'session.status', { status: 'idle' });
    });
  }

  // The request's answered somewhere else, as in the panel at the Mac.
  #closeReview(id, session) {
    const requestId = session.review;
    session.review = undefined;
    session.reviewLooks = 0;
    if (requestId) this.#store.settle(requestId, { decision: 'unknown', by: 'terminal' });
  }

  // Opens the panel the documents are answered in, and presses its key for the answer for each that
  // waits, until the panel has gone, which is when Antigravity takes the answer and starts on it.
  async #answerReview(known, key) {
    const read = () => this.#terminal.readScreen(known).catch(() => '');
    const until = async test => {
      for (const end = Date.now() + this.#timing.commandLimit; Date.now() < end; await pause(this.#timing.keyCheck)) {
        const found = test(await read());
        if (found) return found;
      }
      return undefined;
    };
    if (showsDialog(await read())) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
    await this.#emptyBox(known);
    await this.#terminal.paste(known, REVIEW_COMMAND);
    await pause(this.#timing.pasteSettle);
    await this.#terminal.pressKey(known, 'Enter');
    let panel = await until(readReview);
    if (!panel) {
      // Whatever opened instead is put away, and the box cleared of what was typed.
      await this.#terminal.pressKey(known, 'Escape').catch(() => {});
      throw new HelperError('review_failed', 'The terminal didn\'t open its review as expected, so nothing was answered.');
    }
    for (let presses = 0; panel && presses < MOST_REVIEW_PRESSES; presses++) {
      const { left } = panel;
      await this.#terminal.pressKey(known, key);
      // One fewer to answer, or the panel gone with the last of them.
      const after = await until(screen => { const now = readReview(screen); return !now || now.left < left ? { now } : undefined; });
      if (!after) throw new HelperError('review_failed', 'The terminal didn\'t take the answer as expected.');
      panel = after.now;
    }
    this.#session(known.id).lastHookAt = Date.now();
    return true;
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
    // A document that waits to be looked over leaves the terminal free: a message can be typed past it,
    // and the mode switched, as at the Mac.
    const pending = this.#store.pendingFor(known).find(request => request.id !== this.#session(known.id).review);
    if (pending) throw new HelperError('request_pending', 'Answer the open request first.', { requestId: pending.id });
    const screen = await this.#terminal.readScreen(known);
    if (showsDialog(screen) || readReview(screen)) throw new HelperError('dialog_open', 'A dialog is open in the terminal.');
  }

  // Empties the box of whatever's typed in it, as a draft left at the Mac, so that what's typed next is
  // all that's sent and not added to it. The keys are the box's own, and do nothing to an empty one.
  #emptyBox(known) {
    return emptyBox(known, async () => hasTyped(await this.#terminal.readScreen(known).catch(() => '')), {
      press: (target, key) => this.#terminal.pressKey(target, key), settle: this.#timing.boxSettle,
    });
  }

  // Opens Antigravity's terminal on a conversation, and waits until it's ready for a message. It asks
  // first about a folder it doesn't trust, and the reader's word, given in the app, answers that here.
  async #open(sessionId, cwd, { trust = false } = {}) {
    if (!this.#terminal) throw new HelperError('no_tmux', `Install tmux or Rex on your ${computer} to run this session.`);
    const name = `${TERMINAL_PREFIX}${sessionId.slice(0, TERMINAL_ID_LENGTH)}`;
    const variables = Object.fromEntries(TERMINAL_ENV.filter(key => this.#env[key]).map(key => [key, this.#env[key]]));
    // The terminal the helper opened on it before may still be there with Antigravity in it, as after the
    // helper has started again and before the session's next hook. A second one on the same conversation
    // would be two of Antigravity writing to it, so that one is gone back to.
    const open = await this.#terminal.findSession?.(name, variables);
    if (open && this.#terminal.foreground && await runsIn(this.#terminal, open)) return open;
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
    if (!this.#installed()) throw new HelperError('no_antigravity', `Antigravity isn't on this ${computer}.`);
    if (!this.#terminal) throw new HelperError('no_tmux', `Install tmux or Rex on your ${computer} to run this session.`);
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

  async send({ sessionId, text, clientId, lane, attachments = [], pages = false }) {
    const known = await this.#live(sessionId);
    const message = { clientId, text, lane: lane ?? 'next', attachments, pages: pages === true };
    // A turn takes nothing more once it's going: what's sent meanwhile waits for its end.
    if (this.#session(sessionId).turn || this.#store.isBusy(known) || this.#store.pendingFor(known).length) {
      this.#store.hold(known, message);
      return { queued: true };
    }
    const opened = await this.deliver(known, message);
    return { queued: false, ...(opened === 'page' && { page: true }) };
  }

  // A message is typed into the terminal, and starts a turn when Antigravity says so. A command is one too,
  // and can open a page there instead, as /model does its list: 'page' then, for a client that can show one.
  async deliver(known, { text, clientId, attachments = [], pages = false }) {
    this.#withPane(known);
    const session = this.#session(known.id);
    if (session.turn) throw new HelperError('send_failed', 'Antigravity is still answering the last message.');
    const typed = typedText(text, attachments);
    if (!typed.trim()) throw new HelperError('bad_text', 'Nothing to send.');
    // A line that starts with a slash is a command of the terminal's. One with a file before it isn't one:
    // the file's path is what it starts with.
    const isCommand = !attachments.length && typeof text === 'string' && text.trimStart().startsWith('/');
    await this.#refuseIfOpen(known);
    const entry = { typed, text, clientId, attachments, at: Date.now() };
    session.typed.push(entry);
    try {
      await this.#emptyBox(known);
      await this.#terminal.paste(known, typed);
      await pause(this.#timing.pasteSettle);
      // A command's own list opens as it's typed, for Enter to take the command from: nothing in the way.
      if (!isCommand) await this.#refuseIfOpen(known);
      await this.#terminal.pressKey(known, 'Enter');
    } catch (error) {
      session.typed = session.typed.filter(found => found !== entry);
      throw error;
    }
    if (isCommand) {
      const left = await this.#afterCommand(known, session, pages);
      if (left === 'page') {
        // What's picked on the page is the terminal's doing, and no turn will tell of this line.
        session.typed = session.typed.filter(found => found !== entry);
        return left;
      }
      // A command that only printed something leaves the terminal waiting, with no turn to wait for. The
      // line stays known as the client's, for a turn that's slow to start.
      if (left !== 'turn') return undefined;
    }
    // Until its hook says the turn has started, so that nothing else is typed behind it.
    this.#store.report(known.id, 'session.status', { status: 'running' });
    session.lastHookAt = Date.now();
    return undefined;
  }

  // What a command the reader sent has left: a 'turn', as a command that's a message to a model starts;
  // a 'page' that it opened in the terminal, for a client that can show one, which any other is refused,
  // with the page closed again; or nothing, as a command that only prints something leaves.
  async #afterCommand(known, session, pages) {
    let screen = '';
    for (const end = Date.now() + this.#timing.commandSettle; Date.now() < end; await pause(this.#timing.keyCheck)) {
      if (session.turn) return 'turn';
      screen = await this.#terminal.readScreen(known).catch(() => '');
      if (showsPage(screen)) break;
    }
    if (session.turn) return 'turn';
    if (showsPage(screen)) {
      if (pages) return 'page';
      await this.#closePage(known);
      throw new HelperError('terminal_only', 'That command only works at the terminal.');
    }
    return isIdle(screen) ? undefined : 'turn';
  }

  // Esc, for as long as a page is what's open: with nothing open it would stop a turn.
  async #closePage(known) {
    for (let press = 0; press < PAGE_CLOSE_PRESSES; press++) {
      if (!showsPage(await this.#terminal.readScreen(known).catch(() => ''))) return;
      await this.#terminal.pressKey(known, 'Escape');
      await pause(this.#timing.keySettle);
    }
  }

  // What a command opened in the session's terminal, to see and work from afar, as a Claude Code session's
  // is: null when nothing is.
  async page({ sessionId }) {
    const known = this.#withPane(await this.#live(sessionId));
    if (!showsPage(await this.#terminal.readScreen(known))) return { page: null };
    const read = this.#terminal.readStyledScreen ?? this.#terminal.readScreen;
    // Down to the line that says how to move in it: the bar under that is the terminal's own, not the page's.
    const screen = (await read(known)).trimEnd();
    const bar = screen.lastIndexOf('\n');
    return { page: openPageOf(bar < 0 ? screen : screen.slice(0, bar), () => true) };
  }

  // A key for what's open, and nothing else: with nothing open, Esc would stop the turn and Enter would
  // send what's in the box.
  async pageKey({ sessionId, key }) {
    if (!PAGE_KEYS.includes(key)) throw new HelperError('bad_key', `${key} isn't a key a page takes.`);
    const known = this.#withPane(await this.#live(sessionId));
    if (!showsPage(await this.#terminal.readScreen(known))) throw new HelperError('no_page', 'Nothing is open in the terminal.');
    await this.#terminal.pressKey(known, key);
    return {};
  }

  // Text for a page's search box.
  async pageText({ sessionId, text }) {
    if (typeof text !== 'string' || !text) throw new HelperError('bad_text', 'Nothing to type.');
    const known = this.#withPane(await this.#live(sessionId));
    if (!showsPage(await this.#terminal.readScreen(known))) throw new HelperError('no_page', 'Nothing is open in the terminal.');
    await this.#terminal.paste(known, text);
    return {};
  }

  // Closes what's open, as the reader leaves it.
  async pageClose({ sessionId }) {
    await this.#closePage(this.#withPane(await this.#live(sessionId)));
    return {};
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
    await this.#emptyBox(known);
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

  // The models on offer, and the commands a conversation in the session's folder can be given. Both are
  // asked of Antigravity, and neither is written down here.
  async capabilities({ sessionId } = {}) {
    if (!this.#installed()) return { commands: [], models: [], skills: [] };
    const folder = this.#store.find(sessionId)?.cwd ?? os.homedir();
    const [commands, models] = await Promise.all([this.#knownCommands(folder), this.#knownModels()]);
    return { commands, models, skills: [] };
  }

  // A folder's commands, asked once and kept a while: asking makes a conversation and takes it away again,
  // which isn't done for every list a client draws. What couldn't be asked is asked again soon.
  #knownCommands(folder) {
    const kept = this.#commands.get(folder);
    if (kept && Date.now() - kept.at < (kept.failed ? COMMANDS_RETRY_MS : COMMANDS_KEPT_MS)) return kept.list;
    const entry = { at: Date.now(), failed: false };
    entry.list = Promise.resolve().then(() => this.#listCommands(folder)).catch(error => {
      console.error(`antigravity commands: ${error.message}`);
      entry.failed = true;
      return [];
    });
    this.#commands.set(folder, entry);
    return entry.list;
  }

  // The account's limits, as Antigravity last reported them. It's asked again once that's a few minutes
  // old, and a status waits only a moment for it: the first can come with a later one.
  async #limits() {
    const kept = this.#usage;
    if (Date.now() - kept.at > USAGE_LIFETIME_MS) {
      kept.reading ??= Promise.resolve().then(() => this.#readUsage()).then(
        report => { Object.assign(kept, { at: Date.now(), limits: limitsFrom(report) }); },
        () => { kept.at = Date.now() - USAGE_LIFETIME_MS + USAGE_RETRY_MS; },
      ).finally(() => { kept.reading = undefined; });
      await Promise.race([kept.reading, pause(this.#timing.usageWait)]);
    }
    return kept.limits;
  }

  // The account's limits for a list of what's used, as a status sheet has them, and `reading` while
  // they're being asked for: the first read takes Antigravity a while, and comes with a later ask.
  // Nothing where Antigravity isn't installed.
  async limits() {
    if (!this.#installed()) return undefined;
    const limits = (await this.#limits()) ?? [];
    return { limits, reading: Boolean(this.#usage.reading), ...(limits.length && { updatedAt: Math.floor(this.#usage.at / 1000) }) };
  }

  // What a status sheet shows of a session the helper follows, and nothing for one it doesn't: what it
  // runs on, where, and every limit the account has, as Antigravity's own `/usage` lists them.
  async status({ sessionId }) {
    const known = this.#store.find(sessionId);
    if (!known) return { status: null };
    const limits = this.#installed() ? await this.#limits() : [];
    return {
      status: {
        model: known.model, effort: known.effort, project: known.cwd ? path.basename(known.cwd) : undefined,
        ...(limits.length && { limits }), updatedAt: Math.floor(Date.now() / 1000),
      },
    };
  }

  // What was said before the turn going on: the steps before the message that started it.
  #past(sessionId) {
    const steps = this.#steps(sessionId);
    if (!this.#sessions.get(sessionId)?.turn) return historyOf(steps, { root: this.#root });
    const start = steps.findLastIndex(isUserStep);
    return historyOf(start >= 0 ? steps.slice(0, start) : steps, { root: this.#root });
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

  // Tells the Antigravity that has a conversation open in a terminal the helper can reach to go: the
  // session's own terminal, or the one the helper opened on it before. Left running, it would write
  // the conversation back.
  async #quit(sessionId, known) {
    if (!this.#terminal?.processOf) return;
    const name = `${TERMINAL_PREFIX}${sessionId.slice(0, TERMINAL_ID_LENGTH)}`;
    const variables = Object.fromEntries(TERMINAL_ENV.filter(key => this.#env[key]).map(key => [key, this.#env[key]]));
    const where = known?.pane ? known : await this.#terminal.findSession?.(name, variables);
    if (!where) return;
    const running = await this.#terminal.processOf(where).catch(() => undefined);
    if (!running || !PROGRAMS.has(running.name)) return;
    if (running.pid) {
      try {
        this.#kill(running.pid);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error; // it has just gone by itself
      }
    }
    for (const end = Date.now() + this.#timing.quitLimit; ; await pause(this.#timing.quitCheck)) {
      if (!(await runsIn(this.#terminal, where))) return;
      if (Date.now() >= end) throw new HelperError('session_running', 'This session wouldn\'t stop, so it hasn\'t been deleted.');
    }
  }

  // Deletes a conversation from this Mac, as Antigravity's own picker does: its files, and its place in
  // Antigravity's lists. One that's open in a terminal is quit first. The files go to the Trash.
  async remove({ sessionId }) {
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new HelperError('unknown_session', `No session ${sessionId}`);
    const known = this.#typable(sessionId);
    const files = () => conversationFiles(this.#data, sessionId).filter(file => fs.existsSync(file));
    if (!known && !files().length && !this.#store.find(sessionId)) throw new HelperError('unknown_session', `No session ${sessionId}`);
    await this.#quit(sessionId, known);
    const left = files();
    if (left.length) await trashFiles(left, sessionId, this.#trash);
    // Its file is what says a conversation is there, so a row that stays behind lists nothing.
    await this.#forget(sessionId).catch(error => { console.error(`antigravity: ${sessionId} is still in Antigravity's own lists: ${error.message}`); });
    this.#sessions.delete(sessionId);
    this.#listed.delete(sessionId);
    this.#store.forget(sessionId);
    return {};
  }

  // A picture of a conversation's, by the id a page was given for it: read where its step says it is.
  image({ sessionId, imageId }) {
    const [, , index, which] = PICTURE_ID.exec(String(imageId)) ?? [];
    const step = index === undefined ? undefined : this.#steps(sessionId).find(found => found.step_index === Number(index));
    const source = step && String(imageId).startsWith(isUserStep(step) ? 'said-' : 'step-') ? pictureSourcesOf(step, this.#root)[Number(which)] : undefined;
    const picture = source && readPicture(source);
    if (!picture) throw new HelperError('unknown_image', 'This image is no longer there.');
    return picture;
  }
}
