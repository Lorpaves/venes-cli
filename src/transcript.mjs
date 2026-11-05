// Claude Code's transcript format is undocumented, so everything here is
// tolerant: records and fields it doesn't recognise are skipped, never fatal.

import fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const INTERRUPTED = /^\[Request interrupted by user/;
const HIDDEN_USER_TEXT = /^<(task-notification|command-|local-command|system-reminder)/;

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

// Interrupts and terminal rejections fire no hook, so these transcript records
// are the only signal that they happened.
export function signalsFrom(record) {
  if (record?.type !== 'user') return [];
  const signals = [];
  for (const block of blocksOf(record)) {
    if (block?.type === 'tool_result') {
      signals.push({ type: 'toolResult', toolUseId: block.tool_use_id, isError: !!block.is_error, text: resultText(block) });
    } else if (block?.type === 'text' && INTERRUPTED.test(block.text ?? '')) {
      signals.push({ type: 'interrupted' });
    }
  }
  return signals;
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

export function readHistory(file, limit = 200) {
  const items = [];
  const tools = new Map();
  for (const record of fs.readFileSync(file, 'utf8').split('\n').map(parseLine)) {
    if (!record || record.isSidechain || record.isMeta) continue;
    if (record.type !== 'user' && record.type !== 'assistant') continue;
    for (const block of blocksOf(record)) {
      if (!block) continue;
      const at = record.timestamp;
      if (block.type === 'tool_use') {
        const item = { role: 'tool', at, toolUseId: block.id, name: block.name, input: block.input };
        tools.set(block.id, item);
        items.push(item);
      } else if (block.type === 'tool_result') {
        const item = tools.get(block.tool_use_id);
        if (item) Object.assign(item, { result: resultText(block), isError: !!block.is_error });
      } else if (block.type === 'text') {
        const text = block.text ?? '';
        if (record.type === 'assistant') items.push({ role: 'assistant', at, text });
        else if (INTERRUPTED.test(text)) items.push({ role: 'system', at, kind: 'interrupted' });
        else if (!HIDDEN_USER_TEXT.test(text)) items.push({ role: 'user', at, text: unwrapPasted(text) });
      }
    }
  }
  return items.slice(-limit);
}
