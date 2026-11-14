import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CodexLink, frame, readFrames } from '../../src/codexlink.mjs';

// A server's frame, which isn't masked.
function serverFrame(opcode, payload, isFinal = true) {
  const { length } = payload;
  const head = length < 126 ? Buffer.from([(isFinal ? 0x80 : 0) | opcode, length])
    : Buffer.from([(isFinal ? 0x80 : 0) | opcode, 126, length >> 8, length & 255]);
  return Buffer.concat([head, payload]);
}

// Codex's app server, as far as a connection goes: the upgrade, then what `serve` makes of each message.
async function fakeServer(t, serve) {
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')), 's.sock');
  const sockets = [];
  const server = net.createServer(socket => {
    sockets.push(socket);
    let buffer = Buffer.alloc(0);
    let isOpen = false;
    const say = message => socket.write(serverFrame(1, Buffer.from(JSON.stringify(message))));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!isOpen) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.+)\r\n/.exec(buffer.subarray(0, end + 2).toString())[1];
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        isOpen = true;
      }
      const { frames, rest } = readFrames(buffer);
      buffer = rest;
      for (const { opcode, payload } of frames) {
        if (opcode === 1) serve(JSON.parse(payload.toString()), { say, socket });
        else if (opcode === 10) serve({ pong: payload.toString() }, { say, socket });
      }
    });
  });
  await new Promise(resolve => { server.listen(socketPath, resolve); });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return socketPath;
}

const CLIENT = { name: 'venes', title: 'Venes', version: '1' };

test('a frame a client sends is masked, and reads back as it was', () => {
  for (const size of [0, 5, 125, 126, 70_000]) {
    const payload = Buffer.alloc(size, 'x');
    const { frames, rest } = readFrames(frame(1, payload));
    assert.equal(rest.length, 0);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], { opcode: 1, isFinal: true, payload });
  }
});

test('frames are read as far as they have arrived', () => {
  const whole = Buffer.concat([serverFrame(1, Buffer.from('one')), serverFrame(1, Buffer.from('two'))]);
  const { frames, rest } = readFrames(whole.subarray(0, whole.length - 2));
  assert.deepEqual(frames.map(read => read.payload.toString()), ['one']);
  assert.equal(readFrames(Buffer.concat([rest, whole.subarray(whole.length - 2)])).frames[0].payload.toString(), 'two');
});

test('it says who it is, then asks and is answered', async t => {
  const heard = [];
  const socketPath = await fakeServer(t, (message, { say }) => {
    heard.push(message);
    if (message.method === 'initialize') say({ id: message.id, result: { userAgent: 'codex' } });
    if (message.method === 'thread/loaded/list') say({ id: message.id, result: { data: ['t1'] } });
    if (message.method === 'thread/read') say({ id: message.id, error: { code: -32600, message: 'no such thread' } });
  });
  const link = await CodexLink.connect(socketPath, CLIENT);
  t.after(() => link.close());
  assert.deepEqual(link.hello, { userAgent: 'codex' });
  assert.deepEqual(await link.request('thread/loaded/list', {}), { data: ['t1'] });
  await assert.rejects(link.request('thread/read', { threadId: 'x' }), error => error.message === 'no such thread' && error.rpcCode === -32600);
  assert.deepEqual(heard[0].params, { clientInfo: CLIENT, capabilities: { experimentalApi: true } });
  assert.deepEqual(heard[1], { method: 'initialized' });
});

test('what the server says and asks comes as it is, and an answer goes back by its id', async t => {
  const answers = [];
  const socketPath = await fakeServer(t, (message, { say }) => {
    if (message.method === 'initialize') say({ id: message.id, result: {} });
    else if (message.method === 'initialized') {
      say({ method: 'turn/started', params: { threadId: 't' } });
      say({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
    } else answers.push(message);
  });
  const link = await CodexLink.connect(socketPath, CLIENT);
  t.after(() => link.close());
  // Both come in one read, so both are listened for before either is waited on.
  const [note, asked] = await Promise.all([
    new Promise(resolve => { link.once('notification', resolve); }),
    new Promise(resolve => { link.once('request', resolve); }),
  ]);
  assert.deepEqual(note, { method: 'turn/started', params: { threadId: 't' } });
  assert.equal(asked.id, 7);
  link.respond(asked.id, { decision: 'accept' });
  await new Promise(resolve => { setTimeout(resolve, 50); });
  assert.deepEqual(answers, [{ id: 7, result: { decision: 'accept' } }]);
});

test('a message in pieces is one message, and a ping is answered', async t => {
  let pong;
  const socketPath = await fakeServer(t, (message, { say, socket }) => {
    if (message.method === 'initialize') say({ id: message.id, result: {} });
    else if (message.method === 'initialized') {
      const text = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'hello' } }));
      socket.write(serverFrame(1, text.subarray(0, 10), false));
      socket.write(serverFrame(0, text.subarray(10), true));
      socket.write(serverFrame(9, Buffer.from('are you there')));
    } else if (message.pong !== undefined) pong = message.pong;
  });
  const link = await CodexLink.connect(socketPath, CLIENT);
  t.after(() => link.close());
  const note = await new Promise(resolve => { link.once('notification', resolve); });
  assert.equal(note.params.delta, 'hello');
  await new Promise(resolve => { setTimeout(resolve, 50); });
  assert.equal(pong, 'are you there');
});

test('a connection that goes fails what was waiting, and says so once', async t => {
  const socketPath = await fakeServer(t, (message, { say, socket }) => {
    if (message.method === 'initialize') say({ id: message.id, result: {} });
    if (message.method === 'thread/list') socket.destroy();
  });
  const link = await CodexLink.connect(socketPath, CLIENT);
  let closes = 0;
  link.on('close', () => { closes += 1; });
  await assert.rejects(link.request('thread/list', {}), /closed the connection/);
  assert.equal(link.isOpen, false);
  assert.equal(closes, 1);
  await assert.rejects(link.request('thread/list', {}), /isn't connected/);
});

test('nothing listening is an error, and so is something that is not Codex', async t => {
  await assert.rejects(CodexLink.connect(path.join(os.tmpdir(), 'no-such-venes.sock'), CLIENT), error => error.code === 'ENOENT');
  const socketPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cx-')), 's.sock');
  const server = net.createServer(socket => { socket.on('data', () => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')); socket.on('error', () => {}); });
  await new Promise(resolve => { server.listen(socketPath, resolve); });
  t.after(() => server.close());
  await assert.rejects(CodexLink.connect(socketPath, CLIENT), /refused the connection: HTTP\/1.1 400/);
});
