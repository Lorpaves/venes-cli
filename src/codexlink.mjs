// A connection to Codex's app server: JSON-RPC in WebSocket text frames, over the Unix socket its
// daemon listens on. Node's own WebSocket can't reach a Unix socket, and this is all of the protocol
// the app server uses: an upgrade, text frames, pings and a close.

import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const REQUEST_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 5000;
const OPCODE = { continuation: 0, text: 1, close: 8, ping: 9, pong: 10 };

// One frame from a client, which masks what it sends.
export function frame(opcode, payload, mask = crypto.randomBytes(4)) {
  const { length } = payload;
  let head;
  if (length < 126) head = Buffer.from([0x80 | opcode, 0x80 | length]);
  else if (length < 65536) head = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([head, mask, masked]);
}

// The frames at the start of `buffer`, as a server sends them, and what's left of it.
export function readFrames(buffer) {
  const frames = [];
  let rest = buffer;
  for (;;) {
    if (rest.length < 2) break;
    let length = rest[1] & 127;
    let at = 2;
    if (length === 126) {
      if (rest.length < 4) break;
      length = rest.readUInt16BE(2);
      at = 4;
    } else if (length === 127) {
      if (rest.length < 10) break;
      length = Number(rest.readBigUInt64BE(2));
      at = 10;
    }
    const isMasked = (rest[1] & 0x80) !== 0;
    const start = at + (isMasked ? 4 : 0);
    if (rest.length < start + length) break;
    const payload = Buffer.from(rest.subarray(start, start + length));
    if (isMasked) for (let i = 0; i < payload.length; i++) payload[i] ^= rest[at + (i % 4)];
    frames.push({ opcode: rest[0] & 15, isFinal: (rest[0] & 0x80) !== 0, payload });
    rest = rest.subarray(start + length);
  }
  return { frames, rest };
}

// Emits `notification` for what the server says, `request` for what it asks, and `close` once.
export class CodexLink extends EventEmitter {
  #socket;
  #waiting = new Map();
  #next = 1;
  #buffer = Buffer.alloc(0);
  #pieces = [];
  #isOpen = false;

  get isOpen() { return this.#isOpen; }

  // What the server said of itself in reply to `initialize`.
  hello;

  static connect(socketPath, clientInfo, { timeout = CONNECT_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      const link = new CodexLink();
      const socket = net.connect(socketPath);
      link.#socket = socket;
      const timer = setTimeout(() => socket.destroy(new Error('Codex took too long to answer.')), timeout);
      const fail = error => { clearTimeout(timer); reject(error); };
      socket.once('error', fail);
      socket.once('connect', () => {
        const key = crypto.randomBytes(16).toString('base64');
        socket.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      const onHead = chunk => {
        link.#buffer = Buffer.concat([link.#buffer, chunk]);
        const end = link.#buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const head = link.#buffer.subarray(0, end).toString();
        link.#buffer = link.#buffer.subarray(end + 4);
        socket.off('data', onHead);
        if (!/^HTTP\/1\.1 101/.test(head)) {
          socket.destroy();
          fail(new Error(`Codex refused the connection: ${head.split('\r\n')[0]}`));
          return;
        }
        link.#isOpen = true;
        socket.off('error', fail);
        socket.on('error', () => {});
        socket.on('data', data => link.#onData(data));
        socket.on('close', () => link.#onClose());
        link.#onData(Buffer.alloc(0));
        link.request('initialize', { clientInfo, capabilities: { experimentalApi: true } }).then(hello => {
          clearTimeout(timer);
          link.hello = hello;
          link.notify('initialized');
          resolve(link);
        }, error => { socket.destroy(); fail(error); });
      };
      socket.on('data', onHead);
    });
  }

  request(method, params, { timeout = REQUEST_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.#isOpen) { reject(new Error('Codex isn\'t connected.')); return; }
      const id = this.#next++;
      const timer = setTimeout(() => {
        if (this.#waiting.delete(id)) reject(new Error(`Codex didn't answer ${method}.`));
      }, timeout);
      timer.unref();
      this.#waiting.set(id, { resolve, reject, timer });
      this.#send({ id, method, params });
    });
  }

  notify(method, params) { this.#send({ method, params }); }

  // The answer to something the server asked.
  respond(id, result) { this.#send({ id, result }); }

  close() { this.#socket.destroy(); }

  #send(message) {
    if (this.#isOpen) this.#socket.write(frame(OPCODE.text, Buffer.from(JSON.stringify(message))));
  }

  #onData(chunk) {
    const { frames, rest } = readFrames(Buffer.concat([this.#buffer, chunk]));
    this.#buffer = rest;
    for (const { opcode, isFinal, payload } of frames) {
      if (opcode === OPCODE.ping) this.#socket.write(frame(OPCODE.pong, payload));
      else if (opcode === OPCODE.close) this.#socket.destroy();
      else if (opcode === OPCODE.text || opcode === OPCODE.continuation) {
        this.#pieces.push(payload);
        if (!isFinal) continue;
        const text = Buffer.concat(this.#pieces).toString();
        this.#pieces = [];
        this.#onMessage(text);
      }
    }
  }

  #onMessage(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.method !== undefined) {
      this.emit(message.id !== undefined ? 'request' : 'notification', message);
      return;
    }
    const waiting = this.#waiting.get(message.id);
    if (!waiting) return;
    this.#waiting.delete(message.id);
    clearTimeout(waiting.timer);
    if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code, data: message.error.data }));
    else waiting.resolve(message.result);
  }

  #onClose() {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    for (const { reject, timer } of this.#waiting.values()) {
      clearTimeout(timer);
      reject(new Error('Codex closed the connection.'));
    }
    this.#waiting.clear();
    this.emit('close');
  }
}
