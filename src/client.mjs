import net from 'node:net';
import { EventEmitter } from 'node:events';
import { lineOf, onLines } from './lines.mjs';

// Newline-delimited JSON client, over client.sock or any pair of streams. Emits
// 'message' for everything that isn't the reply to a request.
export class HelperClient extends EventEmitter {
  #output;
  #nextId = 1;
  #waiting = new Map();

  static connect(socketPath) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once('error', reject);
      socket.once('connect', () => resolve(HelperClient.over(socket, socket)));
    });
  }

  static over(input, output) {
    const client = new HelperClient();
    client.#output = output;
    onLines(input, line => client.#receive(JSON.parse(line)));
    input.on('error', () => {}); // a dropped connection isn't thrown
    return client;
  }

  #receive(message) {
    const waiter = message.type === 'result' ? this.#waiting.get(message.id) : undefined;
    if (!waiter) {
      this.emit('message', message);
      return;
    }
    this.#waiting.delete(message.id);
    if (message.ok) waiter.resolve(message);
    else waiter.reject(Object.assign(new Error(message.error.message), message.error));
  }

  request(cmd, params = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#output.write(lineOf({ id, cmd, ...params }));
    });
  }

  close() {
    this.#output.destroy();
  }
}
