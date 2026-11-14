// Runs one read for the helper in a process of its own, and prints the reply. See library.mjs.
// A page comes from the transcript and not from the SDK's getSessionMessages(), which stops at
// the last compaction, and that can be nearly all of a long session.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readHistory, readImage } from './transcript.mjs';

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

async function* noMessages() {
  await new Promise(() => {});
}

// What Claude Code offers in a folder, from a session that's never given anything to do. Hooks
// are off for it, so that it doesn't look like a session to the helper, or to anything else, and
// no MCP server gets started for the moment it lasts.
async function capabilities({ sdk, cwd, claude }) {
  const { query } = await sdkAt(sdk);
  const session = query({
    prompt: noMessages(),
    options: {
      cwd, pathToClaudeCodeExecutable: claude, persistSession: false, strictMcpConfig: true,
      settingSources: ['user', 'project', 'local'], settings: { disableAllHooks: true },
    },
  });
  try {
    const { commands, models } = await session.initializationResult();
    return { commands, models };
  } finally {
    session.close();
  }
}

// The limits Claude Code's /usage shows, which has some a status line isn't told, such as a week's
// use of one model. From a session that's never given anything to do, as `capabilities` is. The SDK
// calls this experimental, so it's asked only where it's there, and a helper is released with the
// version of the SDK it was tried with.
async function usage({ sdk, claude }) {
  const { query } = await sdkAt(sdk);
  const session = query({
    prompt: noMessages(),
    options: {
      cwd: os.homedir(), pathToClaudeCodeExecutable: claude, persistSession: false, strictMcpConfig: true,
      settingSources: ['user'], settings: { disableAllHooks: true },
    },
  });
  try {
    await session.initializationResult();
    const read = session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof read !== 'function') return { limits: null };
    return { limits: (await read.call(session, { skipBehaviors: true }))?.rate_limits ?? null };
  } finally {
    session.close();
  }
}

const operations = {
  list: async ({ sdk, limit, offset }) => ({ sessions: await (await sdkAt(sdk)).listSessions({ limit, offset }) }),
  info: async ({ sdk, sessionId }) => ({ session: await (await sdkAt(sdk)).getSessionInfo(sessionId) }),
  history: ({ sessionId, limit, before }) => readHistory(findTranscript(sessionId), { limit, before }),
  image: ({ sessionId, id }) => readImage(findTranscript(sessionId), id) ?? {},
  delete: async ({ sdk, sessionId }) => {
    findTranscript(sessionId);
    await (await sdkAt(sdk)).deleteSession(sessionId);
    return {};
  },
  capabilities,
  usage,
};

let reply;
try {
  const request = JSON.parse(process.argv[2]);
  reply = await operations[request.op](request);
} catch (error) {
  reply = { error: { code: error.code ?? 'internal', message: error.message } };
}
// An exit of its own, because a session that has closed can still hold the event loop open.
process.stdout.write(JSON.stringify(reply), () => process.exit(0));
