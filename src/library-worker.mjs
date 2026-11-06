// Runs one read for the helper in a process of its own, and prints the reply. See library.mjs.
// A page comes from the transcript and not from the SDK's getSessionMessages(), which stops at
// the last compaction, and that can be nearly all of a long session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHistory } from './transcript.mjs';

const SESSION_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

class ReadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function findTranscript(sessionId) {
  const missing = new ReadError('unknown_session', `No stored session ${sessionId}`);
  if (!SESSION_ID.test(sessionId)) throw missing;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  for (const project of fs.readdirSync(projects)) {
    const file = path.join(projects, project, `${sessionId}.jsonl`);
    if (fs.existsSync(file)) return file;
  }
  throw missing;
}

const sdkAt = entry => import(pathToFileURL(entry));

const operations = {
  list: async ({ sdk, limit, offset }) => ({ sessions: await (await sdkAt(sdk)).listSessions({ limit, offset }) }),
  info: async ({ sdk, sessionId }) => ({ session: await (await sdkAt(sdk)).getSessionInfo(sessionId) }),
  history: ({ sessionId, limit, before }) => readHistory(findTranscript(sessionId), { limit, before }),
};

try {
  const request = JSON.parse(process.argv[2]);
  process.stdout.write(JSON.stringify(await operations[request.op](request)));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code ?? 'internal', message: error.message } }));
}
