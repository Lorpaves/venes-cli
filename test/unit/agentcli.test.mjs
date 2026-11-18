import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentCli, installOf, latestSource, systemCommand, updateFor, versionIn } from '../../src/agentcli.mjs';

test('a version is the first number a command prints', () => {
  assert.equal(versionIn('2.1.326 (Claude Code)'), '2.1.326');
  assert.equal(versionIn('codex-cli 0.169.0'), '0.169.0');
  assert.equal(versionIn('1.5.11\n'), '1.5.11');
  assert.equal(versionIn(undefined), undefined);
});

test('how a command was installed is told by where its file really is, on a Mac, Linux or Windows', () => {
  const home = '/Users/a';
  assert.deepEqual(installOf('/opt/homebrew/Caskroom/claude-code@latest/2.1.326/claude', { home }), { kind: 'brew', cask: true, name: 'claude-code@latest', prefix: '/opt/homebrew' });
  assert.deepEqual(installOf('/home/linuxbrew/.linuxbrew/Cellar/codex/0.169.0/bin/codex', { home }), { kind: 'brew', cask: false, name: 'codex', prefix: '/home/linuxbrew/.linuxbrew' });
  assert.deepEqual(installOf('/Users/a/.nvm/versions/node/v22.12.0/lib/node_modules/@anthropic-ai/claude-code/cli.js', { home }), { kind: 'npm', name: '@anthropic-ai/claude-code', prefix: '/Users/a/.nvm/versions/node/v22.12.0/lib' });
  assert.equal(installOf('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js', { home: 'C:\\Users\\a' }).name, '@openai/codex');
  assert.deepEqual(installOf('/Users/a/.local/share/claude/versions/2.1.326', { home }), { kind: 'native' });
  assert.deepEqual(installOf('C:\\Users\\a\\.local\\share\\claude\\versions\\2.1.326\\claude.exe', { home: 'C:\\Users\\a' }), { kind: 'native' });
  assert.deepEqual(installOf('C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe', { home: 'C:\\Users\\a' }), { kind: 'winget', name: 'Anthropic.ClaudeCode' });
  assert.deepEqual(installOf('/Users/a/.codex/packages/standalone/releases/0.153.4-aarch64-apple-darwin/bin/codex', { home }), { kind: 'self' });
  assert.deepEqual(installOf('/usr/bin/claude', { home }), { kind: 'system' });
  assert.deepEqual(installOf('/Users/a/.local/bin/agy', { agent: 'antigravity', home }), { kind: 'self' });
  assert.deepEqual(installOf('/Users/a/bin/claude', { agent: 'claude', home }), { kind: 'unknown' });
});

test('each way of installing has its update, or a command for someone with the rights to run it', () => {
  assert.deepEqual(updateFor('claude', { kind: 'brew', cask: true, name: 'claude-code@latest', prefix: '/opt/homebrew' }), { command: ['/opt/homebrew/bin/brew', 'upgrade', '--cask', 'claude-code@latest'] });
  assert.deepEqual(updateFor('codex', { kind: 'brew', cask: false, name: 'codex', prefix: '/home/linuxbrew/.linuxbrew' }), { command: ['/home/linuxbrew/.linuxbrew/bin/brew', 'upgrade', 'codex'] });
  const npm = { kind: 'npm', name: '@anthropic-ai/claude-code', prefix: '/usr/local/lib' };
  assert.deepEqual(updateFor('claude', npm, { npmAt: '/usr/local/bin/npm' }), { command: ['/usr/local/bin/npm', 'install', '-g', '@anthropic-ai/claude-code@latest'] });
  assert.deepEqual(updateFor('claude', npm, { writable: () => false }), { manual: 'sudo npm install -g @anthropic-ai/claude-code@latest' });
  assert.deepEqual(updateFor('claude', { kind: 'native' }), { command: ['claude', 'update'] });
  assert.equal(updateFor('claude', { kind: 'winget', name: 'Anthropic.ClaudeCode' }).command.slice(0, 4).join(' '), 'winget upgrade --id Anthropic.ClaudeCode');
  assert.deepEqual(updateFor('claude', { kind: 'system' }, { has: name => name === 'apt-get' }), { manual: 'sudo apt update && sudo apt upgrade claude-code' });
  assert.equal(updateFor('claude', { kind: 'system' }, { has: () => false }), undefined);
  assert.equal(updateFor('codex', { kind: 'system' }, { has: () => true }), undefined);
  assert.deepEqual(updateFor('antigravity', { kind: 'self' }), { command: ['agy', 'update'] });
  assert.deepEqual(updateFor('codex', { kind: 'self' }), { command: ['codex', 'update'] });
  assert.deepEqual(updateFor('codex', { kind: 'daemon' }), { command: ['codex', 'app-server', 'daemon', 'update'] });
  assert.equal(updateFor('claude', { kind: 'unknown' }), undefined);
});

test('a Linux system names its own upgrade', () => {
  assert.equal(systemCommand(name => name === 'dnf'), 'sudo dnf upgrade claude-code');
  assert.equal(systemCommand(name => name === 'apk'), 'sudo apk upgrade claude-code');
});

test('the newest version is asked where that way of installing says it, and nowhere for Antigravity', () => {
  const cask = latestSource('claude', { kind: 'brew', cask: true, name: 'claude-code@latest' });
  assert.equal(cask.url, 'https://formulae.brew.sh/api/cask/claude-code%40latest.json');
  assert.equal(cask.read({ version: '2.1.327' }), '2.1.327');
  assert.equal(latestSource('codex', { kind: 'brew', cask: false, name: 'codex' }).read({ versions: { stable: '0.170.0' } }), '0.170.0');
  assert.equal(latestSource('claude', { kind: 'npm', name: '@anthropic-ai/claude-code' }).url, 'https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest');
  assert.equal(latestSource('claude', { kind: 'native' }, { channel: 'stable' }).url, 'https://downloads.claude.ai/claude-code-releases/stable');
  assert.equal(latestSource('claude', { kind: 'native' }).url, 'https://downloads.claude.ai/claude-code-releases/latest');
  assert.equal(latestSource('codex', { kind: 'daemon' }).url, 'https://registry.npmjs.org/@openai%2fcodex/latest');
  assert.equal(latestSource('antigravity', { kind: 'self' }), undefined);
});

// A computer as the helper finds it: what each command says, and what the internet says is newest.
function computer({ commands = {}, latest = {}, failing } = {}) {
  const ran = [];
  const fetched = [];
  const exec = async (file, args) => {
    ran.push([file, ...args].join(' '));
    const said = commands[[file, ...args].join(' ')];
    if (said instanceof Error) throw said;
    if (said === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    return { stdout: typeof said === 'function' ? await said() : said, stderr: '' };
  };
  const fetch = async url => {
    fetched.push(url);
    if (failing) throw new Error('offline');
    const said = latest[url];
    if (said === undefined) throw new Error('404');
    return said;
  };
  return { cli: new AgentCli({ exec, fetch, platform: 'darwin', home: '/Users/a', env: {} }), ran, fetched };
}

const CASK = '/opt/homebrew/Caskroom/claude-code@latest/2.1.326/claude';
const CASK_API = 'https://formulae.brew.sh/api/cask/claude-code%40latest.json';
const claudeAt = (extra = {}) => ({ '/bin/sh -c command -v claude': `${CASK}\n`, [`${CASK} --version`]: '2.1.326 (Claude Code)\n', ...extra });

test('a newer Claude Code can be installed, and the session runs the version it says', async () => {
  const { cli } = computer({ commands: claudeAt(), latest: { [CASK_API]: { version: '2.1.327' } } });
  assert.deepEqual(await cli.report('claude', { running: '2.1.326' }), {
    agent: 'claude', running: '2.1.326', installed: '2.1.326', latest: '2.1.327', install: 'brew', update: 'available',
  });
});

test('an update that would stop work waits, as Codex\'s does', async () => {
  const { cli } = computer({ commands: claudeAt(), latest: { [CASK_API]: { version: '2.1.327' } } });
  assert.equal((await cli.report('claude', { busy: true })).update, 'busy');
  await assert.rejects(cli.update('claude', { busy: true }), { code: 'agent_busy' });
});

test('one already up to date has nothing to update, and an installed version newer than the running one shows', async () => {
  const { cli } = computer({ commands: claudeAt(), latest: { [CASK_API]: { version: '2.1.326' } } });
  const report = await cli.report('claude', { running: '2.1.320' });
  assert.deepEqual([report.update, report.running, report.installed], ['none', '2.1.320', '2.1.326']);
});

test('the newest version is asked once an hour, not each time the sheet opens', async () => {
  const { cli, fetched } = computer({ commands: claudeAt(), latest: { [CASK_API]: { version: '2.1.327' } } });
  await cli.report('claude');
  await cli.report('claude');
  assert.equal(fetched.length, 1);
});

test('offline, there is just nothing newer to say', async () => {
  const { cli } = computer({ commands: claudeAt(), failing: true });
  const report = await cli.report('claude');
  assert.deepEqual([report.latest, report.update], [null, 'none']);
});

test('Codex is the version its daemon runs, and its daemon updates it', async () => {
  const daemon = JSON.stringify({ status: 'running', managedCodexPath: '/Users/a/.codex/packages/standalone/current/bin/codex', managedCodexVersion: '0.153.4', cliVersion: '0.169.0', appServerVersion: '0.153.4' });
  const { cli } = computer({ commands: { 'codex app-server daemon version': daemon }, latest: { 'https://registry.npmjs.org/@openai%2fcodex/latest': { version: '0.169.0' } } });
  assert.deepEqual(await cli.report('codex'), {
    agent: 'codex', running: '0.153.4', installed: '0.153.4', latest: '0.169.0', install: 'daemon', update: 'available',
  });
});

test('Antigravity updates itself and says its newest version nowhere, so it has no update to offer', async () => {
  const { cli } = computer({ commands: { '/bin/sh -c command -v agy': '/Users/a/.local/bin/agy\n', '/Users/a/.local/bin/agy --version': '1.5.11\n' } });
  const report = await cli.report('antigravity');
  assert.deepEqual([report.installed, report.install, report.update], ['1.5.11', 'self', 'none']);
});

test('an agent with no command here says so', async () => {
  const { cli } = computer();
  const report = await cli.report('antigravity');
  assert.deepEqual([report.installed, report.install, report.update], [null, 'missing', 'none']);
});

test('an update runs in the background, says so meanwhile, and hands on the version it installed', async () => {
  let finish;
  const upgraded = new Promise(resolve => { finish = resolve; });
  let version = '2.1.326';
  const { cli, ran } = computer({
    commands: claudeAt({
      [`${CASK} --version`]: () => `${version} (Claude Code)\n`,
      '/opt/homebrew/bin/brew upgrade --cask claude-code@latest': () => upgraded.then(() => { version = '2.1.327'; return ''; }),
    }),
    latest: { [CASK_API]: { version: '2.1.327' } },
  });
  let told;
  const done = new Promise(resolve => { told = resolve; });
  assert.deepEqual(await cli.update('claude', { after: told }), { started: true });
  assert.equal((await cli.report('claude')).update, 'updating');
  assert.deepEqual(await cli.update('claude'), { started: false, updating: true }, 'a second asks for nothing more');
  finish();
  assert.equal((await done).version, '2.1.327');
  assert.ok(ran.includes('/opt/homebrew/bin/brew upgrade --cask claude-code@latest'));
  assert.equal((await cli.report('claude')).update, 'none');
});

test('an update that fails says what the command said, and can be tried again', async () => {
  const { cli } = computer({
    commands: claudeAt({ '/opt/homebrew/bin/brew upgrade --cask claude-code@latest': Object.assign(new Error('exit 1'), { stderr: 'Error: Download failed' }) }),
    latest: { [CASK_API]: { version: '2.1.327' } },
  });
  await cli.update('claude');
  await new Promise(resolve => { setTimeout(resolve, 10); });
  const report = await cli.report('claude');
  assert.deepEqual([report.update, report.error], ['available', 'Error: Download failed']);
});

test('an install the helper doesn\'t know of runs nothing', async () => {
  const { cli } = computer({ commands: { '/bin/sh -c command -v claude': '/Users/a/bin/claude\n', '/Users/a/bin/claude --version': '2.1.300\n' } });
  await assert.rejects(cli.update('claude'), { code: 'no_update' });
});
