import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PushDevices, noticeFor, notify, payloadFor, seal, titleFor } from '../../src/push.mjs';

const KEY = crypto.randomBytes(32).toString('base64');
const TOKEN = 'ab'.repeat(32);

function open(sealed, key) {
  const text = Buffer.from(sealed.c, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(sealed.n, 'base64'));
  decipher.setAuthTag(text.subarray(text.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(text.subarray(0, text.length - 16)), decipher.final()]).toString('utf8'));
}

function devicesIn(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-push-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return { devices: new PushDevices(path.join(folder, 'push.json')), file: path.join(folder, 'push.json') };
}

test('what\'s sealed opens with the key, and only with it', () => {
  const sealed = seal({ kind: 'finished', body: '做完了' }, KEY);
  assert.equal(Buffer.from(sealed.n, 'base64').length, 12);
  assert.deepEqual(open(sealed, KEY), { kind: 'finished', body: '做完了' });
  assert.throws(() => open(sealed, crypto.randomBytes(32).toString('base64')));
  assert.notEqual(seal({ a: 1 }, KEY).n, seal({ a: 1 }, KEY).n, 'a new nonce each time');
});

test('the payload says nothing but that there\'s news, until the phone opens it', () => {
  const payload = payloadFor({ n: 'n', c: 'c' });
  assert.deepEqual(payload.aps, { alert: { title: 'Venes', 'loc-key': 'Something happened in a session.' }, sound: 'default', 'mutable-content': 1 });
  assert.deepEqual(payload.v, { n: 'n', c: 'c' });
});

test('a request and a turn that ends are worth one, as in the app', () => {
  assert.deepEqual(noticeFor({ kind: 'request.opened', sessionId: 's1' }, 'Fix'), { kind: 'needsInput', session: 's1', title: 'Fix', body: '' });
  assert.equal(noticeFor({ kind: 'turn.end', sessionId: 's1', lastMessage: ' Done.\n' }, 'T').body, 'Done.');
  assert.equal(noticeFor({ kind: 'turn.end', sessionId: 's1' }, 'T').body, '', 'the phone says it in its own words');
  assert.equal([...noticeFor({ kind: 'turn.end', sessionId: 's1', lastMessage: '写'.repeat(400) }, 'T').body].length, 180);
  assert.equal(noticeFor({ kind: 'turn.start', sessionId: 's1' }, 'T'), undefined);
  assert.equal(noticeFor({ kind: 'turn.end' }, 'T'), undefined);
});

test('a session is named as the app names it', () => {
  assert.equal(titleFor({ id: 'abcdef1234', title: '\n  Fix login \nmore', cwd: '/x/Venes' }), 'Fix login');
  assert.equal(titleFor({ id: 'abcdef1234', cwd: '/x/Venes' }), 'Venes');
  assert.equal(titleFor({ id: 'abcdef1234' }), 'abcdef12');
});

test('phones are kept only for this user, once each, a token for one phone only', t => {
  const { devices, file } = devicesIn(t);
  devices.register({ deviceId: 'd1', token: TOKEN, key: KEY, sandbox: true, mac: 'm1' });
  devices.register({ deviceId: 'd1', token: 'cd'.repeat(32), key: KEY });
  devices.register({ deviceId: 'd2', token: 'CD'.repeat(32), key: KEY });
  assert.deepEqual(devices.list().map(d => [d.deviceId, d.token]), [['d2', 'cd'.repeat(32)]], 'd1\'s new token went to d2');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new PushDevices(file).list(), devices.list(), 'and they\'re there after a restart');
  devices.unregister('d2');
  assert.deepEqual(devices.list(), []);
});

test('only a real device token, key and id are taken', t => {
  const { devices } = devicesIn(t);
  for (const bad of [{ token: TOKEN, key: KEY }, { deviceId: 'd', token: 'xyz', key: KEY }, { deviceId: 'd', token: TOKEN, key: 'short' },
    { deviceId: 'd', token: TOKEN, key: KEY, mac: 'x'.repeat(101) }]) {
    assert.throws(() => devices.register(bad), { code: 'bad_device' });
  }
});

test('a phone away hears of it sealed, and a phone that\'s connected doesn\'t', async t => {
  const { devices } = devicesIn(t);
  devices.register({ deviceId: 'away', token: TOKEN, key: KEY, sandbox: true, mac: 'm1' });
  devices.register({ deviceId: 'here', token: 'cd'.repeat(32), key: KEY });
  const sent = [];
  const results = await notify({
    devices, isConnected: id => id === 'here', event: { kind: 'turn.end', sessionId: 's1', lastMessage: 'All done' }, title: async () => 'Fix login',
    url: 'http://relay/push', send: async (url, body) => { sent.push({ url, body }); return { status: 200, body: { status: 200 } }; },
  });
  assert.deepEqual(results, [{ deviceId: 'away', status: 200 }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.token, TOKEN);
  assert.equal(sent[0].body.sandbox, true);
  assert.equal(sent[0].body.collapseId, 's1.finished');
  assert.deepEqual(open(sent[0].body.payload.v, KEY), { kind: 'finished', session: 's1', title: 'Fix login', body: 'All done', mac: 'm1' });
});

test('nothing is looked up or sent when no one is away or nothing happened', async t => {
  const { devices } = devicesIn(t);
  let lookedUp = false;
  const title = async () => { lookedUp = true; return 'T'; };
  const send = async () => assert.fail('nothing to send');
  assert.deepEqual(await notify({ devices, isConnected: () => false, event: { kind: 'turn.end', sessionId: 's1' }, title, send }), []);
  devices.register({ deviceId: 'd', token: TOKEN, key: KEY });
  assert.deepEqual(await notify({ devices, isConnected: () => false, event: { kind: 'turn.start', sessionId: 's1' }, title, send }), []);
  assert.equal(lookedUp, false);
});

test('a token Apple no longer takes is forgotten, and a relay that\'s down is only reported', async t => {
  const { devices } = devicesIn(t);
  devices.register({ deviceId: 'd', token: TOKEN, key: KEY });
  const event = { kind: 'request.opened', sessionId: 's1' };
  const down = await notify({ devices, isConnected: () => false, event, title: async () => 'T', send: async () => { throw new Error('offline'); } });
  assert.deepEqual(down, [{ deviceId: 'd', error: 'offline' }]);
  assert.equal(devices.list().length, 1);
  await notify({ devices, isConnected: () => false, event, title: async () => 'T', send: async () => ({ status: 502, body: { status: 410, reason: 'Unregistered' } }) });
  assert.deepEqual(devices.list(), []);
});

test('a session that isn\'t Claude Code\'s is only told to a phone whose app can show one', async t => {
  const { devices, file } = devicesIn(t);
  devices.register({ deviceId: 'newer', token: TOKEN, key: KEY, agents: ['codex', 7, ''] });
  devices.register({ deviceId: 'older', token: 'cd'.repeat(32), key: KEY });
  assert.deepEqual(devices.list().map(device => [device.deviceId, device.agents]), [['newer', ['codex']], ['older', undefined]]);
  assert.deepEqual(new PushDevices(file).list(), devices.list(), 'and that\'s kept');
  const told = async agent => (await notify({
    devices, isConnected: () => false, event: { kind: 'turn.end', sessionId: 's1', lastMessage: 'Done' }, title: async () => 'Fix login', agent,
    url: 'http://relay/push', send: async () => ({ status: 200, body: { status: 200 } }),
  })).map(result => result.deviceId);
  assert.deepEqual(await told('codex'), ['newer']);
  assert.deepEqual(await told(undefined), ['newer', 'older']);
});
