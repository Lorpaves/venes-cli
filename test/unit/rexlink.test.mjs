import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { FrameReader, RexLink, encodeFrame, socketPathOf } from '../../src/rexlink.mjs';

const TEXT = 1;
const PING = 9;
const PONG = 10;

// A frame as a server sends it: not masked.
function serverFrame(opcode, payload, { isFinal = true } = {}) {
  const head = payload.length <= 125 ? Buffer.from([(isFinal ? 0x80 : 0) | opcode, payload.length])
    : Buffer.concat([Buffer.from([(isFinal ? 0x80 : 0) | opcode, 126]), Buffer.from([payload.length >> 8, payload.length & 0xff])]);
  return Buffer.concat([head, payload]);
}

test('a frame goes out masked, and comes back as it was, whatever its length', () => {
  for (const length of [0, 5, 125, 126, 70_000]) {
    const payload = crypto.randomBytes(length);
    const frame = encodeFrame(TEXT, payload);
    assert.equal(frame[1] & 0x80, 0x80, 'masked');
    assert.deepEqual(new FrameReader().push(frame), [{ isFinal: true, opcode: TEXT, payload }]);
  }
});

test('frames are read as they arrive, in pieces or several at once', () => {
  const reader = new FrameReader();
  const both = Buffer.concat([serverFrame(TEXT, Buffer.from('one')), serverFrame(TEXT, Buffer.from('x'.repeat(300)))]);
  assert.deepEqual(reader.push(both.subarray(0, 4)).map(frame => frame.payload.toString()), ['one'].slice(0, 0));
  assert.deepEqual(reader.push(both.subarray(4, 9)).map(frame => frame.payload.toString()), ['one']);
  assert.deepEqual(reader.push(both.subarray(9)).map(frame => frame.payload.length), [300]);
});

test('a local server\'s address says where its socket is', () => {
  assert.equal(socketPathOf('unix:///Users/me/Library/Application%20Support/rex/server.sock'), '/Users/me/Library/Application Support/rex/server.sock');
  assert.equal(socketPathOf('https://home.tail0.ts.net'), undefined);
  assert.equal(socketPathOf(undefined), undefined);
});

// A server that speaks as Rex's does, as far as the helper uses it. `answers` is what each method gets.
function fakeRex(t, answers = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-'));
  const socketPath = path.join(dir, 's');
  const seen = { hello: undefined, requests: [], pongs: [], sockets: [] };
  const server = net.createServer(socket => {
    seen.sockets.push(socket);
    let head = Buffer.alloc(0);
    let reader;
    const send = message => socket.write(serverFrame(TEXT, Buffer.from(JSON.stringify(message))));
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (!reader) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        const key = /sec-websocket-key: (.+)/i.exec(head.toString())[1].trim();
        assert.match(head.toString(), /Sec-WebSocket-Protocol: rex\.control\.v1/);
        const accept = crypto.createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        reader = new FrameReader();
        chunk = head.subarray(end + 4);
      }
      for (const { opcode, payload } of reader.push(chunk)) {
        if (opcode === PONG) { seen.pongs.push(payload.toString()); continue; }
        if (opcode !== TEXT) continue;
        const message = JSON.parse(payload.toString());
        if (message.type === 'hello') {
          seen.hello = message;
          send({ type: 'welcome', protocol: 'rex.control.v1', limits: { max_message_bytes: 1048576 }, client: { id: 'client:1', reconnect_token: 't' } });
        } else if (message.type === 'request') {
          seen.requests.push([message.method, message.payload]);
          const answer = answers[message.method];
          if (answer === 'silent') continue;
          if (answer?.error) send({ type: 'response', id: message.id, error: answer.error });
          else send({ type: 'response', id: message.id, payload: answer });
        }
      }
    });
  });
  t.after(() => {
    for (const socket of seen.sockets) socket.destroy();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return new Promise(resolve => { server.listen(socketPath, () => resolve({ endpoint: `unix://${socketPath}`, seen })); });
}

test('the connection says who it is, asks, and is answered', async t => {
  const { endpoint, seen } = await fakeRex(t, {
    'session.attach': { view: {} }, 'com.superlogical.terminal.resize': {},
    'session.own_block': { error: { code: 'bad_request', message: 'not a block' } },
  });
  const link = await RexLink.connect(endpoint, { version: '1.2.3' });
  t.after(() => link.close());
  assert.equal(link.clientId, 'client:1');
  assert.deepEqual(seen.hello, { type: 'hello', api_revision: 13, client: { kind: 'agent', platform: 'macos', name: 'venes', version: '1.2.3' } });
  assert.deepEqual(await link.request('session.attach', { session_id: 'session:1' }), { view: {} });
  assert.deepEqual(await link.call({ rexSession: 'session:1', pane: 'block:2' }, 'resize', { columns: 47, rows: 30 }), {}, 'no payload is an empty one');
  assert.deepEqual(seen.requests.at(-1), ['com.superlogical.terminal.resize', { session_id: 'session:1', block_id: 'block:2', args: { columns: 47, rows: 30 } }]);
  await assert.rejects(link.request('session.own_block', {}), { code: 'bad_request', message: 'not a block' });
});

test('what Rex says by itself comes as events, pings are answered, and a message in pieces is put together', async t => {
  const { endpoint, seen } = await fakeRex(t);
  const link = await RexLink.connect(endpoint);
  t.after(() => link.close());
  const events = [];
  link.on('event', event => events.push(event));
  const [socket] = seen.sockets;
  const event = JSON.stringify({ type: 'event', seq: 1, payload: { type: 'session_created', payload: { session: { session_id: 'session:9' } } } });
  socket.write(serverFrame(PING, Buffer.from('are you there')));
  socket.write(serverFrame(TEXT, Buffer.from(event.slice(0, 20)), { isFinal: false }));
  socket.write(serverFrame(0, Buffer.from(event.slice(20))));
  socket.write(serverFrame(TEXT, Buffer.from(JSON.stringify({ type: 'something_new' }))));
  for (let tries = 0; tries < 200 && (!events.length || !seen.pongs.length); tries++) await new Promise(resolve => { setTimeout(resolve, 5); });
  assert.deepEqual(events, [{ type: 'session_created', payload: { session: { session_id: 'session:9' } } }]);
  assert.deepEqual(seen.pongs, ['are you there']);
});

test('a connection that closes fails what was waiting, and says so', async t => {
  const { endpoint, seen } = await fakeRex(t, { 'session.list': 'silent' });
  const link = await RexLink.connect(endpoint);
  let closed = false;
  link.on('close', () => { closed = true; });
  const waiting = link.request('session.list');
  seen.sockets[0].destroy();
  await assert.rejects(waiting, /closed/);
  assert.equal(closed, true);
  assert.equal(link.isOpen, false);
  await assert.rejects(link.request('session.list'), /closed/);
});

test('with no server there, connecting fails', async () => {
  await assert.rejects(RexLink.connect('unix:///no/such/rex.sock'));
  await assert.rejects(RexLink.connect('https://example.com'), /Unix socket/);
});
