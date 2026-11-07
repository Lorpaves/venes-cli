import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions.mjs';
import { sendMessage } from '../../src/terminal.mjs';
import { readHistory } from '../../src/transcript.mjs';
import {
  MAX_UPLOAD_BYTES, findUpload, pruneUploads, removeUploads, safeName, saveUpload, splitAttachments,
} from '../../src/uploads.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const base64 = text => Buffer.from(text).toString('base64');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-uploads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a name is one path part, keeps its spaces for a file, and loses them for a picture', () => {
  assert.equal(safeName('report final.pdf', 'application/pdf'), 'report final.pdf');
  assert.equal(safeName('IMG 1234.JPG', 'image/jpeg'), 'IMG-1234.JPG');
  assert.equal(safeName('../../etc/passwd', 'text/plain'), 'passwd');
  assert.equal(safeName('C:\\Users\\me\\notes.txt', 'text/plain'), 'notes.txt');
  assert.equal(safeName('a"b\nc.txt', 'text/plain'), 'ab c.txt');
  assert.equal(safeName('.hidden.txt', 'text/plain'), 'hidden.txt');
});

test('a picture\'s name ends in its type\'s extension, which is how Claude Code knows it', () => {
  assert.equal(safeName('photo', 'image/png'), 'photo.png');
  assert.equal(safeName('photo.heic', 'image/jpeg'), 'photo.heic.jpg');
  assert.equal(safeName('scan.jpeg', 'IMAGE/JPEG'), 'scan.jpeg');
  assert.equal(safeName('', 'image/webp'), 'image.webp');
  assert.equal(safeName(undefined, 'text/plain'), 'file');
});

test('a long name is cut, keeping its extension', () => {
  const name = safeName(`${'a'.repeat(200)}.pdf`, 'application/pdf');
  assert.equal(name.length, 120);
  assert.ok(name.endsWith('.pdf'));
  assert.equal(safeName(`a.${'b'.repeat(200)}`, 'text/plain').length, 120);
});

test('an upload is kept with what it is, and found again by its id', t => {
  const root = tempRoot(t);
  const picture = saveUpload(root, { sessionId: SESSION_ID, name: 'shot.png', mediaType: 'IMAGE/PNG', data: base64('png bytes') });
  assert.equal(picture.kind, 'image');
  assert.equal(picture.mediaType, 'image/png');
  assert.equal(picture.size, 9);
  assert.match(picture.uploadId, /^[0-9a-f]{32}$/);
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hello') });
  assert.equal(file.kind, 'file');
  const found = findUpload(root, SESSION_ID, file.uploadId);
  assert.equal(found.path, path.join(root, SESSION_ID, file.uploadId, 'notes.txt'));
  assert.equal(fs.readFileSync(found.path, 'utf8'), 'hello');
  assert.deepEqual({ ...found, path: undefined }, { ...file, path: undefined });
});

test('an upload that isn\'t there is undefined, and a session id has to look like one', t => {
  const root = tempRoot(t);
  assert.equal(findUpload(root, SESSION_ID, 'f'.repeat(32)), undefined);
  assert.equal(findUpload(root, SESSION_ID, '../../etc'), undefined);
  assert.throws(() => findUpload(root, '../x', 'f'.repeat(32)), { code: 'unknown_session' });
  assert.throws(() => saveUpload(root, { sessionId: 'a/b', name: 'x', mediaType: 'text/plain', data: base64('x') }), { code: 'unknown_session' });
  const { uploadId } = saveUpload(root, { sessionId: SESSION_ID, name: 'x.txt', mediaType: 'text/plain', data: base64('x') });
  fs.rmSync(path.join(root, SESSION_ID, uploadId, 'x.txt'));
  assert.equal(findUpload(root, SESSION_ID, uploadId), undefined);
});

test('an upload needs a type and something in it, and has a size limit', t => {
  const root = tempRoot(t);
  const save = fields => () => saveUpload(root, { sessionId: SESSION_ID, name: 'x', mediaType: 'text/plain', data: base64('x'), ...fields });
  assert.throws(save({ mediaType: undefined }), { code: 'bad_upload' });
  assert.throws(save({ mediaType: 'not a type' }), { code: 'bad_upload' });
  assert.throws(save({ data: '' }), { code: 'bad_upload' });
  assert.throws(save({ data: '====' }), { code: 'bad_upload' });
  assert.throws(save({ data: 'A'.repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8) }), { code: 'too_large' });
  assert.equal(fs.existsSync(path.join(root, SESSION_ID)), false);
});

test('a session\'s uploads go with it, and old ones go when the helper starts', t => {
  const root = tempRoot(t);
  const old = saveUpload(root, { sessionId: SESSION_ID, name: 'old.txt', mediaType: 'text/plain', data: base64('o') });
  const recent = saveUpload(root, { sessionId: SESSION_ID, name: 'new.txt', mediaType: 'text/plain', data: base64('n') });
  const other = 'aaaaaaaa-2222-4333-8444-555555555555';
  saveUpload(root, { sessionId: other, name: 'gone.txt', mediaType: 'text/plain', data: base64('g') });
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const age = (sessionId, uploadId, days) => fs.utimesSync(path.join(root, sessionId, uploadId), (now - days * day) / 1000, (now - days * day) / 1000);
  age(SESSION_ID, old.uploadId, 31);
  age(SESSION_ID, recent.uploadId, 2);
  for (const uploadId of fs.readdirSync(path.join(root, other))) age(other, uploadId, 40);
  pruneUploads(root, { now });
  assert.equal(findUpload(root, SESSION_ID, old.uploadId), undefined);
  assert.ok(findUpload(root, SESSION_ID, recent.uploadId));
  assert.equal(fs.existsSync(path.join(root, other)), false);
  removeUploads(root, SESSION_ID);
  assert.equal(fs.existsSync(path.join(root, SESSION_ID)), false);
  pruneUploads(path.join(root, 'nothing here'));
});

test('what Venes typed ahead of a message comes off its text, and its files are listed', t => {
  const root = tempRoot(t);
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'report final.pdf', mediaType: 'application/pdf', data: base64('%PDF') });
  const where = path.join(root, SESSION_ID, file.uploadId, 'report final.pdf');
  const described = { uploadId: file.uploadId, name: 'report final.pdf', mediaType: 'application/pdf', size: 4 };
  assert.deepEqual(splitAttachments(`[Image #1] [Image #2] @"${where}" sum it up`, root), { text: 'sum it up', files: [described] });
  assert.deepEqual(splitAttachments(`[Image #3]  @"${where}"  `, root), { text: '', files: [described] });
  const picture = saveUpload(root, { sessionId: SESSION_ID, name: 'p.png', mediaType: 'image/png', data: base64('p') });
  const left = path.join(root, SESSION_ID, picture.uploadId, 'p.png');
  assert.deepEqual(splitAttachments(`${left} what is it`, root).files.map(({ name }) => name), ['p.png']);
  assert.deepEqual(splitAttachments(`@${left} what is it`, root).text, 'what is it');
});

test('only the start is Venes\'s: the rest, and references to other files, are what someone wrote', t => {
  const root = tempRoot(t);
  const same = text => assert.deepEqual(splitAttachments(text, root), { text, files: [] });
  same('compare [Image #1] with this');
  same('@"/etc/hosts" what is this');
  same('@src/app.js explain');
  same('/compact');
  same('  indented on purpose');
  same(`@"${path.join(root, SESSION_ID, 'not-an-upload', 'x.txt')}" hi`);
});

test('a message sent with attachments is matched to its send, and says what files it had', t => {
  const root = tempRoot(t);
  const store = new SessionStore({ splitAttachments: text => splitAttachments(text, root) });
  const events = [];
  store.on('event', event => events.push(event));
  const file = saveUpload(root, { sessionId: 'a', name: 'notes.txt', mediaType: 'text/plain', data: base64('hi') });
  const where = path.join(root, 'a', file.uploadId, 'notes.txt');
  store.handleHook({ session_id: 'a', cwd: '/w', hook_event_name: 'SessionStart' });
  store.expectEcho(store.get('a'), 'c1', 'read these');
  store.handleHook({ session_id: 'a', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: `[Image #1] @"${where}" read these` });
  const sent = events.find(event => event.kind === 'message.user');
  assert.equal(sent.text, 'read these');
  assert.equal(sent.clientId, 'c1');
  assert.deepEqual(sent.attachments, [{ uploadId: file.uploadId, name: 'notes.txt', mediaType: 'text/plain', size: 2 }]);
  assert.equal(store.get('a').lastPrompt, 'read these');
});

test('a message with no attachments says nothing about them', () => {
  const store = new SessionStore();
  const events = [];
  store.on('event', event => events.push(event));
  store.handleHook({ session_id: 'a', cwd: '/w', hook_event_name: 'UserPromptSubmit', prompt: 'hello' });
  assert.equal('attachments' in events.find(event => event.kind === 'message.user'), false);
});

test('history shows a message without what Venes typed for it, with its files and pictures', t => {
  const home = tempRoot(t);
  const { VENES_HOME } = process.env;
  process.env.VENES_HOME = home;
  t.after(() => { if (VENES_HOME === undefined) delete process.env.VENES_HOME; else process.env.VENES_HOME = VENES_HOME; });
  const root = path.join(home, 'uploads');
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hi') });
  const where = path.join(root, SESSION_ID, file.uploadId, 'notes.txt');
  const transcript = path.join(home, 't.jsonl');
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } };
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: `[Image #1] @"${where}" look` }, image] } })}\n`);
  const [item] = readHistory(transcript).items;
  assert.equal(item.text, 'look');
  assert.deepEqual(item.attachments, [{ uploadId: file.uploadId, name: 'notes.txt', mediaType: 'text/plain', size: 2 }]);
  assert.equal(item.images.length, 1);
});

// A rex that writes down how it was called. Its screen shows a picture's mark once a picture's
// path has been pasted and the screen read `readsToShow` times since, unless `takesPictures` is false.
function fakeRex(t, { takesPictures = true, readsToShow = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-rex-'));
  const log = path.join(dir, 'calls');
  const script = path.join(dir, 'rex');
  fs.writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const input = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : undefined;
const earlier = fs.existsSync(${JSON.stringify(log)}) ? fs.readFileSync(${JSON.stringify(log)}, 'utf8') : '';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input }) + '\\n');
if (args.includes('format')) {
  const sincePicture = earlier.split('.png').slice(1).join('').split('"format"').length - 1;
  const shown = ${JSON.stringify(takesPictures)} && earlier.includes('.png') && sincePicture + 1 >= ${readsToShow};
  process.stdout.write(JSON.stringify({ content: shown ? '❯ [Image #1]\\n  ⏸ manual mode on\\n' : '❯ \\n  ⏸ manual mode on\\n' }));
}
`, { mode: 0o755 });
  const { PATH } = process.env;
  process.env.PATH = `${dir}:${PATH}`;
  t.after(() => {
    process.env.PATH = PATH;
    fs.rmSync(dir, { recursive: true });
  });
  return ({ reads = false } = {}) => fs.readFileSync(log, 'utf8').trim().split('\n').map(entry => JSON.parse(entry))
    .filter(({ args }) => reads || !args.includes('format'))
    .map(({ args, input }) => {
      if (args.includes('format')) return 'read';
      return args.at(-1) === 'enter' ? 'enter' : JSON.parse(input).event.payload.text;
    });
}

const SESSION = { pane: 'block:1', rexSession: 'session:1' };
const picture = { kind: 'image', path: '/u/s/1/shot.png' };
const notes = { kind: 'file', path: '/u/s/2/my notes.txt' };

test('attachments are typed in their order ahead of the text, each picture by itself', async t => {
  const typed = fakeRex(t);
  await sendMessage(SESSION, { text: 'look', attachments: [notes, picture] }, () => undefined, { imageLimit: 2000, imageCheck: 5 });
  assert.deepEqual(typed(), ['@"/u/s/2/my notes.txt" ', '/u/s/1/shot.png', ' ', 'look', 'enter']);
});

test('nothing more is typed until the picture\'s mark shows', async t => {
  const typed = fakeRex(t, { readsToShow: 3 });
  await sendMessage(SESSION, { text: 'look', attachments: [picture] }, () => undefined, { imageLimit: 2000, imageCheck: 5 });
  const calls = typed({ reads: true });
  const pasted = calls.indexOf('/u/s/1/shot.png');
  assert.deepEqual(calls.slice(pasted, pasted + 5), ['/u/s/1/shot.png', 'read', 'read', 'read', ' ']);
});

test('a message can be attachments alone', async t => {
  const typed = fakeRex(t);
  await sendMessage(SESSION, { attachments: [picture] }, () => undefined, { imageLimit: 2000, imageCheck: 5 });
  assert.deepEqual(typed(), ['/u/s/1/shot.png', ' ', 'enter']);
});

test('a picture Claude Code doesn\'t take is left as its path, and the message still goes', async t => {
  const typed = fakeRex(t, { takesPictures: false });
  const started = Date.now();
  await sendMessage(SESSION, { text: 'look', attachments: [picture] }, () => undefined, { imageLimit: 150, imageCheck: 5 });
  assert.ok(Date.now() - started >= 150);
  assert.deepEqual(typed(), ['/u/s/1/shot.png', ' ', 'look', 'enter']);
});

test('what Claude Code shows under its input box is read off the screen', async () => {
  const { statusLines } = await import('../../src/terminal.mjs');
  const screen = [
    '⏺ Done.',
    '',
    '─────────────────────────────────────────── venes-app ─',
    '❯ ',
    '────────────────────────────────────────────────────────',
    '  ◆ Opus 5.5 · max │ Venes │ ctx ━━━━ 90% │ cache 99%',
    '  ⏵⏵ bypass permissions on · 1 shell',
    '',
    '',
  ].join('\n');
  assert.deepEqual(statusLines(screen), ['◆ Opus 5.5 · max │ Venes │ ctx ━━━━ 90% │ cache 99%', '⏵⏵ bypass permissions on · 1 shell']);
  assert.deepEqual(statusLines(' Do you want to proceed?\n ❯ 1. Yes\n Esc to cancel\n'), []);
  assert.deepEqual(statusLines('──────────\n❯ \n──────────\n'), []);
});
