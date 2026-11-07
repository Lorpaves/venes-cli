// The little of Rex's client protocol the app uses, to test the helper's end of it. `GET /llms.txt`
// on a Rex server documents it.

const ESC = 0x1b;
const BACKSLASH = 0x5c;
const UNDERSCORE = 0x5f;

export class RexControl {
  #socket;
  #next = 1;
  #waiting = new Map();

  static async connect(url) {
    const control = new RexControl();
    control.#socket = new WebSocket(`${url}/api/control`, 'rex.control.v1');
    await new Promise((resolve, reject) => {
      control.#socket.onopen = resolve;
      control.#socket.onerror = () => reject(new Error('no control connection'));
    });
    const welcome = new Promise(resolve => {
      control.#socket.onmessage = ({ data }) => {
        const message = JSON.parse(data);
        if (message.type === 'welcome') resolve(message);
        if (message.type !== 'response') return;
        const waiter = control.#waiting.get(message.id);
        control.#waiting.delete(message.id);
        if (message.error) waiter.reject(Object.assign(new Error(message.error.message), message.error));
        else waiter.resolve(message.payload ?? {});
      };
    });
    control.#socket.send(JSON.stringify({ type: 'hello', api_revision: 11, client: { kind: 'app', platform: 'ios', name: 'Venes test', version: '0' } }));
    await welcome;
    return control;
  }

  request(method, payload = {}) {
    const id = String(this.#next++);
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ type: 'request', id, method, payload }));
    });
  }

  close() { this.#socket.close(1000); }
}

// What a data connection carries, as what the program printed: the snapshot goes, up to the first
// `resize`, and so does each of Rex's own messages.
export class TerminalStream {
  #nonce;
  #bytes = Buffer.alloc(0);
  #started = false;

  constructor(nonce) { this.#nonce = String(nonce); }

  // Returns the program's bytes in `chunk`, and any of Rex's messages that came with them.
  take(chunk) {
    this.#bytes = Buffer.concat([this.#bytes, chunk]);
    const output = [];
    const messages = [];
    for (;;) {
      const start = this.#bytes.findIndex((byte, index) => byte === ESC && this.#bytes[index + 1] === UNDERSCORE);
      if (start < 0) break;
      const end = this.#bytes.findIndex((byte, index) => index > start && byte === ESC && this.#bytes[index + 1] === BACKSLASH);
      if (end < 0) break;
      if (this.#started) output.push(this.#bytes.subarray(0, start));
      const body = this.#bytes.subarray(start + 2, end).toString();
      const [, nonce, json] = body.match(/^rex1;(\d+);(.*)$/s) ?? [];
      if (nonce === this.#nonce) {
        const message = JSON.parse(json);
        messages.push(message);
        if (message.type === 'resize') this.#started = true;
      }
      this.#bytes = this.#bytes.subarray(end + 2);
    }
    if (this.#started) {
      const safe = this.#bytes.indexOf(ESC) < 0 ? this.#bytes.length : this.#bytes.indexOf(ESC);
      output.push(this.#bytes.subarray(0, safe));
      this.#bytes = this.#bytes.subarray(safe);
    }
    return { output: Buffer.concat(output), messages };
  }
}

// Opens `venes attach --pipe` in a block no window shows, and gives it stdin and stdout.
export async function openPipe(url, label, command) {
  const control = await RexControl.connect(url);
  const { sessions } = await control.request('session.list');
  const session = sessions.find(entry => entry.label === label) ?? await control.request('session.create', { label });
  const sessionId = session.session_id;
  await control.request('session.attach', { session_id: sessionId });
  const { block_id: blockId } = await control.request('session.new_block', {
    session_id: sessionId, flavor: 'com.superlogical.terminal.shell', label: 'venes-attach', options: { shell: 'none', login: false, command },
  });
  const { ticket } = await control.request('data.connect', { session_id: sessionId, block_id: blockId, data_ref_id: 'terminal', subprotocol: 'rex.data.terminal.v1' });
  const data = new WebSocket(`${url}/api/data`, 'rex.data.terminal.v1');
  data.binaryType = 'arraybuffer';
  await new Promise((resolve, reject) => {
    data.onopen = resolve;
    data.onerror = () => reject(new Error('no data connection'));
  });
  const stream = { lines: [], ended: undefined, onLine: () => {} };
  let terminal;
  let partial = '';
  const started = new Promise(resolve => {
    data.onmessage = ({ data: raw }) => {
      const bytes = Buffer.from(raw);
      if (!terminal) {
        if (bytes[0] !== 0x81) throw new Error(`refused: ${bytes[1]}`);
        terminal = new TerminalStream(bytes.readBigUInt64LE(24));
        return;
      }
      const { output, messages } = terminal.take(bytes);
      if (messages.some(message => message.type === 'resize')) resolve();
      for (const message of messages) if (message.type === 'child_exited') stream.ended = message.exit_code;
      partial += output.toString().replaceAll('\r', '');
      const lines = partial.split('\n');
      partial = lines.pop();
      for (const line of lines) { stream.lines.push(line); stream.onLine(line); }
    };
  });
  data.send(Buffer.concat([Buffer.from([0x01]), Buffer.from(ticket, 'base64url')]));
  await started;
  const write = text => control.request('com.superlogical.terminal.write', { session_id: sessionId, block_id: blockId, args: { data: text } });
  await write('\n');
  return {
    stream, write, blockId, sessionId, control,
    close: async () => {
      await control.request('block.close', { session_id: sessionId, block_id: blockId }).catch(() => {});
      data.close(1000);
      control.close();
    },
    // As a client that lost its connection would: nobody hears from it again.
    vanish: () => {
      data.close(1000);
      control.close();
    },
  };
}
