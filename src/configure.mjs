// Changing the model and effort of a session. One that's running is told the way a person
// would tell it, and one that isn't keeps the choice for when it's resumed.

import { HelperError } from './sessions.mjs';

// Typed into a terminal and passed on a command line, so there's no room for anything else.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'auto']);

export async function configureSession({ store, library, sessionWithPane, tell, chosenForResume }, { sessionId, model, effort }) {
  if (model !== undefined && !MODEL_NAME.test(model)) throw new HelperError('bad_model', `Not a model: ${model}`);
  if (effort !== undefined && !EFFORT_LEVELS.has(effort)) throw new HelperError('bad_effort', `Not an effort level: ${effort}`);
  const known = store.find(sessionId);
  if (!known || known.status === 'ended') {
    const running = await library.running();
    if (running.some(session => session.id === sessionId)) throw new HelperError('no_pane', 'This session is running outside tmux.');
    chosenForResume.set(sessionId, { ...chosenForResume.get(sessionId), ...(model && { model }), ...(effort && { effort }) });
    return {};
  }
  const session = sessionWithPane(sessionId);
  if (model) {
    store.expectModelSwitch(session);
    await tell(session, `/model ${model}`);
  }
  if (effort) await tell(session, `/effort ${effort}`);
  return {};
}
