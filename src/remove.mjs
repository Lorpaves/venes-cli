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

async function stop(running, isListed, { kill, limit, check }) {
  // A supervisor runs these, and `claude rm` has its own rules about their worktrees.
  if (running.kind === 'background' || !running.pid) throw new HelperError('background_session', 'Delete a background session with claude rm.');
  kill(running.pid);
  const end = Date.now() + limit;
  while (await isListed()) {
    if (Date.now() >= end) throw new HelperError('session_running', 'This session wouldn\'t stop, so it hasn\'t been deleted.');
    await pause(check);
  }
}

export async function removeSession({ store, library, kill = signal, limit = STOP_LIMIT_MS, check = CHECK_MS }, sessionId) {
  const isListed = async () => (await library.running()).find(session => session.id === sessionId);
  const running = await isListed();
  if (running) await stop(running, isListed, { kill, limit, check });
  try {
    await library.delete(sessionId);
  } catch (error) {
    // One that never got as far as a transcript still has a row to go.
    if (error.code !== 'unknown_session' || !store.find(sessionId)) throw error;
  }
  store.forget(sessionId);
}
