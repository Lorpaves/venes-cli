// What has to outlive a restart for a session to stay listed and typed into. There's no
// conversation text here: that stays in Claude Code's own transcript.

import fs from 'node:fs';

const FIELDS = ['id', 'cwd', 'pane', 'tmuxSocket', 'rexSession', 'rexServer', 'transcriptPath', 'permissionMode', 'model', 'effort', 'startedAt', 'lastEventAt'];

export function readRegistry(file) {
  try {
    const records = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(records) ? records.filter(record => record?.id && record.pane) : [];
  } catch {
    return [];
  }
}

export function writeRegistry(file, sessions) {
  const records = sessions.map(session => Object.fromEntries(FIELDS.map(field => [field, session[field]])));
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(records), { mode: 0o600 });
  fs.renameSync(temporary, file);
}
