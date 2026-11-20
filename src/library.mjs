// Sessions the helper hasn't heard from, through what Claude Code documents for this:
// `claude agents --json` for what's running, and the Agent SDK for what's stored. Reads run in a
// process of their own, because a long transcript takes over a gigabyte to load, and hooks
// can't wait behind that.

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HelperError } from './sessions.mjs';

const exec = promisify(execFile);
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
// Pinned so that a release runs what it was tested with. Update it with each release.
const SDK_VERSION = '0.3.319';
const INSTALL_TIMEOUT_MS = 180_000;
const AGENTS_TIMEOUT_MS = 10_000;
// How many of the helper's own runs of Claude Code are remembered, to leave them out of what's running.
// Each lasts a few seconds, and there's one every few minutes at most.
const OWN_RUNS_KEPT = 64;
const READ_TIMEOUT_MS = 60_000;
const READ_BUFFER_BYTES = 64 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 50;
// Long enough to open many pages, and short enough that a new skill soon shows up.
const CAPABILITIES_LIFETIME_MS = 5 * 60_000;
// Each read of the account's usage starts Claude Code, and a week's limit moves slowly.
const USAGE_LIFETIME_MS = 3 * 60_000;
const WORKER = fileURLToPath(new URL('library-worker.mjs', import.meta.url));

const STATUS = { busy: 'running', waiting: 'waiting', idle: 'idle' };
// A background session can still be at work with no process, and then has no `status`.
const BACKGROUND_STATE = { working: 'running', blocked: 'waiting' };

// What's running, but the helper's own runs of Claude Code, by the session ids it gave them: `own`.
export function readRunning(stdout, own = new Set()) {
  return JSON.parse(stdout).filter(entry => entry.sessionId && !own.has(entry.sessionId)).map(entry => ({
    id: entry.sessionId, title: entry.name, cwd: entry.cwd, startedAt: entry.startedAt, pid: entry.pid, kind: entry.kind,
    status: STATUS[entry.status] ?? BACKGROUND_STATE[entry.state] ?? 'idle',
  }));
}

// What's running comes first, on the first page, wherever it would otherwise have been.
export function libraryPage(stored, running, { limit, offset }) {
  const live = new Map(running.map(session => [session.id, session]));
  const items = stored.map(session => ({
    id: session.sessionId, title: session.summary, cwd: session.cwd,
    lastActiveAt: session.lastModified, startedAt: session.createdAt, status: live.get(session.sessionId)?.status ?? null,
  }));
  const listed = new Set(items.map(item => item.id));
  const unlisted = offset ? [] : running.filter(session => !listed.has(session.id)).map(session => ({ ...session, lastActiveAt: session.startedAt }));
  return { items: [...unlisted, ...items], offset: offset + stored.length, hasMore: stored.length === limit };
}

// One page of every agent's stored sessions together: what's going on now first, then the newest first.
// `claude` is Claude Code's newest `offset + limit`, and `others` what the other agents have, so nothing
// older than what's there can belong on the page. The reply's `offset` is where the next page starts.
export function mergedPage(claude, others, { limit, offset }) {
  const lastActive = item => item.lastActiveAt ?? 0;
  const all = [...claude.items, ...others].sort((a, b) => Number(b.status != null) - Number(a.status != null) || lastActive(b) - lastActive(a));
  const items = all.slice(offset, offset + limit);
  return { items, offset: offset + items.length, hasMore: claude.hasMore || all.length > offset + limit };
}

// What a session that's running somewhere else is doing, for someone opening it. `claude agents`
// only says whether its process is busy, which a background shell keeps it long after a turn has
// ended, so the transcript gets the last word on that.
export function joinedStatus(running, items) {
  if (!running) return 'ended';
  const last = items.at(-1);
  const isTurnOver = last?.role === 'turn_end' || last?.kind === 'interrupted';
  return running.status === 'running' && isTurnOver ? 'idle' : running.status;
}

// What a client needs of each. Names starting with two underscores are Claude Code's own plumbing.
export function readCapabilities({ commands = [], models = [] }) {
  return {
    commands: commands.filter(command => !command.name.startsWith('__')).map(({ name, description, argumentHint }) => ({ name, description, argumentHint: argumentHint ?? '' })),
    models: models.map(({ value, displayName, description, resolvedModel, supportedEffortLevels }) => ({
      value, displayName, description, resolvedModel, effortLevels: supportedEffortLevels ?? [],
    })),
  };
}

const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// A week's limits that are each for one model, from what /usage is told: the name the server gives the
// model, such as Fable, its share in tenths, and when it resets. An account with no such limit has
// none, and one that has reset since starts again from nothing.
export function readModelLimits(limits, now = Date.now()) {
  const scoped = Array.isArray(limits?.model_scoped) ? limits.model_scoped : [];
  return scoped.filter(entry => typeof entry?.display_name === 'string' && entry.display_name && isNumber(entry.utilization)).map(entry => {
    const at = typeof entry.resets_at === 'string' ? Date.parse(entry.resets_at) : NaN;
    if (Number.isFinite(at) && at <= now) return { name: entry.display_name, percent: 0 };
    return { name: entry.display_name, percent: Math.round(entry.utilization * 10) / 10, ...(Number.isFinite(at) && { resetsAt: Math.floor(at / 1000) }) };
  });
}

// The plan an account is on, as Claude Code names it, without the "Claude" each of its names starts with:
// it's shown beside Claude Code's own name. Nothing for an account with none.
export const planName = said => (typeof said === 'string' ? said.trim().replace(/^Claude\s+(?=\S)/i, '') : '') || undefined;

// All the account's limits from what /usage is told, for a list of what's used: the five hours' and the
// week's, then each model's week by its name, each with its share in tenths and when it resets. None
// for an account with none, as an API's.
export function readAccountLimits(limits, now = Date.now()) {
  const windowOf = (window, said) => {
    if (!isNumber(said?.utilization)) return [];
    const at = typeof said.resets_at === 'string' ? Date.parse(said.resets_at) : NaN;
    if (Number.isFinite(at) && at <= now) return [{ window, percent: 0 }];
    return [{ window, percent: Math.round(said.utilization * 10) / 10, ...(Number.isFinite(at) && { resetsAt: Math.floor(at / 1000) }) }];
  };
  return [
    ...windowOf('fiveHour', limits?.five_hour), ...windowOf('sevenDay', limits?.seven_day),
    ...readModelLimits(limits, now).map(({ name, ...limit }) => ({ name, window: 'sevenDay', ...limit })),
  ];
}

// npm, which on Windows is a command file that can't be started as a program is. The script it runs
// is beside Node there, and Node runs that itself.
function runNpm(args, options) {
  if (process.platform !== 'win32') return exec('npm', args, options);
  const script = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return exec(process.execPath, [script, ...args], options);
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const file = path.join(dir, process.platform === 'win32' ? `${name}.exe` : name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* not in this one */ }
  }
  return undefined;
}

export class Library {
  #sdkDir;
  #installing;
  #capabilities = new Map();
  #usage;
  #plan;
  // The session ids of the helper's own runs of Claude Code, the newest last. Claude Code lists every
  // process of its own as a session that's running, these too, named for the folder they're in.
  #ownRuns = new Set();
  // Ends an install of the SDK going on when the helper stops.
  #stopping = new AbortController();

  constructor({ sdkDir }) { this.#sdkDir = sdkDir; }

  get #installed() { return path.join(this.#sdkDir, SDK_VERSION); }
  get #entry() { return path.join(this.#installed, 'node_modules', SDK_PACKAGE, 'sdk.mjs'); }

  // Only the SDK's own code is needed to read sessions, so its Claude Code binary stays out.
  async #install() {
    const partial = `${this.#installed}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.mkdirSync(partial, { recursive: true });
    const args = ['install', '--prefix', partial, '--no-audit', '--no-fund', '--ignore-scripts', '--omit=optional', '--omit=peer', `${SDK_PACKAGE}@${SDK_VERSION}`];
    try {
      await runNpm(args, { timeout: INSTALL_TIMEOUT_MS, signal: this.#stopping.signal });
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw new HelperError('sdk_unavailable', `Couldn't install the Agent SDK: ${error.message}`);
    }
    for (const name of fs.readdirSync(this.#sdkDir)) {
      if (name !== path.basename(partial)) fs.rmSync(path.join(this.#sdkDir, name), { recursive: true, force: true });
    }
    fs.renameSync(partial, this.#installed);
  }

  // Ends an install going on, and waits for it, so that nothing writes to its folder once the helper
  // has gone, as when Venes is uninstalled.
  async stop() {
    this.#stopping.abort();
    await this.#installing?.catch(() => {});
  }

  async prepare() {
    if (fs.existsSync(this.#entry)) return this.#entry;
    this.#installing ??= this.#install().finally(() => { this.#installing = undefined; });
    await this.#installing;
    return this.#entry;
  }

  async #read(request) {
    const { stdout } = await exec(process.execPath, [WORKER, JSON.stringify(request)], { timeout: READ_TIMEOUT_MS, maxBuffer: READ_BUFFER_BYTES });
    const { error, ...reply } = JSON.parse(stdout);
    if (error) throw new HelperError(error.code, error.message);
    return reply;
  }

  async running() {
    const { stdout } = await exec('claude', ['agents', '--json'], { timeout: AGENTS_TIMEOUT_MS, cwd: os.homedir() });
    return readRunning(stdout, this.#ownRuns);
  }

  // A session id for one of the helper's own runs of Claude Code, so that it's never taken for a session.
  #ownRun() {
    const id = randomUUID();
    this.#ownRuns.add(id);
    if (this.#ownRuns.size > OWN_RUNS_KEPT) this.#ownRuns.delete(this.#ownRuns.values().next().value);
    return id;
  }

  async page({ limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
    const sdk = await this.prepare();
    const [{ sessions }, running] = await Promise.all([
      this.#read({ op: 'list', sdk, limit, offset }),
      // Without this the list still works. It just can't say what's running.
      this.running().catch(() => []),
    ]);
    return libraryPage(sessions, running, { limit, offset });
  }

  // The newest stored sessions, for the folders they ran in.
  async recent(limit) {
    const { sessions } = await this.#read({ op: 'list', sdk: await this.prepare(), limit, offset: 0 });
    return sessions;
  }

  async info(sessionId) {
    const { session } = await this.#read({ op: 'info', sdk: await this.prepare(), sessionId });
    return session;
  }

  history(sessionId, { limit, before } = {}) {
    return this.#read({ op: 'history', sessionId, limit, before });
  }

  image(sessionId, id) {
    return this.#read({ op: 'image', sessionId, id });
  }

  // The file an Artifact call published: `{path}`, or nothing. `file` is the transcript, when it's known.
  artifact(sessionId, id, file) {
    return this.#read({ op: 'artifact', sessionId, id, file });
  }

  // Its transcript and its subagents' are gone from this Mac after this.
  async delete(sessionId) {
    await this.#read({ op: 'delete', sdk: await this.prepare(), sessionId });
  }

  async #readCapabilities(cwd) {
    const claude = findOnPath('claude');
    if (!claude) throw new HelperError('no_claude', 'Claude Code is not on the PATH.');
    return readCapabilities(await this.#read({ op: 'capabilities', sdk: await this.prepare(), cwd, claude, sessionId: this.#ownRun() }));
  }

  // The commands and models on offer in a folder. Pages opening together share one read.
  capabilities(folder, now = Date.now()) {
    const cwd = folder && fs.existsSync(folder) ? folder : os.homedir();
    const known = this.#capabilities.get(cwd);
    if (known && now - known.at < CAPABILITIES_LIFETIME_MS) return known.reply;
    const reply = this.#readCapabilities(cwd);
    this.#capabilities.set(cwd, { at: now, reply });
    reply.catch(() => this.#capabilities.delete(cwd));
    return reply;
  }

  async #readLimits() {
    const claude = findOnPath('claude');
    if (!claude) return null;
    const read = await this.#read({ op: 'usage', sdk: await this.prepare(), claude, sessionId: this.#ownRun() });
    // The plan stays as it was last said when a read comes back without one.
    this.#plan = planName(read.plan) ?? this.#plan;
    return read.limits ?? null;
  }

  // The plan the account is on, once Claude Code has been asked its limits, and nothing before that.
  get plan() {
    return this.#plan;
  }

  // What /usage is told of the account's limits. Read once for a few minutes, with sheets and lists
  // asking together sharing the read. One that can't be read is none, kept as long, so that a status
  // asked for every few seconds doesn't start Claude Code each time.
  #limits(now) {
    if (this.#usage && now - this.#usage.at < USAGE_LIFETIME_MS) return this.#usage.reply;
    const reply = this.#readLimits().catch(() => null);
    this.#usage = { at: now, reply };
    return reply;
  }

  // The week's limits that are for one model, which an account has or hasn't.
  async modelLimits(now = Date.now()) {
    return readModelLimits(await this.#limits(now), now);
  }

  // All of them, for a list of what's used, with the plan they come with and when they were read: nothing for an account with none,
  // or where Claude Code can't be asked.
  async accountLimits(now = Date.now()) {
    const limits = readAccountLimits(await this.#limits(now), now);
    return limits.length ? { limits, ...(this.#plan && { plan: this.#plan }), updatedAt: Math.floor((this.#usage?.at ?? now) / 1000) } : undefined;
  }
}
