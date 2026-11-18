// Which command line an agent's sessions run on here, how it was put on the computer, how new it is, and
// what brings it up to date. The way it was installed decides the update, on a Mac, Linux or Windows
// alike: Homebrew, npm, Claude Code's own installer, WinGet, the CLI's own updater, or Codex's daemon.
// One that only an administrator can update, as a Linux system's package, has its command given
// instead, for someone at the computer to run.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HelperError } from './errors.mjs';
import { isNewer } from './version.mjs';

const execFileAsync = promisify(execFile);

// What each agent's command is called, and where each way of installing it keeps it.
export const CLIS = {
  claude: { command: 'claude', npm: '@anthropic-ai/claude-code', winget: 'Anthropic.ClaudeCode', linux: 'claude-code' },
  codex: { command: 'codex', npm: '@openai/codex' },
  antigravity: { command: 'agy' },
};

const VERSION_MS = 60_000;
const LATEST_MS = 60 * 60_000;
const LATEST_FAILED_MS = 10 * 60_000;
const FETCH_MS = 8_000;
const COMMAND_MS = 20_000;
const UPDATE_MS = 15 * 60_000;
const ERROR_CHARS = 600;
const RELEASES = 'https://downloads.claude.ai/claude-code-releases';

// The first version number in what a command printed.
export const versionIn = text => String(text ?? '').match(/\d+\.\d+(?:\.\d+)*/)?.[0];

// How a command was installed, from where its file really is.
export function installOf(file, { agent, home = os.homedir() } = {}) {
  const at = String(file ?? '').split(/[\\/]/).join('/');
  const inHome = at.startsWith(`${home.split(/[\\/]/).join('/')}/`);
  let found = at.match(/^(.*)\/Caskroom\/([^/]+)\//);
  if (found) return { kind: 'brew', cask: true, name: found[2], prefix: found[1] };
  found = at.match(/^(.*)\/Cellar\/([^/]+)\//);
  if (found) return { kind: 'brew', cask: false, name: found[2], prefix: found[1] };
  found = at.match(/^(.*?)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
  if (found) return { kind: 'npm', name: found[2], prefix: found[1] };
  if (at.includes('/.local/share/claude/versions/')) return { kind: 'native' };
  found = at.match(/\/Microsoft\/WinGet\/Packages\/([^/_]+)/i);
  if (found) return { kind: 'winget', name: found[1] };
  if (at.includes('/.codex/packages/standalone/')) return { kind: 'self' };
  if (/^\/(usr\/)?(s?bin|lib|lib64|libexec|share)\//.test(at)) return { kind: 'system' };
  // Antigravity's installer puts its command in the user's own folder, and keeps it up to date itself.
  if (agent === 'antigravity' && inHome) return { kind: 'self' };
  return { kind: 'unknown' };
}

// What a Linux system that installed Claude Code from its repository upgrades it with.
export function systemCommand(has) {
  if (has('apt-get')) return 'sudo apt update && sudo apt upgrade claude-code';
  if (has('dnf')) return 'sudo dnf upgrade claude-code';
  if (has('apk')) return 'sudo apk upgrade claude-code';
  return undefined;
}

// What brings an agent's command up to date: a command to run, or one to give someone with the rights to
// run it. Nothing for a way of installing that has no update the helper knows.
export function updateFor(agent, install, { writable = () => true, has = () => false, npmAt } = {}) {
  const cli = CLIS[agent];
  switch (install?.kind) {
    case 'daemon':
      return { command: ['codex', 'app-server', 'daemon', 'update'] };
    case 'brew': {
      const brew = install.prefix ? `${install.prefix}/bin/brew` : 'brew';
      return { command: [brew, 'upgrade', ...(install.cask ? ['--cask'] : []), install.name] };
    }
    case 'npm': {
      const npm = npmAt ?? 'npm';
      const args = ['install', '-g', `${install.name}@latest`];
      return writable(install) ? { command: [npm, ...args] } : { manual: `sudo npm ${args.join(' ')}` };
    }
    case 'native':
      return agent === 'claude' ? { command: [cli.command, 'update'] } : undefined;
    case 'winget':
      return agent === 'claude'
        ? { command: ['winget', 'upgrade', '--id', cli.winget, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'] }
        : undefined;
    case 'system': {
      const manual = agent === 'claude' ? systemCommand(has) : undefined;
      return manual ? { manual } : undefined;
    }
    case 'self':
      return { command: [cli.command, 'update'] };
    default:
      return undefined;
  }
}

// Where the newest version of a command is said, for its way of installing. Antigravity says it nowhere
// that can be asked, and updates itself.
export function latestSource(agent, install, { channel = 'latest' } = {}) {
  switch (install?.kind) {
    case 'brew':
      return { url: `https://formulae.brew.sh/api/${install.cask ? 'cask' : 'formula'}/${encodeURIComponent(install.name)}.json`, read: json => (install.cask ? json?.version : json?.versions?.stable) };
    case 'npm':
      return { url: `https://registry.npmjs.org/${install.name.replace('/', '%2f')}/latest`, read: json => json?.version };
    case 'daemon':
      return { url: 'https://registry.npmjs.org/@openai%2fcodex/latest', read: json => json?.version };
    case 'native': case 'winget': case 'system':
      return agent === 'claude' ? { url: `${RELEASES}/${channel === 'stable' ? 'stable' : 'latest'}`, text: true } : undefined;
    case 'self':
      return agent === 'codex' ? { url: 'https://registry.npmjs.org/@openai%2fcodex/latest', read: json => json?.version } : undefined;
    default:
      return undefined;
  }
}

const tail = text => String(text ?? '').trim().slice(-ERROR_CHARS);

function defaultExec(platform, env) {
  return (file, args, { timeout = COMMAND_MS } = {}) => execFileAsync(file, args, {
    timeout, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true, shell: platform === 'win32',
  });
}

async function defaultFetch(url, { text }) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), headers: { 'User-Agent': 'venes-cli' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return text ? (await response.text()).trim() : response.json();
}

export class AgentCli {
  #exec;
  #fetch;
  #platform;
  #env;
  #home;
  #now;
  #installed = new Map();
  #latest = new Map();
  #jobs = new Map();

  constructor({ exec, fetch = defaultFetch, platform = process.platform, env = process.env, home = os.homedir(), now = Date.now } = {}) {
    this.#platform = platform;
    this.#env = env;
    this.#exec = exec ?? defaultExec(platform, env);
    this.#fetch = fetch;
    this.#home = home;
    this.#now = now;
  }

  // Where a command is, as a shell here would find it.
  async #where(command) {
    try {
      const { stdout } = this.#platform === 'win32'
        ? await this.#exec('where', [command])
        : await this.#exec('/bin/sh', ['-c', `command -v ${command}`]);
      const file = stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean);
      return file && path.isAbsolute(file) ? file : undefined;
    } catch {
      return undefined;
    }
  }

  async #codexDaemon() {
    try {
      const { stdout } = await this.#exec('codex', ['app-server', 'daemon', 'version']);
      return JSON.parse(stdout);
    } catch {
      return undefined;
    }
  }

  // What's installed of an agent's command, and how. Codex's sessions run in its daemon, so for Codex
  // it's the daemon's package and the version it runs, when the daemon manages one.
  async installed(agent) {
    const cached = this.#installed.get(agent);
    if (cached && this.#now() - cached.at < VERSION_MS) return cached.value;
    let value;
    const daemon = agent === 'codex' ? await this.#codexDaemon() : undefined;
    if (daemon?.managedCodexPath) {
      value = { file: daemon.managedCodexPath, install: { kind: 'daemon' }, version: versionIn(daemon.managedCodexVersion), running: versionIn(daemon.appServerVersion) };
    } else {
      const file = await this.#where(CLIS[agent].command);
      let real = file;
      try { real = file && fs.realpathSync(file); } catch { /* keep what was found */ }
      let version;
      try { version = file && versionIn((await this.#exec(file, ['--version'])).stdout); } catch { /* not there to ask */ }
      value = { file: real, install: real ? installOf(real, { agent, home: this.#home }) : { kind: 'missing' }, version };
    }
    this.#installed.set(agent, { at: this.#now(), value });
    return value;
  }

  #channel() {
    try {
      const file = path.join(this.#env.CLAUDE_CONFIG_DIR || path.join(this.#home, '.claude'), 'settings.json');
      return JSON.parse(fs.readFileSync(file, 'utf8')).autoUpdatesChannel;
    } catch {
      return undefined;
    }
  }

  // The newest version there is for a way of installing, asked at most hourly.
  async latest(agent, install) {
    const source = latestSource(agent, install, { channel: agent === 'claude' ? this.#channel() : undefined });
    if (!source) return undefined;
    const cached = this.#latest.get(source.url);
    if (cached && this.#now() - cached.at < (cached.value ? LATEST_MS : LATEST_FAILED_MS)) return cached.value;
    let value;
    try {
      const said = await this.#fetch(source.url, { text: source.text });
      value = versionIn(source.text ? said : source.read(said));
    } catch { /* asked again later */ }
    this.#latest.set(source.url, { at: this.#now(), value });
    return value;
  }

  #has(name) {
    return ['/usr/bin', '/bin', '/usr/sbin', '/sbin'].some(dir => fs.existsSync(path.join(dir, name)));
  }

  #writable(install) {
    if (install.kind !== 'npm') return true;
    try {
      fs.accessSync(install.prefix, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  #npmAt(install) {
    if (install?.kind !== 'npm' || this.#platform === 'win32') return undefined;
    // A global package is in <prefix>/lib/node_modules, and its npm in <prefix>/bin.
    const npm = path.join(path.dirname(install.prefix), 'bin', 'npm');
    return fs.existsSync(npm) ? npm : undefined;
  }

  plan(agent, install) {
    return updateFor(agent, install, { writable: i => this.#writable(i), has: name => this.#has(name), npmAt: this.#npmAt(install) });
  }

  // What a session's sheet shows of its agent's command. `running` is the version the session runs, when
  // that can be told; `busy` keeps an update that would stop work from starting.
  async report(agent, { running, busy = false } = {}) {
    const installed = await this.installed(agent);
    const latest = await this.latest(agent, installed.install);
    const job = this.#jobs.get(agent);
    const plan = this.plan(agent, installed.install);
    const current = installed.version;
    const ran = running ?? installed.running ?? current;
    let update = 'none';
    if (job?.state === 'running') update = 'updating';
    else if (latest && current && isNewer(latest, current)) {
      if (plan?.command) update = busy ? 'busy' : 'available';
      else if (plan?.manual) update = 'manual';
    }
    return {
      agent, running: ran ?? null, installed: current ?? null, latest: latest ?? null, install: installed.install.kind, update,
      ...(update === 'manual' && { command: plan.manual }),
      ...(job?.state === 'failed' && { error: job.error }),
    };
  }

  // Runs the update in the background. `after` hears of it once it's done, with the version now installed.
  async update(agent, { busy = false, after } = {}) {
    if (this.#jobs.get(agent)?.state === 'running') return { started: false, updating: true };
    if (busy) throw new HelperError('agent_busy', 'It is working. Try again when it has finished.');
    const installed = await this.installed(agent);
    const plan = this.plan(agent, installed.install);
    if (!plan?.command) throw new HelperError('no_update', plan?.manual ? `Run this on the computer: ${plan.manual}` : 'This install has no update the helper can run.');
    const job = { state: 'running', startedAt: this.#now() };
    this.#jobs.set(agent, job);
    const [file, ...args] = plan.command;
    this.#exec(file, args, { timeout: UPDATE_MS })
      .then(async () => {
        this.#installed.delete(agent);
        const now = await this.installed(agent);
        job.state = 'done';
        job.version = now.version;
        await after?.({ version: now.version, running: now.running });
      })
      .catch(error => {
        job.state = 'failed';
        job.error = tail(error.stderr) || tail(error.stdout) || error.message;
      });
    return { started: true };
  }
}
