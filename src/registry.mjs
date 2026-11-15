// What has to outlive a restart for a session to stay listed and typed into, and for its plans to
// offer the same ways on and go back to the mode they were made in. There's no conversation text
// here: that stays in Claude Code's own transcript.

import fs from 'node:fs';

// `agent` and `permissionModes` are a session's that isn't Claude Code's and still runs in a terminal, as
// Antigravity's does: whose it is, and the modes it has.
const FIELDS = [
  'id', 'cwd', 'startFolder', 'folders', 'pane', 'tmuxSocket', 'rexSession', 'rexServer', 'transcriptPath', 'permissionMode', 'modes', 'modeBeforePlan', 'model',
  'effort', 'startedAt', 'lastEventAt', 'agent', 'permissionModes',
];

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
