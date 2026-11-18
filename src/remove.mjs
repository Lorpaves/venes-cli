// Deleting a session from this Mac for good, through the Agent SDK. One that's running ends first,
// or it would write its transcript straight back.

import { HelperError } from './sessions.mjs';

// It had gone within 150ms when measured, its SessionEnd hook included.
const STOP_LIMIT_MS = 5000;
const CHECK_MS = 100;

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function signal(pid) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error; // it has just gone by itself
  }
}

// Ends a session's Claude Code, as SIGTERM asks it to, and waits for it to go. False when it wasn't
// running. `said` is what's told when it can't be stopped: one a supervisor runs, or one that won't go.
export async function stopSession({ library, kill = signal, limit = STOP_LIMIT_MS, check = CHECK_MS }, sessionId, said = {}) {
  const {
    background = 'Delete a background session with claude rm.',
    wouldnt = 'This session wouldn\'t stop, so it hasn\'t been deleted.',
  } = said;
  const isListed = async () => (await library.running()).find(session => session.id === sessionId);
  const running = await isListed();
  if (!running) return false;
  // A supervisor runs these, and `claude rm` has its own rules about their worktrees.
  if (running.kind === 'background' || !running.pid) throw new HelperError('background_session', background);
  kill(running.pid);
  const end = Date.now() + limit;
  while (await isListed()) {
    if (Date.now() >= end) throw new HelperError('session_running', wouldnt);
    await pause(check);
  }
  return true;
}

export async function removeSession({ store, library, kill = signal, limit = STOP_LIMIT_MS, check = CHECK_MS }, sessionId) {
  await stopSession({ library, kill, limit, check }, sessionId);
  try {
    await library.delete(sessionId);
  } catch (error) {
    // One that never got as far as a transcript still has a row to go.
    if (error.code !== 'unknown_session' || !store.find(sessionId)) throw error;
  }
  store.forget(sessionId);
}
