import test from 'node:test';
import assert from 'node:assert/strict';
import { fromWire, nativePath, toWire, windowsDrives, wirePath } from '../../src/wirepaths.mjs';

test('a Windows path is said the way a client takes a path apart', () => {
  assert.equal(wirePath('C:\\Users\\Ada Lovelace\\work'), '/C:/Users/Ada Lovelace/work');
  assert.equal(wirePath('C:\\'), '/C:');
  assert.equal(wirePath('d:\\'), '/d:');
  assert.equal(wirePath('C:/Users/ada'), '/C:/Users/ada', 'as Git Bash or Node may have written it');
  assert.equal(wirePath('C:\\Users\\ada\\'), '/C:/Users/ada');
  assert.equal(wirePath('src\\app\\main.js'), 'src/app/main.js', 'one under a folder only has its separators turned');
  assert.equal(wirePath('src/app/main.js'), 'src/app/main.js');
  assert.equal(wirePath('\\\\server\\share\\work'), '//server/share/work');
  assert.equal(wirePath('/'), '/');
  assert.equal(wirePath(''), '');
  assert.equal(wirePath(undefined), undefined);
});

test('and what a client says back is this computer\'s own again', () => {
  assert.equal(nativePath('/C:/Users/Ada Lovelace/work'), 'C:\\Users\\Ada Lovelace\\work');
  assert.equal(nativePath('/C:'), 'C:\\');
  assert.equal(nativePath('/C:/'), 'C:\\');
  assert.equal(nativePath('/d:/x/../y'), 'd:\\y');
  for (const own of ['/', 'src/app/main.js', 'C:\\Users\\ada', 'C:/Users/ada', '//server/share/work', '/Users/ada', '', '/C:x']) {
    assert.equal(nativePath(own), own, own);
  }
  assert.equal(nativePath(7), 7);
});

test('every path goes there and back the same', () => {
  for (const own of ['C:\\', 'C:\\Users', 'C:\\Users\\Ada Lovelace\\a b\\c.txt', 'D:\\x']) assert.equal(nativePath(wirePath(own)), own);
});

test('a message has its paths turned wherever they are, and nothing else', () => {
  const sent = toWire({
    type: 'result', ok: true, home: 'C:\\Users\\ada', name: 'C:\\not a path field',
    recent: [{ path: 'C:\\Users\\ada\\work', name: 'work', trusted: true, running: 0 }],
    git: { root: 'C:\\Users\\ada\\work', files: [{ path: 'src/a.js', from: 'src\\old.js', added: 1 }] },
  });
  assert.deepEqual(sent, {
    type: 'result', ok: true, home: '/C:/Users/ada', name: 'C:\\not a path field',
    recent: [{ path: '/C:/Users/ada/work', name: 'work', trusted: true, running: 0 }],
    git: { root: '/C:/Users/ada/work', files: [{ path: 'src/a.js', from: 'src\\old.js', added: 1 }] },
  });
});

test('what a session said or was told keeps its paths as they were written', () => {
  const event = { type: 'event', event: { kind: 'tool.start', sessionId: 's', cwd: 'C:\\w', input: { path: 'C:\\w\\src', file_path: 'C:\\w\\a.js' } } };
  assert.deepEqual(toWire(event), { type: 'event', event: { kind: 'tool.start', sessionId: 's', cwd: '/C:/w', input: { path: 'C:\\w\\src', file_path: 'C:\\w\\a.js' } } });
  const said = { text: 'open C:\\w', content: [{ path: 'C:\\w' }], output: { cwd: 'C:\\w' }, answers: { path: 'C:\\w' } };
  assert.deepEqual(toWire(said), said);
  // A list of stored sessions and a page of history are both `items`, and what's a path in one is said as one.
  assert.deepEqual(toWire({ items: [{ id: 'a', cwd: 'C:\\w' }, { role: 'assistant', text: 'see C:\\w', page: { path: 'C:\\w\\page.html' } }] }),
    { items: [{ id: 'a', cwd: '/C:/w' }, { role: 'assistant', text: 'see C:\\w', page: { path: '/C:/w/page.html' } }] });
});

test('what a client asks has its paths turned back, and its other fields left', () => {
  assert.deepEqual(fromWire({ cmd: 'fileWrite', id: 3, sessionId: 's', path: '/C:/w/a b.txt', text: '/C:/not/a/path', was: 'x' }),
    { cmd: 'fileWrite', id: 3, sessionId: 's', path: 'C:\\w\\a b.txt', text: '/C:/not/a/path', was: 'x' });
  assert.deepEqual(fromWire({ cmd: 'start', cwd: '/C:/w', trust: true }), { cmd: 'start', cwd: 'C:\\w', trust: true });
  assert.deepEqual(fromWire({ cmd: 'gitStage', root: '/C:/w', paths: ['src/a.js'] }), { cmd: 'gitStage', root: 'C:\\w', paths: ['src/a.js'] });
  assert.deepEqual(fromWire({ cmd: 'folders', path: '/' }), { cmd: 'folders', path: '/' });
  assert.deepEqual(fromWire({ cmd: 'files', sessionId: 's', path: 'src/app' }), { cmd: 'files', sessionId: 's', path: 'src/app' });
});

test('a message is turned into a new one, and the one given is left as it was', () => {
  const given = { cwd: 'C:\\w', list: [{ path: 'C:\\w\\a' }] };
  toWire(given);
  assert.deepEqual(given, { cwd: 'C:\\w', list: [{ path: 'C:\\w\\a' }] });
});

test('the drives there are stand at the top', () => {
  assert.deepEqual(windowsDrives(drive => ['C:\\', 'E:\\'].includes(drive)), [{ name: 'C:', path: 'C:\\' }, { name: 'E:', path: 'E:\\' }]);
  assert.deepEqual(windowsDrives(() => false), []);
});
