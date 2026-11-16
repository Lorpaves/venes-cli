// The helper end to end on whatever system this is, with nothing of Claude Code's signed in: set up in
// a folder of its own, reached by a client, told of a session by the hook's own script, asked a
// permission through it and answered from the client, then stopped. It's what a Windows machine is
// tried with, where the sockets are pipes and the hook's script is Node's, and it runs the same on a
// Mac and on Linux.
//
//   node test/smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const isWindows = process.platform === 'win32';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-smoke-'));
const at = (...parts) => path.join(work, ...parts);
// Nothing of this machine's own is touched: every folder and socket the helper would use is the run's.
Object.assign(process.env, {
  VENES_HOME: at('home'), CLAUDE_CONFIG_DIR: at('claude'), DISABLE_UPDATES: '1', VENES_SDK_DIR: at('sdk'),
  VENES_TERMINAL: 'tmux', VENES_TMUX_SOCKET: at('no-tmux.sock'), VENES_REX_SERVER: `unix://${at('no-rex.sock')}`,
  VENES_CODEX_SOCKET: at('no-codex.sock'), VENES_AGY_CONFIG: at('antigravity'), VENES_AUTHORIZED_KEYS: at('authorized_keys'),
  VENES_DOWNLOADS: at('downloads'), VENES_TRASH: at('trash'), VENES_PUSH_URL: 'http://127.0.0.1:9/push',
});
delete process.env.CLAUDE_PLUGIN_ROOT;
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

// The hook's script, as Claude Code runs it: by Git Bash on Windows, by sh elsewhere.
const GIT_BASH = process.env.VENES_GIT_BASH || 'C:\\Program Files\\Git\\bin\\bash.exe';
function hook(mode, event, { through = 'script' } = {}) {
  const [command, args] = through === 'node' ? [process.execPath, [path.join(repo, 'scripts', 'hook.cjs'), mode]]
    : isWindows ? [GIT_BASH, [path.join(repo, 'scripts', 'hook.sh').replace(/\\/g, '/'), mode]]
      : ['/bin/sh', [path.join(repo, 'scripts', 'hook.sh'), mode]];
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let errors = '';
  child.stdout.on('data', chunk => { out += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify(event));
  return new Promise(resolve => { child.once('exit', code => resolve({ code, out, errors })); });
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

  // 3. A session starts, told of by the hook's script, and by Node's own way to it.
  const sessions = { script: randomUUID(), node: randomUUID() };
  for (const [through, sessionId] of Object.entries(sessions)) {
    const event = { session_id: sessionId, hook_event_name: 'SessionStart', source: 'startup', cwd: work, transcript_path: at('claude', 'projects', 'x', `${sessionId}.jsonl`) };
    const done = await hook('session-start', event, { through });
    assert.equal(done.code, 0, done.errors);
    let followed;
    for (let tries = 0; tries < 60 && !followed; tries++) {
      await delay(50);
      followed = (await client.request('sessions')).sessions.find(session => session.id === sessionId);
    }
    assert.ok(followed, `the session told of through ${through} is followed: ${done.errors}`);
  }
  step('a hook reaches the helper', isWindows ? 'through Git Bash and Node, and through Node alone' : 'through sh and curl, and through Node');

  // 4. A permission is asked through the hook, which waits, and answered from the client.
  const sessionId = sessions.script;
  const tool = { session_id: sessionId, cwd: work, permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'touch x' } };
  await hook('fast', { ...tool, hook_event_name: 'PreToolUse', tool_use_id: 't1' });
  const waiting = hook('hold', { ...tool, hook_event_name: 'PermissionRequest' });
  let asked;
  for (let tries = 0; tries < 100 && !asked; tries++) {
    await delay(50);
    asked = messages.find(message => message.type === 'event' && message.kind === 'request.opened' && message.sessionId === sessionId)
      ?? messages.map(message => message.event).find(event => event?.kind === 'request.opened');
  }
  assert.ok(asked, `the request reached the client: ${JSON.stringify(messages.slice(-3)).slice(0, 400)}`);
  const requestId = asked.request?.id ?? asked.requestId ?? asked.id;
  await client.request('respond', { requestId, decision: 'allow' });
  const answered = await waiting;
  assert.deepEqual(JSON.parse(answered.out), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  step('a permission asked through the hook is answered from the client');

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
  fs.writeFileSync(path.join(at('nowhere'), isWindows ? 'venes.cmd' : 'venes'), '');
  const silent = await hook('fast', { session_id: sessionId, hook_event_name: 'Stop' }, { through: 'node' });
  assert.deepEqual([silent.code, silent.out], [0, '']);
  step('stopped, and a hook with no helper to tell says nothing');
  console.log('SMOKE PASSED');
} catch (error) {
  failed = error;
  console.error(error.stack ?? error);
  try { console.error(fs.readFileSync(paths.logFile, 'utf8').split('\n').slice(-30).join('\n')); } catch { /* no log */ }
} finally {
  try { launch('stop'); } catch { /* gone already */ }
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(failed ? 1 : 0);
