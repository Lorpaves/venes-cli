import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SHELL_FILES, hidesInput, installShellFiles, recorded, settingsCommand, shellCommand, shellFor, sizeCommand, sizeIn } from '../../src/shellmarks.mjs';
import { MARK_CODE } from '../../src/termengine.mjs';

test('the session runs the reader\'s own shell when the hooks are written for it', () => {
  const has = (...files) => file => files.includes(file);
  assert.deepEqual(shellFor({ SHELL: '/opt/homebrew/bin/zsh' }, has('/opt/homebrew/bin/zsh', '/bin/zsh')), { file: '/opt/homebrew/bin/zsh', kind: 'zsh' });
  assert.deepEqual(shellFor({ SHELL: '/usr/bin/bash' }, has('/usr/bin/bash', '/bin/zsh')), { file: '/usr/bin/bash', kind: 'bash' });
  // Another shell's reader gets zsh, or bash where there's no zsh.
  assert.deepEqual(shellFor({ SHELL: '/opt/homebrew/bin/fish' }, has('/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash')), { file: '/bin/zsh', kind: 'zsh' });
  assert.deepEqual(shellFor({ SHELL: '/usr/bin/fish' }, has('/usr/bin/fish', '/usr/bin/bash')), { file: '/usr/bin/bash', kind: 'bash' });
  assert.deepEqual(shellFor({}, has('/bin/bash')), { file: '/bin/bash', kind: 'bash' });
  // One named that isn't there is passed over.
  assert.deepEqual(shellFor({ SHELL: '/gone/zsh' }, has('/bin/bash')), { file: '/bin/bash', kind: 'bash' });
  assert.throws(() => shellFor({ SHELL: '/bin/sh' }, has('/bin/sh')), { code: 'no_shell' });
});

test('zsh reads the helper\'s files ahead of the reader\'s, and bash one file in their place', () => {
  const zsh = shellCommand({ shellDir: '/v/shell', mark: 'abc', env: { HOME: '/Users/me', PATH: '/bin', LANG: 'zh_CN.UTF-8' }, shell: { file: '/bin/zsh', kind: 'zsh' } });
  assert.deepEqual(zsh.command, ['/bin/zsh', '-l', '-i']);
  assert.deepEqual(zsh.env, {
    VENES_TERMINAL_MARK: 'abc', LANG: 'zh_CN.UTF-8', PATH: '/bin', HOME: '/Users/me', ZDOTDIR: '/v/shell/zsh', VENES_USER_ZDOTDIR: '/Users/me', DISABLE_AUTO_UPDATE: 'true',
  });
  // A reader who keeps their zsh files elsewhere has them read from there, and a helper with no language set says one.
  const moved = shellCommand({ shellDir: '/v/shell', mark: 'abc', env: { HOME: '/Users/me', ZDOTDIR: '/Users/me/.config/zsh', LC_ALL: 'C' }, shell: { file: '/bin/zsh', kind: 'zsh' } });
  assert.deepEqual([moved.env.VENES_USER_ZDOTDIR, moved.env.LANG, moved.env.LC_ALL, moved.env.PATH], ['/Users/me/.config/zsh', 'en_US.UTF-8', 'C', undefined]);
  const bash = shellCommand({ shellDir: '/v/shell', mark: 'abc', env: { HOME: '/home/me' }, shell: { file: '/usr/bin/bash', kind: 'bash' } });
  assert.deepEqual(bash.command, ['/usr/bin/bash', '--rcfile', '/v/shell/bash/bashrc', '-i']);
  // The helper's home is said, which is where bash looks for its files and keeps its history.
  assert.deepEqual(bash.env, { VENES_TERMINAL_MARK: 'abc', LANG: 'en_US.UTF-8', HOME: '/home/me' });
  assert.equal('HOME' in shellCommand({ shellDir: '/v/shell', mark: 'abc', env: {}, shell: { file: '/usr/bin/bash', kind: 'bash' } }).env, false);
});

test('the files a shell reads are written where it looks, under the names it looks for', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-shell-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  installShellFiles(dir);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'zsh')).sort(), ['.zlogin', '.zprofile', '.zshenv', '.zshrc', 'venes.zsh']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'bash')), ['bashrc']);
  assert.deepEqual(Object.keys(SHELL_FILES), ['zsh', 'bash']);
  // The marks they write are the ones the helper reads, and only the session's own shell writes them.
  for (const file of ['zsh/venes.zsh', 'bash/bashrc']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(text.includes(`]${MARK_CODE};`), `${file} writes mark ${MARK_CODE}`);
    assert.match(text, /unset VENES_TERMINAL_MARK/);
  }
  assert.equal(fs.statSync(path.join(dir, 'zsh', 'venes.zsh')).mode & 0o777, 0o600);
  // Each of zsh's reads the reader's own of the same name.
  for (const name of ['.zshenv', '.zprofile', '.zshrc', '.zlogin']) {
    assert.ok(fs.readFileSync(path.join(dir, 'zsh', name), 'utf8').includes(`source $ZDOTDIR/${name}`));
  }
});

test('a command is run under script, as each system\'s script takes one', () => {
  assert.deepEqual(recorded(['/bin/zsh', '-l', '-i'], '/v/t/stream', { platform: 'darwin', flush: () => true }), ['script', '-q', '-a', '-F', '/v/t/stream', '/bin/zsh', '-l', '-i']);
  assert.deepEqual(recorded(['/bin/zsh', '-l'], '/v/t/stream', { platform: 'darwin', flush: () => false }), ['script', '-q', '-a', '-t', '0', '/v/t/stream', '/bin/zsh', '-l']);
  assert.deepEqual(
    recorded(['/usr/bin/bash', '--rcfile', "/home/it's me/bashrc", '-i'], '/v/t/stream', { platform: 'linux' }),
    ['script', '-q', '-a', '-f', '-e', '-c', `'/usr/bin/bash' '--rcfile' '/home/it'\\''s me/bashrc' '-i'`, '/v/t/stream'],
  );
});

test('a terminal\'s size and settings are asked of its own device', () => {
  assert.deepEqual(sizeCommand('/dev/ttys010', { columns: 47, rows: 30 }, 'darwin'), ['stty', '-f', '/dev/ttys010', 'cols', '47', 'rows', '30']);
  assert.deepEqual(sizeCommand('/dev/pts/3', { columns: 47, rows: 30 }, 'linux'), ['stty', '-F', '/dev/pts/3', 'cols', '47', 'rows', '30']);
  assert.deepEqual(settingsCommand('/dev/pts/3', 'linux'), ['stty', '-F', '/dev/pts/3', '-a']);
  assert.deepEqual(sizeIn('speed 9600 baud; 30 rows; 47 columns;\nlflags: icanon'), { columns: 47, rows: 30 });
  assert.deepEqual(sizeIn('speed 38400 baud; rows 30; columns 47; line = 0;'), { columns: 47, rows: 30 });
  assert.equal(sizeIn('nothing of the kind'), undefined);
});

test('a program that reads a line without showing it is asking for something secret', () => {
  // A Mac's stty, and Linux's.
  assert.equal(hidesInput('lflags: icanon isig iexten -echo echoe echok'), true);
  assert.equal(hidesInput('isig icanon iexten -echo echoe echok -echonl'), true);
  assert.equal(hidesInput('lflags: icanon isig iexten echo echoe'), false);
  // An editor reads each key for itself, and shows what it likes.
  assert.equal(hidesInput('lflags: -icanon isig -iexten -echo'), false);
});
