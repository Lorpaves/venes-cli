#!/usr/bin/env node
// End-to-end check against a real interactive Claude Code session, with this
// repository loaded as the plugin through --plugin-dir.
//
//   VENES_E2E_WS=/abs/workspace node test/e2e.mjs [case-prefix ...]
//
// Isolation: a dedicated tmux socket and VENES_HOME, and no user settings loaded.
// Nothing is installed: the plugin exists only for these sessions.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { helperPaths } from '../src/paths.mjs';
import { HelperClient } from '../src/client.mjs';
import { findClaudePanes } from '../src/tmux.mjs';
import { VERSION } from '../src/version.mjs';

const WS = process.env.VENES_E2E_WS;
if (!WS || !path.isAbsolute(WS)) throw new Error('VENES_E2E_WS must be an absolute path');
// Unix socket paths are limited to 104 bytes on macOS, which rules out long temp dirs.
const HOME = process.env.VENES_E2E_HOME || '/tmp/venes-e2e';
const MODEL = process.env.VENES_E2E_MODEL || 'haiku';
const CLAUDE = execFileSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).trim();
const SOCK = 'venes-e2e';
const PLUGIN = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(PLUGIN, 'cli/venes.mjs');
const paths = helperPaths(HOME);

const delay = ms => new Promise(r => { setTimeout(r, ms); });
const shq = s => `'${s.replace(/'/g, `'\\''`)}'`;
const tmux = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const exists = f => fs.existsSync(path.join(WS, f));
const TOUCH = n => `Use the Bash tool to run exactly this command: touch e2e-${n}.txt -- then reply with only the word DONE.`;
const ASK = 'Use the AskUserQuestion tool to ask me one question, "Which color?", with exactly two options: Red and Blue. After I answer, reply with only the color I picked.';
const PLAN = n => `Make a one-step plan to create the file e2e-${n}.txt using touch, then call ExitPlanMode. Do not ask questions.`;
const SLEEP = (s, word) => `Use the Bash tool in the foreground to run exactly this command: python3 -c 'import time; time.sleep(${s})' -- then reply with only the word ${word}.`;

function startHelper(cli = CLI) {
  // Updates stay off: a test run must never touch the plugins of the Claude it borrows.
  const env = { ...process.env, VENES_HOME: HOME, DISABLE_UPDATES: '1' };
  spawn(process.execPath, [cli, 'daemon'], { env, stdio: 'ignore', detached: true }).unref();
}
function helperPid() {
  try { return Number(fs.readFileSync(paths.pidFile, 'utf8')); } catch { return undefined; }
}
// By pid file, because the plugin's SessionStart hook may have started it.
async function stopHelper() {
  const pid = helperPid();
  if (!pid) return;
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  for (let i = 0; i < 60; i++) {
    try { process.kill(pid, 0); } catch { return; }
    await delay(50);
  }
}
process.on('exit', () => { try { process.kill(helperPid(), 'SIGTERM'); } catch { /* not running */ } });
async function connect() {
  for (let i = 0; i < 40; i++) {
    try { return await HelperClient.connect(paths.clientSocket); } catch { await delay(100); }
  }
  throw new Error('helper did not come up');
}

class Run {
  events = [];
  constructor(client) {
    this.client = client;
    client.on('message', m => { if (m.type === 'event') this.events.push(m.event); });
  }
  pane() { return tmux('capture-pane', '-p', '-t', 'run'); }
  key(...k) { tmux('send-keys', '-t', 'run', ...k); }
  async type(text) { tmux('send-keys', '-t', 'run', '-l', text); await delay(500); this.key('Enter'); }
  async wait(pred, ms = 45000, label = 'event') {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      await delay(60);
    }
    throw new Error(`timed out waiting for ${label}; saw: ${this.events.map(e => e.kind).join(' ')}`);
  }
  kind(k, ms) { return this.wait(e => e.kind === k, ms, k); }
  async request(kind, ms) { return (await this.wait(e => e.kind === 'request.opened' && e.request.kind === kind, ms, `request ${kind}`)).request; }
  closed(requestId, ms = 15000) { return this.wait(e => e.kind === 'request.closed' && e.requestId === requestId, ms, 'request.closed'); }
  async turnEnd(ms) { return this.kind('turn.end', ms); }
  async session() {
    const { sessions } = await this.client.request('sessions');
    return sessions.find(s => s.status !== 'ended') ?? sessions.at(-1);
  }
  mark() { this.events.length = 0; }
  // A denied model may try again. Assert on what the helper controls, not on the model's wording.
  denyEverything(message) {
    const deny = requestId => this.client.request('respond', { requestId, decision: 'deny', message }).catch(() => {});
    for (const e of this.events) if (e.kind === 'request.opened') deny(e.request.id);
    this.client.on('message', m => { if (m.type === 'event' && m.event.kind === 'request.opened') deny(m.event.request.id); });
  }
  async deliveredToClaude(text) {
    const end = await this.wait(e => e.kind === 'tool.end' && e.isError, 12000, 'rejected tool.end');
    assert.match(String(end.response), text);
  }
}

function launch({ mode = 'default', sources = 'project' } = {}) {
  const env = [
    `HOME=${process.env.HOME}`, `USER=${process.env.USER}`, `PATH=${process.env.PATH}`, `VENES_HOME=${HOME}`, 'DISABLE_UPDATES=1',
    'TERM=tmux-256color', 'LANG=en_US.UTF-8', 'LC_ALL=en_US.UTF-8',
  ];
  const cmd = ['exec', 'env', '-i', 'TMUX="$TMUX"', 'TMUX_PANE="$TMUX_PANE"', ...env.map(shq), shq(CLAUDE),
    '--model', MODEL, '--permission-mode', mode, '--setting-sources', sources, '--plugin-dir', shq(PLUGIN)].join(' ');
  tmux('new-session', '-d', '-s', 'run', '-x', '110', '-y', '42', '-c', WS, 'sh', '-c', cmd);
}

async function ready(run) {
  const end = Date.now() + 40000; let answered = false;
  while (Date.now() < end) {
    const p = run.pane();
    if (/Yes, I accept/.test(p)) { run.key('Down'); await delay(400); run.key('Enter'); await delay(1500); continue; }
    if (!answered && /trust/i.test(p) && /Yes/.test(p)) { run.key('Enter'); answered = true; await delay(1500); continue; }
    if (/shortcuts|mode on|\bmanual\b|plan mode|bypass permissions on/i.test(p)) { await delay(1200); return; }
    await delay(200);
  }
  throw new Error(`Claude did not start:\n${run.pane()}`);
}

const cases = {};
const T = (name, opts, fn) => { cases[name] = { opts, fn }; };

T('discovery_and_stream', {}, async r => {
  await r.kind('session.started', 8000);
  const before = await r.session();
  assert.ok(before.pane, 'pane is known from SessionStart');
  assert.equal(before.pane, tmux('display-message', '-p', '-t', 'run', '#{pane_id}').trim());
  const panes = await findClaudePanes([before.tmuxSocket]);
  assert.deepEqual(panes.map(p => p.pane), [before.pane], 'the scan finds Claude in its pane, and nothing else');
  await r.type('Reply with only the word STREAM.');
  const end = await r.turnEnd();
  assert.equal(end.lastMessage.trim(), 'STREAM');
  assert.equal((await r.kind('message.user')).text, 'Reply with only the word STREAM.');
  const delta = await r.kind('message.assistant.delta');
  assert.match(delta.text, /STREAM/);
  assert.equal((await r.session()).status, 'idle');
});

T('approve_from_client', {}, async r => {
  await r.type(TOUCH('allow'));
  const request = await r.request('permission');
  assert.equal(request.toolName, 'Bash');
  assert.ok(request.toolUseId, 'paired with PreToolUse');
  assert.equal((await r.session()).status, 'waiting');
  assert.match(r.pane(), /Do you want to proceed/, 'terminal dialog is visible at the same time');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  assert.equal((await r.closed(request.id)).by, 'client');
  await r.turnEnd();
  assert.ok(exists('e2e-allow.txt'));
  assert.ok(r.events.some(e => e.kind === 'tool.end' && e.name === 'Bash' && !e.isError));
});

T('deny_from_client', {}, async r => {
  await r.type(TOUCH('deny'));
  const request = await r.request('permission');
  r.denyEverything('Denied from the phone.');
  assert.deepEqual((({ decision, by }) => [decision, by])(await r.closed(request.id)), ['deny', 'client']);
  await r.deliveredToClaude(/Denied from the phone/);
  await r.turnEnd();
  assert.ok(!exists('e2e-deny.txt'));
});

T('terminal_approves_first', {}, async r => {
  await r.type(TOUCH('term'));
  const request = await r.request('permission');
  await delay(1000);
  r.key('1');
  const closed = await r.closed(request.id);
  assert.deepEqual([closed.decision, closed.by], ['allow', 'terminal']);
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'deny' }), { code: 'request_closed' });
  await r.turnEnd();
  assert.ok(exists('e2e-term.txt'));
});

T('terminal_rejects', {}, async r => {
  await r.type(TOUCH('rej'));
  const request = await r.request('permission');
  await delay(1000);
  const pressed = Date.now();
  r.key('Escape');
  const closed = await r.closed(request.id, 8000);
  console.log(`      terminal rejection detected after ${closed.at - pressed}ms`);
  assert.deepEqual([closed.decision, closed.by], ['deny', 'terminal']);
  await r.kind('turn.interrupted', 5000);
  assert.equal((await r.session()).status, 'idle');
  assert.ok(!exists('e2e-rej.txt'));
});

T('interrupt_running_tool', {}, async r => {
  await r.type(`Use the Bash tool in the foreground to run exactly this command: python3 -c 'import time; time.sleep(30)' -- then reply with only the word FINISHED.`);
  const request = await r.request('permission');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await delay(2500);
  const { id } = await r.session();
  const pressed = Date.now();
  await r.client.request('interrupt', { sessionId: id });
  const seen = await r.kind('turn.interrupted', 8000);
  console.log(`      interrupt detected after ${seen.at - pressed}ms`);
  assert.ok(r.events.some(e => e.kind === 'tool.end' && e.isError), 'the running tool is closed');
  assert.equal((await r.session()).status, 'idle');
  await assert.rejects(r.client.request('interrupt', { sessionId: id }), { code: 'not_running' });
});

T('interrupt_generation', {}, async r => {
  await r.type('Write the numbers 1 to 2000, one per line, with no tools.');
  await r.kind('message.assistant.delta', 20000);
  const { id } = await r.session();
  await r.client.request('interrupt', { sessionId: id });
  await r.kind('turn.interrupted', 8000);
  assert.equal((await r.session()).status, 'idle');
});

T('question_from_client', {}, async r => {
  await r.type(ASK);
  const request = await r.request('question');
  assert.equal(request.input.questions[0].question, 'Which color?');
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', answers: {} }), { code: 'missing_answers' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers: { 'Which color?': 'Blue' } });
  assert.match((await r.turnEnd()).lastMessage, /Blue/);
});

T('question_in_bypass_mode', { mode: 'bypassPermissions' }, async r => {
  await r.type(TOUCH('bypass'));
  await r.turnEnd();
  assert.ok(exists('e2e-bypass.txt'));
  assert.ok(!r.events.some(e => e.kind === 'request.opened'), 'no approval in bypass mode');
  r.mark();
  await r.type(ASK);
  const request = await r.request('question');
  await r.client.request('respond', { requestId: request.id, decision: 'allow', answers: { 'Which color?': 'Red' } });
  assert.match((await r.turnEnd()).lastMessage, /Red/);
});

T('plan_approve', { mode: 'plan' }, async r => {
  await r.type(PLAN('plan'));
  const request = await r.request('plan', 60000);
  assert.match(request.input.plan, /e2e-plan/);
  r.mark();
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  const tool = await r.request('permission', 30000);
  await r.client.request('respond', { requestId: tool.id, decision: 'allow' });
  await r.turnEnd();
  assert.ok(exists('e2e-plan.txt'));
  assert.ok(r.events.some(e => e.kind === 'session.mode' && e.permissionMode === 'default'), 'mode change is reported');
});

T('plan_reject', { mode: 'plan' }, async r => {
  await r.type(PLAN('planno'));
  const request = await r.request('plan', 60000);
  r.denyEverything('Rejected from the phone.');
  await r.deliveredToClaude(/Rejected from the phone/);
  await r.turnEnd(60000);
  assert.ok(!exists('e2e-planno.txt'));
});

T('send_messages', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  const long = `Reply with only the word LONG. Ignore the padding: ${'x'.repeat(3000)}`;
  for (const text of ['请只回复 中文收到', '第一行：只回复 多行收到\n第二行：不要解释', '-- reply with only the word DASH;', long]) {
    r.mark();
    await r.client.request('send', { sessionId: id, text });
    assert.equal((await r.kind('message.user', 12000)).text, text);
    await r.turnEnd(30000);
  }
});

T('send_is_blocked_during_a_request', {}, async r => {
  await r.type(TOUCH('guard'));
  const request = await r.request('permission');
  const { id } = await r.session();
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'stray message' }), { code: 'request_pending' });
  await delay(1500);
  assert.ok(!exists('e2e-guard.txt'), 'the blocked send must not approve the tool');
  r.denyEverything('Denied from the phone.');
  await r.closed(request.id);
  await r.turnEnd();
  assert.ok(!exists('e2e-guard.txt'));
});

T('send_is_blocked_by_an_unknown_dialog', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  await r.type('/model');
  await delay(1500);
  await assert.rejects(r.client.request('send', { sessionId: id, text: 'stray message' }), { code: 'dialog_open' });
  r.key('Escape');
});

T('background_agent', {}, async r => {
  r.denyEverything('Not needed. Just reply.'); // the subagent may reach for a tool that needs approval
  await r.type('Use the Agent tool with subagent_type general-purpose and the prompt "Reply with the number 4". Then reply with only the word DONE.');
  await r.kind('agent.start', 30000);
  await r.wait(e => e.kind === 'agent.stop', 45000, 'agent.stop');
  await r.kind('turn.end', 30000);
  await delay(2500);
  const fake = r.events.filter(e => e.kind === 'message.user' && e.text.includes('task-notification'));
  assert.equal(fake.length, 0, 'task notifications are not user messages');
});

T('history', {}, async r => {
  await r.type(TOUCH('hist'));
  const request = await r.request('permission');
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd();
  await delay(1500);
  const { id } = await r.session();
  const { items } = await r.client.request('history', { sessionId: id });
  for (const role of ['assistant', 'tool', 'turn_end', 'user']) assert.ok(items.some(i => i.role === role), role);
  assert.equal(items.find(i => i.role === 'tool').name, 'Bash');
});

T('history_pages_and_keeps_messages_sent_during_a_turn', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(5, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: 'Also say the word QUEUED.' });
  await r.turnEnd(40000);
  await delay(1500);
  const all = await r.client.request('history', { sessionId: id, limit: 1000 });
  assert.equal(all.hasMore, false);
  assert.ok(all.items.some(i => i.role === 'user' && i.text === 'Also say the word QUEUED.'), 'a message sent during a turn is kept');
  const page = await r.client.request('history', { sessionId: id, limit: 2 });
  const older = await r.client.request('history', { sessionId: id, limit: 2, before: page.before });
  assert.equal(page.hasMore, true);
  assert.deepEqual([...older.items, ...page.items], all.items.slice(-4), 'pages join up with no overlap');
});

T('join_replays_the_running_turn_and_nothing_twice', { mode: 'bypassPermissions' }, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  await delay(2500);
  const { id } = await r.session();
  const before = await r.client.request('join', { sessionId: id });
  assert.deepEqual(before.turn, [], 'a finished turn comes from the transcript alone');
  assert.ok(before.items.some(i => i.role === 'assistant' && /READY/.test(i.text)));
  assert.match(before.sessions[0].lastMessage, /READY/);
  assert.equal(before.sessions[0].lastPrompt, 'Reply with only the word READY.');

  r.mark();
  const prompt = SLEEP(5, 'SECOND');
  await r.type(prompt);
  const start = await r.kind('tool.start', 30000);
  await delay(800); // long enough for the transcript to have the call
  const during = await r.client.request('join', { sessionId: id });
  assert.equal(during.sessions[0].status, 'running');
  assert.ok(!during.items.some(i => i.role === 'user' && i.text === prompt), 'the prompt is in the turn, not the page');
  assert.ok(!during.items.some(i => i.toolUseId === start.toolUseId), 'nor is the running call');
  assert.ok(during.items.some(i => i.text === 'Reply with only the word READY.'), 'the page keeps the turn before');
  assert.equal(during.turn[0].kind, 'message.user');
  assert.equal(during.turn[0].text, prompt);
  assert.ok(during.turn.some(e => e.kind === 'tool.start' && e.toolUseId === start.toolUseId));
  assert.ok(!during.turn.some(e => e.kind === 'tool.end'), 'the call is still running');
  assert.equal(during.turn.at(-1).seq, during.seq, 'nothing newer is left out');

  await r.turnEnd(40000);
  await delay(2500);
  const after = await r.client.request('join', { sessionId: id });
  assert.deepEqual(after.turn, []);
  const tool = after.items.find(i => i.toolUseId === start.toolUseId);
  assert.ok(tool && 'result' in tool, 'once it is over the transcript has it all');
  assert.equal(after.items.filter(i => i.role === 'user' && i.text === prompt).length, 1);
});

T('send_carries_a_client_id', {}, async r => {
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  const { queued } = await r.client.request('send', { sessionId: id, text: 'Reply with only the word ECHO.', clientId: 'c1', lane: 'later' });
  assert.equal(queued, false, 'an idle session takes it right away');
  assert.equal((await r.kind('message.user', 12000)).clientId, 'c1');
  await r.turnEnd(30000);
});

T('send_during_a_turn', { mode: 'bypassPermissions' }, async r => {
  const echoed = clientId => r.wait(e => e.kind === 'message.user' && e.clientId === clientId, 12000, `echo of ${clientId}`);
  await r.type(SLEEP(10, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();

  assert.equal((await r.client.request('send', { sessionId: id, text: 'Also say the word NEXT.', clientId: 'next', lane: 'next' })).queued, false);
  await echoed('next');
  assert.ok(!r.events.some(e => e.kind === 'tool.end'), 'the next lane reaches Claude while the tool still runs');

  const later = { sessionId: id, lane: 'later' };
  assert.equal((await r.client.request('send', { ...later, text: 'Reply with only the word LATER.', clientId: 'later' })).queued, true);
  assert.equal((await r.client.request('send', { ...later, text: 'Reply with only the word DROPPED.', clientId: 'drop' })).queued, true);
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'drop' })).cancelled, true);
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'drop' })).cancelled, false);

  await r.turnEnd(40000);
  assert.ok(!r.events.some(e => e.clientId === 'later'), 'a held message waits for the turn to end');
  await echoed('later');
  await r.wait(e => e.kind === 'turn.end' && /LATER/.test(e.lastMessage), 30000, 'the held turn');
  assert.equal((await r.client.request('cancel', { sessionId: id, clientId: 'later' })).cancelled, false, 'too late to cancel');
  assert.ok(!r.events.some(e => e.kind === 'message.user' && /DROPPED/.test(e.text)), 'a cancelled message never reaches Claude');
});

T('held_message_follows_an_interrupt', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(20, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word AFTER.', clientId: 'after', lane: 'later' });
  await r.client.request('interrupt', { sessionId: id });
  await r.kind('turn.interrupted', 8000);
  await r.wait(e => e.kind === 'message.user' && e.clientId === 'after', 12000, 'held message');
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'the held turn');
});

T('held_messages_get_past_a_local_command', { mode: 'bypassPermissions' }, async r => {
  await r.type(SLEEP(5, 'FIRST'));
  await r.kind('tool.start', 30000);
  const { id } = await r.session();
  const later = { sessionId: id, lane: 'later' };
  await r.client.request('send', { ...later, text: '/compact', clientId: 'compact' });
  await r.client.request('send', { ...later, text: 'Reply with only the word AFTER.', clientId: 'after' });
  const compacted = await r.kind('compact.end', 120000);
  const echo = await r.wait(e => e.kind === 'message.user' && e.clientId === 'after', 15000, 'the message behind the command');
  assert.ok(echo.seq > compacted.seq, 'it waits for the compaction to finish');
  await r.wait(e => e.kind === 'turn.end' && /AFTER/.test(e.lastMessage), 30000, 'its turn');
});

T('a_compaction_that_fails_ends', {}, async r => {
  const { id } = await r.session();
  await r.client.request('send', { sessionId: id, text: '/compact' });
  const failed = await r.kind('compact.failed', 15000);
  assert.match(failed.message, /Not enough messages/);
  assert.ok(!r.events.some(e => e.kind === 'compact.end'));
  await r.client.request('send', { sessionId: id, text: 'Reply with only the word STILL.', lane: 'later', clientId: 'still' });
  await r.wait(e => e.kind === 'turn.end' && /STILL/.test(e.lastMessage), 30000, 'a message after it');
});

T('always_allow', { sources: 'project,local' }, async r => {
  const prompt = `Use the Bash tool to run exactly this command: python3 -c 'print(40 + 2)' -- then reply with only the word DONE.`;
  try {
    await r.type(prompt);
    const request = await r.request('permission');
    assert.deepEqual(request.permissionSuggestions.map(s => s.type), ['addRules'], 'a rule for this command, nothing wider');
    await r.client.request('respond', { requestId: request.id, decision: 'allow', always: true });
    await r.turnEnd();
    r.mark();
    await r.type(prompt);
    await r.turnEnd();
    assert.ok(r.events.some(e => e.kind === 'tool.end' && /42/.test(e.response?.stdout)), 'the tool ran again');
    assert.ok(!r.events.some(e => e.kind === 'request.opened'), 'without asking');
    assert.equal((await r.session()).permissionMode, 'default', 'the mode is left alone');
    const { permissions } = JSON.parse(fs.readFileSync(path.join(WS, '.claude/settings.local.json'), 'utf8'));
    console.log(`      remembered: ${JSON.stringify(permissions.allow)}`);
    assert.ok(permissions.allow.some(rule => rule.startsWith('Bash(python3')), 'as a rule in the project\'s local settings');
  } finally {
    fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true }); // the rule must not reach other cases
  }
});

T('always_is_not_offered_for_a_mode_switch', {}, async r => {
  await r.type(TOUCH('widen'));
  const request = await r.request('permission');
  assert.deepEqual(request.permissionSuggestions, [], 'touch only gets a mode suggestion, which is withheld');
  await assert.rejects(r.client.request('respond', { requestId: request.id, decision: 'allow', always: true }), { code: 'nothing_to_remember' });
  await r.client.request('respond', { requestId: request.id, decision: 'allow' });
  await r.turnEnd();
  assert.equal((await r.session()).permissionMode, 'default');
});

T('background_command', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Bash tool with run_in_background set to true to run exactly: sleep 3; echo BGDONE -- then reply with only the word STARTED and stop.');
  const { task } = await r.wait(e => e.kind === 'background.task' && e.task.type === 'shell', 30000, 'launch');
  assert.equal(task.status, 'running');
  assert.ok(task.toolUseId);
  const end = await r.turnEnd();
  assert.deepEqual(end.tasks.map(t => t.id), [task.id]);
  const finished = await r.wait(e => e.kind === 'background.task' && e.task.id === task.id && e.task.status !== 'running', 20000, 'finish');
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.task.hasOutput, true);
  const { id, tasks } = await r.session();
  assert.equal(tasks.find(t => t.id === task.id).status, 'completed');
  assert.match((await r.client.request('taskOutput', { sessionId: id, taskId: task.id })).output, /BGDONE/);
});

T('subagent_calls_name_their_parent', { mode: 'bypassPermissions' }, async r => {
  await r.type('Use the Agent tool with subagent_type general-purpose and this prompt: "Use the Bash tool to run: echo hi. Then reply DONE." Then reply with only the word OK.');
  const parent = await r.wait(e => e.kind === 'tool.start' && e.name === 'Agent', 30000, 'Agent call');
  const inner = await r.wait(e => e.kind === 'tool.start' && e.agentId, 45000, 'subagent call');
  assert.equal(inner.parentToolUseId, parent.toolUseId);
  const { task } = await r.wait(e => e.kind === 'background.task' && e.task.type === 'subagent' && e.task.status !== 'running', 60000, 'finish');
  assert.ok(task.tokens > 0);
  assert.ok(task.toolUses >= 1);
  const { id } = await r.session();
  assert.match((await r.client.request('taskOutput', { sessionId: id, taskId: task.id })).output, /DONE/);
  const { items } = await r.client.request('history', { sessionId: id });
  assert.ok(items.some(i => i.parentToolUseId === parent.toolUseId && i.name === 'Bash'), 'history nests it too');
});

T('compaction_reports_its_size', {}, async r => {
  const started = await r.kind('session.started', 8000);
  assert.equal(started.cwd, fs.realpathSync(WS));
  await r.type('Reply with only the word READY.');
  await r.turnEnd();
  const { id } = await r.session();
  r.mark();
  await r.client.request('send', { sessionId: id, text: '/compact' });
  const end = await r.kind('compact.end', 120000);
  assert.ok(end.preTokens > 0 && end.postTokens > 0, 'the sizes reach the event');
  await delay(500);
  const { items } = await r.client.request('history', { sessionId: id });
  assert.ok(items.some(i => i.role === 'compact' && i.preTokens === end.preTokens));
  assert.ok(!items.some(i => i.role === 'user' && /being continued/.test(i.text)), 'the summary is not shown as a user message');
});

T('clear_replaces_the_session', {}, async r => {
  await r.type('Reply with only the word FIRST.');
  await r.turnEnd();
  const first = (await r.session()).id;
  r.mark();
  await r.client.request('send', { sessionId: first, text: '/clear' });
  await r.wait(e => e.kind === 'session.ended' && e.sessionId === first, 10000, 'old session ended');
  await r.wait(e => e.kind === 'session.started' && e.sessionId !== first, 10000, 'new session started');
  const { sessions } = await r.client.request('sessions');
  const live = sessions.filter(s => s.status !== 'ended');
  assert.equal(live.length, 1);
  assert.notEqual(live[0].id, first);
  assert.ok(live[0].pane);
});

T('reconnect_replays_events', {}, async r => {
  await r.type('Reply with only the word ONE.');
  await r.turnEnd();
  const { seq } = await new Promise(resolve => {
    r.client.once('message', resolve);
    r.client.request('subscribe').catch(() => {});
  });
  await r.type('Reply with only the word TWO.');
  await delay(100);
  await r.wait(e => e.kind === 'turn.end' && /TWO/.test(e.lastMessage), 30000, 'second turn');
  const late = await HelperClient.connect(paths.clientSocket);
  const replay = [];
  late.on('message', m => { if (m.type === 'event') replay.push(m.event); });
  const { gap } = await late.request('subscribe', { since: seq });
  await delay(200);
  late.close();
  assert.equal(gap, false);
  assert.ok(replay.some(e => e.kind === 'turn.end' && /TWO/.test(e.lastMessage)));
  assert.ok(replay.every(e => e.seq > seq));

  const other = await HelperClient.connect(paths.clientSocket);
  const fromAnotherBoot = await other.request('subscribe', { since: seq, bootId: 'an-earlier-boot' });
  other.close();
  assert.equal(fromAnotherBoot.gap, true, 'a helper restart is reported as a gap');
});

T('plugin_starts_the_helper', { noHelper: true }, async r => {
  const client = await connect();
  const run = new Run(client);
  await client.request('subscribe');
  assert.ok(fs.statSync(paths.launcher).mode & 0o100, 'launcher written');
  assert.match(fs.readFileSync(paths.launcher, 'utf8'), /cli\/venes\.mjs/);
  await r.type('Reply with only the word AUTO.');
  assert.match((await run.turnEnd(30000)).lastMessage, /AUTO/);
  assert.equal(execFileSync(paths.launcher, ['status'], { encoding: 'utf8' }).trim(), 'running');
  client.close();
});

// A copy of this plugin that says it's older, as an install from before an update would be.
function startOlderHelper() {
  const dir = `${HOME}-older`;
  fs.rmSync(dir, { recursive: true, force: true });
  for (const part of ['src', 'cli', '.claude-plugin', 'package.json']) fs.cpSync(path.join(PLUGIN, part), path.join(dir, part), { recursive: true });
  const manifest = path.join(dir, '.claude-plugin/plugin.json');
  fs.writeFileSync(manifest, JSON.stringify({ ...JSON.parse(fs.readFileSync(manifest, 'utf8')), version: '0.0.1' }));
  startHelper(path.join(dir, 'cli/venes.mjs'));
}

T('a_new_session_replaces_an_older_helper', { noHelper: true, before: startOlderHelper }, async r => {
  const client = await connect();
  assert.equal((await client.request('ping')).version, VERSION, 'the plugin\'s session start swapped it');
  const run = new Run(client);
  await client.request('subscribe');
  const { sessions } = await client.request('sessions');
  assert.equal(sessions.length, 1, 'and its own SessionStart reached the new helper');
  assert.ok(sessions[0].pane);
  assert.match(fs.readFileSync(paths.launcher, 'utf8'), new RegExp(CLI.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await r.type('Reply with only the word SWAPPED.');
  assert.match((await run.turnEnd(30000)).lastMessage, /SWAPPED/);
  client.close();
  fs.rmSync(`${HOME}-older`, { recursive: true, force: true });
});

T('helper_down_is_silent', { noHelper: true }, async r => {
  (await connect()).close();
  await stopHelper();
  await r.type(TOUCH('down'));
  await r.waitForPane(/Do you want to proceed/, 25000);
  r.key('1');
  await r.waitForPane(/⏺ DONE/, 20000);
  await delay(800);
  const screen = r.pane();
  assert.doesNotMatch(screen, /hook error|ECONNREFUSED|failed/i, 'no hook noise in the terminal');
  assert.ok(exists('e2e-down.txt'));
  startHelper();
  const client = await connect();
  const run = new Run(client);
  await client.request('subscribe');
  await r.type('Reply with only the word BACK.');
  await run.wait(e => e.kind === 'turn.end' && /BACK/.test(e.lastMessage), 30000, 'turn.end BACK');
  assert.ok((await run.session()).pane, 'the session re-attaches on its next event');
  client.close();
});

// Opt-in, because it needs key login to this Mac. Starts nothing locally: the
// helper comes up through the same SSH command the app runs, with SSH's minimal PATH.
if (process.env.VENES_E2E_SSH) T('over_real_ssh', { noHelper: true }, async r => {
  (await connect()).close();
  await stopHelper();
  const connectSsh = () => {
    const child = spawn('ssh', ['-T', '-o', 'BatchMode=yes', `${process.env.USER}@localhost`, paths.launcher, 'attach'], { stdio: ['pipe', 'pipe', 'inherit'] });
    return { child, client: HelperClient.over(child.stdout, child.stdin) };
  };
  try {
    const first = connectSsh();
    const run = new Run(first.client);
    await first.client.request('subscribe');

    await r.type(TOUCH('ssh'));
    const request = await run.request('permission');
    await first.client.request('respond', { requestId: request.id, decision: 'allow' });
    await run.turnEnd();
    assert.ok(exists('e2e-ssh.txt'), 'approved over SSH');

    run.mark();
    const { id } = await run.session();
    await first.client.request('send', { sessionId: id, text: 'Reply with only the word SSHOK.' });
    assert.equal((await run.kind('message.user', 12000)).text, 'Reply with only the word SSHOK.');
    await run.turnEnd(30000);

    const gone = new Promise(resolve => { first.child.once('exit', resolve); });
    first.child.stdin.end();
    await gone;
    await delay(500);

    const second = connectSsh();
    const { sessions } = await second.client.request('sessions');
    assert.ok(sessions.some(s => s.id === id), 'the helper outlives the SSH connection');
    second.child.kill();
  } finally {
    await stopHelper();
  }
});

Run.prototype.waitForPane = async function waitForPane(re, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(this.pane())) return; await delay(150); }
  throw new Error(`pane never matched ${re}:\n${this.pane()}`);
};

async function runCase(name) {
  const { opts, fn } = cases[name];
  for (const f of fs.readdirSync(WS)) if (f.startsWith('e2e-')) fs.rmSync(path.join(WS, f));
  let client; let run;
  const started = Date.now();
  try {
    if (opts.noHelper) {
      opts.before?.();
      if (opts.before) (await connect()).close();
      run = new Run({ on() {} });
    } else {
      startHelper();
      client = await connect();
      run = new Run(client);
      await client.request('subscribe');
    }
    launch(opts);
    await ready(run);
    await fn(run);
    console.log(`ok    ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
    return true;
  } catch (error) {
    console.log(`FAIL  ${name}: ${error.message}`);
    try { console.log(run.pane().trimEnd().split('\n').slice(-14).join('\n')); } catch { /* no pane */ }
    return false;
  } finally {
    try { tmux('kill-session', '-t', 'run'); } catch { /* already gone */ }
    await delay(500);
    client?.close();
    await stopHelper();
  }
}

fs.mkdirSync(WS, { recursive: true });
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(path.join(WS, '.claude'), { recursive: true, force: true });
try { tmux('kill-server'); } catch { /* not running */ }
tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'keep', 'sleep', '86400');
tmux('set-option', '-g', 'remain-on-exit', 'off');

const wanted = process.argv.slice(2);
const names = Object.keys(cases).filter(n => !wanted.length || wanted.some(w => n.startsWith(w)));
console.log(`e2e: ${names.length} cases, model=${MODEL}`);
let failed = 0;
for (const name of names) if (!(await runCase(name))) failed++;
try { tmux('kill-server'); } catch { /* already gone */ }
fs.rmSync(HOME, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
