import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { AcpLink, PROTOCOL_VERSION } from '../../src/acplink.mjs';
import { onLines } from '../../src/lines.mjs';

// An agent at the other end of two pipes, which answers as `answer` says.
function pipes(answer) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const asked = [];
  onLines(toAgent, line => {
    const message = JSON.parse(line);
    asked.push(message);
    const reply = answer(message);
    if (reply) fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply })}\n`);
  });
  return { link: AcpLink.over(fromAgent, toAgent), asked, fromAgent };
}

test('an answer goes to what asked for it, and a refusal is an error with the agent\'s own word', async () => {
  const { link, asked, fromAgent } = pipes(message => (message.method === 'session/new' ? { result: { sessionId: 's1' } } : { error: { code: -32601, message: 'No such thing.' } }));
  // What the agent says of its own accord, and what isn't a message at all, are let by.
  fromAgent.write('starting up\n');
  fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })}\n`);
  fromAgent.write(`${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'fs/read_text_file', params: {} })}\n`);
  assert.deepEqual(await link.request('session/new', { cwd: '/w', mcpServers: [] }), { sessionId: 's1' });
  assert.deepEqual(asked[0], { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/w', mcpServers: [] } });
  await assert.rejects(link.request('nonsense'), { message: 'No such thing.', rpcCode: -32601 });
});

test('an agent that says nothing is waited on only so long, and one that has gone answers nothing more', async () => {
  const { link, fromAgent } = pipes(() => undefined);
  await assert.rejects(link.request('session/new', {}, { timeout: 20 }), /took too long to answer session\/new/);
  const waiting = link.request('session/new', {}, { timeout: 5000 });
  fromAgent.destroy();
  await assert.rejects(waiting, /has gone/);
  assert.equal(link.isOpen, false);
  await assert.rejects(link.request('session/new'), /has gone/);
});

test('an agent is started, told who\'s calling, and let go', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-acp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const agent = path.join(dir, 'agent.mjs');
  fs.writeFileSync(agent, `
    import readline from 'node:readline';
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const message = JSON.parse(line);
      const result = message.method === 'initialize' ? { protocolVersion: message.params.protocolVersion, client: message.params.clientInfo.name, cwd: process.cwd() }
        : { sessionId: 'made-' + message.params.cwd };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
    });
  `);
  const link = await AcpLink.start(process.execPath, [agent], { cwd: fs.realpathSync(dir), env: process.env, clientInfo: { name: 'venes', version: '0' } });
  assert.deepEqual(link.agent, { protocolVersion: PROTOCOL_VERSION, client: 'venes', cwd: fs.realpathSync(dir) });
  assert.deepEqual(await link.request('session/new', { cwd: '/w' }), { sessionId: 'made-/w' });
  link.close();
  assert.equal(link.isOpen, false);
  await assert.rejects(AcpLink.start(path.join(dir, 'no-such-agent'), [], { clientInfo: {} }));
});
