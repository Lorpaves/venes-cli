import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { hooksFile, installHooks, pluginFolder, removeHooks } from '../../src/agyhooks.mjs';
import { VERSION } from '../../src/version.mjs';

function folder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-agyhooks-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the plugin goes where Antigravity looks, or where a run says', () => {
  assert.equal(pluginFolder({}, '/Users/me'), '/Users/me/.gemini/config/plugins/venes');
  assert.equal(pluginFolder({ VENES_AGY_CONFIG: '/tmp/elsewhere' }, '/Users/me'), '/tmp/elsewhere/plugins/venes');
});

test('no hook is asked whether a tool may run', () => {
  const hooks = hooksFile().venes;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostInvocation', 'PostToolUse', 'PreInvocation', 'SessionStart', 'Stop']);
  assert.deepEqual(hooks.Stop, [{ type: 'command', command: './hook.sh', timeout: 10 }]);
  assert.deepEqual(hooks.PostToolUse, [{ matcher: '*', hooks: [{ type: 'command', command: './hook.sh', timeout: 10 }] }]);
});

test('it\'s put on a Mac that has Antigravity\'s folder, kept as it is when nothing changed, and taken away whole', t => {
  const home = folder(t);
  const plugin = pluginFolder({}, home);
  assert.deepEqual(installHooks(plugin), { installed: false }, 'no Antigravity here');
  assert.equal(fs.existsSync(path.join(home, '.gemini')), false);
  fs.mkdirSync(path.join(home, '.gemini'));
  assert.deepEqual(installHooks(plugin), { installed: true, changed: true, folder: plugin });
  assert.deepEqual(fs.readdirSync(plugin).sort(), ['hook.sh', 'hooks.json', 'plugin.json']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(plugin, 'plugin.json'), 'utf8')), { name: 'venes', version: VERSION, description: 'Forwards session events to the local Venes helper.' });
  assert.equal(fs.statSync(path.join(plugin, 'hook.sh')).mode & 0o777, 0o755);
  assert.equal(installHooks(plugin).changed, false);
  fs.writeFileSync(path.join(plugin, 'hooks.json'), '{}');
  fs.chmodSync(path.join(plugin, 'hook.sh'), 0o644);
  assert.equal(installHooks(plugin).changed, true);
  assert.deepEqual([JSON.parse(fs.readFileSync(path.join(plugin, 'hooks.json'), 'utf8')), fs.statSync(path.join(plugin, 'hook.sh')).mode & 0o777], [hooksFile(), 0o755]);
  assert.deepEqual([removeHooks(plugin), fs.existsSync(plugin), removeHooks(plugin)], [true, false, false]);
  // A run that names its own folder gets it there whatever the Mac has.
  const named = pluginFolder({ VENES_AGY_CONFIG: path.join(home, 'named') }, home);
  assert.equal(installHooks(named, { always: true }).installed, true);
});

const run = (script, env, input) => new Promise(resolve => {
  const child = spawn('/bin/sh', [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', piece => { out += piece; });
  child.on('close', code => resolve({ code, out }));
  child.stdin.end(input);
});

test('the script hands an event to the helper with where it came from, and tells Antigravity to go on either way', async t => {
  const home = folder(t);
  const plugin = pluginFolder({ VENES_AGY_CONFIG: path.join(home, 'config') }, home);
  installHooks(plugin, { always: true });
  const script = path.join(plugin, 'hook.sh');
  const event = JSON.stringify({ conversationId: 'c', hookEventName: 'Stop' });
  // No helper: nothing waits, and nothing is wrong.
  assert.deepEqual(await run(script, { VENES_HOME: path.join(home, 'none'), PATH: '/usr/bin:/bin' }, event), { code: 0, out: '{}' });

  const venes = path.join(home, 'v');
  fs.mkdirSync(venes);
  const heard = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', piece => { body += piece; });
    req.on('end', () => { heard.push({ url: req.url, headers: req.headers, body }); res.end('ignored'); });
  });
  await new Promise(resolve => { server.listen(path.join(venes, 'hook.sock'), resolve); });
  t.after(() => server.close());
  const told = await run(script, { VENES_HOME: venes, PATH: '/usr/bin:/bin', TMUX_PANE: '%4', TMUX: '/tmp/s,1,0', REX_BLOCK: 'block:b' }, event);
  assert.deepEqual(told, { code: 0, out: '{}' });
  assert.equal(heard.length, 1);
  const [{ url, headers, body }] = heard;
  assert.deepEqual([url, body, headers['x-venes-agent'], headers['x-venes-pane'], headers['x-venes-tmux'], headers['x-venes-rex-block'], headers['x-venes-rex-session']],
    // A header with nothing to say isn't sent.
    ['/hook', event, 'antigravity', '%4', '/tmp/s,1,0', 'block:b', undefined]);
});
