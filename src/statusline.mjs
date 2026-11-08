// What a status line shows, item by item, read off its text: the model, the context it has used,
// the limits, the branch, and so on, whatever look the status line gives them. A part that isn't
// one of these is an item of its own, as it reads, so nothing on the line is lost.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 1000;

// Between the parts of a line: bars, dots, and powerline's arrows.
const SEPARATOR = /\s*(?:[│┃|¦‖∣•·∙⋅]|[\ue0b0-\ue0d7])\s*/gu;
// What starts a new part where there's no separator: a label with its value, a meter with no label,
// or an icon.
const STARTER = /(?<=\s|^)(?:(?:ctx|ctxt|context|5h|7d|weekly|week|session|spend|cache)\s*:?\s*(?=[\d$]|[\u2500-\u259f\u25a0-\u25ff\u2800-\u28ff])|(?<!(?:ctx|ctxt|context|5h|7d|weekly|week|session|spend|cache)\s*:?\s*)[\u2500-\u259f\u25a0-\u25ff\u2800-\u28ff]{2,}(?=[^%]*%)|[📁📂🗂🌿⎇💰💵⏱⌛🕐🔗🧠🤖]|[\ue0a0\ue725\uf418\uf126\uf07b\uf07c\uf4bc]|wt:|[PM]R\s?#)/gu;
// Icons, meters and marks around a value, which aren't part of it: emoji, Nerd Fonts' icons, box
// drawing, blocks, shapes and braille, and the arrows status lines use as icons.
const DECOR = /[\p{Extended_Pictographic}\uFE0F\u200D\ue000-\uf8ff\u{f0000}-\u{ffffd}─-▟■-◿⠀-⣿⎇⏵⏸↻⟳]/gu;
// A hint about keys or a command, like "(shift+tab to cycle)", "? for shortcuts", "← for agents" or
// "/effort", which says nothing of the session.
const HINT = /\(\s*[^()]*\bto\s+\w+[^()]*\)|^\?\s*for shortcuts$|^(?:esc|ctrl\+\w+|alt\+\w+|option\+\w+|cmd\+\w+|shift\+tab|enter|tab|space|hold space|[←→↑↓])\s*(?:to|for)\s+.*$|^\/[a-z][\w-]*$/i;
const PERCENT = /(\d+(?:\.\d+)?)\s*%/;
const TOKENS = String.raw`\d[\d.,]*\s?[kKmM]?`;
const BRANCH_MARK = /^(?:[🌿⎇\ue0a0\ue725\uf418\uf126]\uFE0F?\s*|git:\(|branch:?\s+)/u;
const FOLDER_MARK = /^[📁📂🗂\uf07b\uf07c]/u;
const EFFORT = /^(?:effort:?\s*)?(low|medium|high|xhigh|max)$/i;
// An effort level written after a model, like "Opus 5.5 (max)".
const EFFORT_WORD = /\s*\(?\b(low|medium|high|xhigh|max)\b\)?\s*$/i;
const MODEL = /\b(?:claude-)?(opus|sonnet|haiku|fable)\b(?:[\s-]*(\d+(?:[.-]\d+)?))?/i;
const DURATION = /^(?=\d)(?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+(?:\.\d+)?s)?$/;
// Claude Code's permission mode, marked or not: "⏵⏵ accept edits on", "⏸ plan mode on" and the like.
const MODE = /^(?:(?:⏵⏵|⏸)\s*(.+?)|(bypass permissions|accept edits|auto-accept edits|plan mode|auto mode|manual mode|don't ask))\s+on\b/i;

const clean = text => text.replace(DECOR, ' ').replace(/^\[|\]$/g, ' ').replace(/\s+/g, ' ').trim();
const capitalized = text => text.charAt(0).toUpperCase() + text.slice(1);

// The parts of a line, as ranges of it: between separators, and before each starter.
function partsOf(text) {
  const parts = [];
  let start = 0;
  const add = (from, to) => {
    let at = from;
    for (const { index } of text.slice(from, to).matchAll(STARTER)) {
      if (index > 0 && text.slice(at, from + index).trim()) {
        parts.push([at, from + index]);
        at = from + index;
      }
    }
    parts.push([at, to]);
  };
  for (const match of text.matchAll(SEPARATOR)) {
    add(start, match.index);
    start = match.index + match[0].length;
  }
  add(start, text.length);
  return parts
    .map(([from, to]) => {
      const lead = text.slice(from, to).search(/\S/);
      return lead < 0 ? undefined : { from: from + lead, text: text.slice(from + lead, to).trimEnd() };
    })
    .filter(Boolean);
}

// The colour of the line at a place in it, as its runs give it.
function colorAt(runs, index) {
  let at = 0;
  for (const run of runs) {
    at += run.text.length;
    if (index < at) return run.color;
  }
  return undefined;
}

function percentItem(text, lower, seen) {
  const match = text.match(PERCENT);
  let percent = Number(match[1]);
  let kind;
  if (/\b(?:ctx|ctxt|context)\b|上下文|🧠/.test(lower)) kind = 'context';
  else if (/\b(?:5h|5-hour|five[- ]hour|session)\b|5小时/.test(lower)) kind = 'fiveHour';
  else if (/\b(?:7d|7-day|seven[- ]day|weekly|week|wk)\b|7天|本周/.test(lower)) kind = 'sevenDay';
  else if (/\bspend\b/.test(lower)) kind = 'spend';
  else if (/\bcache\b|缓存/.test(lower)) kind = 'cache';
  else if (!seen.has('context')) kind = 'context';
  else kind = 'other';
  // A share left is turned into the share used, which is what every meter here shows.
  if (kind === 'context' && /\b(?:left|remaining|free)\b|剩余/.test(lower)) percent = 100 - percent;
  const item = { kind, percent, at: match.index };
  if (kind === 'context') {
    const input = text.match(new RegExp(`(${TOKENS})\\s*↑|↑\\s*(${TOKENS})`));
    const output = text.match(new RegExp(`(${TOKENS})\\s*↓|↓\\s*(${TOKENS})`));
    const share = text.match(new RegExp(`(${TOKENS})\\s*/\\s*(${TOKENS})`));
    if (input) item.input = (input[1] ?? input[2]).replace(/\s/g, '');
    if (output) item.output = (output[1] ?? output[2]).replace(/\s/g, '');
    if (share) Object.assign(item, { used: share[1].replace(/\s/g, ''), total: share[2].replace(/\s/g, '') });
  } else if (kind !== 'cache' && kind !== 'other') {
    if (kind === 'spend') {
      const { used, total } = spendItem(text) ?? {};
      if (used) Object.assign(item, { used, total });
    }
    const resets = text.match(/(?:↻|⟳|🔄|\bresets?(?:\s+(?:in|at))?:?)\s*([^()]+?)\s*\)?$/iu);
    if (resets) item.resets = resets[1].trim();
  }
  if (kind === 'other') item.value = text;
  return item;
}

function spendItem(text) {
  const money = [...text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/g)].map(match => match[1]);
  if (money.length < 2) return undefined;
  const [used, limit] = money.map(value => Number(value.replace(/,/g, '')));
  return { kind: 'spend', percent: limit > 0 ? Math.round((used / limit) * 1000) / 10 : undefined, used: `$${money[0]}`, total: `$${money[1]}` };
}

function branchItem(text) {
  const rest = clean(text.replace(BRANCH_MARK, '').replace(/\)$/, ''));
  if (!rest) return undefined;
  const [name, ...status] = rest.split(' ');
  return { kind: 'branch', value: name, ...(status.length ? { status: status.join(' ') } : {}) };
}

// What one part shows, if it's one of the things a status line is known to show.
function itemsOf(text, known, seen) {
  const lower = text.toLowerCase();
  const plain = clean(text);
  const mode = text.match(MODE);
  if (mode) return [{ kind: 'mode', value: capitalized((mode[1] ?? mode[2]).toLowerCase()) }];
  const vim = text.match(/^--\s*(INSERT|NORMAL|VISUAL(?: LINE)?)\s*--$/);
  if (vim) return [{ kind: 'vim', value: vim[1] }];
  if (/^\d+\s+(?:shells?|background tasks?|bash(?:es)?)$/i.test(plain)) return [{ kind: 'background', value: plain }];
  const update = text.match(/^Update available!?\s*(?:Run:\s*(.+))?$/i);
  if (update) return [{ kind: 'update', ...(update[1] ? { value: update[1].trim() } : {}) }];
  if (/\bspend\b/.test(lower) && !PERCENT.test(text)) {
    const spend = spendItem(text);
    if (spend) return [spend];
  }
  if (PERCENT.test(text)) return [percentItem(text, lower, seen)];
  if (BRANCH_MARK.test(text) || (known.branch && plain === known.branch)) {
    const branch = branchItem(text);
    if (branch) return [branch];
  }
  const pr = text.match(/\b([PM]R)\s?#(\d+)\b\s*([a-z_]+)?/i);
  if (pr) return [{ kind: 'pr', value: `#${pr[2]}`, ...(pr[3] ? { state: pr[3].toLowerCase() } : {}) }];
  const worktree = text.match(/^wt:\s*(\S+)|\bworktree:?\s+(\S+)/i);
  if (worktree) return [{ kind: 'worktree', value: worktree[1] ?? worktree[2] }];
  const cost = text.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/);
  if (cost) return [{ kind: 'cost', value: `$${cost[1]}` }];
  const lines = plain.match(/^\+(\d+)\s*[/,]?\s*[-−](\d+)$/);
  if (lines) return [{ kind: 'lines', added: Number(lines[1]), removed: Number(lines[2]) }];
  if (/[⏱⌛🕐]/u.test(text) || /\b(?:duration|elapsed)\b/i.test(text) || DURATION.test(plain)) {
    const value = clean(text.replace(/\b(?:duration|elapsed):?/i, ''));
    if (DURATION.test(value)) return [{ kind: 'duration', value }];
  }
  const model = plain.match(MODEL);
  if (model) {
    const items = [{ kind: 'model', value: plain.replace(/[()]/g, '').replace(EFFORT_WORD, '').trim() }];
    const effort = plain.match(EFFORT_WORD);
    if (effort) items.push({ kind: 'effort', value: effort[1] });
    return items;
  }
  const effort = plain.match(EFFORT);
  if (effort) return [{ kind: 'effort', value: effort[1] }];
  return placeItems(text, plain, known);
}

// Where the session is: a folder, a repository, or both, as "owner/name › folder".
function placeItems(text, plain, known) {
  const folder = known.cwd ? path.basename(known.cwd) : undefined;
  const both = plain.match(/^([\w.-]+\/[\w.-]+)\s*›\s*(.+)$/);
  if (both) return [{ kind: 'repo', value: both[1] }, { kind: 'folder', value: both[2] }];
  if (FOLDER_MARK.test(text) || /^[~/]/.test(plain) || (folder && (plain === folder || known.cwd.endsWith(`/${plain}`)))) {
    return plain ? [{ kind: 'folder', value: plain }] : [];
  }
  if (/^🔗/u.test(text) || /^[\w.-]+\/[\w.-]+$/.test(plain)) return plain ? [{ kind: 'repo', value: plain }] : [];
  return plain ? [{ kind: 'other', value: text }] : [];
}

// Everything the status line shows, in its order. `styled` is its lines as runs, and `known` is
// what the helper knows of the session: its folder, and the branch checked out there.
export function statusItems(styled, known = {}) {
  const items = [];
  const seen = new Set();
  for (const runs of styled) {
    const line = runs.map(run => run.text).join('');
    for (const part of partsOf(line)) {
      const text = part.text.replace(HINT, '').trim();
      if (!text || HINT.test(text)) continue;
      for (const { at, ...item } of itemsOf(text, known, seen)) {
        const color = at === undefined ? undefined : colorAt(runs, part.from + at);
        items.push({ ...item, ...(color ? { color } : {}), text: part.text });
        seen.add(item.kind);
      }
    }
  }
  return items;
}

// The branch checked out in a folder, which a status line can show with nothing to mark it.
export async function checkedOutBranch(cwd) {
  if (!cwd) return undefined;
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
