// A connection to an agent that speaks the Agent Client Protocol: JSON-RPC, a message a line, over the
// stdin and stdout of a process of the agent's own, which this starts. It's what editors drive an
// agent through, and what Antigravity's `agy acp` serves. The helper asks it one thing, to make an
// empty conversation, so this only asks and hears the answer: what the agent tells or asks of its
// own accord is let by.

import { spawn } from 'node:child_process';
import { lineOf, onLines } from './lines.mjs';

const REQUEST_TIMEOUT_MS = 30_000;
export const PROTOCOL_VERSION = 1;

export class AcpLink {
  #output;
  #child;
  #nextId = 1;
  #waiting = new Map();
  #isOpen = true;

  // Starts the agent, and says who's calling. What the agent says of itself is the link's `agent`.
  static async start(command, args, { cwd, env, clientInfo } = {}) {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    const link = AcpLink.over(child.stdout, child.stdin, child);
    // The agent goes when this does, however this ends.
    const end = () => child.kill();
    process.once('exit', end);
    child.on('error', error => link.#closed(error));
    child.on('exit', () => {
      process.off('exit', end);
      link.#closed();
    });
    try {
      // No files of the client's to read or write through, and no terminal of its: the agent uses its own.
      link.agent = await link.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo,
      });
      return link;
    } catch (error) {
      link.close();
      throw error;
    }
  }

  static over(input, output, child = undefined) {
    const link = new AcpLink();
    link.#output = output;
    link.#child = child;
    onLines(input, line => link.#receive(line));
    input.on('close', () => link.#closed());
    input.on('error', () => {});
    output.on('error', () => {});
    return link;
  }

  get isOpen() {
    return this.#isOpen;
  }

  #receive(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // what an agent prints that isn't a message is nothing to this
    }
    if (message.method !== undefined) return;
    const waiter = this.#waiting.get(message.id);
    if (!waiter) return;
    this.#waiting.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(Object.assign(new Error(message.error.message ?? 'The agent refused.'), { rpcCode: message.error.code }));
    else waiter.resolve(message.result ?? {});
  }

  #closed(error = undefined) {
    if (!this.#isOpen) return;
    this.#isOpen = false;
    for (const { reject, timer } of this.#waiting.values()) {
      clearTimeout(timer);
      reject(error ?? new Error('The agent has gone.'));
    }
    this.#waiting.clear();
  }

  request(method, params = {}, { timeout = REQUEST_TIMEOUT_MS } = {}) {
    if (!this.#isOpen) return Promise.reject(new Error('The agent has gone.'));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting.delete(id);
        reject(new Error(`The agent took too long to answer ${method}.`));
      }, timeout);
      timer.unref();
      this.#waiting.set(id, { resolve, reject, timer });
      this.#output.write(lineOf({ jsonrpc: '2.0', id, method, params }));
    });
  }

  close() {
    this.#child?.kill();
    this.#closed();
  }
}
