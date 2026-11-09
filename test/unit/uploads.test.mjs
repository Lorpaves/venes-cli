import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../../src/sessions.mjs';
import { sendMessage } from '../../src/terminal.mjs';
import { readHistory } from '../../src/transcript.mjs';
import {
  MAX_UPLOAD_BYTES, answersWithAttachments, discardUpload, findUpload, markSent, pruneUploads, referenceTo, removeUploads, safeName, saveUpload,
  splitAttachments,
} from '../../src/uploads.mjs';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const base64 = text => Buffer.from(text).toString('base64');

// Nothing here may reach the real Downloads, even by default.
const SAFE_DOWNLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-downloads-'));
process.env.VENES_DOWNLOADS = SAFE_DOWNLOADS;
process.on('exit', () => fs.rmSync(SAFE_DOWNLOADS, { recursive: true, force: true }));

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-uploads-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

const tempFolders = t => ({ root: tempRoot(t), downloads: tempRoot(t) });

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

test('an upload goes in Downloads, and is found again by its id', t => {
  const { root, downloads } = tempFolders(t);
  const picture = saveUpload(root, { sessionId: SESSION_ID, name: 'shot.png', mediaType: 'IMAGE/PNG', data: base64('png bytes') }, downloads);
  assert.equal(picture.kind, 'image');
  assert.equal(picture.mediaType, 'image/png');
  assert.equal(picture.size, 9);
  assert.match(picture.uploadId, /^[0-9a-f]{32}$/);
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hello') }, downloads);
  assert.equal(file.kind, 'file');
  const found = findUpload(root, SESSION_ID, file.uploadId);
  assert.equal(found.path, path.join(downloads, 'notes.txt'));
  assert.equal(fs.readFileSync(found.path, 'utf8'), 'hello');
  assert.deepEqual({ ...found, path: undefined }, { ...file, path: undefined });
  assert.deepEqual(fs.readdirSync(path.join(root, SESSION_ID, file.uploadId)), ['upload.json'], 'only what is known of it is kept apart');
});

test('a name Downloads has already gets a number, the way Finder numbers a copy', t => {
  const { root, downloads } = tempFolders(t);
  fs.writeFileSync(path.join(downloads, 'notes.txt'), 'mine');
  fs.writeFileSync(path.join(downloads, 'shot.png'), 'mine');
  const save = (name, mediaType) => {
    const { uploadId } = saveUpload(root, { sessionId: SESSION_ID, name, mediaType, data: base64('x') }, downloads);
    return findUpload(root, SESSION_ID, uploadId).path;
  };
  assert.equal(save('notes.txt', 'text/plain'), path.join(downloads, 'notes 2.txt'));
  assert.equal(save('notes.txt', 'text/plain'), path.join(downloads, 'notes 3.txt'));
  assert.equal(save('shot.png', 'image/png'), path.join(downloads, 'shot-2.png'), 'a picture\'s still has no spaces');
  assert.equal(save('Makefile', 'text/plain'), path.join(downloads, 'Makefile'));
  assert.equal(save('Makefile', 'text/plain'), path.join(downloads, 'Makefile 2'));
  assert.equal(fs.readFileSync(path.join(downloads, 'notes.txt'), 'utf8'), 'mine', 'nothing of the person\'s is written over');
  assert.equal(fs.readFileSync(path.join(downloads, 'shot.png'), 'utf8'), 'mine');
});

test('where this Mac won\'t let the helper write in Downloads, a file is kept out of the way instead', t => {
  const { root, downloads } = tempFolders(t);
  fs.chmodSync(downloads, 0o500);
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hello') }, downloads);
  fs.chmodSync(downloads, 0o700);
  const found = findUpload(root, SESSION_ID, file.uploadId);
  assert.equal(found.path, path.join(root, SESSION_ID, file.uploadId, 'notes.txt'));
  assert.equal(fs.readFileSync(found.path, 'utf8'), 'hello');
});

test('an upload that isn\'t there is undefined, and a session id has to look like one', t => {
  const { root, downloads } = tempFolders(t);
  assert.equal(findUpload(root, SESSION_ID, 'f'.repeat(32)), undefined);
  assert.equal(findUpload(root, SESSION_ID, '../../etc'), undefined);
  assert.throws(() => findUpload(root, '../x', 'f'.repeat(32)), { code: 'unknown_session' });
  assert.throws(() => saveUpload(root, { sessionId: 'a/b', name: 'x', mediaType: 'text/plain', data: base64('x') }, downloads), { code: 'unknown_session' });
  const { uploadId } = saveUpload(root, { sessionId: SESSION_ID, name: 'x.txt', mediaType: 'text/plain', data: base64('x') }, downloads);
  fs.renameSync(path.join(downloads, 'x.txt'), path.join(downloads, 'moved.txt'));
  assert.equal(findUpload(root, SESSION_ID, uploadId), undefined, 'one the person moved is gone');
});

test('an upload needs a type and something in it, and has a size limit', t => {
  const { root, downloads } = tempFolders(t);
  const save = fields => () => saveUpload(root, { sessionId: SESSION_ID, name: 'x', mediaType: 'text/plain', data: base64('x'), ...fields }, downloads);
  assert.throws(save({ mediaType: undefined }), { code: 'bad_upload' });
  assert.throws(save({ mediaType: 'not a type' }), { code: 'bad_upload' });
  assert.throws(save({ data: '' }), { code: 'bad_upload' });
  assert.throws(save({ data: '====' }), { code: 'bad_upload' });
  assert.throws(save({ data: 'A'.repeat(Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 8) }), { code: 'too_large' });
  assert.equal(fs.existsSync(path.join(root, SESSION_ID)), false);
  assert.deepEqual(fs.readdirSync(downloads), []);
});

test('what\'s known of a session\'s uploads goes with it, and old ones go when the helper starts, but not their files', t => {
  const { root, downloads } = tempFolders(t);
  const old = saveUpload(root, { sessionId: SESSION_ID, name: 'old.txt', mediaType: 'text/plain', data: base64('o') }, downloads);
  const recent = saveUpload(root, { sessionId: SESSION_ID, name: 'new.txt', mediaType: 'text/plain', data: base64('n') }, downloads);
  const other = 'aaaaaaaa-2222-4333-8444-555555555555';
  saveUpload(root, { sessionId: other, name: 'gone.txt', mediaType: 'text/plain', data: base64('g') }, downloads);
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
  assert.deepEqual(fs.readdirSync(downloads).sort(), ['gone.txt', 'new.txt', 'old.txt'], 'Downloads is the person\'s');
  pruneUploads(path.join(root, 'nothing here'));
});

test('an upload taken back out of the composer goes from Downloads with what is known of it', t => {
  const { root, downloads } = tempFolders(t);
  const taken = saveUpload(root, { sessionId: SESSION_ID, name: 'taken.txt', mediaType: 'text/plain', data: base64('x') }, downloads);
  const kept = saveUpload(root, { sessionId: SESSION_ID, name: 'kept.txt', mediaType: 'text/plain', data: base64('y') }, downloads);
  assert.deepEqual(discardUpload(root, SESSION_ID, taken.uploadId), { discarded: true });
  assert.deepEqual(fs.readdirSync(downloads), ['kept.txt'], 'only that one goes');
  assert.equal(fs.existsSync(path.join(root, SESSION_ID, taken.uploadId)), false);
  assert.equal(findUpload(root, SESSION_ID, taken.uploadId), undefined);
  assert.deepEqual(discardUpload(root, SESSION_ID, taken.uploadId), { discarded: false }, 'again is nothing');
  assert.ok(findUpload(root, SESSION_ID, kept.uploadId));
});

test('an upload a message has stays, file and all, and it shows as it did', t => {
  const { root, downloads } = tempFolders(t);
  const sent = saveUpload(root, { sessionId: SESSION_ID, name: 'sent.txt', mediaType: 'text/plain', data: base64('x') }, downloads);
  markSent(root, SESSION_ID, sent.uploadId);
  markSent(root, SESSION_ID, sent.uploadId);
  assert.deepEqual(discardUpload(root, SESSION_ID, sent.uploadId), { discarded: false });
  assert.equal(fs.readFileSync(path.join(downloads, 'sent.txt'), 'utf8'), 'x');
  assert.deepEqual(findUpload(root, SESSION_ID, sent.uploadId), { ...sent, path: path.join(downloads, 'sent.txt') }, 'what the helper notes for itself isn\'t shown');
  markSent(root, SESSION_ID, 'f'.repeat(32));
  markSent(root, SESSION_ID, '../../etc');
  assert.equal(fs.existsSync(path.join(root, SESSION_ID, 'f'.repeat(32))), false, 'one that isn\'t there stays not there');
});

test('a file changed, touched or moved since it came is the person\'s, so only what is known of it goes', t => {
  const { root, downloads } = tempFolders(t);
  const save = name => saveUpload(root, { sessionId: SESSION_ID, name, mediaType: 'text/plain', data: base64('x') }, downloads);
  const changed = save('changed.txt');
  fs.writeFileSync(path.join(downloads, 'changed.txt'), 'mine now');
  const touched = save('touched.txt');
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(downloads, 'touched.txt'), later, later);
  const moved = save('moved.txt');
  fs.renameSync(path.join(downloads, 'moved.txt'), path.join(downloads, 'elsewhere.txt'));
  const swapped = save('swapped.txt');
  fs.rmSync(path.join(downloads, 'swapped.txt'));
  fs.mkdirSync(path.join(downloads, 'swapped.txt'));
  for (const { uploadId } of [changed, touched, moved, swapped]) {
    assert.deepEqual(discardUpload(root, SESSION_ID, uploadId), { discarded: false });
    assert.equal(fs.existsSync(path.join(root, SESSION_ID, uploadId)), false);
  }
  assert.deepEqual(fs.readdirSync(downloads).sort(), ['changed.txt', 'elsewhere.txt', 'swapped.txt', 'touched.txt']);
  assert.equal(fs.readFileSync(path.join(downloads, 'changed.txt'), 'utf8'), 'mine now');
});

test('a file from before the helper noted when it wrote one stays, since it can\'t be told from one changed since', t => {
  const { root, downloads } = tempFolders(t);
  const before = saveUpload(root, { sessionId: SESSION_ID, name: 'before.txt', mediaType: 'text/plain', data: base64('x') }, downloads);
  const about = path.join(root, SESSION_ID, before.uploadId, 'upload.json');
  const { mtimeMs, ...older } = JSON.parse(fs.readFileSync(about, 'utf8'));
  assert.equal(typeof mtimeMs, 'number');
  fs.writeFileSync(about, JSON.stringify(older));
  assert.deepEqual(discardUpload(root, SESSION_ID, before.uploadId), { discarded: false });
  assert.deepEqual(fs.readdirSync(downloads), ['before.txt']);
  assert.equal(fs.existsSync(path.join(root, SESSION_ID, before.uploadId)), false);
});

test('one kept out of the way, where Downloads wouldn\'t take it, goes with what is known of it', t => {
  const { root, downloads } = tempFolders(t);
  fs.chmodSync(downloads, 0o500);
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hello') }, downloads);
  fs.chmodSync(downloads, 0o700);
  assert.deepEqual(discardUpload(root, SESSION_ID, file.uploadId), { discarded: true });
  assert.equal(fs.existsSync(path.join(root, SESSION_ID, file.uploadId)), false);
});

test('only an upload\'s id can be discarded, in a session\'s', t => {
  const { root } = tempFolders(t);
  assert.throws(() => discardUpload(root, SESSION_ID, '../../etc'), { code: 'bad_upload' });
  assert.throws(() => discardUpload(root, SESSION_ID, undefined), { code: 'bad_upload' });
  assert.throws(() => discardUpload(root, '../x', 'f'.repeat(32)), { code: 'unknown_session' });
  assert.deepEqual(discardUpload(root, SESSION_ID, 'f'.repeat(32)), { discarded: false });
});

test('what Venes typed ahead of a message comes off its text, and its files are listed', t => {
  const { root, downloads } = tempFolders(t);
  const split = text => splitAttachments(text, { root, sessionId: SESSION_ID });
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'report final.pdf', mediaType: 'application/pdf', data: base64('%PDF') }, downloads);
  const where = path.join(downloads, 'report final.pdf');
  const described = { uploadId: file.uploadId, name: 'report final.pdf', mediaType: 'application/pdf', size: 4 };
  assert.deepEqual(split(`[Image #1] [Image #2] @"${where}" sum it up`), { text: 'sum it up', files: [described] });
  assert.deepEqual(split(`[Image #3]  @"${where}"  `), { text: '', files: [described] });
  const picture = saveUpload(root, { sessionId: SESSION_ID, name: 'p.png', mediaType: 'image/png', data: base64('p') }, downloads);
  const left = findUpload(root, SESSION_ID, picture.uploadId).path;
  assert.deepEqual(split(`${left} what is it`).files.map(({ name }) => name), ['p.png']);
  assert.deepEqual(split(`@${left} what is it`).text, 'what is it');
  // One from before Downloads, kept with what's known of it.
  const before = 'b'.repeat(32);
  fs.mkdirSync(path.join(root, SESSION_ID, before));
  fs.writeFileSync(path.join(root, SESSION_ID, before, 'upload.json'), JSON.stringify({ name: 'a.txt', mediaType: 'text/plain', size: 1, kind: 'file' }));
  fs.writeFileSync(path.join(root, SESSION_ID, before, 'a.txt'), 'a');
  assert.deepEqual(split(`@"${path.join(root, SESSION_ID, before, 'a.txt')}" and`),
    { text: 'and', files: [{ uploadId: before, name: 'a.txt', mediaType: 'text/plain', size: 1 }] });
  assert.equal(findUpload(root, SESSION_ID, before).path, path.join(root, SESSION_ID, before, 'a.txt'));
});

test('only the start is Venes\'s: the rest, and references to other files, are what someone wrote', t => {
  const { root, downloads } = tempFolders(t);
  const same = text => assert.deepEqual(splitAttachments(text, { root, sessionId: SESSION_ID }), { text, files: [] });
  same('compare [Image #1] with this');
  same('@"/etc/hosts" what is this');
  same('@src/app.js explain');
  same('/compact');
  same('  indented on purpose');
  same(`@"${path.join(root, SESSION_ID, 'not-an-upload', 'x.txt')}" hi`);
  fs.writeFileSync(path.join(downloads, 'mine.txt'), 'mine');
  same(`@"${path.join(downloads, 'mine.txt')}" hi`);
  const elsewhere = saveUpload(root, { sessionId: 'aaaaaaaa-2222-4333-8444-555555555555', name: 'n.txt', mediaType: 'text/plain', data: base64('n') }, downloads);
  same(`@"${findUpload(root, 'aaaaaaaa-2222-4333-8444-555555555555', elsewhere.uploadId).path}" another session's`);
  assert.deepEqual(splitAttachments(`@"${path.join(downloads, 'mine.txt')}" hi`, { root }), { text: `@"${path.join(downloads, 'mine.txt')}" hi`, files: [] });
});

test('a message sent with attachments is matched to its send, and says what files it had', t => {
  const { root, downloads } = tempFolders(t);
  const store = new SessionStore({ splitAttachments: (text, sessionId) => splitAttachments(text, { root, sessionId }) });
  const events = [];
  store.on('event', event => events.push(event));
  const file = saveUpload(root, { sessionId: 'a', name: 'notes.txt', mediaType: 'text/plain', data: base64('hi') }, downloads);
  const where = path.join(downloads, 'notes.txt');
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
  const { root: home, downloads } = tempFolders(t);
  const { VENES_HOME } = process.env;
  process.env.VENES_HOME = home;
  t.after(() => { if (VENES_HOME === undefined) delete process.env.VENES_HOME; else process.env.VENES_HOME = VENES_HOME; });
  const root = path.join(home, 'uploads');
  const file = saveUpload(root, { sessionId: SESSION_ID, name: 'notes.txt', mediaType: 'text/plain', data: base64('hi') }, downloads);
  const where = path.join(downloads, 'notes.txt');
  // A transcript is named for its session, which is whose uploads it can name.
  const transcript = path.join(home, `${SESSION_ID}.jsonl`);
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

test('a video keeps no spaces and has its extension, since its path goes in as it is', t => {
  assert.equal(safeName('screen recording.MOV', 'video/quicktime'), 'screen-recording.MOV');
  assert.equal(safeName('clip', 'video/mp4'), 'clip.mp4');
  assert.equal(safeName('', 'video/quicktime'), 'video.mov');
  assert.equal(safeName('a b.webm', 'video/webm'), 'a-b.webm');
  const { root, downloads } = tempFolders(t);
  const video = saveUpload(root, { sessionId: SESSION_ID, name: 'screen recording.mov', mediaType: 'video/quicktime', data: base64('moov') }, downloads);
  assert.equal(video.kind, 'video');
  const found = findUpload(root, SESSION_ID, video.uploadId);
  assert.equal(referenceTo(found), found.path, 'no @, since Claude Code has nothing to put in for a video');
  assert.equal(referenceTo({ kind: 'file', path: '/u/x.txt' }), '@"/u/x.txt"');
  assert.equal(found.path, path.join(downloads, 'screen-recording.mov'));
  assert.deepEqual(splitAttachments(`${found.path} what happens here`, { root, sessionId: SESSION_ID }),
    { text: 'what happens here', files: [{ uploadId: video.uploadId, name: 'screen-recording.mov', mediaType: 'video/quicktime', size: 4 }] });
});

test('a video is typed as its path, between the other attachments and the text', async t => {
  const typed = fakeRex(t);
  const video = { kind: 'video', path: '/u/s/3/clip.mov' };
  await sendMessage(SESSION, { text: 'look', attachments: [video, notes] }, () => undefined, { imageLimit: 2000, imageCheck: 5 });
  assert.deepEqual(typed(), ['/u/s/3/clip.mov ', '@"/u/s/2/my notes.txt" ', 'look', 'enter']);
});

test('files given with an answer follow what was typed, and stand alone for one answered with files only', () => {
  const uploads = {
    u1: { kind: 'image', path: '/d/Venes/shot.png' },
    u2: { kind: 'file', path: '/d/Venes/notes final.txt' },
    u3: { kind: 'video', path: '/d/Venes/clip.mov' },
  };
  const resolve = ids => ids.map(id => uploads[id]);
  const answers = answersWithAttachments({ Colour: 'Red', Size: 'Big' }, { Colour: ['u1', 'u2'], Why: ['u3'] }, resolve);
  assert.deepEqual(answers, {
    Colour: 'Red @"/d/Venes/shot.png" @"/d/Venes/notes final.txt"',
    Size: 'Big',
    Why: '/d/Venes/clip.mov',
  });
});

test('an answer without files stays as it came', () => {
  const answers = { Q: 'a' };
  assert.equal(answersWithAttachments(answers, undefined, () => { throw new Error('not asked'); }), answers);
  assert.deepEqual(answersWithAttachments(answers, { Q: [] }, ids => ids), { Q: 'a' });
});

test('files that do not go by question are refused', () => {
  for (const attachments of [null, ['u1'], 'u1']) {
    assert.throws(() => answersWithAttachments({}, attachments, ids => ids), { code: 'bad_attachment' });
  }
});

