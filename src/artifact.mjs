// A page a session published with Claude Code's Artifact tool, for a client to show itself. On claude.ai the
// page is private to whoever published it, so a phone that isn't signed in there gets only a link. The page is
// made from a file on this Mac, which is what's read here: found from the call that published it, never from
// a path a client names, so a client can have only what a session published.

import fs from 'node:fs';
import { HelperError } from './sessions.mjs';

// What claude.ai takes for a page.
export const ARTIFACT_BYTES = 16 * 1024 * 1024;

const unknown = () => new HelperError('unknown_artifact', 'That isn\'t a page this session published.');

// The text of the file at `file`, which `findArtifact` found. `limit` is for the tests.
export function readArtifact(file, { limit = ARTIFACT_BYTES } = {}) {
  if (typeof file !== 'string' || !file) throw unknown();
  let bytes;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new HelperError('artifact_gone', 'The file this page was made from is no longer there.');
    if (stat.size > limit) throw new HelperError('artifact_too_big', 'This page is too big to show here.');
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof HelperError) throw error;
    throw new HelperError('artifact_gone', 'The file this page was made from is no longer there.');
  }
  if (bytes.includes(0)) throw new HelperError('artifact_not_text', 'This page isn\'t text.');
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    throw new HelperError('artifact_not_text', 'This page isn\'t text.');
  }
}

export function checkedToolUse(toolUseId) {
  if (typeof toolUseId !== 'string' || !toolUseId) throw unknown();
  return toolUseId;
}
