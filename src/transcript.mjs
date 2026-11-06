// Claude Code's transcript format is undocumented, so everything here is
// tolerant: records and fields it doesn't recognise are skipped, never fatal.

import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const INTERRUPTED = /^\[Request interrupted by user/;
const HIDDEN_USER_TEXT = /^<(task-notification|command-|local-command|system-reminder)/;
const REFUSAL = /^model_refusal_(no_)?fallback$/;
const BACKGROUND_OUTPUT = /Output is being written to: (\S+\.output)/;
const LOCAL_COMMAND_OUTPUT = /^<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/;
const DEFAULT_HISTORY_LIMIT = 200;

// Long or many-line pastes reach Claude wrapped in these tags; the id pairs them.
const PASTED_BLOCK = /\n*<pasted_content id="([^"]*)">\n([\s\S]*?)\n<\/pasted_content id="\1">\n?/g;

export function unwrapPasted(text) {
  return text.replace(PASTED_BLOCK, (match, id, body, offset) => (offset === 0 ? body : `\n\n${body}`));
}

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

function userSignals(record) {
  const signals = [];
  for (const block of blocksOf(record)) {
    if (block?.type === 'tool_result') {
      const text = resultText(block);
      signals.push({
        type: 'toolResult', toolUseId: block.tool_use_id, isError: !!block.is_error, text,
        outputFile: text.match(BACKGROUND_OUTPUT)?.[1],
      });
    } else if (block?.type === 'text' && INTERRUPTED.test(block.text ?? '')) {
      signals.push({ type: 'interrupted' });
    } else if (block?.type === 'text') {
      signals.push(...localOutputSignals(block.text));
    }
  }
  return signals;
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

// Hooks don't report any of these, so these transcript records are the only signal
// that they happened: interrupts, terminal rejections, thinking, compaction results, refusals.
export function signalsFrom(record) {
  if (record?.isSidechain) return [];
  switch (record?.type) {
    case 'user': return userSignals(record);
    case 'assistant': return thinkingSignals(record);
    case 'system': return systemSignals(record);
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

export class TranscriptTail {
  #file;
  #offset;
  #partial = '';
  #decoder = new StringDecoder('utf8');

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
    this.#offset = size;
    const lines = (this.#partial + this.#decoder.write(buffer)).split('\n');
    this.#partial = lines.pop();
    return lines.map(parseLine).filter(Boolean);
  }
}

function parseLine(line) {
  if (!line.trim()) return null;
  try { return JSON.parse(line); } catch { return null; }
}

const readRecords = file => fs.readFileSync(file, 'utf8').split('\n').map(parseLine).filter(Boolean);

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
  const items = [];
  const tools = new Map();
  const addUserText = (text, at) => {
    if (INTERRUPTED.test(text)) items.push({ role: 'system', at, kind: 'interrupted' });
    else if (!HIDDEN_USER_TEXT.test(text)) items.push({ role: 'user', at, text: unwrapPasted(text) });
  };
  for (const record of readRecords(file)) {
    if (record.isSidechain || record.isMeta || record.isCompactSummary) continue;
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
      for (const block of blocksOf({ message: { content: prompt } })) {
        if (block?.type === 'text') addUserText(block.text ?? '', at);
      }
    } else if (record.type === 'user' || record.type === 'assistant') {
      for (const block of blocksOf(record)) {
        if (!block) continue;
        addToolBlock(block, at, items, tools);
        if (block.type === 'thinking' && (block.thinking || record.thinkingDurationMs)) {
          items.push({ role: 'thinking', at, text: block.thinking ?? '', durationMs: record.thinkingDurationMs });
        } else if (block.type === 'text') {
          if (record.type === 'assistant') items.push({ role: 'assistant', at, text: block.text ?? '' });
          else addUserText(block.text ?? '', at);
        }
      }
    }
  }
  return items;
}

// `before` counts items from the start of the transcript, which only ever grows, so a
// cursor stays valid while the session runs. Subagent calls follow the call that started
// them and don't count towards `limit`.
export function readHistory(file, { limit, before } = {}) {
  const items = conversationItems(file);
  const end = Math.min(before ?? items.length, items.length);
  const start = Math.max(0, end - (limit ?? DEFAULT_HISTORY_LIMIT));
  const subagents = subagentTranscripts(file);
  const withCalls = item => (subagents.has(item.toolUseId)
    ? [item, ...subagentCalls(subagents.get(item.toolUseId), item.toolUseId).flatMap(withCalls)]
    : [item]);
  return { items: items.slice(start, end).flatMap(withCalls), before: start, hasMore: start > 0 };
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
