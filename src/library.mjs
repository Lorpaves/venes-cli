// Sessions the helper hasn't heard from, through what Claude Code documents for this:
// `claude agents --json` for what's running, and the Agent SDK for what's stored. Reads run in a
// process of their own, because a long transcript takes over a gigabyte to load, and hooks
// can't wait behind that.

import { execFile } from 'node:child_process';
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
const READ_TIMEOUT_MS = 60_000;
const READ_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_PAGE_SIZE = 50;
const WORKER = fileURLToPath(new URL('library-worker.mjs', import.meta.url));

const STATUS = { busy: 'running', waiting: 'waiting', idle: 'idle' };
// A background session can still be at work with no process, and then has no `status`.
const BACKGROUND_STATE = { working: 'running', blocked: 'waiting' };

export function readRunning(stdout) {
  return JSON.parse(stdout).filter(entry => entry.sessionId).map(entry => ({
    id: entry.sessionId, title: entry.name, cwd: entry.cwd, startedAt: entry.startedAt,
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

export class Library {
  #sdkDir;
  #installing;

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
      await exec('npm', args, { timeout: INSTALL_TIMEOUT_MS });
    } catch (error) {
      fs.rmSync(partial, { recursive: true, force: true });
      throw new HelperError('sdk_unavailable', `Couldn't install the Agent SDK: ${error.message}`);
    }
    for (const name of fs.readdirSync(this.#sdkDir)) {
      if (name !== path.basename(partial)) fs.rmSync(path.join(this.#sdkDir, name), { recursive: true, force: true });
    }
    fs.renameSync(partial, this.#installed);
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
    return readRunning(stdout);
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

  async info(sessionId) {
    const { session } = await this.#read({ op: 'info', sdk: await this.prepare(), sessionId });
    return session;
  }

  history(sessionId, { limit, before } = {}) {
    return this.#read({ op: 'history', sessionId, limit, before });
  }
}
