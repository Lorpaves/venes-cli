// A connection to Rex's server that stays open. The `rex` command connects, asks one thing and goes,
// which is enough to type and to read. Two things need a client that stays: Rex has a terminal follow
// the size of the client that owns it, for as long as that client is connected, and it tells a
// connected client what changes, such as a terminal opening or its program changing folder.
//
// It's Rex's control connection, as `GET /llms.txt` on a Rex server describes it: a WebSocket on the
// server's Unix socket, with one JSON object a message. Node's own WebSocket can't reach a Unix
// socket, so the little of the protocol that's needed is here: text messages, pings, and messages
// that come in pieces. No extension is asked for, so nothing is compressed.

import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PROTOCOL = 'rex.control.v1';
// The revision of Rex's API these messages are written for. A newer server translates.
const API_REVISION = 13;
const CONNECT_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 10_000;
// A hello has to come within five seconds, and a welcome answers it at once.
const WELCOME_TIMEOUT_MS = 5000;
const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 };
const FIN = 0x80;
const MASKED = 0x80;
const SHORT_LENGTH = 125;
const MEDIUM_LENGTH = 126;
const LONG_LENGTH = 127;
const MAX_MEDIUM = 0xffff;
// More than Rex ever sends in one message, which is a mebibyte.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

// One frame from a client, which has to mask what it sends.
export function encodeFrame(opcode, payload = Buffer.alloc(0), mask = crypto.randomBytes(4)) {
  const length = payload.length;
  let header;
  if (length <= SHORT_LENGTH) {
    header = Buffer.from([FIN | opcode, MASKED | length]);
  } else if (length <= MAX_MEDIUM) {
    header = Buffer.alloc(4);
    header[0] = FIN | opcode;
    header[1] = MASKED | MEDIUM_LENGTH;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = FIN | opcode;
    header[1] = MASKED | LONG_LENGTH;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// The frames in what has arrived so far, each whole. A frame cut short waits for the rest.
export class FrameReader {
  #pending = Buffer.alloc(0);

  push(chunk) {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    const frames = [];
    for (;;) {
      const frame = this.#next();
      if (!frame) return frames;
      frames.push(frame);
    }
  }

  #next() {
    const bytes = this.#pending;
    if (bytes.length < 2) return undefined;
    const isMasked = (bytes[1] & MASKED) !== 0;
    let length = bytes[1] & 0x7f;
    let offset = 2;
    if (length === MEDIUM_LENGTH) {
      if (bytes.length < 4) return undefined;
      length = bytes.readUInt16BE(2);
      offset = 4;
    } else if (length === LONG_LENGTH) {
      if (bytes.length < 10) return undefined;
      const long = bytes.readBigUInt64BE(2);
      if (long > BigInt(MAX_MESSAGE_BYTES)) throw new Error('A message from Rex is too long.');
      length = Number(long);
      offset = 10;
    }
    const maskLength = isMasked ? 4 : 0;
    if (bytes.length < offset + maskLength + length) return undefined;
    const payload = Buffer.from(bytes.subarray(offset + maskLength, offset + maskLength + length));
    if (isMasked) {
      const mask = bytes.subarray(offset, offset + 4);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    this.#pending = bytes.subarray(offset + maskLength + length);
    return { isFinal: (bytes[0] & FIN) !== 0, opcode: bytes[0] & 0x0f, payload };
  }
}

// Where a local server listens, from the address Rex gives for it, such as
// unix:///Users/me/Library/Application%20Support/rex/server.sock.
export function socketPathOf(endpoint) {
  if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) return undefined;
  try {
    return decodeURIComponent(new URL(endpoint).pathname);
  } catch {
    return undefined;
  }
}

export class RexLink extends EventEmitter {
  #socket;
  #reader = new FrameReader();
  #waiting = new Map();
  #next = 1;
  #pieces = [];
  #isClosed = false;
  // The client this connection is, by Rex's id for it, which is who owns what it claims.
  clientId;

  // Connects, says hello and waits for the welcome. `client` is what Rex shows people this is.
  static async connect(endpoint, { name = 'venes', version } = {}) {
    const path = socketPathOf(endpoint);
    if (!path) throw new Error(`Rex's server isn't on a Unix socket: ${endpoint}`);
    const link = new RexLink();
    const socket = await openSocket(path);
    link.#socket = socket;
    socket.on('data', chunk => link.#received(chunk));
    socket.on('error', () => link.#closed());
    socket.on('close', () => link.#closed());
    const welcome = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Rex didn\'t answer.')), WELCOME_TIMEOUT_MS);
      link.once('welcome', message => { clearTimeout(timer); resolve(message); });
      link.once('close', () => { clearTimeout(timer); reject(new Error('Rex closed the connection.')); });
    });
    link.#send({ type: 'hello', api_revision: API_REVISION, client: { kind: 'agent', platform: 'macos', name, ...(version && { version }) } });
    try {
      const message = await welcome;
      if (message.protocol !== PROTOCOL) throw new Error(`Rex speaks ${message.protocol}.`);
      link.clientId = message.client?.id;
      return link;
    } catch (error) {
      link.close();
      throw error;
    }
  }

  get isOpen() { return !this.#isClosed; }

  // Calls one of Rex's methods. Fails as Rex says, with its `code`, or when no answer comes.
  request(method, payload = {}) {
    if (this.#isClosed) return Promise.reject(new Error('The connection to Rex has closed.'));
    const id = String(this.#next++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`Rex took too long over ${method}.`));
      }, REQUEST_TIMEOUT_MS);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#send({ type: 'request', id, method, payload });
    });
  }

  // A method of a block's own, such as a terminal's `resize`.
  call({ rexSession, pane }, method, args = {}) {
    return this.request(`com.superlogical.terminal.${method}`, { session_id: rexSession, block_id: pane, args });
  }

  close() {
    if (this.#isClosed) return;
    try { this.#socket.write(encodeFrame(OPCODE.close)); } catch { /* already gone */ }
    this.#socket.destroy();
    this.#closed();
  }

  #send(message) {
    this.#socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(message))));
  }

  #received(chunk) {
    let frames;
    try {
      frames = this.#reader.push(chunk);
    } catch {
      this.close();
      return;
    }
    for (const { isFinal, opcode, payload } of frames) {
      if (opcode === OPCODE.ping) this.#socket.write(encodeFrame(OPCODE.pong, payload));
      else if (opcode === OPCODE.close) this.close();
      else if (opcode === OPCODE.text || opcode === OPCODE.continuation) {
        this.#pieces.push(payload);
        if (!isFinal) continue;
        const text = Buffer.concat(this.#pieces).toString('utf8');
        this.#pieces = [];
        this.#handle(text);
      }
    }
  }

  // A welcome, an answer, or something that happened. Anything else is a newer server's, and is skipped.
  #handle(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.type === 'welcome') {
      this.emit('welcome', message);
    } else if (message.type === 'response') {
      const waiter = this.#waiting.get(message.id);
      if (!waiter) return;
      this.#waiting.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'Rex refused.'), { code: message.error.code }));
      else waiter.resolve(message.payload ?? {});
    } else if (message.type === 'event' && message.payload) {
      this.emit('event', message.payload);
    }
  }

  #closed() {
    if (this.#isClosed) return;
    this.#isClosed = true;
    for (const { reject, timer } of this.#waiting.values()) {
      clearTimeout(timer);
      reject(new Error('The connection to Rex has closed.'));
    }
    this.#waiting.clear();
    this.emit('close');
  }
}

// The socket once Rex has agreed to speak WebSocket on it.
function openSocket(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    const key = crypto.randomBytes(16).toString('base64');
    const accept = crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    let head = Buffer.alloc(0);
    const fail = error => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Rex didn\'t answer.')), CONNECT_TIMEOUT_MS);
    const onData = chunk => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = head.subarray(0, end).toString('latin1').split('\r\n');
      const headers = new Map(lines.slice(1).map(line => {
        const colon = line.indexOf(':');
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
      }));
      if (!/^HTTP\/1\.1 101\b/.test(lines[0]) || headers.get('sec-websocket-accept') !== accept) {
        fail(new Error(`Rex refused the connection: ${lines[0]}`));
        return;
      }
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', fail);
      // Anything after the headers is already the first of what Rex has to say.
      const rest = head.subarray(end + 4);
      resolve(socket);
      if (rest.length) queueMicrotask(() => socket.emit('data', rest));
    };
    socket.on('data', onData);
    socket.once('error', fail);
    socket.once('connect', () => {
      socket.write([
        'GET /api/control HTTP/1.1', 'Host: localhost', 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Protocol: ${PROTOCOL}`, '', '',
      ].join('\r\n'));
    });
  });
}
