// Notifications for a phone that isn't connected: a session wants an answer, or its turn is done. A
// phone that's connected shows its own. The phone registers its device token and a key over the paired
// link. What a notification says is sealed with that key, so the relay, which holds the key Apple's push
// service wants and passes the notification on, can't read it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HelperError } from './sessions.mjs';

export const RELAY_URL = 'https://venes-push.kirass1230.workers.dev/push';
// What's said of a turn that's done, at most, as the app says it. The phone has its own words for the
// rest, in its own language.
const BODY_LENGTH = 180;
const DEVICE_TOKEN = /^[0-9a-f]{64,200}$/i;
const ID_LIMIT = 100;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SEND_TIMEOUT_MS = 10_000;
// Apple's answers that mean the token is no good any more.
const GONE = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);
// Shown if the phone can't open what's sealed, in its own language: the words are a key the app has.
const FALLBACK = { title: 'Venes', 'loc-key': 'Something happened in a session.' };

const firstLine = text => text?.split('\n').map(line => line.trim()).find(Boolean);

// A session's name as the app's list has it: its stored title, its folder, or the start of its id.
export function titleFor({ id, title, cwd }) {
  return firstLine(title) ?? (cwd ? path.basename(cwd) : undefined) ?? id.slice(0, 8);
}

// Which events are worth a notification, as the app decides for its own, with what a turn that's done
// said, if anything.
export function noticeFor(event, title) {
  if (typeof event?.sessionId !== 'string') return undefined;
  if (event.kind === 'request.opened') return { kind: 'needsInput', session: event.sessionId, title, body: '' };
  if (event.kind === 'turn.end') {
    const said = typeof event.lastMessage === 'string' ? event.lastMessage.trim() : '';
    return { kind: 'finished', session: event.sessionId, title, body: [...said].slice(0, BODY_LENGTH).join('') };
  }
  return undefined;
}

// AES-256-GCM, the tag after the text, each in base64.
export function seal(value, key) {
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce);
  const text = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { n: nonce.toString('base64'), c: text.toString('base64') };
}

export function payloadFor(sealed) {
  return { aps: { alert: FALLBACK, sound: 'default', 'mutable-content': 1 }, v: sealed };
}

function checkedDevice({ deviceId, token, key, sandbox = false, mac, agents }) {
  const isId = value => typeof value === 'string' && value.length > 0 && value.length <= ID_LIMIT;
  if (!isId(deviceId)) throw new HelperError('bad_device', 'That isn\'t a device.');
  if (typeof token !== 'string' || !DEVICE_TOKEN.test(token)) throw new HelperError('bad_device', 'That isn\'t a device token.');
  if (typeof key !== 'string' || Buffer.from(key, 'base64').length !== KEY_BYTES) throw new HelperError('bad_device', 'That isn\'t a key.');
  if (mac !== undefined && !isId(mac)) throw new HelperError('bad_device', 'That isn\'t a Mac.');
  // The sessions other than Claude Code's that the phone's app can show, which it's only told of then.
  const shown = Array.isArray(agents) ? agents.filter(isId) : [];
  return { deviceId, token: token.toLowerCase(), key, sandbox: sandbox === true, ...(mac && { mac }), ...(shown.length && { agents: shown }) };
}

// The phones to notify, kept in a file only this user can read, since each has its key.
export class PushDevices {
  #file;
  #devices;

  constructor(file) {
    this.#file = file;
    try {
      this.#devices = JSON.parse(fs.readFileSync(file, 'utf8')).devices ?? [];
    } catch {
      this.#devices = []; // none yet, or a file that can't be read, which the next change replaces
    }
  }

  list() { return [...this.#devices]; }

  register(fields) {
    const device = checkedDevice(fields);
    // One entry for a phone, and a token only for the phone it now belongs to.
    this.#devices = [...this.#devices.filter(d => d.deviceId !== device.deviceId && d.token !== device.token), device];
    this.#save();
  }

  unregister(deviceId) {
    this.#devices = this.#devices.filter(d => d.deviceId !== deviceId);
    this.#save();
  }

  forgetToken(token) {
    this.#devices = this.#devices.filter(d => d.token !== token);
    this.#save();
  }

  #save() {
    fs.writeFileSync(this.#file, JSON.stringify({ devices: this.#devices }), { mode: 0o600 });
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

// Sends what an event is worth to each phone that isn't connected now. `title` is looked up only when
// there's someone to tell. `agent` is whose session it is when it isn't Claude Code's, which only a
// phone whose app can show such a session hears of.
export async function notify({ devices, isConnected, event, title, agent = undefined, url = process.env.VENES_PUSH_URL || RELAY_URL, send = post }) {
  const away = devices.list().filter(device => !isConnected(device.deviceId) && (!agent || device.agents?.includes(agent)));
  if (!away.length || !noticeFor(event, '')) return [];
  const notice = noticeFor(event, await title());
  return Promise.all(away.map(async device => {
    const body = {
      token: device.token, sandbox: device.sandbox, collapseId: `${notice.session}.${notice.kind}`.slice(0, 64),
      payload: payloadFor(seal({ ...notice, ...(device.mac && { mac: device.mac }) }, device.key)),
    };
    try {
      const answer = await send(url, body);
      if (GONE.has(answer.body?.reason)) devices.forgetToken(device.token);
      return { deviceId: device.deviceId, status: answer.body?.status ?? answer.status };
    } catch (error) {
      return { deviceId: device.deviceId, error: error.message };
    }
  }));
}
