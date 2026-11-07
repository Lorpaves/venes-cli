// Changing the model and effort of a session, for that session alone. One that's running changes
// through its model picker, and one that isn't keeps the choice for when it's resumed.

import { HelperError, notTypable } from './sessions.mjs';

// Passed on a command line, so there's no room for anything else.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]*$/;
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Runs work for each id in the order it was asked for. Two things typed into a session at once
// would land in each other, and a message's Enter in an open picker would save a default.
export function oneAtATime() {
  const last = new Map();
  return (id, work) => {
    const turn = (last.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    last.set(id, turn);
    return turn;
  };
}

// A change typed as a message. What else can follow /effort, like `status`, isn't one.
export function readSwitch(text) {
  const [, command, value] = text.match(/^\s*\/(model|effort)\s+(\S+)\s*$/) ?? [];
  if (command === 'model') return { model: value };
  return command === 'effort' && EFFORT_LEVELS.has(value) ? { effort: value } : undefined;
}

// Its picker row, whose number is where it comes in the list. `default` can resolve to the same
// model as a row of its own, so a name that's a value goes first.
function rowFor(models, model) {
  const index = [option => option.value === model, option => option.resolvedModel === model].map(matches => models.findIndex(matches)).find(found => found >= 0);
  if (index === undefined) throw new HelperError('bad_model', `Not a model on offer here: ${model}`);
  return { label: models[index].displayName, number: index + 1 };
}

export async function configureSession({ store, library, sessionWithPane, switchTo, chosenForResume }, { sessionId, model, effort }) {
  if (model !== undefined && !MODEL_NAME.test(model)) throw new HelperError('bad_model', `Not a model: ${model}`);
  if (effort !== undefined && !EFFORT_LEVELS.has(effort)) throw new HelperError('bad_effort', `Not an effort level: ${effort}`);
  const known = store.find(sessionId);
  if (!known || known.status === 'ended') {
    const running = await library.running();
    if (running.some(session => session.id === sessionId)) throw notTypable();
    chosenForResume.set(sessionId, { ...chosenForResume.get(sessionId), ...(model && { model }), ...(effort && { effort }) });
    return {};
  }
  const session = sessionWithPane(sessionId);
  const { models } = await library.capabilities(session.cwd);
  await switchTo(session, { row: model && rowFor(models, model), effort });
  return {};
}
