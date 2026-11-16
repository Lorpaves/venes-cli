import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { downloadsFolder } from '../../src/paths.mjs';

function home(t, dirs) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'venes-home-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  if (dirs !== undefined) {
    fs.mkdirSync(path.join(folder, '.config'));
    fs.writeFileSync(path.join(folder, '.config', 'user-dirs.dirs'), dirs);
  }
  return folder;
}

test('a Mac\'s downloads are in Downloads, whatever else a file in the home folder says', t => {
  const folder = home(t, 'XDG_DOWNLOAD_DIR="$HOME/Elsewhere"\n');
  assert.equal(downloadsFolder({ home: folder, platform: 'darwin', config: undefined }), path.join(folder, 'Downloads'));
});

test('a Linux desktop says where its downloads go, in its own language if it has one', t => {
  const named = home(t, '# what the desktop wrote\nXDG_DESKTOP_DIR="$HOME/桌面"\nXDG_DOWNLOAD_DIR="$HOME/下载"\n');
  assert.equal(downloadsFolder({ home: named, platform: 'linux', config: undefined }), path.join(named, '下载'));
  const elsewhere = home(t, 'XDG_DOWNLOAD_DIR="/mnt/data/incoming"\n');
  assert.equal(downloadsFolder({ home: elsewhere, platform: 'linux', config: undefined }), '/mnt/data/incoming');
});

test('with nothing said, or the home folder itself named, it\'s Downloads', t => {
  const bare = home(t);
  assert.equal(downloadsFolder({ home: bare, platform: 'linux', config: undefined }), path.join(bare, 'Downloads'));
  const none = home(t, 'XDG_DOWNLOAD_DIR="$HOME/"\n');
  assert.equal(downloadsFolder({ home: none, platform: 'linux', config: undefined }), path.join(none, 'Downloads'));
});
