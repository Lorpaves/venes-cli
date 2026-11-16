import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  UsageBook, antigravityStep, antigravityTurn, chatFolders, claudeEntry, codexTokens, dayOf, eachLine, hourOf, lastDays, lastHours, limitsFromRollout,
  protoFields, readUsage, usageReply,
} from '../../src/usage.mjs';

const WORKER = fileURLToPath(new URL('../../src/usage-worker.mjs', import.meta.url));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Noon, so many days ago, where this computer is: a day there, whatever its time zone.
const NOW = Date.now();
function noon(daysAgo = 0) {
  const date = new Date(NOW);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - daysAgo);
  return date;
}
const stamp = daysAgo => noon(daysAgo).toISOString();

const PRICES = {
  'gemini-4-hydrogen': { input: 1.5e-6, output: 1e-5, reasoning: 7.5e-6, cacheRead: 1.5e-7 },
  'claude-opus-5-5': { input: 4e-6, output: 2e-5, cacheRead: 2e-7, cacheWrite: 5e-6, cacheWriteLong: 8e-6 },
  'gpt-6-astra': { input: 1e-5, output: 5e-5, cacheRead: 1e-6, over: { tokens: 272000, input: 2e-5, output: 7.5e-5, cacheRead: 2e-6 } },
};

// A reply in Claude Code's transcript, as it writes one: on a line for each part of it, each with the
// request's whole count.
const reply = ({ id, request = `req_${id}`, daysAgo = 0, at = undefined, model = 'claude-opus-5-5', usage, sidechain = false }) => JSON.stringify({
  type: 'assistant', uuid: `${id}-${Math.random()}`, timestamp: at === undefined ? stamp(daysAgo) : new Date(at).toISOString(), requestId: request, isSidechain: sidechain,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'a "usage" in words is no count' }], usage },
});
const said = text => JSON.stringify({ type: 'user', timestamp: stamp(0), message: { role: 'user', content: `${text} "usage" "assistant"` } });
const USED = { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 400 } };

// The lines of a Codex rollout that say what was used.
const context = (model = 'gpt-6-astra') => JSON.stringify({ type: 'turn_context', timestamp: stamp(0), payload: { model, cwd: '/code' } });
const record = (usage, daysAgo = 0) => JSON.stringify({ type: 'token_usage_record', timestamp: stamp(daysAgo), ordinal: 1, payload: { usage, thread_token_usage: usage } });
const count = (last, total, { daysAgo = 0, limits } = {}) => JSON.stringify({
  type: 'event_msg', timestamp: stamp(daysAgo),
  payload: { type: 'token_count', info: last && { last_token_usage: last, total_token_usage: { total_tokens: total } }, rate_limits: limits ?? null },
});
const SPENT = { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 20, total_tokens: 1050 };

// What Antigravity keeps in a conversation's database, written as it writes it: a message is its fields
// one after the other, each a number or some bytes.
const varint = value => {
  const bytes = [];
  for (let left = value; ; left = Math.floor(left / 128)) {
    bytes.push(left >= 128 ? (left % 128) | 0x80 : left);
    if (left < 128) return Buffer.from(bytes);
  }
};
const number = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytesOf = (field, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};
const text = (field, value) => bytesOf(field, Buffer.from(value));
const step = (id, at) => Buffer.concat([bytesOf(1, number(1, Math.floor(at / 1000)), number(2, (at % 1000) * 1e6)), number(3, 7), text(12, id)]);
const turn = (id, model, { input = 0, cacheRead = 0, reasoning = 0, output = 0 }) => Buffer.concat([
  bytesOf(1, text(2, 'a prompt that is none of the count'), bytesOf(4, number(1, 1298), number(2, input), number(5, cacheRead), number(9, reasoning), number(10, output), text(11, 'resp')), text(19, model), text(21, 'Its Name')),
  text(4, id),
]);
const SQLITE = fs.existsSync('/usr/bin/sqlite3') ? '/usr/bin/sqlite3' : 'sqlite3';
const hasSqlite = (() => {
  try {
    execFileSync(SQLITE, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
// A conversation's database, with its steps and what each response used.
function conversation(file, steps, turns) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  const rows = (table, list) => list.map((bytes, idx) => `insert into ${table} values (${idx}, x'${bytes.toString('hex')}');`).join(' ');
  execFileSync(SQLITE, [file, `create table steps (idx integer, metadata blob); create table gen_metadata (idx integer, data blob); ${rows('steps', steps)} ${rows('gen_metadata', turns)}`]);
  return file;
}

function setup(t) {
  const dir = tempDir(t);
  const folders = {
    claude: [path.join(dir, 'claude', 'projects')], codex: [path.join(dir, 'codex', 'sessions'), path.join(dir, 'codex', 'archived_sessions')],
    antigravity: [path.join(dir, 'gemini', 'conversations')],
  };
  const write = (file, lines, { append = false } = {}) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs[append ? 'appendFileSync' : 'writeFileSync'](file, lines.map(line => `${line}\n`).join(''));
    return file;
  };
  const file = path.join(dir, 'helper', 'usage.json');
  const read = (options = {}) => readUsage({ file, folders, prices: PRICES, now: NOW, ...options });
  return { dir, folders, write, file, read };
}
const sum = list => list.reduce((total, value) => total + value, 0);
// A day's cost is told to a hundredth of a cent.
const near = (actual, expected, what) => assert.ok(Math.abs(actual - expected) <= 5.1e-5, `${what ?? ''} ${actual} is not ${expected}`);

test('a moment is on the day it falls where the computer is, and the last days end today', () => {
  assert.equal(dayOf(new Date(2026, 10, 16, 0, 0, 1).getTime()), '2026-11-16');
  assert.equal(dayOf(new Date(2026, 10, 16, 23, 59, 59).getTime()), '2026-11-16');
  assert.equal(dayOf(new Date(2026, 0, 5, 9).getTime()), '2026-01-05');
  const days = lastDays(30, new Date(2026, 2, 3, 0, 5).getTime());
  assert.equal(days.length, 30);
  assert.deepEqual([days[0], days.at(-2), days.at(-1)], ['2026-02-02', '2026-03-02', '2026-03-03']);
  assert.equal(new Set(days).size, 30);
  assert.deepEqual(lastDays(1, new Date(2026, 10, 16, 23, 59).getTime()), ['2026-11-16']);
  // An hour is told by its day and its number, and the last of them is this one.
  assert.equal(hourOf(new Date(2026, 10, 16, 9, 59, 59).getTime()), '2026-11-16T09');
  const hours = lastHours(24, new Date(2026, 10, 16, 15, 30).getTime());
  assert.deepEqual([hours.length, hours[0], hours.at(-2), hours.at(-1)], [24, '2026-11-15T16', '2026-11-16T14', '2026-11-16T15']);
  assert.deepEqual(lastHours(3, new Date(2026, 0, 1, 1, 5).getTime()), ['2025-12-31T23', '2026-01-01T00', '2026-01-01T01']);
});

test('a reply in a transcript says what its request used, by the kinds a price is listed for', () => {
  const found = claudeEntry(JSON.parse(reply({ id: 'msg_1', usage: USED })));
  assert.deepEqual(found.tokens, { input: 10, output: 200, cacheRead: 3000, cacheWrite: 100, cacheWriteLong: 400 });
  assert.deepEqual([found.key, found.model, found.at], ['msg_1:req_msg_1', 'claude-opus-5-5', noon(0).getTime()]);
  // From before Claude Code said how long what it cached would stay: all of it for minutes.
  assert.deepEqual(claudeEntry(JSON.parse(reply({ id: 'msg_2', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 30 } }))).tokens,
    { input: 1, output: 2, cacheRead: 0, cacheWrite: 30, cacheWriteLong: 0 });
  for (const other of [
    JSON.parse(said('hello')), { type: 'assistant', timestamp: stamp(0), message: { id: 'x', model: 'claude-opus-5-5' } },
    JSON.parse(reply({ id: 'msg_3', model: '<synthetic>', usage: USED })), { type: 'assistant', message: { id: 'x', model: 'm', usage: USED } }, undefined, null, 5,
  ]) assert.equal(claudeEntry(other), undefined);
});

test('Codex counts what was cached among a response\'s input', () => {
  assert.deepEqual(codexTokens(SPENT), { input: 400, output: 50, cacheRead: 600, cacheWrite: 0, cacheWriteLong: 0 });
  assert.deepEqual(codexTokens({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 300, output_tokens: 5 }), { input: 100, output: 5, cacheRead: 600, cacheWrite: 300, cacheWriteLong: 0 });
  assert.deepEqual(codexTokens(), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteLong: 0 });
});

test('a file is read by whole lines from where the last read ended', t => {
  const dir = tempDir(t);
  const file = path.join(dir, 'lines.jsonl');
  // One line longer than what's read at a time, and a last one still being written.
  const long = 'x'.repeat((1 << 20) + 4321);
  fs.writeFileSync(file, `first\n${long}\nthird\nhalf a li`);
  const seen = [];
  const end = eachLine(file, 0, line => seen.push(line.toString()));
  assert.deepEqual(seen.map(line => line.length), [5, long.length, 5]);
  assert.equal(seen[1], long);
  assert.equal(end, 6 + long.length + 1 + 6);
  fs.appendFileSync(file, 'ne\nfifth\n');
  const more = [];
  assert.equal(eachLine(file, end, line => more.push(line.toString())), fs.statSync(file).size);
  assert.deepEqual(more, ['half a line', 'fifth']);
  assert.equal(eachLine(file, fs.statSync(file).size, () => assert.fail('nothing new')), fs.statSync(file).size);
  // Stopped between two reads, it says how far it got, and nothing of a line it had only part of.
  let asked = 0;
  const some = [];
  const stopped = eachLine(file, 0, line => some.push(line.toString()), () => asked++ < 1);
  assert.deepEqual([some, stopped], [['first'], 6]);
});

test('each agent\'s chats are counted by day, a request once, and costed by the price list', t => {
  const { folders, write, read, file } = setup(t);
  const session = path.join(folders.claude[0], '-code-demo', 'aaaa.jsonl');
  write(session, [
    said('hello'),
    // One reply on three lines, each with the request's whole count.
    reply({ id: 'msg_1', usage: USED }), reply({ id: 'msg_1', usage: USED }), reply({ id: 'msg_1', usage: USED }),
    said('a tool\'s result'),
    reply({ id: 'msg_2', daysAgo: 2, usage: { input_tokens: 1000, output_tokens: 1000 } }),
    // What Claude Code writes for a reply that's none of a model's.
    reply({ id: 'msg_3', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }),
    'not json at all "usage" "assistant"',
    reply({ id: 'msg_4', daysAgo: 100, usage: { input_tokens: 7, output_tokens: 7 } }),
  ]);
  // A subagent's replies are in a file of its own, and nowhere else.
  write(path.join(folders.claude[0], '-code-demo', 'aaaa', 'subagents', 'agent-1.jsonl'), [reply({ id: 'msg_s', usage: { input_tokens: 5, output_tokens: 5 }, sidechain: true })]);
  // A model the list has no price for is counted, and said to have none.
  write(path.join(folders.claude[0], '-code-other', 'bbbb.jsonl'), [reply({ id: 'msg_u', model: 'claude-unlisted-9', usage: { input_tokens: 40, output_tokens: 2 } })]);
  write(path.join(folders.claude[0], '-code-other', 'notes.txt'), [reply({ id: 'msg_t', usage: USED })]);

  write(path.join(folders.codex[0], '2026', '11', '16', 'rollout-a.jsonl'), [
    JSON.stringify({ type: 'session_meta', timestamp: stamp(1), payload: { id: 't1' } }),
    context(), record(SPENT, 1), count(SPENT, 1050, { daysAgo: 1 }),
    // A response over the size the maker charges more from.
    record({ input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 1000, total_tokens: 301_000 }),
    count({ input_tokens: 300_000, cached_input_tokens: 100_000, output_tokens: 1000 }, 302_050),
  ]);
  // From before Codex wrote a record with each response: its running count, said twice here.
  write(path.join(folders.codex[1], 'rollout-old.jsonl'), [
    context(), count(SPENT, 1050, { daysAgo: 3 }), count(SPENT, 1050, { daysAgo: 3 }), count(null, 0, { daysAgo: 3 }),
    count({ input_tokens: 10, cached_input_tokens: 0, output_tokens: 1 }, 1061, { daysAgo: 3 }),
  ]);

  const found = read();
  assert.equal(found.scanning, false);
  assert.deepEqual([found.days.length, found.days.at(-1), found.hours.length, found.hours.at(-1)], [90, dayOf(NOW), 24, hourOf(NOW)]);
  const { claude, codex } = found.agents;
  assert.deepEqual(Object.keys(found.agents).sort(), ['claude', 'codex']);
  assert.deepEqual([claude.tokens.input.at(-1), claude.tokens.output.at(-1), claude.tokens.cacheRead.at(-1), claude.tokens.cacheWrite.at(-1)], [10 + 5 + 40, 200 + 5 + 2, 3000, 500]);
  assert.deepEqual([claude.tokens.input.at(-3), claude.tokens.output.at(-3)], [1000, 1000]);
  assert.equal(sum(claude.tokens.input), 1055, 'nothing from longer ago than the days shown');
  near(claude.cost.at(-1), 10 * 4e-6 + 200 * 2e-5 + 3000 * 2e-7 + 100 * 5e-6 + 400 * 8e-6 + 5 * 4e-6 + 5 * 2e-5, 'today');
  near(claude.cost.at(-3), 1000 * 4e-6 + 1000 * 2e-5, 'two days ago');
  assert.equal(claude.unpriced, 42);
  assert.deepEqual([codex.tokens.input.at(-2), codex.tokens.cacheRead.at(-2), codex.tokens.output.at(-2)], [400, 600, 50]);
  assert.deepEqual([codex.tokens.input.at(-1), codex.tokens.cacheRead.at(-1), codex.tokens.output.at(-1)], [200_000, 100_000, 1000]);
  near(codex.cost.at(-1), 200_000 * 2e-5 + 100_000 * 2e-6 + 1000 * 7.5e-5, 'the long request');
  near(codex.cost.at(-2), 400 * 1e-5 + 600 * 1e-6 + 50 * 5e-5, 'yesterday');
  assert.deepEqual([codex.tokens.input.at(-4), codex.tokens.cacheRead.at(-4), codex.tokens.output.at(-4)], [410, 600, 51], 'a count that has not grown is the one before');
  assert.equal(codex.unpriced, 0);
  assert.equal(fs.statSync(file).mode & 0o777, process.platform === 'win32' ? fs.statSync(file).mode & 0o777 : 0o600);

  // Asked again with nothing new, it reads no chat: one that can't be read any more would have said so.
  const errors = t.mock.method(console, 'error', () => {});
  const chmod = fs.statSync(session).mode;
  fs.chmodSync(session, 0o000);
  assert.deepEqual(read().agents, found.agents);
  fs.chmodSync(session, chmod);
  assert.equal(errors.mock.callCount(), 0);

  // A reply whose lines say less of a kind of token later than earlier is counted by the most they say.
  write(session, [reply({ id: 'msg_6', usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 900 } }), reply({ id: 'msg_6', usage: { input_tokens: 0, output_tokens: 20 } })], { append: true });
  const merged = read();
  assert.deepEqual([merged.agents.claude.tokens.input.at(-1), merged.agents.claude.tokens.output.at(-1), merged.agents.claude.tokens.cacheRead.at(-1)], [55 + 50, 207 + 20, 3000 + 900]);
  // What's written since is added, and the reply that was on its last lines is still counted once.
  write(session, [reply({ id: 'msg_4', usage: { input_tokens: 7, output_tokens: 7 } }), reply({ id: 'msg_5', usage: { input_tokens: 100, output_tokens: 0 } }), reply({ id: 'msg_5', usage: { input_tokens: 100, output_tokens: 30 } })], { append: true });
  const later = read();
  assert.deepEqual([later.agents.claude.tokens.input.at(-1), later.agents.claude.tokens.output.at(-1)], [55 + 50 + 7 + 100, 207 + 20 + 7 + 30], 'its last word on what it used is what counts');
  assert.deepEqual(later.agents.codex, found.agents.codex);

  // Written anew and shorter, a chat is counted from its start.
  write(session, [reply({ id: 'msg_9', usage: { input_tokens: 1, output_tokens: 1 } })]);
  const anew = read();
  assert.deepEqual([anew.agents.claude.tokens.input.at(-1), anew.agents.claude.tokens.output.at(-1), sum(anew.agents.claude.tokens.input)], [1 + 5 + 40, 1 + 5 + 2, 46]);

  // Deleted, what it used was still used, and stays counted.
  fs.rmSync(session);
  assert.equal(sum(read().agents.claude.tokens.input), 46);
  assert.equal(sum(read().agents.claude.tokens.input), 46);
  // Until its days are all longer ago than those shown.
  assert.equal(sum(read({ now: NOW + 100 * 24 * 60 * 60 * 1000 }).agents.claude?.tokens.input ?? []), 0);
});

test('a message of Antigravity\'s is read field by field, and one that isn\'t a message is no count', () => {
  const at = noon(1).getTime() + 250;
  assert.deepEqual(antigravityStep(step('step-1', at)), { id: 'step-1', at });
  assert.deepEqual(antigravityTurn(turn('step-1', 'gemini-4-hydrogen', { input: 300, cacheRead: 2000, reasoning: 40, output: 10 })), {
    step: 'step-1', model: 'gemini-4-hydrogen', tokens: { input: 300, output: 10, reasoning: 40, cacheRead: 2000, cacheWrite: 0, cacheWriteLong: 0 },
  });
  // A number of more than seven bits takes more than a byte, and a field of other bytes is passed over.
  assert.deepEqual([...protoFields(Buffer.concat([number(1, 300), Buffer.from([0x15, 1, 2, 3, 4]), Buffer.from([0x19, 1, 2, 3, 4, 5, 6, 7, 8]), text(2, 'hi')]))].map(field => [field.number, field.value, field.isBytes]),
    [[1, 300, undefined], [2, undefined, false], [3, undefined, false], [2, undefined, true]]);
  for (const bad of [Buffer.from([0x0a, 0x05, 1]), Buffer.from([0x08]), Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x0b, 1])]) {
    assert.throws(() => [...protoFields(bad)]);
    assert.equal(antigravityStep(bad), undefined);
    assert.equal(antigravityTurn(bad), undefined);
  }
  // A step with no time, or no name, places nothing, and a response with no count is none.
  assert.equal(antigravityStep(text(12, 'step-1')), undefined);
  assert.equal(antigravityStep(bytesOf(1, number(1, 1_800_000_000))), undefined);
  assert.equal(antigravityTurn(Buffer.concat([bytesOf(1, text(19, 'gemini-4-hydrogen')), text(4, 'step-1')])), undefined);
  assert.equal(antigravityTurn(Buffer.alloc(0)), undefined);
});

test('Antigravity\'s conversations are counted from their databases, each response on the day of its step', { skip: !hasSqlite && 'no sqlite3 here' }, t => {
  const { folders, read } = setup(t);
  const chat = path.join(folders.antigravity[0], 'aaaa.db');
  const first = [step('s1', noon(1).getTime()), step('s2', noon(0).getTime()), Buffer.from('not a step')];
  conversation(chat, first, [
    turn('s1', 'gemini-4-hydrogen', { input: 1000, cacheRead: 5000, reasoning: 200, output: 100 }),
    turn('s2', 'gemini-4-hydrogen', { input: 10, output: 1 }),
    // A model the price list has nothing for, a response with no step to say when it was, and a row that's no response.
    turn('s2', 'gemini-flash-worker-agy', { input: 7, output: 3 }), turn('s9', 'gemini-4-hydrogen', { input: 999 }), Buffer.from('nor this'),
  ]);
  const found = read();
  const { antigravity } = found.agents;
  assert.deepEqual(Object.keys(found.agents), ['antigravity']);
  assert.deepEqual([antigravity.tokens.input.at(-2), antigravity.tokens.cacheRead.at(-2), antigravity.tokens.output.at(-2)], [1000, 5000, 300], 'the reasoning is output');
  assert.deepEqual([antigravity.tokens.input.at(-1), antigravity.tokens.output.at(-1), antigravity.unpriced], [17, 4, 10]);
  // The reasoning at its own price, where the maker lists one.
  near(antigravity.cost.at(-2), 1000 * 1.5e-6 + 5000 * 1.5e-7 + 200 * 7.5e-6 + 100 * 1e-5, 'yesterday');
  assert.deepEqual(read().agents, found.agents);

  // It's counted whole again when it has changed, since a row of it can: here its second response has grown.
  conversation(chat, first, [turn('s1', 'gemini-4-hydrogen', { input: 1000, cacheRead: 5000, reasoning: 200, output: 100 }), turn('s2', 'gemini-4-hydrogen', { input: 10, output: 50 })]);
  const later = read();
  assert.deepEqual([later.agents.antigravity.tokens.input.at(-1), later.agents.antigravity.tokens.output.at(-1), later.agents.antigravity.unpriced], [10, 50, 0]);

  // What isn't a database of its conversations is passed over, with a word in the log.
  const errors = t.mock.method(console, 'error', () => {});
  fs.writeFileSync(path.join(folders.antigravity[0], 'bbbb.db'), 'not a database');
  assert.deepEqual(read().agents.antigravity, later.agents.antigravity);
  assert.equal(errors.mock.callCount(), 1);
});

test('Codex\'s fast modes are charged at their own prices, from when the thread was set to one', t => {
  const { folders, write, read } = setup(t);
  const tiered = { ...PRICES, 'gpt-6-astra': { ...PRICES['gpt-6-astra'], tiers: { priority: { input: 2e-5, output: 1e-4, cacheRead: 2e-6 }, ultrafast: { input: 6e-5, output: 3e-4, cacheRead: 6e-6 } } } };
  const settings = (tier, key = 'service_tier') => JSON.stringify({ type: 'event_msg', timestamp: stamp(0), payload: { type: 'thread_settings_applied', thread_id: 't', thread_settings: { [key]: tier, model: 'gpt-6-astra' } } });
  const rollout = path.join(folders.codex[0], 'rollout-a.jsonl');
  write(rollout, [context(), record(SPENT), settings('priority'), record(SPENT), JSON.stringify({ type: 'event_msg', timestamp: stamp(0), payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6-astra' } } }), record(SPENT)]);
  const usual = 400 * 1e-5 + 600 * 1e-6 + 50 * 5e-5;
  const priority = 400 * 2e-5 + 600 * 2e-6 + 50 * 1e-4;
  near(read({ prices: tiered }).agents.codex.cost.at(-1), usual + 2 * priority, 'a setting that says nothing of the tier leaves it as it was');
  // The tier holds for what's written later, read where the last read left off.
  write(rollout, [settings('ultrafast'), record(SPENT), settings('default'), record(SPENT)], { append: true });
  near(read({ prices: tiered }).agents.codex.cost.at(-1), 2 * usual + 2 * priority + (400 * 6e-5 + 600 * 6e-6 + 50 * 3e-4));
});

test('a chat nobody has written to since before the days shown is left unread', t => {
  const { folders, write, read } = setup(t);
  const old = write(path.join(folders.claude[0], '-code', 'old.jsonl'), [reply({ id: 'msg_1', daysAgo: 100, usage: USED })]);
  const then = noon(100);
  fs.utimesSync(old, then, then);
  assert.deepEqual(read(), { days: lastDays(90, NOW), hours: lastHours(24, NOW), agents: {}, scanning: false });
  assert.deepEqual(readUsage({ folders: { claude: [path.join(folders.claude[0], 'nowhere')] }, now: NOW }).agents, {});
});

test('what was used in the last day is counted by the hour too', t => {
  const { folders, write, read } = setup(t);
  const hour = 60 * 60 * 1000;
  const session = write(path.join(folders.claude[0], '-code', 'a.jsonl'), [
    reply({ id: 'msg_1', at: NOW - 2 * hour, usage: { input_tokens: 5, output_tokens: 50 } }),
    // One reply on two lines, and one from the day before the hours told, which is in its day alone.
    reply({ id: 'msg_2', at: NOW - 1000, usage: { input_tokens: 1, output_tokens: 10 } }), reply({ id: 'msg_2', at: NOW - 1000, usage: { input_tokens: 1, output_tokens: 10 } }),
    reply({ id: 'msg_3', at: NOW - 30 * hour, usage: { input_tokens: 1000, output_tokens: 0 } }),
  ]);
  write(path.join(folders.codex[0], 'rollout-a.jsonl'), [context(), JSON.stringify({ type: 'token_usage_record', timestamp: new Date(NOW - 2 * hour).toISOString(), payload: { usage: SPENT } })]);
  const found = read();
  const { claude, codex } = found.agents;
  assert.equal(found.hours.at(-1), hourOf(NOW));
  const at = hours => found.hours.indexOf(hourOf(NOW - hours * hour));
  assert.deepEqual([claude.hourly.tokens.input[at(2)], claude.hourly.tokens.output[at(2)]], [5, 50]);
  assert.deepEqual([claude.hourly.tokens.input[at(0)], claude.hourly.tokens.output[at(0)]], [1, 10]);
  assert.deepEqual([sum(claude.hourly.tokens.input), sum(claude.tokens.input)], [6, 1006]);
  near(claude.hourly.cost[at(2)], 5 * 4e-6 + 50 * 2e-5, 'two hours ago');
  assert.deepEqual([codex.hourly.tokens.input[at(2)], codex.hourly.tokens.cacheRead[at(2)], sum(codex.hourly.cost) > 0], [400, 600, true]);
  assert.equal(claude.hourly.cost.length, found.hours.length);

  // An hour that's a day old by the next read is told no more, and what was used in it stays in its day.
  const later = read({ now: NOW + 23 * hour });
  assert.deepEqual([sum(later.agents.claude.hourly.tokens.input), sum(later.agents.claude.tokens.input)], [1, 1006]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(path.dirname(folders.claude[0]), '..', 'helper', 'usage.json'), 'utf8')).files[session].hours), [hourOf(NOW - 1000)]);
});

test('what a cache saved, and each model\'s part, are told by the day and by the hour', t => {
  const { folders, write, read } = setup(t);
  const hour = 60 * 60 * 1000;
  write(path.join(folders.claude[0], '-code', 'a.jsonl'), [
    reply({ id: 'msg_1', at: NOW - hour, usage: { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1_000_000 } }),
    reply({ id: 'msg_2', daysAgo: 2, model: 'claude-unlisted-9', usage: { input_tokens: 5000, output_tokens: 0 } }),
  ]);
  write(path.join(folders.codex[0], 'rollout-a.jsonl'), [context(), record(SPENT, 1)]);
  const found = read();
  const { claude, codex } = found.agents;
  const at = found.hours.indexOf(hourOf(NOW - hour));
  // Claude's cache read saved what it would have cost as input, less what it did cost.
  near(claude.saved.at(-1), 1_000_000 * (4e-6 - 2e-7), 'today');
  near(claude.hourly.saved[at], 1_000_000 * (4e-6 - 2e-7), 'that hour');
  near(codex.saved.at(-2), 600 * (1e-5 - 1e-6), 'yesterday');
  assert.equal(sum(claude.saved.slice(0, -1)), 0);
  // Each model, the costliest first, with its cost and all its tokens by the day and by the hour.
  assert.deepEqual(claude.models.map(own => own.model), ['claude-opus-5-5', 'claude-unlisted-9']);
  const [opus, unlisted] = claude.models;
  assert.deepEqual([opus.tokens.at(-1), opus.hourly.tokens[at], unlisted.tokens.at(-3), sum(unlisted.cost)], [1_000_110, 1_000_110, 5000, 0]);
  // One the price list has nothing for says how many of its tokens that was, and one it has says nothing.
  assert.deepEqual([unlisted.unpriced, 'unpriced' in opus], [5000, false]);
  near(opus.cost.at(-1), 10 * 4e-6 + 100 * 2e-5 + 1_000_000 * 2e-7, 'its cost');
  assert.deepEqual([opus.cost.length, opus.hourly.cost.length], [90, 24]);
  assert.deepEqual(codex.models.map(own => [own.model, sum(own.tokens)]), [['gpt-6-astra', 1050]]);
  // And so they're told to a client.
  const told = usageReply({ read: found, now: NOW }).agents.find(agent => agent.agent === 'claude');
  assert.deepEqual([told.saved, told.models], [claude.saved, claude.models]);
});

test('a read stops when its time is up, says so, and the next goes on from there', t => {
  const { folders, write, read } = setup(t);
  const big = Array.from({ length: 3 }, (_, i) => reply({ id: `msg_${i}`, usage: { input_tokens: 1, output_tokens: 1 } }));
  for (const name of ['a', 'b', 'c', 'd']) write(path.join(folders.claude[0], '-code', `${name}.jsonl`), big);
  // A clock that moves on a little each time it's looked at: time for two chats, and no more.
  const ticking = (step, time = 0) => () => (time += step);
  const first = read({ budgetMs: 10, clock: ticking(1.9) });
  assert.equal(first.scanning, true);
  const sofar = sum(first.agents.claude.tokens.input);
  assert.ok(sofar > 0 && sofar < 12, `${sofar}`);
  let reads = 1;
  let last = first;
  while (last.scanning && reads < 10) {
    last = read({ budgetMs: 10, clock: ticking(1.9) });
    reads++;
  }
  assert.equal(last.scanning, false);
  assert.ok(reads > 1 && reads < 10, `${reads}`);
  assert.equal(sum(last.agents.claude.tokens.input), 12);
  assert.equal(sum(read().agents.claude.tokens.input), 12);
});

test('the limits Codex wrote down with a count stand in for it when it isn\'t running', t => {
  const { folders, write, read } = setup(t);
  const soon = Math.floor(NOW / 1000) + 3600;
  const past = Math.floor(NOW / 1000) - 60;
  const limits = { primary: { used_percent: 42, window_minutes: 300, resets_at: soon }, secondary: { used_percent: 50, window_minutes: 10080, resets_at: past }, plan_type: 'plus', credits: null };
  write(path.join(folders.codex[0], 'rollout-a.jsonl'), [context(), count(SPENT, 1050, { daysAgo: 2, limits: { primary: { used_percent: 1, window_minutes: 300 } } })]);
  write(path.join(folders.codex[0], 'rollout-b.jsonl'), [context(), count(SPENT, 1050, { daysAgo: 0, limits }), count(SPENT, 2100, { daysAgo: 1, limits: { primary: null, secondary: null } })]);
  const found = read();
  assert.deepEqual(found.codexLimits, { at: noon(0).getTime(), ...limits });
  assert.deepEqual(limitsFromRollout(found.codexLimits, NOW), {
    limits: [{ window: 'fiveHour', percent: 42, resetsAt: soon }, { window: 'sevenDay', percent: 0 }], plan: 'plus', updatedAt: Math.floor(noon(0).getTime() / 1000),
  });
  assert.equal(limitsFromRollout(undefined), undefined);
  assert.equal(limitsFromRollout({ at: 1, primary: { used_percent: 5, window_minutes: 60 } }), undefined, 'a window that is neither of the plan\'s two');
});

test('a client is told of each agent it takes that has anything to show', () => {
  const days = ['2026-11-15', '2026-11-16'];
  const used = { tokens: { input: [1, 2], output: [3, 4], cacheRead: [0, 0], cacheWrite: [0, 0] }, cost: [0.5, 1], unpriced: 0 };
  const read = { days, agents: { claude: { ...used, unpriced: 7 }, codex: used }, scanning: false, codexLimits: { at: 5000, primary: { used_percent: 9, window_minutes: 300, resets_at: 99 } } };
  const now = 20_000;
  const reply = usageReply({
    read, now,
    limits: {
      claude: { limits: [{ window: 'fiveHour', percent: 12.5, resetsAt: 100 }] },
      antigravity: { limits: [{ name: 'Gemini', window: 'sevenDay', percent: 3 }], reading: false, updatedAt: 19 },
    },
  });
  assert.deepEqual(reply, {
    days, scanning: false, updatedAt: 20,
    agents: [
      { agent: 'claude', tokens: used.tokens, cost: used.cost, unpriced: 7, limits: [{ window: 'fiveHour', percent: 12.5, resetsAt: 100 }] },
      // Codex isn't running to say, so its limits are those it last wrote down.
      { agent: 'codex', tokens: used.tokens, cost: used.cost, limits: [{ window: 'fiveHour', percent: 9, resetsAt: 99 }], limitsAt: 5 },
      // An agent nothing was counted for has its limits.
      { agent: 'antigravity', limits: [{ name: 'Gemini', window: 'sevenDay', percent: 3 }], limitsAt: 19 },
    ],
  });
  // What Codex says now is what's told, with its plan and credits.
  const live = usageReply({ read, now, limits: { codex: { limits: [{ window: 'sevenDay', percent: 80 }], plan: 'pro', credits: { unlimited: false, balance: 5 }, updatedAt: 18 } } });
  assert.deepEqual(live.agents[1], { agent: 'codex', tokens: used.tokens, cost: used.cost, limits: [{ window: 'sevenDay', percent: 80 }], plan: 'pro', credits: { unlimited: false, balance: 5 }, limitsAt: 18 });
  // A client from before the other agents is told of Claude Code alone, and an agent with nothing isn't told of.
  assert.deepEqual(usageReply({ read, now, shown: agent => agent === 'claude' }).agents.map(agent => agent.agent), ['claude']);
  assert.deepEqual(usageReply({ read: { days, agents: {}, scanning: false }, now, limits: { antigravity: { limits: [], reading: false } } }).agents, []);
  // The hours are told as the days are, where the read has them.
  const hourly = { tokens: used.tokens, cost: used.cost };
  const byHour = usageReply({ read: { days, hours: ['2026-11-16T14', '2026-11-16T15'], agents: { claude: { ...used, hourly } }, scanning: false }, now });
  assert.deepEqual([byHour.hours, byHour.agents[0].hourly], [['2026-11-16T14', '2026-11-16T15'], hourly]);
  // More is to come while the chats are still being read, or a limit is still being asked for.
  assert.equal(usageReply({ read: { ...read, scanning: true }, now }).scanning, true);
  assert.equal(usageReply({ read, now, limits: { antigravity: { limits: [], reading: true } } }).scanning, true);
});

test('the chats are read by one process at a time, and what it found stands for a while', async () => {
  let now = 1000;
  const runs = [];
  let scanning = true;
  let release;
  const refreshed = [];
  const book = new UsageBook({
    file: '/h/usage.json', pricesFile: '/h/prices.json', now: () => now, prices: { refresh: async () => { refreshed.push(now); } },
    run: request => new Promise(resolve => { runs.push(request); release = () => resolve({ days: [], agents: {}, scanning }); }),
  });
  const [first, second] = [book.read(), book.read()];
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { file: '/h/usage.json', pricesFile: '/h/prices.json', budgetMs: 6000 });
  release();
  assert.equal(await first, await second);
  assert.equal((await first).scanning, true);
  // One that stopped short is gone on with at once.
  scanning = false;
  const third = book.read();
  assert.equal(runs.length, 2);
  release();
  assert.equal((await third).scanning, false);
  now += 29_000;
  assert.equal(await book.read(), await third);
  assert.equal(runs.length, 2);
  now += 2000;
  const fourth = book.read();
  assert.equal(runs.length, 3);
  release();
  await fourth;
  assert.ok(refreshed.length >= 3, 'the list of prices is looked at with each');

  // A read that failed is tried again by the next.
  const failing = new UsageBook({ run: async () => { throw new Error('no node'); } });
  await assert.rejects(failing.read(), /no node/);
  await assert.rejects(failing.read(), /no node/);
});

test('the process that reads prints what it found, with the prices kept beside it', t => {
  const { dir, folders, write, file } = setup(t);
  const home = path.join(dir, 'home');
  write(path.join(home, '.claude', 'projects', '-code', 'a.jsonl'), [reply({ id: 'msg_1', usage: USED })]);
  write(path.join(home, '.codex', 'sessions', 'rollout-a.jsonl'), [context(), record(SPENT)]);
  const pricesFile = path.join(dir, 'prices.json');
  fs.writeFileSync(pricesFile, JSON.stringify({ at: Date.now() + 1000, prices: PRICES }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
  const printed = JSON.parse(execFileSync(process.execPath, [WORKER, JSON.stringify({ file, pricesFile, budgetMs: 5000 })], { env, encoding: 'utf8' }));
  assert.equal(printed.scanning, false);
  assert.equal(printed.agents.claude.tokens.output.at(-1), 200);
  near(printed.agents.codex.cost.at(-1), 400 * 1e-5 + 600 * 1e-6 + 50 * 5e-5);
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [WORKER, 'not json'], { env, encoding: 'utf8' })).error.code, 'internal');
  assert.deepEqual(chatFolders({ CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' }, '/home/me'), {
    claude: [path.join('/c', 'projects')], codex: [path.join('/x', 'sessions'), path.join('/x', 'archived_sessions')],
    antigravity: [path.join('/home/me', '.gemini', 'antigravity-cli', 'conversations')],
  });
  assert.deepEqual(chatFolders({}, '/home/me').claude, [path.join('/home/me', '.claude', 'projects')]);
  assert.ok(folders);
});
