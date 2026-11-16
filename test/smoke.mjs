// The helper end to end on whatever system this is, with nothing of Claude Code's signed in: set up in
// a folder of its own, reached by a client, told of a session by the hooks' own lines, asked a
// permission through them and answered from the client, then stopped. The lines are read out of
// hooks.json and run each way Claude Code runs one here: by sh on a Mac and on Linux, and on Windows by
// Git Bash where Git for Windows is installed and by PowerShell, which is what it uses where it isn't.
//
//   node test/smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const isWindows = process.platform === 'win32';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-smoke-'));
const at = (...parts) => path.join(work, ...parts);
// Nothing of this machine's own is touched: every folder and socket the helper would use is the run's.
Object.assign(process.env, {
  VENES_HOME: at('home'), CLAUDE_CONFIG_DIR: at('claude'), DISABLE_UPDATES: '1', VENES_SDK_DIR: at('sdk'),
  VENES_TERMINAL: 'tmux', VENES_TMUX_SOCKET: at('no-tmux.sock'), VENES_REX_SERVER: `unix://${at('no-rex.sock')}`,
  VENES_CODEX_SOCKET: at('no-codex.sock'), VENES_AGY_CONFIG: at('antigravity'), VENES_AUTHORIZED_KEYS: at('authorized_keys'),
  VENES_DOWNLOADS: at('downloads'), VENES_TRASH: at('trash'), VENES_PUSH_URL: 'http://127.0.0.1:9/push',
  CLAUDE_PLUGIN_ROOT: repo,
});
fs.mkdirSync(at('claude'), { recursive: true });
fs.mkdirSync(at('trash'), { recursive: true });

const { helperPaths } = await import(new URL('../src/paths.mjs', import.meta.url));
const { HelperClient } = await import(new URL('../src/client.mjs', import.meta.url));
const paths = helperPaths();
const cli = path.join(repo, 'cli', 'venes.mjs');
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const step = (name, detail = '') => console.log(`ok  ${name}${detail ? `: ${detail}` : ''}`);

// The launcher, as a person runs it: a command file on Windows, a script elsewhere.
const launch = (...args) => (isWindows
  ? execFileSync('cmd.exe', ['/d', '/s', '/c', `"${paths.launcher}" ${args.join(' ')}`], { encoding: 'utf8', windowsVerbatimArguments: true })
  : execFileSync(paths.launcher, args, { encoding: 'utf8' }));

// The ways Claude Code runs a hook's line on this system.
const GIT_BASH = process.env.VENES_GIT_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';
const routes = !isWindows ? ['sh'] : [...(fs.existsSync(GIT_BASH) ? ['Git Bash'] : []), 'PowerShell'];
const lines = JSON.parse(fs.readFileSync(path.join(repo, 'hooks', 'hooks.json'), 'utf8')).hooks;

// One event, sent the way `route` says, through the line hooks.json has for it.
function hook(route, event) {
  const line = lines[event.hook_event_name][0].hooks[0].command;
  const [command, args] = route === 'sh' ? ['/bin/sh', ['-c', line]]
    : route === 'Git Bash' ? [GIT_BASH, ['-c', line]]
      // PowerShell has its own way to write a variable of the environment's, which Claude Code puts in.
      : ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', line.replaceAll('${CLAUDE_PLUGIN_ROOT}', '${env:CLAUDE_PLUGIN_ROOT}')]];
  const started = Date.now();
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let errors = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(event));
  return new Promise(resolve => {
    child.once('error', error => resolve({ code: -1, out, errors: String(error), took: Date.now() - started }));
    child.once('exit', code => resolve({ code, out, errors, took: Date.now() - started }));
  });
}

let failed;
try {
  // 1. Set up, as the plugin does when a session starts: the launcher written, the helper started.
  execFileSync(process.execPath, [cli, 'setup'], { stdio: 'inherit' });
  assert.equal(fs.existsSync(paths.launcher), true, 'the launcher is written');
  assert.match(launch('version'), /\(running: /);
  step('set up, and the launcher runs', `${path.basename(paths.launcher)} says ${launch('version').trim()}`);

  // 2. A client, as `attach` gives the app one.
  const client = await HelperClient.connect(paths.clientSocket);
  const messages = [];
  client.on('message', message => messages.push(message));
  for (let tries = 0; tries < 50 && !messages.length; tries++) await delay(50);
  assert.equal(messages[0]?.type, 'hello');
  assert.equal(messages[0].platform, process.platform);
  await client.request('subscribe');
  step('a client is greeted', `${messages[0].platform}, ${isWindows ? 'over a named pipe' : 'over a socket'}`);

  for (const route of routes) {
    // 3. A session starts, told of by the hook's line.
    const sessionId = randomUUID();
    const told = await hook(route, { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup', cwd: work, transcript_path: at('claude', 'projects', 'x', `${sessionId}.jsonl`) });
    assert.equal(told.code, 0, `${route}: ${told.errors}`);
    let followed;
    for (let tries = 0; tries < 60 && !followed; tries++) {
      await delay(50);
      followed = (await client.request('sessions')).sessions.find(session => session.id === sessionId);
    }
    assert.ok(followed, `the session told of through ${route} is followed: ${told.errors}`);

    // 4. A permission is asked through the hook, which waits, and refused from the client in words
    // that aren't ASCII, which have to come back whole through whatever shell is in between.
    const tool = { session_id: sessionId, cwd: work, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'touch x' } };
    const before = await hook(route, { ...tool, hook_event_name: 'PreToolUse', tool_use_id: `t-${sessionId}` });
    assert.deepEqual([before.code, before.out], [0, ''], `${route}: ${before.errors}`);
    const waiting = hook(route, { ...tool, hook_event_name: 'PermissionRequest' });
    let asked;
    for (let tries = 0; tries < 200 && !asked; tries++) {
      await delay(50);
      asked = messages.map(message => message.event ?? message).find(event => event?.kind === 'request.opened' && event.sessionId === sessionId);
    }
    assert.ok(asked, `the request asked through ${route} reached the client: ${JSON.stringify(messages.slice(-2)).slice(0, 300)}`);
    const words = '不行，换个办法 – não';
    await client.request('respond', { requestId: asked.request.id, decision: 'deny', message: words });
    const answered = await waiting;
    assert.equal(answered.code, 0, `${route}: ${answered.errors}`);
    const { decision } = JSON.parse(answered.out).hookSpecificOutput;
    assert.equal(decision.behavior, 'deny');
    assert.ok(decision.message.endsWith(words), `${route} brought back: ${decision.message}`);
    step(`through ${route}: a session is followed, and a permission asked and refused`, `${before.took} ms for an event that says nothing`);
  }

  // 5. With no helper, a hook says nothing and ends well, and Claude Code carries on.
  client.close();
  launch('stop');
  for (let tries = 0; tries < 60; tries++) {
    await delay(50);
    if (!/running:/.test(launch('version'))) break;
  }
  assert.doesNotMatch(launch('version'), /running:/);
  process.env.VENES_HOME = at('nowhere');
  fs.mkdirSync(at('nowhere'));
  fs.writeFileSync(path.join(at('nowhere'), isWindows ? 'venes.cmd' : 'venes'), isWindows ? '' : '#!/bin/sh\n', { mode: 0o755 });
  for (const route of routes) {
    const silent = await hook(route, { session_id: randomUUID(), hook_event_name: 'Stop' });
    assert.deepEqual([silent.code, silent.out], [0, ''], `${route}: ${silent.errors}`);
  }
  step('stopped, and a hook with no helper to tell says nothing', routes.join(', '));
  console.log('SMOKE PASSED');
} catch (error) {
  failed = error;
  console.error(error.stack ?? error);
  try { console.error(fs.readFileSync(paths.logFile, 'utf8').split('\n').slice(-30).join('\n')); } catch { /* no log */ }
} finally {
  try { launch('stop'); } catch { /* gone already */ }
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 }); } catch { /* still held by something on its way out */ }
}
process.exit(failed ? 1 : 0);
