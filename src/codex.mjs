// Codex sessions. Codex has a server of its own for its clients, which its desktop app, its editor
// extension and its remote control all go through, and it keeps one running on this Mac as a daemon.
// The helper is one more client of that daemon: a session here is a thread there, and everything
// comes and goes as that server's own messages, with nothing typed into a terminal or read off one.
// A thread on the daemon can have several clients at once, so `codex --remote unix://` at the Mac
// and a phone can work the same session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CodexLink } from './codexlink.mjs';
import { checkedFolder } from './folders.mjs';
import { HelperError } from './errors.mjs';
import { mediaTypeOf } from './files.mjs';
import { imageSize } from './imagesize.mjs';
import { isImage } from './uploads.mjs';
import { VERSION } from './version.mjs';

const exec = promisify(execFile);

export const AGENT = 'codex';
const CLIENT = { name: 'venes', title: 'Venes', version: VERSION };
const DAEMON_START_MS = 30_000;
// The models on offer change with a Codex release, not by the minute.
const MODELS_LIFETIME_MS = 5 * 60_000;
const DEFAULT_HISTORY_LIMIT = 50;
// As big a picture as is read for a page. A bigger one isn't shown.
const PICTURE_BYTES = 20 * 1024 * 1024;
// The pictures kept track of for a session, and the sessions they're kept for, so that a client can ask
// for one by the id a page gave it.
const KEPT_PICTURES = 200;
const KEPT_PICTURE_THREADS = 50;
// Turns asked for at a time, while a page of history fills. A turn can be hundreds of items long, so
// it's a few, and a page is whole turns either way.
const TURNS_PER_READ = 5;
// The turns a thread's events are kept track of by, which is more than the event log can hold of one session's.
const TURNS_TRACKED = 32;
// The stored threads listed with the library's first page.
const LISTED_THREADS = 100;
// A connection that drops is tried again this often, this many times, before its sessions are taken to be over.
const RECONNECT_MS = 1000;
const RECONNECT_TRIES = 5;
// The kinds of thread a person started: Codex's terminal, its apps and editors, and clients such as this.
const LISTED_SOURCES = ['cli', 'vscode', 'appServer', 'unknown'];

// Whether Codex's command is on the PATH.
export function isInstalled(env = process.env) {
  return (env.PATH ?? '').split(':').some(dir => {
    try {
      fs.accessSync(path.join(dir, 'codex'), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// Where Codex's daemon listens, as Codex itself finds it.
export function controlSocket(env = process.env) {
  return env.VENES_CODEX_SOCKET || path.join(codexHome(env), 'app-server-control', 'app-server-control.sock');
}

const codexHome = (env = process.env) => env.CODEX_HOME || path.join(os.homedir(), '.codex');

// The folders Codex's config says it trusts: each a `[projects."<path>"]` table with a trust level of trusted.
export function trustedFolders(config) {
  const trusted = [];
  for (const table of config.split(/^(?=\[)/m)) {
    const header = /^\[projects\."((?:[^"\\]|\\.)*)"\]/.exec(table);
    if (header && /^trust_level\s*=\s*"trusted"/m.test(table)) trusted.push(header[1].replace(/\\(.)/g, '$1'));
  }
  return trusted;
}

// Whether Codex already trusts a folder: itself, or the repository it's in. Its terminal asks before
// it works in any other, and its server asks nothing and trusts it from then on, so the helper asks.
export function isTrustedByCodex(folder, { config = undefined, home = codexHome(), exists = fs.existsSync } = {}) {
  let text = config;
  if (text === undefined) {
    try {
      text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
    } catch {
      return false;
    }
  }
  const trusted = new Set(trustedFolders(text));
  if (trusted.has(folder)) return true;
  for (let above = folder; ; above = path.dirname(above)) {
    if (exists(path.join(above, '.git'))) return trusted.has(above);
    if (above === path.dirname(above)) return false;
  }
}

// The items that are the conversation itself, and the notes Codex keeps of a subagent's comings and
// goings, which its own calls to that subagent already tell. Every other kind is something Codex did,
// which a client shows as a tool call named after the kind.
const TALK = new Set([
  'userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt', 'functionCallOutput', 'contextCompaction', 'enteredReviewMode', 'exitedReviewMode',
  'subAgentActivity',
]);
export const isTool = item => !TALK.has(item.type);
const isFailed = item => item.status === 'failed' || item.status === 'declined';

// A line the reader ran with `!`, which Codex keeps as a command of the reader's own, and not its own doing.
export const isShellLine = item => item.type === 'commandExecution' && item.source === 'userShell';

// The words of a command line, as a shell would take it apart: quotes taken off, and what a backslash
// keeps, kept.
export function shellWords(text) {
  const words = [];
  let word;
  let quote;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (quote === '\'') {
      if (char === '\'') quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && '"\\$`\n'.includes(text[at + 1])) word += text[++at];
      else word += char;
    } else if (char === '\'' || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === '\\' && at + 1 < text.length) word = (word ?? '') + text[++at];
    else if (/\s/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? '') + char;
  }
  if (word !== undefined) words.push(word);
  return words;
}

// The command as the reader typed it. Codex runs it as a login shell's script, and gives it wrapped
// that way: `/bin/zsh -lc 'ls'`.
export function unwrapped(command) {
  const words = shellWords(command);
  return words.length === 3 && words[1] === '-lc' && /(^|\/)(zsh|bash|sh)$/.test(words[0]) ? words[2] : command;
}

// A `data:` address as a picture, its kind and its bytes in base64. Anything else is undefined: an
// address on the web isn't fetched from here.
function dataPicture(url) {
  const [, mediaType, data] = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(typeof url === 'string' ? url : '') ?? [];
  return data ? { mediaType, data } : undefined;
}

// The pictures an item has, each as where it is on this Mac or as what it is: those a message came
// with, the one Codex looked at, the one it made, and those a tool gave back.
export function pictureSourcesOf(item) {
  const fromData = url => { const found = dataPicture(url); return found ? [found] : []; };
  switch (item?.type) {
    case 'userMessage':
      return (item.content ?? []).flatMap(part => {
        if (part?.type === 'localImage') return typeof part.path === 'string' ? [{ path: part.path }] : [];
        return part?.type === 'image' ? fromData(part.url) : [];
      });
    case 'imageView':
      return typeof item.path === 'string' ? [{ path: item.path }] : [];
    case 'imageGeneration':
      if (typeof item.savedPath === 'string') return [{ path: item.savedPath }];
      return typeof item.result === 'string' && item.result ? [{ mediaType: 'image/png', data: item.result }] : [];
    case 'mcpToolCall':
      return (Array.isArray(item.result?.content) ? item.result.content : [])
        .flatMap(part => (part?.type === 'image' && typeof part.data === 'string' && part.data ? [{ mediaType: part.mimeType ?? 'image/png', data: part.data }] : []));
    case 'dynamicToolCall':
      return (item.contentItems ?? []).flatMap(part => (part?.type === 'inputImage' ? fromData(part.imageUrl) : []));
    default:
      return [];
  }
}

// A picture from its source: its kind and its bytes. A file is read where it is, when its name is a
// picture's and it's no bigger than is shown. Undefined for one that has gone.
export function readPicture(source, { limit = PICTURE_BYTES } = {}) {
  if (source.data) return { mediaType: source.mediaType, data: source.data };
  const mediaType = mediaTypeOf(source.path);
  if (!mediaType.startsWith('image/')) return undefined;
  try {
    if (fs.statSync(source.path).size > limit) return undefined;
    return { mediaType, data: fs.readFileSync(source.path).toString('base64') };
  } catch {
    return undefined; // gone, or out of reach
  }
}

// What a page is told of an item's pictures, as of a Claude Code session's: each by the id to ask for
// it by, its kind, how big it is, and its size in pixels where that can be told. `keep` hears each
// one's source by that id.
export function picturesOf(item, keep = undefined) {
  return pictureSourcesOf(item).flatMap((source, index) => {
    const picture = readPicture(source);
    if (!picture) return [];
    const id = `${item.id}:${index}`;
    keep?.(id, source);
    return [{ id, mediaType: picture.mediaType, bytes: Math.floor(picture.data.length * 3 / 4), ...imageSize(picture.data) }];
  });
}

// An item as a page is given it: without the bytes of its pictures, which are asked for one at a time.
export function withoutPictures(item) {
  if (item?.type === 'mcpToolCall' && Array.isArray(item.result?.content)) {
    return { ...item, result: { ...item.result, content: item.result.content.map(part => (part?.type === 'image' ? { ...part, data: undefined } : part)) } };
  }
  if (item?.type === 'dynamicToolCall' && Array.isArray(item.contentItems)) {
    return { ...item, contentItems: item.contentItems.map(part => (part?.type === 'inputImage' ? { ...part, imageUrl: undefined } : part)) };
  }
  if (item?.type === 'imageGeneration' && item.result) return { ...item, result: undefined };
  return item;
}

// What a message says, without what came with it.
export function textOf(content = []) {
  return content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}

export function thinkingOf(item) {
  const parts = item.summary?.length ? item.summary : item.content ?? [];
  return parts.join('\n\n').trim();
}

// A thread a person started, and not one Codex made for itself, as a subagent's is.
export function isListed(thread) {
  return !thread.ephemeral && !thread.parentThreadId && typeof thread.source === 'string' && thread.source !== 'exec' && !thread.source.startsWith('subAgent');
}

// A message's text and files as Codex takes them: a picture as an image, and any other file by its
// path at the head of the text, as someone at the terminal would name it.
export function inputOf(text, attachments = []) {
  const pictures = attachments.filter(upload => upload.kind === 'image' || isImage(upload.mediaType));
  const files = attachments.filter(upload => !pictures.includes(upload));
  const said = [...files.map(upload => upload.path), text].filter(Boolean).join('\n');
  return [
    ...pictures.map(upload => ({ type: 'localImage', path: upload.path })),
    ...(said ? [{ type: 'text', text: said, text_elements: [] }] : []),
  ];
}

// The skills Codex has on in a folder, as its server lists them: each by the name a `$` calls it by,
// with the short line that says what it's for, and where it is, which is how a turn names one.
export function skillsOf(data = [], cwd = undefined) {
  const entry = data.find(found => found.cwd === cwd) ?? data[0];
  return (entry?.skills ?? []).filter(skill => skill.enabled !== false && typeof skill.name === 'string' && skill.name).map(skill => ({
    name: skill.name, description: `${skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description ?? ''}`.split('\n')[0].trim(),
    path: skill.path,
  }));
}

// The skills a message names with `$`, each once, in the order named. A `$` in the middle of a word,
// as in a shell variable's `${HOME}` or a price, names nothing, and neither does a name that's no skill's.
export function skillsNamed(text, skills = []) {
  const named = [];
  for (const [, name] of `${text ?? ''}`.matchAll(/(?<![\w$])\$([A-Za-z0-9][\w:.-]*)/g)) {
    // A sentence's full stop or colon after the name isn't part of it.
    const skill = skills.find(found => found.name === name) ?? skills.find(found => found.name === name.replace(/[.:-]+$/, ''));
    if (skill && !named.includes(skill)) named.push(skill);
  }
  return named;
}

const shownUpload = ({ uploadId, name, mediaType, size }) => ({ uploadId, name, mediaType, size });

// A stored turn, as history has it. `keep` hears where each of its pictures is, by the id an item has for it.
export function historyOf(turn, keep = undefined) {
  const at = turn.startedAt ? new Date(turn.startedAt * 1000).toISOString() : undefined;
  const items = [];
  // A turn that's nothing but lines run with `!` has no reply to wait for, and no end of its own to tell.
  const isShellTurn = (turn.items ?? []).length > 0 && turn.items.every(isShellLine);
  for (const item of turn.items ?? []) {
    if (isShellLine(item)) {
      items.push({ role: 'user', at, text: `!${unwrapped(item.command)}`, shell: true });
      items.push({ role: 'output', at, stdout: item.aggregatedOutput ?? '', stderr: '', replies: !isShellTurn });
    } else if (item.type === 'userMessage') {
      const images = picturesOf(item, keep);
      items.push({ role: 'user', at, text: textOf(item.content), ...(item.clientId && { clientId: item.clientId }), ...(images.length && { images }) });
    } else if (item.type === 'agentMessage') {
      if (item.text) items.push({ role: 'assistant', at, text: item.text, ...(item.phase && { phase: item.phase }) });
    } else if (item.type === 'reasoning') {
      const text = thinkingOf(item);
      if (text) items.push({ role: 'thinking', at, text });
    } else if (item.type === 'contextCompaction') items.push({ role: 'compact', at, trigger: 'auto' });
    else if (isTool(item)) {
      const images = picturesOf(item, keep);
      const shown = withoutPictures(item);
      items.push({ role: 'tool', at, toolUseId: item.id, name: item.type, input: shown, result: shown, isError: isFailed(item), ...(images.length && { images }) });
    }
  }
  if (turn.status === 'interrupted') items.push({ role: 'system', at, kind: 'interrupted' });
  else if (!isShellTurn && (turn.status === 'completed' || turn.status === 'failed')) items.push({ role: 'turn_end', at, durationMs: turn.durationMs ?? undefined });
  return items;
}

export function libraryItem(thread, status = null) {
  return {
    id: thread.id, title: thread.name || thread.preview || undefined, cwd: thread.cwd,
    lastActiveAt: thread.updatedAt * 1000, startedAt: thread.createdAt * 1000, status, agent: AGENT,
  };
}

// The commands of Codex's terminal that its server can carry out, each named and described as the
// terminal has it (0.153.4). The rest are the terminal's own doing, as its pickers and its settings are,
// and a client has its own ways to those: the model, the mode, the status.
export const COMMANDS = [
  { name: 'compact', description: 'summarize conversation to prevent hitting the context limit', argumentHint: '' },
  { name: 'review', description: 'review my current changes and find issues', argumentHint: '[instructions]' },
  { name: 'init', description: 'create an AGENTS.md file with instructions for Codex', argumentHint: '' },
  { name: 'rename', description: 'rename the current thread', argumentHint: '<name>' },
];

// What the terminal sends Codex for /init, word for word (codex-rs/tui/prompt_for_init_command.md).
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.
`;

// A line that's one of those commands, with what follows its name. Any other line that starts with a
// slash, as a path does, is a message like any other.
export function commandOf(text) {
  const [, name, argument = ''] = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(`${text ?? ''}`.trim()) ?? [];
  return COMMANDS.some(command => command.name === name) ? { name, argument: argument.trim() } : undefined;
}

// What a session may do without asking, as the three choices Codex's own terminal gives under
// /permissions (0.153.4): Read Only, Default and Full Access, each an approval policy and a sandbox.
const MODES = {
  readOnly: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly' } },
  workspace: { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } },
  fullAccess: { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } },
};
export const MODE_IDS = Object.keys(MODES);
// Settings that are none of the three, as from a config of the reader's own.
export const CUSTOM_MODE = 'custom';

// The command that opens Codex's terminal on a thread its server has: another client of the same thread,
// which shows what's said from anywhere and can say things itself. It takes the thread as it is: Codex
// refuses a sandbox or an approval policy given with it ("Permission overrides are not supported when
// resuming a remote task", 0.169.0).
export const terminalCommand = (socketPath, threadId) => ['codex', '--remote', `unix://${socketPath}`, 'resume', threadId];

// Which of the choices a thread's settings are, or nothing when they aren't told.
export function modeOf({ approvalPolicy, sandbox } = {}) {
  if (typeof approvalPolicy !== 'string' && typeof approvalPolicy !== 'object') return undefined;
  if (!sandbox?.type) return undefined;
  const found = MODE_IDS.find(id => MODES[id].approvalPolicy === approvalPolicy && MODES[id].sandboxPolicy.type === sandbox.type);
  // Read Only and Default leave the network off, which a thread with it on isn't.
  return found && !(found !== 'fullAccess' && sandbox.networkAccess === true) ? found : CUSTOM_MODE;
}

export function modelsOf(models = []) {
  return models.filter(model => !model.hidden).map(model => ({
    value: model.id, displayName: model.displayName, description: model.description, resolvedModel: model.model,
    effortLevels: (model.supportedReasoningEfforts ?? []).map(effort => effort.reasoningEffort),
    ...(model.isDefault && { isDefault: true }),
  }));
}

// What Codex's own terminal calls each way of saying yes past the plain one (0.153.4).
const decisionKey = decision => (typeof decision === 'string' ? decision : Object.keys(decision)[0]);
function decisionLabel(decision, toolName) {
  const key = decisionKey(decision);
  if (key === 'acceptForSession') {
    return toolName === 'fileChange' ? 'Yes, and don\'t ask again for these files' : 'Yes, and don\'t ask again for this command in this session';
  }
  if (key === 'acceptWithExecpolicyAmendment') {
    const prefix = (decision.acceptWithExecpolicyAmendment?.execpolicy_amendment ?? []).join(' ');
    return `Yes, and don't ask again for commands that start with \`${prefix}\``;
  }
  if (key === 'applyNetworkPolicyAmendment' && decision.applyNetworkPolicyAmendment?.network_policy_amendment?.action === 'allow') {
    return 'Yes, and allow this host in the future';
  }
  return undefined;
}

const badDecision = decision => new HelperError('bad_decision', `Unknown decision: ${decision}`);
const badOption = () => new HelperError('bad_option', 'That choice isn\'t offered for this request. Choose again.');

// A request to run a command or change files, for a client to answer. Yes is Codex's plain accept,
// `options` are its other ways of saying yes, and no is the way its terminal says it: the turn stops,
// for the reader to say what to do instead, which `message` can already be.
export function approvalRequest(toolName, params, item) {
  const offered = params.availableDecisions ?? ['accept', 'acceptForSession', 'cancel'];
  const byKey = new Map(offered.map(decision => [decisionKey(decision), decision]));
  const options = offered.map(decision => ({ id: decisionKey(decision), label: decisionLabel(decision, toolName) })).filter(option => option.label);
  const { threadId, turnId, ...input } = params;
  return {
    fields: { kind: 'permission', agent: AGENT, toolName, toolUseId: params.itemId, input: { ...input, ...(item?.changes && { changes: item.changes }) }, options },
    decide({ decision, option, message }) {
      if (decision === 'deny') {
        const said = typeof message === 'string' ? message.trim() : '';
        return { result: { decision: byKey.has('cancel') || !byKey.has('decline') ? 'cancel' : 'decline' }, ...(said && { followUp: said }) };
      }
      if (decision !== 'allow') throw badDecision(decision);
      if (option == null) return { result: { decision: 'accept' } };
      if (!options.some(offer => offer.id === option)) throw badOption();
      return { result: { decision: byKey.get(option) } };
    },
  };
}

// Codex asking for more room than its sandbox gives: for this turn, or for as long as the session runs.
export function permissionsRequest(params) {
  const { threadId, turnId, ...input } = params;
  return {
    fields: {
      kind: 'permission', agent: AGENT, toolName: 'permissions', toolUseId: params.itemId, input,
      options: [{ id: 'session', label: 'Yes, grant these permissions for this session' }],
    },
    decide({ decision, option }) {
      if (decision === 'deny') return { result: { permissions: {}, scope: 'turn' } };
      if (decision !== 'allow') throw badDecision(decision);
      if (option != null && option !== 'session') throw badOption();
      return { result: { permissions: params.permissions, scope: option === 'session' ? 'session' : 'turn' } };
    },
  };
}

// Codex's questions, in the shape Claude Code's are in, which a client already shows. Answers come
// keyed by a question's words, and go back keyed by its id.
export function questionRequest(params) {
  const questions = (params.questions ?? []).map(question => ({
    question: question.question, header: question.header, options: question.options ?? [], multiSelect: false,
    id: question.id, isOther: question.isOther === true, isSecret: question.isSecret === true,
  }));
  return {
    fields: { kind: 'question', agent: AGENT, toolName: 'requestUserInput', toolUseId: params.itemId, input: { questions } },
    decide({ decision, answers }) {
      if (decision === 'deny') return { result: { answers: {} } };
      if (decision !== 'allow') throw badDecision(decision);
      const missing = questions.filter(question => !answers?.[question.question]).map(question => question.question);
      if (missing.length) throw new HelperError('missing_answers', 'Every question needs an answer.', { missing });
      return { result: { answers: Object.fromEntries(questions.map(question => [question.id, { answers: [String(answers[question.question])] }])) } };
    },
  };
}

const REQUESTS = {
  'item/commandExecution/requestApproval': (params, item) => approvalRequest('commandExecution', params, item),
  'item/fileChange/requestApproval': (params, item) => approvalRequest('fileChange', params, item),
  'item/permissions/requestApproval': params => permissionsRequest(params),
  'item/tool/requestUserInput': params => questionRequest(params),
};

// The turns some of a session's events are of, so that history doesn't tell them again: the one the
// first of them is in, and every one after. A turn that just ended still counts as going on to a
// client that joins, and the next can have started by then.
export function turnsOf(events, turnStarts = []) {
  if (!events.length) return new Set();
  const [{ seq: first }] = events;
  const within = turnStarts.findLastIndex(turn => turn.after < first);
  return new Set(turnStarts.slice(Math.max(within, 0)).map(turn => turn.id));
}

const statusOf = status => (status?.type === 'active' ? (status.activeFlags?.length ? 'waiting' : 'running') : 'idle');

// How long Codex's word on the account's limits is good for, between its own notices of them.
const LIMITS_LIFETIME_MS = 60_000;
const FIVE_HOURS_MINS = 5 * 60;
const SEVEN_DAYS_MINS = 7 * 24 * 60;

// What a status sheet shows of a Codex session, in the shape Claude Code's status line is kept in: what
// it runs on, where, how full its context is after its last reply, and how much of the account's two
// limits is used. Codex has no status line, and says all of this itself.
export function statusLineOf({ session, usage, limits, branch, at = Date.now() }) {
  const windowOf = minutes => [limits?.primary, limits?.secondary].find(found => found?.windowDurationMins === minutes);
  const limit = found => found && { percent: found.usedPercent, ...(found.resetsAt && { resetsAt: found.resetsAt }) };
  const used = usage?.last?.totalTokens;
  const size = usage?.modelContextWindow;
  const [fiveHour, sevenDay] = [limit(windowOf(FIVE_HOURS_MINS)), limit(windowOf(SEVEN_DAYS_MINS))];
  return {
    model: session.model, effort: session.effort, project: session.cwd ? path.basename(session.cwd) : undefined, branch: branch ?? undefined,
    ...(used !== undefined && size ? { context: { percent: Math.round((used / size) * 1000) / 10, used, size } } : {}),
    ...(fiveHour && { fiveHour }), ...(sevenDay && { sevenDay }),
    updatedAt: Math.floor(at / 1000),
  };
}

// What a terminal opened on a thread is called at the Mac, and what it's given of the helper's own surroundings.
const TERMINAL_PREFIX = 'venes-codex-';
const TERMINAL_ID_LENGTH = 8;
const TERMINAL_ENV = ['PATH', 'LANG', 'LC_ALL', 'CODEX_HOME', 'VENES_TMUX_SOCKET'];

function blankThread() {
  return {
    isSubscribed: false, turnId: undefined, messages: new Map(), tools: new Map(), items: new Set(), sent: new Map(), requests: new Map(),
    // The lines run with `!` that were sent and haven't started, and the ones running, each with its send.
    shells: [], lines: new Map(),
    // The latest turns, each with the last event before it began, to tell which turns some events are of.
    turnStarts: [],
  };
}

export class Codex {
  #store;
  #socketPath;
  #connect;
  #startDaemon;
  #link;
  #opening;
  #threads = new Map();
  // Where each session's pictures are, by the ids its pages were given for them.
  #pictures = new Map();
  // Whether an id is a thread of Codex's, for the sessions the helper hasn't heard from.
  #owned = new Map();
  #cursors = new Map();
  #nextCursor = 1;
  #models;
  // What a reader chose a session to run on, until the turn that takes it.
  #chosen = new Map();
  // The account's limits as Codex last gave them, and when.
  #limits;
  #retry;
  #retryMs;
  #trusts;
  #installed;
  #terminal;
  #env;
  #skills = new Map();
  #isStopped = false;

  constructor({
    store, socketPath = controlSocket(), connect = CodexLink.connect,
    startDaemon = () => exec('codex', ['app-server', 'daemon', 'start'], { timeout: DAEMON_START_MS, cwd: os.homedir() }),
    retryMs = RECONNECT_MS, trusts = isTrustedByCodex,
    // Told where to look, as a test run is, there's a Codex only if something listens there.
    installed = () => !process.env.VENES_CODEX_SOCKET && isInstalled(),
    // What opens a terminal at the Mac, as for a Claude Code session that's resumed: none, and no session gets one.
    terminal = undefined, env = process.env,
  }) {
    this.#terminal = terminal;
    this.#env = env;
    this.#installed = installed;
    this.#retryMs = retryMs;
    this.#trusts = trusts;
    this.#store = store;
    this.#socketPath = socketPath;
    this.#connect = connect;
    this.#startDaemon = startDaemon;
  }

  get name() {
    return AGENT;
  }

  // The sessions already on the daemon when the helper starts, if it's running.
  async restore() {
    await this.#open({ start: false }).catch(() => {});
  }

  stop() {
    this.#isStopped = true;
    clearTimeout(this.#retry);
    this.#link?.close();
  }

  // Whether there's a Codex on this Mac to start a session with: its daemon is up, or its command is there
  // to start it.
  isAvailable() {
    return fs.existsSync(this.#socketPath) || this.#installed();
  }

  // Whether a session is Codex's. One the helper has heard from says so itself, and any other is asked
  // of the daemon, if it's running, once.
  async owns(sessionId) {
    if (typeof sessionId !== 'string') return false;
    const known = this.#store.find(sessionId);
    if (known) return known.agent === AGENT;
    if (this.#owned.has(sessionId)) return this.#owned.get(sessionId);
    const link = await this.#open({ start: false }).catch(() => undefined);
    if (!link) return false;
    try {
      await link.request('thread/read', { threadId: sessionId, includeTurns: false });
      this.#owned.set(sessionId, true);
      return true;
    } catch (error) {
      // Codex saying it has no such thread is an answer. A connection that dropped isn't one.
      if (error.rpcCode !== undefined) this.#owned.set(sessionId, false);
      return false;
    }
  }

  // The connection to the daemon, made when it's first wanted. `start` starts the daemon if it isn't
  // running, which is for someone who asked for Codex, and not for a list that could do without.
  async #open({ start }) {
    if (this.#link?.isOpen) return this.#link;
    this.#opening ??= this.#openNow(start).finally(() => { this.#opening = undefined; });
    return this.#opening;
  }

  async #openNow(start) {
    let link;
    try {
      link = await this.#connect(this.#socketPath, CLIENT);
    } catch (error) {
      if (!start) throw error;
      try {
        await this.#startDaemon();
        link = await this.#connect(this.#socketPath, CLIENT);
      } catch (failure) {
        const isMissing = failure.code === 'ENOENT';
        throw new HelperError('no_codex', isMissing ? 'Codex isn\'t installed on this Mac.' : `Codex's server didn't start: ${failure.message}`);
      }
    }
    link.on('notification', message => {
      try { this.#onNotification(message); } catch (error) { console.error(`codex ${message.method}: ${error.stack}`); }
    });
    link.on('request', message => {
      try { this.#onRequest(link, message); } catch (error) { console.error(`codex ${message.method}: ${error.stack}`); }
    });
    link.on('close', () => this.#onClose(link));
    this.#link = link;
    await this.#adoptLoaded(link).catch(error => console.error(`codex: ${error.message}`));
    return link;
  }

  // The daemon went, or only the connection did. Its threads are still there in the second case, so
  // it's tried again before the sessions are said to be over.
  #onClose(link, tries = RECONNECT_TRIES) {
    if (this.#link === link) this.#link = undefined;
    // What was asked over it can't be answered over it. Codex asks again once its thread is joined again.
    for (const [threadId, thread] of this.#threads) {
      thread.isSubscribed = false;
      thread.requests.clear();
      this.#store.settleAll(threadId, { decision: 'unknown', by: 'session_end' });
    }
    if (this.#isStopped) return;
    const live = () => this.#store.liveSessions().filter(session => session.agent === AGENT);
    if (!live().length) return;
    this.#retry = setTimeout(() => {
      this.#open({ start: false }).catch(() => {
        if (tries > 1) this.#onClose(undefined, tries - 1);
        else for (const session of live()) this.#store.report(session.id, 'session.ended', { reason: 'disconnected' });
      });
    }, this.#retryMs);
    this.#retry.unref();
  }

  // Every thread the daemon has in memory is a session going on, whoever started it. One it no longer
  // has is over.
  async #adoptLoaded(link) {
    const { data: loaded = [] } = await link.request('thread/loaded/list', {});
    for (const session of this.#store.liveSessions()) {
      if (session.agent === AGENT && !loaded.includes(session.id)) this.#store.report(session.id, 'session.ended', { reason: 'closed' });
    }
    for (const threadId of loaded) {
      const read = await link.request('thread/read', { threadId, includeTurns: false }).catch(() => undefined);
      if (read?.thread && isListed(read.thread)) {
        this.#adopt(read.thread);
        await this.#subscribe(link, threadId).catch(() => {});
      }
    }
  }

  #adopt(thread, extra = {}) {
    this.#owned.set(thread.id, true);
    if (!this.#threads.has(thread.id)) this.#threads.set(thread.id, blankThread());
    this.#threads.get(thread.id).branch = thread.gitInfo?.branch ?? undefined;
    const known = this.#store.find(thread.id);
    this.#store.adopt(thread.id, {
      agent: AGENT, permissionModes: MODE_IDS, cwd: thread.cwd, model: thread.model ?? known?.model, effort: thread.reasoningEffort ?? known?.effort,
      startedAt: thread.createdAt ? thread.createdAt * 1000 : known?.startedAt, lastPrompt: known?.lastPrompt ?? (thread.preview || undefined), ...extra,
    });
    this.#store.report(thread.id, 'session.status', { status: statusOf(thread.status) });
    return this.#threads.get(thread.id);
  }

  // Joins a thread the daemon has in memory, to hear all of it. One that has had no turn yet has
  // nothing to join, and is joined when its first turn starts.
  async #subscribe(link, threadId) {
    const thread = this.#threads.get(threadId);
    if (!thread || thread.isSubscribed) return;
    const joined = await link.request('thread/resume', { threadId, excludeTurns: true });
    thread.isSubscribed = true;
    // Joined part way through a turn, what's heard of that turn from here on isn't all of it.
    thread.isPartial = joined.thread?.status?.type === 'active' && !thread.turnId;
    this.#noteSettings(threadId, { model: joined.model, effort: joined.reasoningEffort, approvalPolicy: joined.approvalPolicy, sandbox: joined.sandbox });
  }

  #noteSettings(threadId, { model, effort, approvalPolicy, sandbox }) {
    const session = this.#store.find(threadId);
    if (!session) return;

    if (model) this.#store.report(threadId, 'session.model', { model });
    if (effort && effort !== session.effort) this.#store.report(threadId, 'session.effort', { effort }, { effort });
    // A mode picked from here and not taken yet, which Codex does with the next turn, is the one to show.
    const mode = this.#chosen.get(threadId)?.approvalPolicy ? undefined : modeOf({ approvalPolicy, sandbox });
    if (mode && mode !== session.permissionMode) this.#noteMode(threadId, mode);
  }

  // A session the helper started or loaded has no terminal, where every Claude Code session is in one:
  // Codex's server runs it. So Codex's own terminal is opened on it at the Mac, for whoever goes there,
  // once the thread has a turn, which is when another of Codex's clients can join it. Once for a thread.
  async #showAtMac(threadId, thread) {
    if (!thread.wantsTerminal || thread.hasTerminal || !this.#terminal) return;
    thread.hasTerminal = true;
    const session = this.#store.find(threadId);
    const variables = Object.fromEntries(TERMINAL_ENV.filter(key => this.#env[key]).map(key => [key, this.#env[key]]));
    try {
      await this.#terminal.startSession({
        name: `${TERMINAL_PREFIX}${threadId.slice(0, TERMINAL_ID_LENGTH)}`, cwd: session?.cwd ?? os.homedir(),
        command: terminalCommand(this.#socketPath, threadId), env: variables,
      });
    } catch (error) {
      // The session goes on without one, as it did before there were any.
      console.error(`codex: no terminal for ${threadId}: ${error.message}`);
    }
  }

  #noteMode(threadId, permissionMode) {
    this.#store.report(threadId, 'session.mode', { permissionMode, permissionModes: MODE_IDS }, { permissionMode });
  }

  #onNotification({ method, params = {} }) {
    // The account's, and so every session's.
    if (method === 'account/rateLimits/updated') {
      this.#limits = { at: Date.now(), snapshot: params.rateLimits };
      return;
    }
    const threadId = params.threadId ?? params.thread?.id;
    if (method === 'thread/started') {
      if (isListed(params.thread)) {
        this.#adopt(params.thread);
        this.#store.report(threadId, 'session.started', { source: 'startup', model: params.thread.model, cwd: params.thread.cwd });
        // One loaded from what's stored can be joined now. A new one can't until its first turn.
        if (this.#link) this.#subscribe(this.#link, threadId).catch(() => {});
      }
      return;
    }
    const thread = this.#threads.get(threadId);
    const session = thread && this.#store.find(threadId);
    if (!thread || !session) return;
    const report = (kind, data, fields) => this.#store.report(threadId, kind, data, fields);
    switch (method) {
      case 'thread/status/changed':
        if (params.status?.type === 'notLoaded') this.#end(threadId, 'closed');
        else {
          if (session.status === 'ended') this.#store.adopt(threadId);
          // Told by the turn itself for a thread that's joined, and only by this for one that isn't yet.
          if (!thread.isSubscribed) {
            report('session.status', { status: statusOf(params.status) });
            if (params.status?.type === 'active' && this.#link) this.#subscribe(this.#link, threadId).catch(() => {});
          }
        }
        break;
      case 'thread/closed':
        this.#end(threadId, 'closed');
        break;
      case 'thread/deleted':
      case 'thread/archived':
        this.#forget(threadId);
        break;
      case 'thread/settings/updated':
        this.#noteSettings(threadId, {
          model: params.threadSettings?.model, effort: params.threadSettings?.effort, approvalPolicy: params.threadSettings?.approvalPolicy,
          sandbox: params.threadSettings?.sandboxPolicy,
        });
        break;
      case 'thread/tokenUsage/updated':
        thread.usage = params.tokenUsage;
        break;
      case 'turn/started':
        this.#showAtMac(threadId, thread);
        thread.turnId = params.turn?.id;
        thread.turnStarts.push({ id: thread.turnId, after: this.#store.seq });
        if (thread.turnStarts.length > TURNS_TRACKED) thread.turnStarts.shift();
        thread.isPartial = false;
        // A line run with `!` is a turn of its own to Codex, with nothing at work in it, so a turn is
        // only said to be running once something other than such a line is in it.
        thread.isShellTurn = true;
        break;
      case 'item/started':
        this.#onItemStarted(threadId, thread, params);
        break;
      case 'item/agentMessage/delta': {
        this.#atWork(threadId, thread);
        const message = this.#messageOf(thread, params.itemId);
        report('message.assistant.delta', {
          messageId: params.itemId, turnId: params.turnId, index: message.index++, text: params.delta, final: false, ...(message.phase && { phase: message.phase }),
        });
        break;
      }
      case 'item/completed':
        this.#onItemCompleted(threadId, thread, params);
        break;
      case 'turn/plan/updated':
        report('plan.updated', { explanation: params.explanation ?? undefined, plan: params.plan ?? [] });
        break;
      case 'turn/completed':
        this.#onTurnCompleted(threadId, thread, params.turn ?? {});
        break;
      case 'serverRequest/resolved': {
        // Answered by another client of the thread, as Codex's own terminal is one.
        const requestId = thread.requests.get(params.requestId);
        thread.requests.delete(params.requestId);
        if (requestId) this.#store.settle(requestId, { decision: 'unknown', by: 'terminal' });
        break;
      }
      default:
        break;
    }
  }

  // The turn has more in it than lines run with `!`, so Codex is at work.
  #atWork(threadId, thread) {
    if (!thread.isShellTurn) return;
    thread.isShellTurn = false;
    this.#store.report(threadId, 'session.status', { status: 'running' });
  }

  // A line run with `!`, from here or from Codex's own terminal: the line as it was typed, and then what
  // it printed. Codex answers it only when it ran during a turn, whose reply then takes it in.
  #onShellStarted(threadId, thread, item) {
    if (thread.lines.has(item.id)) return;
    const command = unwrapped(item.command);
    const sent = thread.shells.findIndex(line => line.command === command);
    const clientId = sent >= 0 ? thread.shells.splice(sent, 1)[0].clientId : undefined;
    thread.lines.set(item.id, { clientId });
    const text = `!${command}`;
    this.#store.report(threadId, 'message.user', { text, clientId, shell: true }, { lastPrompt: text });
  }

  #onShellCompleted(threadId, thread, item) {
    this.#onShellStarted(threadId, thread, item);
    const { clientId } = thread.lines.get(item.id);
    thread.lines.delete(item.id);
    this.#store.report(threadId, 'message.output', {
      stdout: item.aggregatedOutput ?? '', stderr: '', replies: !thread.isShellTurn, ...(clientId && { clientId }),
    });
  }

  #messageOf(thread, itemId, phase) {
    if (!thread.messages.has(itemId)) thread.messages.set(itemId, { index: 0, phase: phase ?? undefined });
    return thread.messages.get(itemId);
  }

  // A message joins the conversation once, whichever of its two notices comes first. One sent from a
  // client has the send's id, and its files as the client named them. One typed elsewhere has neither.
  #onUserMessage(threadId, thread, item) {
    if (thread.items.has(item.id)) return;
    thread.items.add(item.id);
    const sent = item.clientId ? thread.sent.get(item.clientId) : undefined;
    if (item.clientId) thread.sent.delete(item.clientId);
    const text = sent?.text ?? textOf(item.content);
    // The message a review opens with has no send of its own to name: it stands for the /review that asked for it.
    const clientId = item.clientId ?? thread.reviewOf ?? undefined;
    thread.reviewOf = undefined;
    this.#store.report(threadId, 'message.user', {
      text, clientId, ...(sent?.attachments.length ? { attachments: sent.attachments } : {}),
    }, { lastPrompt: text });
    // The pictures it came with, as a Claude Code session tells of a message's.
    const images = picturesOf(item, this.#keeping(threadId));
    if (images.length) this.#store.report(threadId, 'message.images', { images });
  }

  // What keeps where a session's pictures are, the latest of them, for `image` to find one by its id.
  #keeping(threadId) {
    return (id, source) => {
      const kept = this.#pictures.get(threadId) ?? new Map();
      // Told of again, a session's pictures are the newest kept, and so is the session.
      this.#pictures.delete(threadId);
      this.#pictures.set(threadId, kept);
      kept.delete(id);
      kept.set(id, source);
      while (kept.size > KEPT_PICTURES) kept.delete(kept.keys().next().value);
      while (this.#pictures.size > KEPT_PICTURE_THREADS) this.#pictures.delete(this.#pictures.keys().next().value);
    };
  }

  // A picture of a session's, by the id a page was given for it.
  image({ sessionId, imageId }) {
    const source = this.#pictures.get(sessionId)?.get(String(imageId));
    const picture = source && readPicture(source);
    if (!picture) throw new HelperError('unknown_image', 'This image is no longer there.');
    return picture;
  }

  #onItemStarted(threadId, thread, { item }) {
    if (isShellLine(item)) {
      this.#onShellStarted(threadId, thread, item);
      return;
    }
    this.#atWork(threadId, thread);
    if (item.type === 'userMessage') this.#onUserMessage(threadId, thread, item);
    else if (item.type === 'agentMessage') this.#messageOf(thread, item.id, item.phase);
    else if (item.type === 'contextCompaction') this.#store.report(threadId, 'compact.start', { trigger: thread.compactsByHand ? 'manual' : 'auto' });
    else if (isTool(item)) this.#startTool(threadId, thread, item);
  }

  #startTool(threadId, thread, item) {
    thread.tools.set(item.id, { name: item.type, item, at: Date.now() });
    this.#store.report(threadId, 'tool.start', { toolUseId: item.id, name: item.type, input: withoutPictures(item) });
  }

  #onItemCompleted(threadId, thread, { item, turnId }) {
    const report = (kind, data, fields) => this.#store.report(threadId, kind, data, fields);
    if (isShellLine(item)) {
      this.#onShellCompleted(threadId, thread, item);
      return;
    }
    this.#atWork(threadId, thread);
    if (item.type === 'userMessage') this.#onUserMessage(threadId, thread, item);
    else if (item.type === 'agentMessage') {
      const message = this.#messageOf(thread, item.id, item.phase);
      thread.messages.delete(item.id);
      // All of it, for a message whose pieces never came, as when it was joined part way.
      const text = message.index === 0 ? item.text ?? '' : '';
      const phase = item.phase ?? message.phase;
      report('message.assistant.delta', { messageId: item.id, turnId, index: message.index, text, final: true, ...(phase && { phase }) },
        phase === 'commentary' ? undefined : { lastMessage: item.text });
    } else if (item.type === 'reasoning') {
      const text = thinkingOf(item);
      if (text) report('message.thinking', { text });
    } else if (item.type === 'contextCompaction') {
      report('compact.end', { trigger: thread.compactsByHand ? 'manual' : 'auto' });
      thread.compactsByHand = false;
    } else if (isTool(item)) {
      // Some kinds are only said once they're done.
      if (!thread.tools.has(item.id)) this.#startTool(threadId, thread, item);
      const { at } = thread.tools.get(item.id);
      thread.tools.delete(item.id);
      report('tool.end', { toolUseId: item.id, name: item.type, response: withoutPictures(item), durationMs: item.durationMs ?? Date.now() - at, isError: isFailed(item) });
      // What it showed, or looked at, as a Claude Code session tells of a tool's pictures.
      const images = picturesOf(item, this.#keeping(threadId));
      if (images.length) report('tool.images', { toolUseId: item.id, images });
    }
  }

  #onTurnCompleted(threadId, thread, turn) {
    const session = this.#store.find(threadId);
    const report = (kind, data) => this.#store.report(threadId, kind, data);
    const isInterrupted = turn.status === 'interrupted';
    // One that was nothing but lines run with `!` was never said to be running, and has no end to tell.
    const isShellTurn = thread.isShellTurn === true && !isInterrupted;
    thread.isShellTurn = false;
    thread.lines.clear();
    thread.turnId = undefined;
    thread.isPartial = false;
    thread.messages.clear();
    this.#store.settleAll(threadId, { decision: isInterrupted ? 'deny' : 'unknown', by: isInterrupted ? 'terminal' : 'turn_end' });
    thread.requests.clear();
    // What was still going when the turn stopped won't say how it ended.
    for (const [toolUseId, { name }] of thread.tools) report('tool.end', { toolUseId, name, isError: true, interrupted: true });
    thread.tools.clear();
    report('session.status', { status: 'idle' });
    if (isShellTurn) return;
    if (isInterrupted) report('turn.interrupted', {});
    else if (turn.status === 'failed') report('turn.error', { error: turn.error?.message, details: turn.error?.additionalDetails ?? turn.error?.codexErrorInfo ?? undefined });
    else report('turn.end', { lastMessage: session?.lastMessage, backgroundTasks: 0, tasks: [] });
    const { followUp } = thread;
    thread.followUp = undefined;
    if (followUp && session) this.deliver(session, { text: followUp }).catch(error => console.error(`codex follow-up: ${error.message}`));
  }

  // Codex asks every client of a thread, and takes the first answer. The others are told it's settled.
  #onRequest(link, { id, method, params = {} }) {
    const thread = this.#threads.get(params.threadId);
    const build = REQUESTS[method];
    if (!thread || !build || !this.#store.find(params.threadId)) return;
    const { fields, decide } = build(params, thread.tools.get(params.itemId)?.item);
    const { request, decision } = this.#store.ask(params.threadId, fields, decide);
    thread.requests.set(id, request.id);
    decision.then(answer => {
      if (!answer) return;
      thread.requests.delete(id);
      // What to do instead, said with a no, is the next thing Codex hears once the turn has stopped.
      if (answer.followUp) thread.followUp = answer.followUp;
      link.respond(id, answer.result);
    });
  }

  #end(threadId, reason) {
    const thread = this.#threads.get(threadId);
    if (thread) Object.assign(thread, blankThread());
    this.#store.report(threadId, 'session.ended', { reason });
  }

  #forget(threadId) {
    this.#threads.delete(threadId);
    this.#pictures.delete(threadId);
    this.#chosen.delete(threadId);
    this.#owned.set(threadId, false);
    if (this.#store.find(threadId)) this.#store.forget(threadId);
  }

  // A new thread in a folder, run as the reader's own settings say, as it would be in their terminal.
  // Codex's server trusts the folder from then on without a word, where its terminal would ask, so a
  // folder it doesn't trust yet takes the reader's say-so first, as Claude Code's does.
  async start({ cwd, trust = false }) {
    const folder = checkedFolder(cwd);
    if (trust !== true && !this.#trusts(folder)) throw new HelperError('needs_trust', 'Codex trusts a folder once a session starts in it.');
    const link = await this.#open({ start: true });
    // A test run starts its threads sandboxed, whatever this Mac's own Codex settings are.
    const started = await link.request('thread/start', { cwd: folder, ...JSON.parse(process.env.VENES_CODEX_START_ARGS ?? '{}') });
    // Whoever starts a thread hears all of it from then on.
    const thread = this.#adopt(started.thread, { model: started.model, effort: started.reasoningEffort ?? undefined, permissionMode: modeOf(started) });
    thread.isSubscribed = true;
    thread.wantsTerminal = true;
    return { sessionId: started.thread.id };
  }

  // A thread the daemon doesn't have in memory is loaded again, which only one of Codex's processes
  // can do at a time: one that's open in a terminal of its own is that terminal's.
  async #load(link, threadId) {
    try {
      const joined = await link.request('thread/resume', { threadId, excludeTurns: true });
      const thread = this.#adopt(joined.thread, { model: joined.model, effort: joined.reasoningEffort ?? undefined, permissionMode: modeOf(joined) });
      thread.isSubscribed = true;
      thread.wantsTerminal = true;
      this.#store.report(threadId, 'session.started', { source: 'resume', model: joined.model, cwd: joined.thread.cwd });
      return thread;
    } catch (error) {
      if (/active writer/.test(error.message)) {
        throw new HelperError('session_elsewhere', 'This session is open in Codex on the Mac. Close it there, or start it with codex --remote unix:// to share it.');
      }
      throw new HelperError('resume_failed', `Codex couldn't open this session: ${error.message}`);
    }
  }

  async #live(threadId) {
    const link = await this.#open({ start: true });
    const session = this.#store.find(threadId);
    let thread = this.#threads.get(threadId);
    if (!thread?.isSubscribed || !session || session.status === 'ended') thread = await this.#load(link, threadId);
    return { link, thread, session: this.#store.get(threadId) };
  }

  async send({ sessionId, text, clientId, lane, attachments = [] }) {
    const { session } = await this.#live(sessionId);
    const message = { clientId, text, lane: lane ?? 'next', attachments };
    if (lane === 'later' && this.#store.isBusy(session)) {
      this.#store.hold(session, message);
      return { queued: true };
    }
    await this.deliver(session, message);
    return { queued: false };
  }

  // A message goes into the turn that's running, for Codex to read between its steps, or starts one.
  // What the reader chose for it to run on goes with the turn that starts, and holds from then on.
  async deliver(session, { text, clientId, attachments = [] }) {
    const { link, thread } = await this.#live(session.id);
    if (!attachments.length && text.startsWith('!')) {
      await this.#runLine(link, thread, session.id, { command: text.slice(1).trim(), clientId });
      return;
    }
    const command = attachments.length ? undefined : commandOf(text);
    if (command && command.name !== 'init') {
      await this.#runCommand(link, thread, session.id, command, clientId);
      return;
    }
    // /init is a message, in the terminal's own words.
    const said = command ? INIT_PROMPT : text;
    // A skill named with `$` goes with the message as Codex's terminal sends one: by its name and where it is.
    const skills = said.includes('$') ? skillsNamed(said, await this.#listSkills(link, session.cwd).catch(() => [])) : [];
    const input = [...inputOf(said, attachments), ...skills.map(({ name, path: file }) => ({ type: 'skill', name, path: file }))];
    if (clientId) thread.sent.set(clientId, { text: said, attachments: attachments.map(shownUpload) });
    const about = { threadId: session.id, input, ...(clientId && { clientUserMessageId: clientId }) };
    try {
      if (thread.turnId) {
        // A turn that ended meanwhile, or one that takes nothing more, leaves it to start the next.
        const isSteered = await link.request('turn/steer', { ...about, expectedTurnId: thread.turnId }).then(() => true, () => false);
        if (isSteered) return;
      }
      const { model, effort, approvalPolicy, sandboxPolicy } = this.#chosen.get(session.id) ?? {};
      await link.request('turn/start', {
        ...about, ...(model && { model }), ...(effort && { effort }), ...(approvalPolicy && { approvalPolicy }), ...(sandboxPolicy && { sandboxPolicy }),
      });
      this.#chosen.delete(session.id);
    } catch (error) {
      if (clientId) thread.sent.delete(clientId);
      throw new HelperError('send_failed', `Codex didn't take the message: ${error.message}`);
    }
  }

  // A line that starts with `!` is the reader's own command, which Codex runs in their shell, outside its
  // sandbox and with no approval asked, as it does one typed that way in its terminal. It comes back as
  // the command Codex ran, which is how its send is told.
  async #runLine(link, thread, threadId, { command, clientId }) {
    if (!command) throw new HelperError('bad_text', 'Nothing to run.');
    const line = { command, clientId };
    thread.shells.push(line);
    try {
      await link.request('thread/shellCommand', { threadId, command });
    } catch (error) {
      thread.shells = thread.shells.filter(other => other !== line);
      throw new HelperError('send_failed', `Codex didn't run the line: ${error.message}`);
    }
  }

  async interrupt({ sessionId }) {
    const thread = this.#threads.get(sessionId);
    if (!thread?.turnId || !this.#link) throw new HelperError('not_running', 'Nothing to interrupt.');
    await this.#link.request('turn/interrupt', { threadId: sessionId, turnId: thread.turnId });
    return {};
  }

  // A page of what was said, oldest first, read back a few turns at a time until it's long enough.
  // It always starts where a turn does. `skip` are turns left out, as the one going on is when its
  // events tell it better.
  async #page(link, threadId, { limit = DEFAULT_HISTORY_LIMIT, cursor, skip = new Set() }) {
    const turns = [];
    let count = 0;
    let next = cursor ?? null;
    do {
      const read = await link.request('thread/turns/list', { threadId, limit: TURNS_PER_READ, cursor: next, sortDirection: 'desc', itemsView: 'full' })
        .catch(error => {
          // A thread that has had no message yet has no turns to list, and Codex says so as an error.
          if (/not materialized|no rollout/.test(error.message)) return { data: [] };
          throw error;
        });
      for (const turn of read.data ?? []) {
        if (skip.has(turn.id)) continue;
        const items = historyOf(turn, this.#keeping(threadId));
        turns.unshift(items);
        count += items.length;
      }
      next = read.nextCursor ?? null;
    } while (next && count < limit);
    let before = 0;
    if (next) {
      before = this.#nextCursor++;
      this.#cursors.set(before, { threadId, cursor: next });
    }
    return { items: turns.flat(), before, hasMore: next !== null };
  }

  async history({ sessionId, limit, before }) {
    const link = await this.#open({ start: true });
    let cursor;
    if (before !== undefined && before !== null) {
      const known = this.#cursors.get(before);
      if (known?.threadId !== sessionId) return { items: [], before: 0, hasMore: false };
      ({ cursor } = known);
    }
    return this.#page(link, sessionId, { limit, cursor });
  }

  // Everything a client needs to open one. The turn going on comes as its events, when the helper
  // heard it start, and as what's stored of it otherwise.
  async join({ sessionId, limit }) {
    const link = await this.#open({ start: true });
    const seq = this.#store.seq;
    const session = this.#store.find(sessionId);
    const isLive = session && session.status !== 'ended';
    const thread = this.#threads.get(sessionId);
    // A turn joined part way is told by what's stored of it, and its events from here on.
    const turn = isLive && !thread?.isPartial ? this.#store.openTurn(session) : [];
    const page = await this.#page(link, sessionId, { limit, skip: turnsOf(turn, thread?.turnStarts) });
    if (isLive) {
      return {
        ...page, turn, queued: [], seq,
        sessions: this.#store.sessions().filter(view => view.id === sessionId),
        requests: this.#store.requests().filter(request => request.sessionId === sessionId),
      };
    }
    const { thread: stored } = await link.request('thread/read', { threadId: sessionId, includeTurns: false });
    return {
      ...page, turn: [], queued: [], seq, requests: [],
      sessions: [{ id: sessionId, status: 'ended', cwd: stored.cwd, model: stored.model, agent: AGENT, tasks: [], backgroundTasks: 0 }],
    };
  }

  async #listModels() {
    if (this.#models && Date.now() - this.#models.at < MODELS_LIFETIME_MS) return this.#models.list;
    const link = await this.#open({ start: true });
    const { data } = await link.request('model/list', {});
    this.#models = { at: Date.now(), list: modelsOf(data) };
    return this.#models.list;
  }

  // What a status sheet shows of a session the helper follows, and nothing for one it doesn't.
  async status({ sessionId }) {
    const session = this.#store.find(sessionId);
    if (!session) return { status: null };
    if (!this.#limits || Date.now() - this.#limits.at > LIMITS_LIFETIME_MS) {
      const link = await this.#open({ start: false }).catch(() => undefined);
      const read = await link?.request('account/rateLimits/read', {}).catch(() => undefined);
      if (read?.rateLimits) this.#limits = { at: Date.now(), snapshot: read.rateLimits };
    }
    const thread = this.#threads.get(sessionId);
    return { status: statusLineOf({ session, usage: thread?.usage, limits: this.#limits?.snapshot, branch: thread?.branch }) };
  }

  // The skills on in a folder, asked for once in a while, since a new one soon wants to show up.
  async #listSkills(link, cwd) {
    const known = this.#skills.get(cwd);
    if (known && Date.now() - known.at < MODELS_LIFETIME_MS) return known.list;
    const { data } = await link.request('skills/list', cwd ? { cwds: [cwd] } : {});
    const list = skillsOf(data, cwd);
    this.#skills.set(cwd, { at: Date.now(), list });
    return list;
  }

  // Codex's server has no list of commands: those are its terminal's own. The ones listed are those the
  // helper carries out itself. Its skills, which a `$` names in a message, are the folder's.
  async capabilities({ sessionId } = {}) {
    const link = await this.#open({ start: true });
    const skills = await this.#listSkills(link, this.#store.find(sessionId)?.cwd).catch(() => []);
    return { commands: COMMANDS, models: await this.#listModels(), skills: skills.map(({ name, description }) => ({ name, description })) };
  }

  // What the session runs on from its next turn, which is when Codex takes it.
  async configure({ sessionId, model, effort }) {
    if (model === undefined && effort === undefined) throw new HelperError('bad_model', 'Nothing to change.');
    const models = await this.#listModels();
    const session = this.#store.find(sessionId);
    const chosen = models.find(offer => offer.value === (model ?? session?.model) || offer.resolvedModel === (model ?? session?.model));
    if (model !== undefined && !chosen) throw new HelperError('bad_model', 'That model isn\'t on offer.');
    if (effort !== undefined && chosen && !chosen.effortLevels.includes(effort)) throw new HelperError('bad_effort', 'That effort level isn\'t on offer for this model.');
    const change = { ...this.#chosen.get(sessionId), ...(model !== undefined && { model: chosen.value }), ...(effort !== undefined && { effort }) };
    this.#chosen.set(sessionId, change);
    this.#noteSettings(sessionId, change);
    return {};
  }

  // A command the reader typed, carried out as Codex's terminal would: none of these is a message for
  // Codex to read. What comes of one is told as Codex tells it: a compaction, a review's turn, a name.
  async #runCommand(link, thread, threadId, { name, argument }, clientId) {
    // The terminal's own words for both.
    if (thread.turnId && name !== 'rename') throw new HelperError('command_failed', `'/${name}' is disabled while a task is in progress.`);
    if (name === 'rename' && !argument) throw new HelperError('command_failed', 'Usage: /rename <name>');
    try {
      if (name === 'compact') {
        thread.compactsByHand = true;
        await link.request('thread/compact/start', { threadId });
      } else if (name === 'review') {
        // Codex opens a review with a message of its own, which is the reader's line to whoever sent it.
        thread.reviewOf = clientId;
        await link.request('review/start', { threadId, target: argument ? { type: 'custom', instructions: argument } : { type: 'uncommittedChanges' } });
      } else await link.request('thread/name/set', { threadId, name: argument });
    } catch (error) {
      thread.compactsByHand = false;
      thread.reviewOf = undefined;
      throw new HelperError('command_failed', `Codex wouldn't do that: ${error.message}`);
    }
  }

  // What the session may do without asking, from its next turn, which is when Codex takes it, and for
  // the turns after.
  async setMode({ sessionId, mode }) {
    if (!Object.hasOwn(MODES, mode)) throw new HelperError('bad_mode', `Not a mode a Codex session can be switched to: ${mode}`);
    if (!this.#store.find(sessionId)) throw new HelperError('unknown_session', `No session ${sessionId}`);
    this.#chosen.set(sessionId, { ...this.#chosen.get(sessionId), ...MODES[mode] });
    this.#noteMode(sessionId, mode);
    return {};
  }

  // Gone from this Mac for good, as Codex's own delete leaves it. A turn going on is stopped first.
  async remove({ sessionId }) {
    const link = await this.#open({ start: true });
    const thread = this.#threads.get(sessionId);
    if (thread?.turnId) await link.request('turn/interrupt', { threadId: sessionId, turnId: thread.turnId }).catch(() => {});
    try {
      await link.request('thread/delete', { threadId: sessionId });
    } catch (error) {
      throw new HelperError('session_running', `Codex wouldn't delete this session: ${error.message}`);
    }
    this.#forget(sessionId);
    return {};
  }

  // The threads Codex has stored, newest first, for the library's first page. One the daemon has in
  // memory says what it's doing. Nothing when Codex isn't there to ask.
  async library() {
    const link = await this.#open({ start: false }).catch(() => undefined);
    if (!link) return [];
    const { data = [] } = await link.request('thread/list', { limit: LISTED_THREADS, sortKey: 'updated_at', sourceKinds: LISTED_SOURCES });
    return data.filter(isListed).map(thread => {
      this.#owned.set(thread.id, true);
      const session = this.#store.find(thread.id);
      return libraryItem(thread, session && session.status !== 'ended' ? session.status : null);
    });
  }

  // The folder a stored thread ran in, for what works on a folder.
  async folderOf(sessionId) {
    const link = await this.#open({ start: false }).catch(() => undefined);
    const read = await link?.request('thread/read', { threadId: sessionId, includeTurns: false }).catch(() => undefined);
    return read?.thread?.cwd;
  }
}
