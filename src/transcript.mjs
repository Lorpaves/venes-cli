// Claude Code's transcript format is undocumented, so everything here is
// tolerant: records and fields it doesn't recognise are skipped, never fatal.

import fs from 'node:fs';
import path from 'node:path';
import { imageSize } from './imagesize.mjs';
import { splitAttachments } from './uploads.mjs';

const INTERRUPTED = /^\[Request interrupted by user/;
const HIDDEN_USER_TEXT = /^<(task-notification|command-|local-command|system-reminder)/;
const REFUSAL = /^model_refusal_(no_)?fallback$/;
// Claude Code's own word that a command went on in the background, at the start of a line of its
// result: with `run_in_background`, or moved there by a message or by its timeout, after whatever it
// printed first. The output file is named for the command's ID. Anything else that says as much, like
// this line in a result that printed it, isn't one.
const BACKGROUND_OUTPUT = /^Command [^\n]*?\bID: ([\w-]+)\b[^\n]*? Output is being written to: (\/[^\n]*?\/\1\.output)(?=[.\s]|$)/m;
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/;
// What ends a turn among a transcript's items, whether it finished or was stopped.
const TURN_ENDS = new Set(['turn_end', 'system']);
const DEFAULT_HISTORY_LIMIT = 200;
// Where a record's line starts in its file, which an image's id goes by.
const OFFSET = Symbol('offset');
const IMAGE_ID = /^(\d{1,15}):(\d{1,6})$/;
const LINE_CHUNK_BYTES = 1024 * 1024;
// A prompt's record is stamped a little before its hook reaches the helper.
const PROMPT_LEAD_MS = 5000;

// Long or many-line pastes reach Claude wrapped in these tags; the id pairs them.
const PASTED_BLOCK = /\n*<pasted_content id="([^"]*)">\n([\s\S]*?)\n<\/pasted_content id="\1">\n?/g;

export function unwrapPasted(text) {
  return text.replace(PASTED_BLOCK, (match, id, body, offset) => (offset === 0 ? body : `\n\n${body}`));
}

// A line typed after `!` runs in the terminal, and Claude Code keeps the command, then what it printed
// with &, < and > in it written as entities. It's read here as Claude Code reads it to show it. When
// Claude won't answer it, a caveat comes just before the command.
const SHELL_INPUT_OPEN = '<bash-input>';
const SHELL_INPUT_CLOSE = '</bash-input>';
const STDOUT_OPEN = '<bash-stdout>';
const STDOUT_CLOSE = '</bash-stdout>';
const PERSISTED_OPEN = '<persisted-output>';
const PERSISTED_CLOSE = '</persisted-output>';
const CAVEAT = /^<local-command-caveat>/;
const ENTITY = /&(?:amp|lt|gt);/g;
const ENTITY_TEXT = { '&amp;': '&', '&lt;': '<', '&gt;': '>' };

const unescaped = text => text.replace(ENTITY, entity => ENTITY_TEXT[entity] ?? entity);

// What output sent from elsewhere is wrapped in, taken off.
function unpasted(text) {
  return text.replace(/^\n+/, '').startsWith('<pasted_content ') ? text.replace(PASTED_BLOCK, (match, id, body) => body) : text;
}

// What's inside the first `name` element of `text` that has anything in it.
function elementText(text, name) {
  if (!text.trim() || !name.trim()) return undefined;
  const open = new RegExp(`<${name}(?=[\\s>])`, 'gi');
  const close = new RegExp(`<\\/${name}>`, 'gi');
  for (let from = 0; ;) {
    open.lastIndex = from;
    const start = open.exec(text);
    close.lastIndex = from;
    const firstClose = close.exec(text);
    if (!start || !firstClose) return undefined;
    const end = text.indexOf('>', start.index + start[0].length);
    if (end === -1) return undefined;
    close.lastIndex = end + 1;
    const closing = close.exec(text);
    if (!closing) return undefined;
    const inside = text.slice(end + 1, closing.index);
    if (inside && firstClose.index + firstClose[0].length > start.index) return inside;
    from = closing.index + closing[0].length;
  }
}

// The command of a line run with `!`, or undefined for any other text.
export function shellCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith(SHELL_INPUT_OPEN) || !trimmed.endsWith(SHELL_INPUT_CLOSE)) return undefined;
  if (trimmed.length < SHELL_INPUT_OPEN.length + SHELL_INPUT_CLOSE.length) return undefined;
  return trimmed.slice(SHELL_INPUT_OPEN.length, trimmed.length - SHELL_INPUT_CLOSE.length) || undefined;
}

// What a line run with `!` printed, as `stdout` and `stderr`, or undefined for any other text. Output
// too long to keep whole is a note about where it went, which is left as it is.
export function shellOutput(text) {
  if (!text.startsWith('<bash-stdout') && !text.startsWith('<bash-stderr')) return undefined;
  const close = text.lastIndexOf(STDOUT_CLOSE);
  const hasStdout = text.startsWith(STDOUT_OPEN) && close !== -1;
  const stdout = unpasted(hasStdout ? text.slice(STDOUT_OPEN.length, close) : '');
  const rest = hasStdout ? text.slice(close + STDOUT_CLOSE.length) : text;
  return {
    stdout: stdout.startsWith(PERSISTED_OPEN) ? withoutPersistedTags(stdout) : unescaped(stdout),
    stderr: unescaped(unpasted(elementText(rest, 'bash-stderr') ?? '')),
  };
}

function withoutPersistedTags(text) {
  const inside = text.slice(PERSISTED_OPEN.length);
  const end = inside.lastIndexOf(PERSISTED_CLOSE);
  return end === -1 ? inside : inside.slice(0, end) + inside.slice(end + PERSISTED_CLOSE.length);
}

const isCaveat = record => blocksOf(record).some(block => block?.type === 'text' && CAVEAT.test(block.text ?? ''));

export const normalized = text => text.trim().split(/\s+/).join(' ');

function blocksOf(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function resultText(block) {
  if (typeof block.content === 'string') return block.content;
  if (!Array.isArray(block.content)) return '';
  return block.content.map(part => part?.text ?? '').join('');
}

// A record's images, in the order an id counts them: what came with a message, and what a tool showed.
function imagesIn(record) {
  const isQueued = record.type === 'attachment' && record.attachment?.type === 'queued_command';
  const blocks = isQueued ? blocksOf({ message: { content: record.attachment.prompt } }) : blocksOf(record);
  return blocks.flatMap(block => {
    if (block?.type === 'tool_result' && Array.isArray(block.content)) {
      return block.content.filter(part => part?.type === 'image').map(part => ({ source: part.source, toolUseId: block.tool_use_id }));
    }
    return block?.type === 'image' ? [{ source: block.source }] : [];
  }).filter(({ source }) => source?.data);
}

// Images are too big to send with a page, so a page says which there are and `readImage` fetches one.
// Each says its size in pixels where that can be told, for a page to give it its room before then.
function imageRefs(record) {
  return imagesIn(record).map(({ source, toolUseId }, index) => ({
    toolUseId, id: `${record[OFFSET]}:${index}`, mediaType: source.media_type, bytes: Math.floor(source.data.length * 3 / 4),
    ...imageSize(source.data),
  }));
}

function imageSignals(record) {
  if (record.isMeta) return [];
  const byTool = new Map();
  const own = [];
  for (const { toolUseId, ...image } of imageRefs(record)) {
    if (toolUseId) byTool.set(toolUseId, [...(byTool.get(toolUseId) ?? []), image]);
    else own.push(image);
  }
  const signals = [...byTool].map(([toolUseId, images]) => ({ type: 'toolImages', toolUseId, images }));
  return own.length ? [...signals, { type: 'userImages', images: own }] : signals;
}

function userSignals(record) {
  const signals = [];
  for (const block of blocksOf(record)) {
    if (block?.type === 'tool_result') {
      const text = resultText(block);
      signals.push({
        type: 'toolResult', toolUseId: block.tool_use_id, isError: !!block.is_error, text,
        outputFile: text.match(BACKGROUND_OUTPUT)?.[2],
      });
    } else if (block?.type === 'text' && INTERRUPTED.test(block.text ?? '')) {
      signals.push({ type: 'interrupted' });
    } else if (block?.type === 'text') {
      signals.push(...shellSignals(record, block.text ?? ''), ...localOutputSignals(block.text));
    }
  }
  return signals;
}

// A line run with `!` says nothing to hooks, so the transcript is all there is of it.
function shellSignals(record, text) {
  const command = shellCommand(text);
  if (command !== undefined) return [{ type: 'shellInput', command, at: record.timestamp, after: record.parentUuid }];
  const output = shellOutput(text);
  if (output) return [{ type: 'shellOutput', ...output, at: record.timestamp }];
  return CAVEAT.test(text) ? [{ type: 'caveat', id: record.uuid }] : [];
}

function localOutputSignals(text) {
  const output = text?.match(LOCAL_COMMAND_OUTPUT);
  return output ? [{ type: 'localOutput', text: output[2] }] : [];
}

// Most thinking blocks are stored without their text, so the duration may be all there is.
function thinkingSignals(record) {
  return blocksOf(record)
    .filter(block => block?.type === 'thinking' && (block.thinking || record.thinkingDurationMs))
    .map(block => ({ type: 'thinking', text: block.thinking ?? '', durationMs: record.thinkingDurationMs }));
}

// Replies Claude Code writes itself, such as an API error, name a made-up model like <synthetic>.
function modelOf(record) {
  const model = record.type === 'assistant' ? record.message?.model : undefined;
  return model && !model.startsWith('<') ? model : undefined;
}

function modelSignals(record) {
  const model = modelOf(record);
  return model ? [{ type: 'model', model }] : [];
}

function systemSignals(record) {
  if (record.subtype === 'compact_boundary') {
    const { preTokens, postTokens } = record.compactMetadata ?? {};
    return [{ type: 'compacted', preTokens, postTokens }];
  }
  if (REFUSAL.test(record.subtype)) {
    return [{
      type: 'refusal', id: record.uuid, model: record.originalModel, fallbackModel: record.fallbackModel,
      scope: record.scope, category: record.apiRefusalCategory, explanation: record.apiRefusalExplanation, text: record.content,
    }];
  }
  return record.subtype === 'local_command' ? localOutputSignals(record.content) : [];
}

// What became of a message typed during a turn. `remove` is Claude reading it in that turn, `dequeue`
// is it starting the next one, and `popAll` is someone taking back all that's queued.
function queueSignals({ operation, content }) {
  if (operation === 'remove' || operation === 'dequeue') return [{ type: 'queueRead', text: content }];
  return operation === 'popAll' ? [{ type: 'queueTakenBack' }] : [];
}

// Hooks don't report any of these, so these transcript records are the only signal
// that they happened: interrupts, terminal rejections, thinking, compaction results, refusals.
export function signalsFrom(record) {
  if (record?.isSidechain) return [];
  switch (record?.type) {
    case 'user': return [...userSignals(record), ...imageSignals(record)];
    case 'attachment': return imageSignals(record);
    case 'assistant': return [...thinkingSignals(record), ...modelSignals(record)];
    case 'system': return systemSignals(record);
    case 'queue-operation': return queueSignals(record);
    default: return [];
  }
}

const tagIn = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1];
const numberIn = (text, name) => { const value = tagIn(text, name); return value === undefined ? undefined : Number(value); };

// A finished task reaches Claude as a synthetic prompt in this form. A result is free
// text that could contain anything, so the other tags are only read outside it.
export function parseTaskNotification(text) {
  const start = text.indexOf('<result>');
  const end = text.lastIndexOf('</result>');
  const hasResult = start >= 0 && end > start;
  const head = hasResult ? text.slice(0, start) : text;
  const tail = hasResult ? text.slice(end) : text;
  const id = tagIn(head, 'task-id');
  if (!id) return undefined;
  return {
    id, toolUseId: tagIn(head, 'tool-use-id'), outputFile: tagIn(head, 'output-file'), status: tagIn(head, 'status'),
    summary: tagIn(head, 'summary'), result: hasResult ? text.slice(start + '<result>'.length, end) : undefined,
    tokens: numberIn(tail, 'subagent_tokens'), toolUses: numberIn(tail, 'tool_uses'), durationMs: numberIn(tail, 'duration_ms'),
  };
}

// Each whole line of `bytes` as a record, and what's left after the last one. `start` is where
// `bytes` starts in its file.
function recordsIn(bytes, start = 0) {
  const records = [];
  let position = 0;
  for (let end = bytes.indexOf(0x0a); end >= 0; end = bytes.indexOf(0x0a, position)) {
    const record = parseLine(bytes.toString('utf8', position, end));
    if (record) records.push(Object.assign(record, { [OFFSET]: start + position }));
    position = end + 1;
  }
  return { records, rest: bytes.subarray(position) };
}

export class TranscriptTail {
  #file;
  #offset;
  #partial = Buffer.alloc(0);

  // Starts at the end of the file: history is served separately by readHistory.
  constructor(file) {
    this.#file = file;
    this.#offset = this.#size();
  }

  #size() {
    try { return fs.statSync(this.#file).size; } catch { return 0; }
  }

  poll() {
    const size = this.#size();
    if (size <= this.#offset) return [];
    const buffer = Buffer.alloc(size - this.#offset);
    const fd = fs.openSync(this.#file, 'r');
    try { fs.readSync(fd, buffer, 0, buffer.length, this.#offset); } finally { fs.closeSync(fd); }
    const { records, rest } = recordsIn(Buffer.concat([this.#partial, buffer]), this.#offset - this.#partial.length);
    this.#offset = size;
    this.#partial = rest;
    return records;
  }
}

// Each live session's transcript as it grows, read every so often. A session's is followed from when
// the helper first hears of it, not from the next read, which took lines written in between for
// history and skipped them.
export function followTranscripts(store, { every }) {
  const tails = new Map();
  const tailOf = session => {
    if (!session?.transcriptPath) return undefined;
    if (!tails.has(session.id)) tails.set(session.id, new TranscriptTail(session.transcriptPath));
    return tails.get(session.id);
  };
  const heard = event => tailOf(store.find(event.sessionId));
  const read = () => {
    // Idle sessions too: compaction and background tasks don't need a running turn.
    for (const session of store.liveSessions()) {
      for (const record of tailOf(session)?.poll() ?? []) store.handleTranscriptRecord(session.id, record);
    }
  };
  store.on('event', heard);
  const timer = setInterval(read, every);
  timer.unref();
  return {
    read,
    stop: () => {
      clearInterval(timer);
      store.off('event', heard);
    },
  };
}

function parseLine(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

// A session has no transcript until its first message.
function readRecords(file) {
  try {
    const bytes = fs.readFileSync(file);
    const { records, rest } = recordsIn(bytes);
    const last = parseLine(rest.toString());
    return last ? [...records, Object.assign(last, { [OFFSET]: bytes.length - rest.length })] : records;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

const subagentDir = transcript => path.join(transcript.replace(/\.jsonl$/, ''), 'subagents');

// No hook links a subagent to the call that started it, but its metadata file does.
export function readAgentParent(transcript, agentId) {
  return readJson(path.join(subagentDir(transcript), `agent-${agentId}.meta.json`))?.toolUseId;
}

function subagentTranscripts(transcript) {
  const dir = subagentDir(transcript);
  const byParent = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch { return byParent; }
  for (const name of names.filter(n => n.endsWith('.meta.json'))) {
    const toolUseId = readJson(path.join(dir, name))?.toolUseId;
    const file = path.join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
    if (toolUseId && fs.existsSync(file)) byParent.set(toolUseId, file);
  }
  return byParent;
}

function addToolBlock(block, at, items, tools) {
  if (block.type === 'tool_use') {
    const item = { role: 'tool', at, toolUseId: block.id, name: block.name, input: block.input };
    tools.set(block.id, item);
    items.push(item);
  } else if (block.type === 'tool_result') {
    const item = tools.get(block.tool_use_id);
    if (item) Object.assign(item, { result: resultText(block), isError: !!block.is_error });
  }
}

function subagentCalls(file, parentToolUseId) {
  const items = [];
  const tools = new Map();
  for (const record of readRecords(file)) {
    for (const block of blocksOf(record)) {
      if (block) addToolBlock(block, record.timestamp, items, tools);
    }
  }
  return items.map(item => ({ ...item, parentToolUseId }));
}

function conversationItems(file) {
  // A transcript is named for its session.
  const sessionId = path.basename(file, '.jsonl');
  const items = [];
  const tools = new Map();
  let model;
  // The caveat before a line run with `!` that Claude won't answer.
  let caveat;
  let shellReplies = true;
  // A tool's images go with its call, and the rest with what the record said, from `first` on.
  const addImages = (record, first) => {
    for (const { toolUseId, ...image } of imageRefs(record)) {
      const owner = toolUseId ? tools.get(toolUseId) : items.slice(first).findLast(item => item.role === 'user');
      if (owner) (owner.images ??= []).push(image);
    }
  };
  // What Venes typed ahead of a message for its attachments isn't part of its text.
  const addUserText = (typed, at, record) => {
    const command = shellCommand(typed);
    const output = command === undefined ? shellOutput(typed) : undefined;
    if (command !== undefined) {
      shellReplies = !record?.parentUuid || record.parentUuid !== caveat;
      items.push({ role: 'user', at, text: `!${command}`, shell: true });
    } else if (output) {
      items.push({ role: 'output', at, ...output, replies: shellReplies });
      shellReplies = true;
    } else if (INTERRUPTED.test(typed)) items.push({ role: 'system', at, kind: 'interrupted' });
    else if (!HIDDEN_USER_TEXT.test(typed)) {
      const { text, files } = splitAttachments(unwrapPasted(typed), { sessionId });
      items.push({ role: 'user', at, text, ...(files.length ? { attachments: files } : {}) });
    }
  };
  for (const record of readRecords(file)) {
    if (record.isMeta && !record.isSidechain && isCaveat(record)) caveat = record.uuid;
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
    model = modelOf(record) ?? model;
    const at = record.timestamp;
    if (record.type === 'system') {
      if (record.subtype === 'turn_duration') items.push({ role: 'turn_end', at, durationMs: record.durationMs });
      if (record.subtype === 'compact_boundary') {
        const { trigger, preTokens, postTokens } = record.compactMetadata ?? {};
        items.push({ role: 'compact', at, trigger, preTokens, postTokens });
      }
    } else if (record.type === 'attachment') {
      // A message sent during a turn is stored here, and has no user record of its own.
      const { type, commandMode, prompt, origin } = record.attachment ?? {};
      if (type !== 'queued_command' || commandMode !== 'prompt' || (origin && origin.kind !== 'human')) continue;
      const first = items.length;
      for (const block of blocksOf({ message: { content: prompt } })) {
        if (block?.type === 'text') addUserText(block.text ?? '', at);
      }
      addImages(record, first);
    } else if (record.type === 'user' || record.type === 'assistant') {
      const first = items.length;
      for (const block of blocksOf(record)) {
        if (!block) continue;
        addToolBlock(block, at, items, tools);
        if (block.type === 'thinking' && (block.thinking || record.thinkingDurationMs)) {
          items.push({ role: 'thinking', at, text: block.thinking ?? '', durationMs: record.thinkingDurationMs });
        } else if (block.type === 'text') {
          if (record.type === 'assistant') items.push({ role: 'assistant', at, text: block.text ?? '' });
          else addUserText(block.text ?? '', at, record);
        }
      }
      addImages(record, first);
    }
  }
  return { items, model };
}

// Where a turn begins among `items`: at its prompt, or for a turn that has none, like a
// finished task's, at its first event.
function turnStartIn(items, { at, prompt }) {
  const stamp = item => Date.parse(item.at);
  const own = prompt === undefined ? -1 : items.findLastIndex(item => (
    item.role === 'user' && stamp(item) >= at - PROMPT_LEAD_MS && normalized(item.text) === normalized(prompt)
  ));
  if (own >= 0) return own;
  const first = items.findIndex(item => stamp(item) >= at);
  return first < 0 ? items.length : first;
}

// Whether a turn begins at `index`: at a prompt, or for one that has none, after the last one ended.
const opensTurn = (items, index) => items[index]?.role === 'user' || TURN_ENDS.has(items[index - 1].role);

// `before` counts items from the start of the transcript, which only ever grows, so a
// cursor stays valid while the session runs. Subagent calls follow the call that started
// them and don't count towards `limit`. `turn` stops the page where that turn begins. A page
// reaches back past `limit` to where a turn begins, because the part of a turn looks like a
// whole one to a client, which would show it as a reply of its own. `model` is the last one to
// have replied.
export function readHistory(file, { limit, before, turn } = {}) {
  const { items, model } = conversationItems(file);
  const edge = turn ? turnStartIn(items, turn) : items.length;
  const end = Math.min(before ?? edge, edge);
  let start = Math.max(0, end - (limit ?? DEFAULT_HISTORY_LIMIT));
  while (start > 0 && !opensTurn(items, start)) start -= 1;
  const subagents = subagentTranscripts(file);
  const withCalls = item => (subagents.has(item.toolUseId)
    ? [item, ...subagentCalls(subagents.get(item.toolUseId), item.toolUseId).flatMap(withCalls)]
    : [item]);
  return { items: items.slice(start, end).flatMap(withCalls), before: start, hasMore: start > 0, model };
}

function lineAt(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(LINE_CHUNK_BYTES);
    const pieces = [];
    for (let position = offset; ;) {
      const length = fs.readSync(fd, chunk, 0, chunk.length, position);
      const end = chunk.subarray(0, length).indexOf(0x0a);
      pieces.push(Buffer.from(chunk.subarray(0, end < 0 ? length : end)));
      if (length === 0 || end >= 0) return Buffer.concat(pieces).toString();
      position += length;
    }
  } finally {
    fs.closeSync(fd);
  }
}

// An image by the id a page gave it. The id says where its record is, because a transcript can be
// far too long to read for one image. `undefined` if it isn't there.
export function readImage(file, id) {
  const [, offset, index] = String(id).match(IMAGE_ID) ?? [];
  if (offset === undefined) return undefined;
  try {
    const record = parseLine(lineAt(file, Number(offset)));
    const source = record ? imagesIn(record)[Number(index)]?.source : undefined;
    return source ? { mediaType: source.media_type, data: source.data } : undefined;
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

// The end of a task's output file, which can be long and may still be growing.
export function readTail(file, maxBytes) {
  const { size } = fs.statSync(file);
  const length = Math.min(size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, size - length); } finally { fs.closeSync(fd); }
  return { output: buffer.toString('utf8'), truncated: size > length };
}
