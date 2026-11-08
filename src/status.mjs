// What Claude Code tells its status line about a session, kept for the phone: the model, the effort,
// the context, the limits and the rest, as Claude Code has them. The helper's command stands in as
// the status line, keeps what it's given, and runs the status line it stands in for with the same,
// so the terminal shows what it did.

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 1000;
const SESSION_ID = /^[\w-]{1,128}$/;
// What's kept of a session that hasn't run its status line for a week goes.
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SUBCOMMAND = 'statusline';

const shellQuote = value => `'${value.replace(/'/g, `'\\''`)}'`;
const isNumber = value => typeof value === 'number' && Number.isFinite(value);
const tenths = value => Math.round(value * 10) / 10;

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeAtomically(file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode });
  fs.renameSync(temp, file);
}

export const statusFile = (dir, sessionId) => path.join(dir, `${sessionId}.json`);

// The command Claude Code runs as the status line once the helper stands in.
export const standInCommand = launcher => `${shellQuote(launcher)} ${SUBCOMMAND}`;
const isStandIn = command => typeof command === 'string' && /(?:^|\/)venes'?\s+statusline$/.test(command.trim());

// Keeps what Claude Code sent, for the session it names. Anything else is left alone.
export function keepStatus(dir, input) {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return false;
  }
  if (typeof data?.session_id !== 'string' || !SESSION_ID.test(data.session_id)) return false;
  writeAtomically(statusFile(dir, data.session_id), input);
  return true;
}

// Stands in as the status line in Claude Code's settings, keeping the one that was there to run
// behind it. A file that can't be read is never written, and once switched off it stays off.
export function installStatusLine({ settingsFile, stateFile, launcher }) {
  const state = readJSON(stateFile) ?? {};
  if (state.off) return 'off';
  let text = '{}';
  try {
    text = fs.readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') return 'unreadable';
  }
  let settings;
  try {
    settings = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return 'unreadable';
  const command = standInCommand(launcher);
  const current = settings.statusLine;
  if (current?.command === command) return 'installed';
  // Another helper's, from another home, stands for the same one, which is already kept.
  if (!isStandIn(current?.command)) writeAtomically(stateFile, `${JSON.stringify({ statusLine: current ?? null }, null, 2)}\n`);
  settings.statusLine = { ...(current && typeof current === 'object' ? current : {}), type: 'command', command };
  writeAtomically(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
  return 'installed';
}

// Puts back the status line the helper stood in for, and stays out until switched on again.
export function removeStatusLine({ settingsFile, stateFile }) {
  const state = readJSON(stateFile) ?? {};
  const settings = readJSON(settingsFile);
  if (settings && isStandIn(settings.statusLine?.command)) {
    if (state.statusLine) settings.statusLine = state.statusLine;
    else delete settings.statusLine;
    writeAtomically(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, 0o644);
  }
  writeAtomically(stateFile, `${JSON.stringify({ ...state, off: true }, null, 2)}\n`);
}

export function switchOnStatusLine(options) {
  const state = readJSON(options.stateFile) ?? {};
  delete state.off;
  writeAtomically(options.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  return installStatusLine(options);
}

async function readAll(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text;
}

// What Claude Code runs as the status line: keeps the input, then runs the status line that was
// there with it, in the user's shell as Claude Code would, and exits as that does.
export async function runStatusLine({ stdin, dir, stateFile, shell = process.env.SHELL || '/bin/sh' }) {
  const input = await readAll(stdin);
  try {
    keepStatus(dir, input);
  } catch {
    // The status line still shows when there's nowhere to keep it.
  }
  const original = readJSON(stateFile)?.statusLine;
  const command = original?.type === 'command' ? original.command : undefined;
  if (!command || isStandIn(command)) return 0;
  return new Promise(resolve => {
    const child = spawn(shell, ['-c', command], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// The branch checked out in a folder.
export async function checkedOutBranch(cwd) {
  if (!cwd) return undefined;
  try {
    const { stdout } = await exec('git', ['--no-optional-locks', '-C', cwd, 'symbolic-ref', '--short', '-q', 'HEAD'], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

// A limit's share, and when it resets. One that has reset since starts again from nothing.
function limitOf(window, now) {
  if (!window || !isNumber(window.used_percentage)) return undefined;
  if (isNumber(window.resets_at) && window.resets_at * 1000 <= now) return { percent: 0 };
  return { percent: tenths(window.used_percentage), ...(isNumber(window.resets_at) ? { resetsAt: window.resets_at } : {}) };
}

// The limits are the account's, so a session that hasn't had a reply yet, and so has none of its
// own, has those the last session to have them was told.
function latestLimits(dir, sessionId) {
  let latest;
  for (const name of fs.readdirSync(dir).filter(file => file.endsWith('.json') && file !== `${sessionId}.json`)) {
    const file = path.join(dir, name);
    const limits = readJSON(file)?.rate_limits;
    if (!limits) continue;
    const at = fs.statSync(file).mtimeMs;
    if (!latest || at > latest.at) latest = { at, limits };
  }
  return latest?.limits;
}

const withoutEmpty = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null));

// What the phone shows of a session, from what its status line was last told: undefined until
// Claude Code has run it. Limits are there with a plan that has them; with an API that has none,
// there's the cost instead.
export async function readStatus(dir, sessionId, now = Date.now()) {
  const file = statusFile(dir, sessionId);
  const data = readJSON(file);
  if (!data || typeof data !== 'object') return undefined;
  const cwd = data.workspace?.current_dir ?? data.cwd;
  const project = data.workspace?.project_dir ?? cwd;
  const repo = data.workspace?.repo;
  const context = data.context_window;
  const cache = data.prompt_cache;
  const replied = context?.current_usage != null || (context?.total_input_tokens ?? 0) > 0;
  const limits = data.rate_limits ?? (replied ? undefined : latestLimits(dir, sessionId));
  return withoutEmpty({
    model: data.model?.display_name,
    effort: data.effort?.level,
    project: project ? path.basename(project) : undefined,
    repo: repo?.owner && repo?.name ? `${repo.owner}/${repo.name}` : undefined,
    branch: await checkedOutBranch(cwd),
    context: context
      ? withoutEmpty({
        percent: isNumber(context.used_percentage) ? tenths(context.used_percentage) : undefined,
        used: isNumber(context.total_input_tokens) ? context.total_input_tokens : undefined,
        size: isNumber(context.context_window_size) ? context.context_window_size : undefined,
      })
      : undefined,
    fiveHour: limitOf(limits?.five_hour, now),
    sevenDay: limitOf(limits?.seven_day, now),
    cache: cache
      ? withoutEmpty({
        percent: isNumber(cache.hit_ratio) ? tenths(cache.hit_ratio * 100) : undefined,
        warm: typeof cache.warm === 'boolean' ? cache.warm : undefined,
        expiresAt: isNumber(cache.expires_at) ? cache.expires_at : undefined,
      })
      : undefined,
    cost: isNumber(data.cost?.total_cost_usd) ? data.cost.total_cost_usd : undefined,
    updatedAt: Math.floor(fs.statSync(file).mtimeMs / 1000),
  });
}

// What's kept of sessions that haven't run their status line for a week.
export function pruneStatus(dir, now = Date.now()) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_MS) fs.rmSync(file, { force: true });
    } catch {
      // Gone already.
    }
  }
}
