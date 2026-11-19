// What the agents here have used, by day: the tokens each wrote down in what it keeps of its own
// chats, and what those would have cost by the public list of prices. Claude Code writes a request's
// tokens with the reply in a session's transcript, and Codex with each response in a thread's
// rollout, and Antigravity with each in the conversation's database.
//
// The chats can be gigabytes, so each file is read once and then only where it has grown, and what was
// counted in it is kept by day in a file of the helper's. A read stops when its time is up and says so,
// and the next one goes on from there, newest files first.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { HelperError } from './errors.mjs';
import { costOf, priceFor, savingsOf } from './prices.mjs';

const exec = promisify(execFile);
const WORKER = fileURLToPath(new URL('usage-worker.mjs', import.meta.url));
const WORKER_TIMEOUT_MS = 60_000;
const WORKER_BUFFER_BYTES = 8 << 20;

export const DAYS = 90;
export const HOURS = 24;
const VERSION = 5;
const HOUR_MS = 60 * 60_000;
const QUARTER_MS = 15 * 60_000;
// Another clock's count that nobody has asked for in this long is let go.
const CLOCK_KEPT_MS = 30 * 24 * HOUR_MS;
const CHUNK_BYTES = 1 << 20;
// How many of a transcript's last requests are remembered, to count once one that's written on several
// lines, which follow each other closely.
const RECENT = 48;
const NEWLINE = 0x0a;

const pad = number => `${number}`.padStart(2, '0');

// How far this computer's clock is ahead of UTC at a moment, in milliseconds.
const here = ms => -new Date(ms).getTimezoneOffset() * 60_000;

// This computer's time zone, by its name.
const hereName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// The clock that days and hours are told by. A reader says which time zone it's in by the zone's name,
// as "Asia/Shanghai", and they're told by the clock there: a day where the reader is isn't a day where
// this computer is. With none said, or one this computer doesn't know, it's this computer's own.
// `name` is the zone's, and `offsetAt` how far its clock is ahead of UTC at a moment, which is asked
// of the system once for each quarter of an hour, since a zone's clock changes on no finer a line.
export function clockOf(zone) {
  const own = { name: hereName(), offsetAt: here };
  if (!zone) return own;
  let format;
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  } catch {
    return own;
  }
  const name = format.resolvedOptions().timeZone;
  if (name === own.name) return own;
  const known = new Map();
  return {
    name,
    offsetAt(ms) {
      const quarter = Math.floor(ms / QUARTER_MS);
      let offset = known.get(quarter);
      if (offset === undefined) {
        const at = quarter * QUARTER_MS;
        const part = Object.fromEntries(format.formatToParts(at).map(({ type, value }) => [type, Number(value)]));
        offset = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - at;
        known.set(quarter, offset);
      }
      return offset;
    },
  };
}

// The day a moment falls on by a clock, as YYYY-MM-DD: this computer's, unless another's `offsetAt` is given.
export function dayOf(ms, offsetAt = here) {
  const date = new Date(ms + offsetAt(ms));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

// The hour a moment falls in by a clock, as YYYY-MM-DDTHH.
export function hourOf(ms, offsetAt = here) {
  return `${dayOf(ms, offsetAt)}T${pad(new Date(ms + offsetAt(ms)).getUTCHours())}`;
}

// The last `count` hours by a clock, this one last. On the night the clocks go back there's one fewer,
// since an hour comes twice by its name.
export function lastHours(count, now = Date.now(), offsetAt = here) {
  const hours = [];
  for (let i = count - 1; i >= 0; i--) {
    const hour = hourOf(now - i * HOUR_MS, offsetAt);
    if (hours.at(-1) !== hour) hours.push(hour);
  }
  return hours;
}

// The last `count` days by a clock, today last: from noon today as that clock has it, a day at a time,
// so that a day the clocks change on is neither left out nor told twice.
export function lastDays(count, now = Date.now(), offsetAt = here) {
  const date = new Date(now + offsetAt(now));
  date.setUTCHours(12, 0, 0, 0);
  const days = [];
  for (let i = 0; i < count; i++) {
    days.unshift(`${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`);
    date.setUTCDate(date.getUTCDate() - 1);
  }
  return days;
}

// The moment a day starts by a clock.
function startOf(day, offsetAt) {
  const [year, month, date] = day.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, date);
  return wall - offsetAt(wall - offsetAt(wall));
}

// What a line of Claude Code's transcript says was used, if it's a reply with its count: `key` is the
// request's own, which a reply written over several lines repeats on each.
export function claudeEntry(record) {
  const message = record?.message;
  const usage = message?.usage;
  if (record?.type !== 'assistant' || !usage || typeof message.model !== 'string' || message.model.startsWith('<')) return undefined;
  const at = Date.parse(record.timestamp);
  if (!Number.isFinite(at)) return undefined;
  const written = usage.cache_creation_input_tokens ?? 0;
  const kept = usage.cache_creation;
  const long = kept?.ephemeral_1h_input_tokens ?? 0;
  return {
    key: message.id ? `${message.id}:${record.requestId ?? ''}` : undefined,
    at,
    model: message.model,
    tokens: {
      input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: kept ? kept.ephemeral_5m_input_tokens ?? Math.max(0, written - long) : written, cacheWriteLong: long,
    },
  };
}

// The same of Codex's count of one response. Its input has what was read from a cache in it, and what
// was written to one, and its output has the reasoning.
export function codexTokens(usage = {}) {
  const cached = usage.cached_input_tokens ?? 0;
  const written = usage.cache_write_input_tokens ?? 0;
  return {
    input: Math.max(0, (usage.input_tokens ?? 0) - cached - written), output: usage.output_tokens ?? 0,
    cacheRead: cached, cacheWrite: written, cacheWriteLong: 0,
  };
}

// A day's tally for a model, or an hour's: [input, output, cache read, cache written, dollars, tokens
// with no price, dollars a cache saved].
const blank = () => [0, 0, 0, 0, 0, 0, 0];

// Adds what a request used at `at` to `into`: to its day among `days`, and to its hour among `hours`
// where that's no longer ago than `hoursFrom`, which is as far back as hours are told, each by the
// clock whose `offsetAt` it has. `tier` is the service tier it was run at, where the maker charges
// apart for one.
function tally(into, at, model, tokens, prices, sign = 1, tier = undefined) {
  const price = priceFor(prices, model);
  const cost = costOf(price, tokens, tier);
  const saved = savingsOf(price, tokens, tier);
  const all = tokens.input + tokens.output + (tokens.reasoning ?? 0) + tokens.cacheRead + tokens.cacheWrite + tokens.cacheWriteLong;
  const slots = [(into.days[dayOf(at, into.offsetAt)] ??= {})];
  if (at >= into.hoursFrom) slots.push((into.hours[hourOf(at, into.offsetAt)] ??= {}));
  for (const slot of slots) {
    const sum = (slot[model] ??= blank());
    sum[0] += sign * tokens.input;
    sum[1] += sign * (tokens.output + (tokens.reasoning ?? 0));
    sum[2] += sign * tokens.cacheRead;
    sum[3] += sign * (tokens.cacheWrite + tokens.cacheWriteLong);
    if (cost === undefined) sum[5] += sign * all;
    else sum[4] += sign * cost;
    sum[6] += sign * saved;
  }
}

// Calls `visit` with each whole line of `file` from `from` on, and gives where the last whole line
// ended: a line still being written is left for the next read. `goesOn` is asked between chunks.
export function eachLine(file, from, visit, goesOn = () => true) {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let position = from;
    let done = from;
    let carried = [];
    while (goesOn()) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!read) break;
      const view = chunk.subarray(0, read);
      let start = 0;
      for (let at = view.indexOf(NEWLINE); at !== -1; at = view.indexOf(NEWLINE, start)) {
        const rest = view.subarray(start, at);
        visit(carried.length ? Buffer.concat([...carried, rest]) : rest);
        carried = [];
        start = at + 1;
        done = position + start;
      }
      if (start < read) carried.push(Buffer.from(view.subarray(start)));
      position += read;
    }
    return done;
  } finally {
    fs.closeSync(fd);
  }
}

const parsed = line => {
  try {
    return JSON.parse(line.toString('utf8'));
  } catch {
    return undefined;
  }
};

const USAGE = Buffer.from('"usage"');
const ASSISTANT = Buffer.from('"assistant"');

// Reads on in one of Claude Code's transcripts. A request is counted once, by its last word on what it
// used, however many lines repeat it.
function readClaude(file, entry, { prices, goesOn, hoursFrom, offsetAt }) {
  const recent = new Map(entry.recent ?? []);
  const into = { days: entry.days, hours: (entry.hours ??= {}), hoursFrom, offsetAt };
  entry.offset = eachLine(file, entry.offset, line => {
    if (!line.includes(USAGE) || !line.includes(ASSISTANT)) return;
    const found = claudeEntry(parsed(line));
    if (!found) return;
    const before = found.key && recent.get(found.key);
    let { tokens } = found;
    if (before) {
      const [at, model, input, output, cacheRead, cacheWrite, cacheWriteLong] = before;
      tally(into, at, model, { input, output, cacheRead, cacheWrite, cacheWriteLong }, prices, -1);
      recent.delete(found.key);
      // Each kind of its tokens comes to the most any of its lines says, as a reply still being
      // written says less on its first lines than on its last.
      const said = { input, output, cacheRead, cacheWrite, cacheWriteLong };
      tokens = Object.fromEntries(Object.entries(tokens).map(([kind, count]) => [kind, Math.max(count, said[kind] ?? 0)]));
    }
    const { input, output, cacheRead, cacheWrite, cacheWriteLong } = tokens;
    tally(into, found.at, found.model, tokens, prices);
    if (found.key) {
      recent.set(found.key, [found.at, found.model, input, output, cacheRead, cacheWrite, cacheWriteLong]);
      if (recent.size > RECENT) recent.delete(recent.keys().next().value);
    }
  }, goesOn);
  entry.recent = [...recent];
}

const RECORD = Buffer.from('"token_usage_record"');
const SETTINGS = Buffer.from('"thread_settings_applied"');
const COUNT = Buffer.from('"token_count"');
const CONTEXT = Buffer.from('"turn_context"');

// Reads on in one of Codex's rollouts. A response's own record of what it used is what counts. A
// rollout from before Codex wrote those has its running count instead, said again whenever it's asked
// for, so there a count that hasn't grown is the one before. What's used is charged at the service
// tier the thread was last set to, as its fast modes are: `priority`, `ultrafast`.
function readCodex(file, entry, { prices, goesOn, hoursFrom, offsetAt }) {
  const own = { days: entry.days, hours: (entry.hours ??= {}), hoursFrom, offsetAt };
  const counted = { days: (entry.counted ??= {}), hours: (entry.countedHours ??= {}), hoursFrom, offsetAt };
  entry.offset = eachLine(file, entry.offset, line => {
    const isRecord = line.includes(RECORD);
    if (!isRecord && !line.includes(COUNT) && !line.includes(CONTEXT) && !line.includes(SETTINGS)) return;
    const record = parsed(line);
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') return;
    if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') entry.model = payload.model;
      return;
    }
    if (payload.type === 'thread_settings_applied') {
      const settings = payload.thread_settings ?? payload.threadSettings;
      const tier = settings?.service_tier ?? settings?.serviceTier;
      if (typeof tier === 'string') entry.tier = tier;
      return;
    }
    const at = Date.parse(record.timestamp);
    if (!Number.isFinite(at)) return;
    const model = entry.model ?? 'unknown';
    if (record.type === 'token_usage_record' && payload.usage) {
      entry.hasRecords = true;
      tally(own, at, model, codexTokens(payload.usage), prices, 1, entry.tier);
    } else if (record.type === 'event_msg' && payload.type === 'token_count') {
      // The account's limits as Codex last heard them, which come with the count.
      if (payload.rate_limits && (payload.rate_limits.primary || payload.rate_limits.secondary)) entry.limits = { at, ...payload.rate_limits };
      const total = payload.info?.total_token_usage?.total_tokens;
      if (payload.info?.last_token_usage && Number.isFinite(total) && total !== entry.total) {
        entry.total = total;
        tally(counted, at, model, codexTokens(payload.info.last_token_usage), prices, 1, entry.tier);
      }
    }
  }, goesOn);
}

// A message as Antigravity writes one down, field by field: each with its number, and its value where
// that's a number, or where its bytes are among `bytes`. Throws on bytes that aren't one.
export function* protoFields(bytes, from = 0, to = bytes.length) {
  let at = from;
  const varint = () => {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (at >= to) throw new Error('a number that runs off the end');
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (!(byte & 0x80)) return value;
    }
    throw new Error('a number with no end');
  };
  while (at < to) {
    const tag = varint();
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (wire === 0) {
      yield { number, value: varint() };
      continue;
    }
    const size = wire === 2 ? varint() : { 1: 8, 5: 4 }[wire];
    if (size === undefined || at + size > to) throw new Error('a field that runs off the end');
    yield { number, from: at, to: at + size, isBytes: wire === 2 };
    at += size;
  }
}

// One of a conversation's steps, as Antigravity keeps it (1.5.8): the name it goes by, and when it was.
export function antigravityStep(bytes) {
  try {
    let id;
    let seconds;
    let nanos = 0;
    for (const field of protoFields(bytes)) {
      if (field.number === 12 && field.isBytes) id = bytes.toString('utf8', field.from, field.to);
      if (field.number !== 1 || !field.isBytes) continue;
      for (const part of protoFields(bytes, field.from, field.to)) {
        if (part.number === 1 && part.value !== undefined) seconds = part.value;
        if (part.number === 2 && part.value !== undefined) nanos = part.value;
      }
    }
    return id && seconds > 0 ? { id, at: seconds * 1000 + Math.floor(nanos / 1e6) } : undefined;
  } catch {
    return undefined;
  }
}

// What one of the model's responses used, as Antigravity keeps it: the step it belongs to, the model,
// and the tokens, with what was read from a cache apart from the input and the reasoning apart from
// what was said.
export function antigravityTurn(bytes) {
  try {
    let step;
    let model;
    let used;
    for (const field of protoFields(bytes)) {
      if (field.number === 4 && field.isBytes) step = bytes.toString('utf8', field.from, field.to);
      if (field.number !== 1 || !field.isBytes) continue;
      for (const part of protoFields(bytes, field.from, field.to)) {
        if (part.number === 19 && part.isBytes) model = bytes.toString('utf8', part.from, part.to);
        if (part.number !== 4 || !part.isBytes) continue;
        used ??= {};
        for (const count of protoFields(bytes, part.from, part.to)) if (count.value !== undefined) used[count.number] = count.value;
      }
    }
    if (!used) return undefined;
    return {
      step, model,
      tokens: { input: used[2] ?? 0, output: used[10] ?? 0, reasoning: used[9] ?? 0, cacheRead: used[5] ?? 0, cacheWrite: 0, cacheWriteLong: 0 },
    };
  } catch {
    return undefined;
  }
}

const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
const SQLITE_BUFFER_BYTES = 512 << 20;
const SQLITE_TIMEOUT_MS = 20_000;

// Each row of a query of one of Antigravity's databases as its number and its bytes. The database is
// read as it is, with nothing written beside it, and where that can't be done as one that won't change.
function rowsOf(file, query) {
  const run = from => execFileSync(SQLITE, ['-readonly', from, query], {
    maxBuffer: SQLITE_BUFFER_BYTES, timeout: SQLITE_TIMEOUT_MS, encoding: 'latin1', stdio: ['ignore', 'pipe', 'ignore'],
  });
  let printed;
  try {
    printed = run(file);
  } catch {
    printed = run(`file:${file.split('/').map(encodeURIComponent).join('/')}?immutable=1`);
  }
  return printed.split('\n').filter(Boolean).map(line => Buffer.from(line.slice(line.indexOf('|') + 1), 'hex'));
}

// Counts one of Antigravity's conversations, which is a database with a row for each of the model's
// responses and a row for each step, where the time is. It's small, and a row of it can change, so
// it's counted whole each time it has changed.
function readAntigravity(file, entry, { prices, hoursFrom, offsetAt }) {
  const times = new Map(rowsOf(file, 'select idx, hex(metadata) from steps order by idx').map(antigravityStep).filter(Boolean).map(step => [step.id, step.at]));
  const into = { days: {}, hours: {}, hoursFrom, offsetAt };
  for (const turn of rowsOf(file, 'select idx, hex(data) from gen_metadata order by idx').map(antigravityTurn)) {
    const at = turn && times.get(turn.step);
    if (at) tally(into, at, turn.model ?? 'unknown', turn.tokens, prices);
  }
  entry.days = into.days;
  entry.hours = into.hours;
}

function filesUnder(folder, matches, found = []) {
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const file = path.join(folder, entry.name);
    if (entry.isDirectory()) filesUnder(file, matches, found);
    else if (entry.isFile() && matches(entry.name)) found.push(file);
  }
  return found;
}

// Where each agent keeps its chats: a session's subagents among Claude Code's, the threads put away
// among Codex's, and a database for each of Antigravity's conversations.
export function chatFolders(env = process.env, home = os.homedir()) {
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return {
    claude: [path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects')],
    codex: [path.join(codex, 'sessions'), path.join(codex, 'archived_sessions')],
    antigravity: [path.join(home, '.gemini', 'antigravity-cli', 'conversations')],
  };
}

// What was counted before by the clock of `zone`. What was counted by another is of no use: its days
// are other days.
function readKept(file, zone) {
  try {
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    return kept?.version === VERSION && kept.zone === zone && kept.files && typeof kept.files === 'object' ? kept : undefined;
  } catch {
    return undefined;
  }
}

// Where a clock's count is kept: this computer's own in `file`, and another's beside it, under the
// zone's name, so that readers in two zones each find theirs as they left it.
function keptFor(file, zone) {
  if (zone === hereName()) return file;
  const { dir, name, ext } = path.parse(file);
  return path.join(dir, `${name}.${zone.replace(/[^A-Za-z0-9_+-]/g, '_')}${ext}`);
}

// Another clock's count that hasn't been asked for in a month goes.
function forgetOldClocks(file, now) {
  const { dir, name, ext } = path.parse(file);
  let found;
  try {
    found = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const other of found) {
    if (!other.startsWith(`${name}.`) || !other.endsWith(ext) || other === `${name}${ext}`) continue;
    try {
      if (now - fs.statSync(path.join(dir, other)).mtimeMs > CLOCK_KEPT_MS) fs.unlinkSync(path.join(dir, other));
    } catch {
      // Gone already, or not to be had: it's looked at again next time.
    }
  }
}

function keep(file, kept) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(kept), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// How each agent's chats are told from what else is in its folders, and read. A transcript only grows,
// so it's read on from where it was. A database is written to in a file beside it before it's written
// to itself, so it has changed when either has.
const KINDS = {
  claude: { ends: '.jsonl', read: readClaude, grows: true },
  codex: { ends: '.jsonl', read: readCodex, grows: true },
  antigravity: { ends: '.db', read: readAntigravity, beside: '-wal' },
};

// A file's size and when it was last written to, with those of what's written beside it.
function stampOf(file, beside) {
  const stat = fs.statSync(file);
  let other;
  try {
    other = beside ? fs.statSync(`${file}${beside}`) : undefined;
  } catch {
    // Nothing beside it now.
  }
  return { size: stat.size, at: Math.max(stat.mtimeMs, other?.mtimeMs ?? 0), stamp: [stat.size, stat.mtimeMs, other?.size ?? 0, other?.mtimeMs ?? 0].join(':') };
}

// Reads what has been written since the last time, for as long as `budgetMs` allows, and gives each
// agent's count: `days` are the last ninety, today last, and `hours` the last twenty-four, this one
// last, by the clock of `zone`, a reader's time zone by its name, or this computer's own with none:
// see `clockOf`. `zone` in what's given is the one they're told by. For each agent `tokens` of each kind and `cost` in dollars are a number a day, and under
// `hourly` a number an hour, with `unpriced`, how many tokens the price list had no model for.
// `scanning` says there's more to read, which the next call goes on with. `codexLimits` are the limits
// Codex last wrote down, with `at`, when. A chat that's deleted is still counted, for the days it was
// used on.
export function readUsage({ file, zone, folders = chatFolders(), prices = {}, now = Date.now(), days: count = DAYS, budgetMs = Infinity, clock = Date.now } = {}) {
  const started = clock();
  const goesOn = () => clock() - started < budgetMs;
  const told = clockOf(zone);
  const { offsetAt } = told;
  const days = lastDays(count, now, offsetAt);
  const hours = lastHours(HOURS, now, offsetAt);
  const since = startOf(days[0], offsetAt);
  // What's as old as the first of the hours told, to the hour by that clock.
  const first = now - (HOURS - 1) * HOUR_MS;
  const hoursFrom = Math.floor((first + offsetAt(first)) / HOUR_MS) * HOUR_MS - offsetAt(first);
  const keptFile = file && keptFor(file, told.name);
  const kept = (keptFile && readKept(keptFile, told.name)) || { files: {} };
  const files = {};
  const waiting = [];
  for (const [agent, roots] of Object.entries(folders)) {
    const kind = KINDS[agent];
    if (!kind) continue;
    for (const chat of roots.flatMap(root => filesUnder(root, name => name.endsWith(kind.ends)))) {
      let found;
      try {
        found = stampOf(chat, kind.beside);
      } catch {
        continue;
      }
      if (found.at < since) continue;
      const before = kept.files[chat];
      // A transcript that's shorter than what was read of it was written anew.
      const entry = before && before.agent === agent && (!kind.grows || found.size >= before.offset) ? before : { agent, offset: 0, days: {} };
      files[chat] = entry;
      if (entry.stamp !== found.stamp && (!kind.grows || entry.offset < found.size)) waiting.push({ chat, entry, found });
    }
  }
  // What's told of is what's no longer ago than the first day and the first hour. The rest is let go.
  const tallies = entry => [[entry.days, days[0]], [entry.counted, days[0]], [entry.hours, hours[0]], [entry.countedHours, hours[0]]];
  const prune = entry => {
    for (const [slots, first] of tallies(entry)) {
      for (const slot of Object.keys(slots ?? {})) if (slot < first) delete slots[slot];
    }
  };
  // What was counted of a chat that's gone since is kept, for as long as it has a day among those shown.
  for (const [chat, entry] of Object.entries(kept.files)) {
    if (files[chat] || fs.existsSync(chat)) continue;
    prune(entry);
    if (Object.keys(entry.days ?? {}).length || Object.keys(entry.counted ?? {}).length) files[chat] = entry;
  }
  // The newest first, which have the days a reader looks at first.
  waiting.sort((a, b) => b.found.at - a.found.at);
  let scanning = false;
  for (const { chat, entry, found } of waiting) {
    if (!goesOn()) {
      scanning = true;
      break;
    }
    try {
      KINDS[entry.agent].read(chat, entry, { prices, goesOn, hoursFrom, offsetAt });
    } catch (error) {
      console.error(`usage: ${chat}: ${error.message}`);
      continue;
    }
    // Read to its end, it's left alone until it changes. A read that stopped short goes on next time.
    if (goesOn() || !KINDS[entry.agent].grows) entry.stamp = found.stamp;
    else scanning = true;
  }
  for (const entry of Object.values(files)) prune(entry);
  if (keptFile) {
    try {
      keep(keptFile, { version: VERSION, zone: told.name, files });
    } catch (error) {
      console.error(`usage: ${error.message}`);
    }
    forgetOldClocks(file, clock());
  }

  const blankSums = slots => ({
    tokens: { input: slots.map(() => 0), output: slots.map(() => 0), cacheRead: slots.map(() => 0), cacheWrite: slots.map(() => 0) },
    cost: slots.map(() => 0),
    saved: slots.map(() => 0),
  });
  const blankModel = () => ({ cost: days.map(() => 0), tokens: days.map(() => 0), unpriced: 0, hourly: { cost: hours.map(() => 0), tokens: hours.map(() => 0) } });
  const dayAt = new Map(days.map((day, at) => [day, at]));
  const hourAt = new Map(hours.map((hour, at) => [hour, at]));
  // Adds what was counted in each of `counted`'s slots to `sums`, and each model's cost and tokens to
  // `models`, by the day or by the hour, and gives the tokens with no price.
  const add = (sums, models, counted, places, isHourly) => {
    let unpriced = 0;
    for (const [slot, byModel] of Object.entries(counted ?? {})) {
      const at = places.get(slot);
      if (at === undefined) continue;
      for (const [model, [input, output, cacheRead, cacheWrite, cost, without, saved = 0]] of Object.entries(byModel)) {
        sums.tokens.input[at] += input;
        sums.tokens.output[at] += output;
        sums.tokens.cacheRead[at] += cacheRead;
        sums.tokens.cacheWrite[at] += cacheWrite;
        sums.cost[at] += cost;
        sums.saved[at] += saved;
        unpriced += without;
        const own = (models[model] ??= blankModel());
        const into = isHourly ? own.hourly : own;
        into.cost[at] += cost;
        into.tokens[at] += input + output + cacheRead + cacheWrite;
        if (!isHourly) own.unpriced += without;
      }
    }
    return unpriced;
  };
  const rounded = costs => costs.map(cost => Math.round(cost * 10000) / 10000);
  const agents = {};
  let codexLimits;
  for (const entry of Object.values(files)) {
    if (entry.limits && (!codexLimits || entry.limits.at > codexLimits.at)) codexLimits = entry.limits;
    // A rollout from before Codex wrote a record with each response is counted by its running count.
    const isCounted = entry.agent === 'codex' && !entry.hasRecords;
    const byDay = isCounted ? entry.counted : entry.days;
    if (!Object.keys(byDay ?? {}).length && !agents[entry.agent]) continue;
    const sums = (agents[entry.agent] ??= { ...blankSums(days), unpriced: 0, hourly: blankSums(hours), byModel: {} });
    sums.unpriced += add(sums, sums.byModel, byDay, dayAt, false);
    add(sums.hourly, sums.byModel, isCounted ? entry.countedHours : entry.hours, hourAt, true);
  }
  const sumOf = list => list.reduce((total, value) => total + value, 0);
  for (const sums of Object.values(agents)) {
    for (const part of [sums, sums.hourly]) {
      part.cost = rounded(part.cost);
      part.saved = rounded(part.saved);
    }
    // Each model that used anything in the days told, the costliest first.
    sums.models = Object.entries(sums.byModel)
      .filter(([, own]) => sumOf(own.tokens) > 0 || sumOf(own.cost) > 0)
      .map(([model, own]) => ({
        model, cost: rounded(own.cost), tokens: own.tokens, hourly: { cost: rounded(own.hourly.cost), tokens: own.hourly.tokens },
        ...(own.unpriced > 0 && { unpriced: own.unpriced }),
      }))
      .sort((a, b) => sumOf(b.cost) - sumOf(a.cost) || sumOf(b.tokens) - sumOf(a.tokens) || a.model.localeCompare(b.model));
    delete sums.byModel;
  }
  return { days, hours, zone: told.name, agents, scanning, ...(codexLimits && { codexLimits }) };
}

const WINDOWS = { 300: 'fiveHour', 10080: 'sevenDay' };

// The limits Codex wrote down with a count, as a list of what's used has them: each of the plan's two
// windows by how much of it was used and when it starts over, in Unix seconds. One that has started
// over since is at nothing. For when Codex isn't running to be asked.
export function limitsFromRollout(found, now = Date.now()) {
  if (!found) return undefined;
  const limits = [found.primary, found.secondary].flatMap(limit => {
    const window = WINDOWS[limit?.window_minutes];
    if (!window || !Number.isFinite(limit.used_percent)) return [];
    if (Number.isFinite(limit.resets_at) && limit.resets_at * 1000 <= now) return [{ window, percent: 0 }];
    return [{ window, percent: limit.used_percent, ...(Number.isFinite(limit.resets_at) && { resetsAt: limit.resets_at }) }];
  });
  if (!limits.length) return undefined;
  return { limits, ...(found.plan_type && { plan: found.plan_type }), updatedAt: Math.floor(found.at / 1000) };
}

const AGENTS = ['claude', 'codex', 'antigravity'];

// What a client is told: the days and the hours, with the time `zone` whose clock they're told by, and
// each agent that has anything to show with its tokens and cost by day, and under `hourly` by hour,
// where it keeps count, and its account's `limits`, where it has them. `shown` says which
// agents the client takes. `limits` are each agent's as it says them now: `{ limits, plan, credits,
// limitResets, updatedAt, reading }`. The plan is in each agent's own words: Codex's kind of plan
// ("plus"), the name Claude Code gives the account's ("Ultra"), and what Antigravity's greeting says
// beside the account ("Google AI Pro").
export function usageReply({ read, limits = {}, shown = () => true, now = Date.now() }) {
  const agents = AGENTS.filter(shown).flatMap(agent => {
    const used = read.agents?.[agent];
    const said = limits[agent] ?? (agent === 'codex' ? limitsFromRollout(read.codexLimits, now) : undefined);
    if (!used && !said?.limits?.length) return [];
    return [{
      agent,
      ...(used && {
        tokens: used.tokens, cost: used.cost, ...(used.saved && { saved: used.saved }), ...(used.hourly && { hourly: used.hourly }),
        ...(used.models && { models: used.models }), ...(used.unpriced > 0 && { unpriced: used.unpriced }),
      }),
      ...(said?.limits?.length && { limits: said.limits }),
      ...(said?.plan && { plan: said.plan }),
      ...(said?.credits && { credits: said.credits }),
      ...(said?.limitResets?.length && { limitResets: said.limitResets }),
      ...(said?.updatedAt && said.limits?.length && { limitsAt: said.updatedAt }),
    }];
  });
  const isReading = AGENTS.some(agent => limits[agent]?.reading);
  return {
    days: read.days, ...(read.hours && { hours: read.hours }), ...(read.zone && { zone: read.zone }), agents,
    scanning: Boolean(read.scanning || isReading), updatedAt: Math.floor(now / 1000),
  };
}

// How long a read may take before it answers with what it has. The next goes on from there.
const BUDGET_MS = 6000;
// What was read stands for this long, since each read goes through whatever has been written since.
const LIFETIME_MS = 30_000;

async function runWorker(request, { signal } = {}) {
  const reading = exec(process.execPath, [WORKER, JSON.stringify(request)], { timeout: WORKER_TIMEOUT_MS, maxBuffer: WORKER_BUFFER_BYTES, signal });
  const { child } = reading;
  // One ended by the helper stopping is told so as soon as it's asked to end, and is waited for until its
  // process has gone, so that it writes nothing after.
  const gone = new Promise(resolve => child.once('exit', resolve));
  let stdout;
  try {
    ({ stdout } = await reading);
  } catch (error) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) await gone;
    throw error;
  }
  const { error, ...reply } = JSON.parse(stdout);
  if (error) throw new HelperError(error.code, error.message);
  return reply;
}

// The reads, one at a time for each clock they're told by, and in a process of their own, since the
// chats they go through can be gigabytes. `run` runs one and gives what it printed. `prices` is asked
// to look at the list again before each, which it does once a day, and what it finds is for the read
// after.
export class UsageBook {
  #run;
  #prices;
  #request;
  #now;
  #kept = new Map();
  #reading = new Map();
  // Ends a read going on when the helper stops.
  #stopping = new AbortController();

  constructor({ file, pricesFile, prices, run = runWorker, budgetMs = BUDGET_MS, now = Date.now }) {
    this.#run = run;
    this.#prices = prices;
    this.#request = { file, pricesFile, budgetMs };
    this.#now = now;
  }

  // `zone` is the reader's time zone by its name, where it says one.
  async read(zone) {
    const clock = zone ?? '';
    const kept = this.#kept.get(clock);
    // One that stopped short is gone on with at once.
    if (kept && !kept.read.scanning && this.#now() - kept.at < LIFETIME_MS) return kept.read;
    this.#prices?.refresh().catch(() => {});
    if (!this.#reading.has(clock)) {
      this.#reading.set(clock, this.#run({ ...this.#request, ...(zone && { zone }) }, { signal: this.#stopping.signal }).then(read => {
        this.#kept.set(clock, { at: this.#now(), read });
        return read;
      }).finally(() => { this.#reading.delete(clock); }));
    }
    return this.#reading.get(clock);
  }

  // Ends the reads going on, and waits for them, so that none writes what it counted once the helper has
  // gone: its folder may be gone too, as when Venes is uninstalled, and the read would make it again.
  async stop() {
    this.#stopping.abort();
    await Promise.allSettled(this.#reading.values());
  }
}
