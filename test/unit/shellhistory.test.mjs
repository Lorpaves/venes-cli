import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ShellHistory, commandsIn, pathSuggestions, suggestionsFrom, unmetafy, usualHistoryFile } from '../../src/shellhistory.mjs';

function folder(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'venes-hist-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('zsh\'s history is a command a line, with when it ran before it where the shell keeps that', () => {
  assert.deepEqual(commandsIn(': 1700000000:0;ls -la\n: 1700000003:12;git status\nplain one\n\n'), ['ls -la', 'git status', 'plain one']);
  // A command of several lines has a backslash at the end of each but the last.
  assert.deepEqual(commandsIn(': 1:0;echo a\\\nb\n: 2:0;pwd\n'), ['echo a\nb', 'pwd']);
  // A line that only looks stamped is a command.
  assert.deepEqual(commandsIn(': not a stamp;x\n'), [': not a stamp;x']);
});

test('bash\'s history is a command a line, and a line of its own for when each ran', () => {
  assert.deepEqual(commandsIn('#1700000000\nls -la\n#1700000003\ngit status\n  \n', 'bash'), ['ls -la', 'git status']);
  // What ends in a backslash there is only that.
  assert.deepEqual(commandsIn('echo a\\\nb\n', 'bash'), ['echo a\\', 'b']);
});

test('what zsh wrote of a line that isn\'t ASCII is put back', () => {
  const said = Buffer.from('echo 你好', 'utf8');
  const kept = Buffer.concat([...said].map(byte => (byte >= 0x83 ? Buffer.from([0x83, byte ^ 0x20]) : Buffer.from([byte]))));
  assert.notDeepEqual(kept, said);
  assert.equal(unmetafy(kept).toString('utf8'), 'echo 你好');
  assert.equal(unmetafy(Buffer.from('plain')).toString(), 'plain');
});

test('a history file is read newest first, each command once, and again only when it changes', t => {
  const file = path.join(folder(t), '.zsh_history');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(': 1:0;ls\n: 2:0;git status\n: 3:0;ls\n: 4:0;echo '), Buffer.from([0x83, 0xe4 ^ 0x20, 0x83, 0xbd ^ 0x20, 0x83, 0xa0 ^ 0x20]), Buffer.from('\n')]));
  const history = new ShellHistory();
  const first = history.commands(file);
  assert.deepEqual(first, ['echo 你', 'ls', 'git status']);
  assert.equal(history.commands(file), first, 'the same list while the file is as it was');
  fs.appendFileSync(file, ': 5:0;make\n');
  assert.deepEqual(history.commands(file), ['make', 'echo 你', 'ls', 'git status']);
  assert.deepEqual(history.commands(path.join(os.tmpdir(), 'no-such-history')), []);
  assert.deepEqual(history.commands(undefined), []);
});

test('only the end of a long history file is read, from a whole line', t => {
  const file = path.join(folder(t), '.bash_history');
  fs.writeFileSync(file, `${'old command\n'.repeat(50)}new one\nnewer one\n`);
  assert.deepEqual(new ShellHistory({ readBytes: 25 }).commands(file, 'bash'), ['newer one', 'new one']);
});

test('a line goes on to what was run before that starts as it does', () => {
  const session = ['git stash', 'ls', 'git status'];
  const kept = ['git status', 'git log --oneline', 'git s'];
  assert.deepEqual(suggestionsFrom([session, kept], 'git s'), ['git stash', 'git status']);
  assert.deepEqual(suggestionsFrom([session, kept], 'git'), ['git stash', 'git status', 'git log --oneline', 'git s']);
  assert.deepEqual(suggestionsFrom([session, kept], 'git', 2), ['git stash', 'git status']);
  // The same letters in another case are another command, and a command of several lines isn't offered.
  assert.deepEqual(suggestionsFrom([['Git status', 'git status\n--short']], 'git'), []);
  assert.deepEqual(suggestionsFrom([[`echo ${'x'.repeat(500)}`]], 'echo'), []);
});

test('the last word of a line is finished as a path from where the shell is', t => {
  const dir = folder(t);
  fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'my docs'));
  for (const name of ['setup.sh', 'src/app.js', 'src/apple.txt', '.hidden', 'server.log']) fs.writeFileSync(path.join(dir, name), '');
  fs.symlinkSync(path.join(dir, 'src'), path.join(dir, 'srclink'));
  const from = text => pathSuggestions(text, { cwd: dir, home: dir });
  assert.deepEqual(from('cat s'), ['cat server.log', 'cat setup.sh', 'cat src/', 'cat srclink/']);
  assert.deepEqual(from('cat src/ap'), ['cat src/app.js', 'cat src/apple.txt']);
  assert.deepEqual(from('cd my'), ['cd my\\ docs/']);
  assert.deepEqual(from('cd my\\ d'), ['cd my\\ docs/']);
  assert.deepEqual(from('ls ~/sr'), ['ls ~/src/', 'ls ~/srclink/']);
  assert.deepEqual(from(`ls ${dir}/src/d`), [`ls ${dir}/src/deep/`]);
  assert.deepEqual(pathSuggestions('cat s', { cwd: dir, home: dir, limit: 1 }), ['cat server.log']);
  // A name that starts with a dot is one only once a dot is typed.
  assert.deepEqual(from('cat .h'), ['cat .hidden']);
  assert.deepEqual(from('cat h'), []);
  // The first word is a command, unless it says where it is.
  assert.deepEqual(from('se'), []);
  assert.deepEqual(from('./se'), ['./server.log', './setup.sh']);
  // After a command that doesn't take files, a word is a path only when it's written as one.
  assert.deepEqual(from('git s'), []);
  assert.deepEqual(from('git add src/ap'), ['git add src/app.js', 'git add src/apple.txt']);
  assert.deepEqual(from('  cat s').length, 4);
  // Nothing typed of a name, a name that's whole, a word with a quote or a variable in it, a folder that isn't there.
  for (const none of ['cat ', 'cat src/', 'cat setup.sh', 'cat "s', "cat 's", 'cat $s', 'cat nowhere/x', '']) assert.deepEqual(from(none), [], none);
});

test('a shell that didn\'t say where its history is has it where its kind usually does', () => {
  assert.equal(usualHistoryFile('zsh', '/h'), '/h/.zsh_history');
  assert.equal(usualHistoryFile('bash', '/h'), '/h/.bash_history');
});
