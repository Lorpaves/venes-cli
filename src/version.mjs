import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8')).version;

const parts = version => version.split('.').map(Number);

// A helper from before versions were reported has none, and counts as older than any.
export function isNewer(version, than) {
  if (!version) return false;
  if (!than) return true;
  const [a, b] = [parts(version), parts(than)];
  if ([...a, ...b].some(Number.isNaN)) return false; // Claude Code can version a plugin by commit
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference > 0;
  }
  return false;
}
