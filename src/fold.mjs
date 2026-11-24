// A long stretch of work is told as how many calls it was. A turn of hundreds of calls is hundreds of
// kilobytes even with each call cut down (see `light.mjs`), and nobody reads them all on a phone, far
// from home least of all. So a client that asks with `foldOver` gets, for each stretch of more calls
// than that, one `fold` in place of them: each call by its id, its name, whether it failed and the file
// it was about, which is what a row that counts them is made from. The words between the calls go with
// them, and the last words stay. `unfold` gives a stretch back whole, by the id of its first call.
//
// A client that shows what the session said between calls asks with `foldRuns` as well (0.43.0): what was
// said stays where it was, and each run of calls between two things said is a fold of its own, which
// `unfold` with `foldRuns` gives back alone. The user asked for the words in the conversation, having found
// them inside a fold (2026-11-24): 「如果是文字消息 不要折叠起来，要在会话消息里显示」.

// What a stretch of work is made of: what the session said, thought and did, with nothing between
// that a reader sees as its own thing (their message, a marker, what a line printed, the turn's end).
const WORK = new Set(['assistant', 'thinking', 'tool']);

// A call a page keeps whole inside a fold: a page the session published shows as a card of its own.
const isCard = item => item.page !== undefined;
const isOwnCall = item => item.role === 'tool' && !item.parentToolUseId;

// The file a call was about, where its input names one.
function fileOf(input) {
  const named = input?.file_path ?? input?.notebook_path ?? input?.path;
  return typeof named === 'string' ? named : undefined;
}

// What a Codex item says of itself that a row counts by: what each part of a command did and to what,
// and the files a change touched. Without them a command that only read files counts as a command, and
// a change as one file, and the row would say something else once it's opened.
function codexDetail(name, item) {
  if (item?.type !== name) return {};
  if (name === 'commandExecution' && Array.isArray(item.commandActions)) {
    return { commandActions: item.commandActions.map(({ type, path }) => ({ type, ...(path !== undefined && { path }) })) };
  }
  if (name === 'fileChange' && Array.isArray(item.changes)) {
    return { changes: item.changes.map(({ path, kind }) => ({ path, ...(kind !== undefined && { kind }) })) };
  }
  return {};
}

// `item` is a Codex call as it stood last, which is what a stored one's `input` is.
function bare({ toolUseId, name, isError, input, item = input }) {
  const file = fileOf(input);
  return { toolUseId, name, ...(isError && { isError: true }), ...(file !== undefined && { file }), ...codexDetail(name, item) };
}

// `items` cut into stretches of work and what stands between them, in order.
function stretches(items) {
  const parts = [];
  for (const item of items) {
    const isWork = WORK.has(item.role);
    const last = parts.at(-1);
    if (last && last.isWork === isWork && isWork) last.items.push(item);
    else parts.push({ isWork, items: [item] });
  }
  return parts;
}

function foldedWhole(run, over) {
  const calls = run.filter(item => isOwnCall(item) && !isCard(item));
  if (calls.length <= over) return run;
  const lastCall = run.findLastIndex(item => item.role === 'tool');
  const cards = run.slice(0, lastCall + 1).filter(item => isOwnCall(item) && isCard(item));
  const lastWords = run.slice(lastCall + 1).filter(item => item.role === 'assistant');
  return [{ role: 'fold', at: run[0].at, key: calls[0].toolUseId, calls: calls.map(bare) }, ...cards, ...lastWords];
}

// A stretch's words, each on its own, and the runs of everything else between them, in order.
function pieces(items) {
  const parts = [];
  for (const item of items) {
    if (item.role === 'assistant') parts.push({ words: item });
    else if (parts.at(-1)?.run) parts.at(-1).run.push(item);
    else parts.push({ run: [item] });
  }
  return parts;
}

// With `foldRuns`: a stretch with more calls than `over` keeps its words where they were, and each run of
// calls between them is a fold, with the pages the session published in it after the fold. A run with no
// call of its own, such as thinking between two things said, has nothing to fold and stays as it was.
function foldedRuns(stretch, over) {
  const calls = stretch.filter(item => isOwnCall(item) && !isCard(item));
  if (calls.length <= over) return stretch;
  return pieces(stretch).flatMap(({ words, run }) => {
    if (words) return [words];
    const own = run.filter(item => isOwnCall(item) && !isCard(item));
    if (!own.length) return run;
    const cards = run.filter(item => isOwnCall(item) && isCard(item));
    return [{ role: 'fold', at: run[0].at, key: own[0].toolUseId, calls: own.map(bare) }, ...cards];
  });
}

// A page's items with each stretch of more than `over` calls folded, by runs for a client that asks.
export function foldedItems(items, over, runs = false) {
  const folded = runs ? foldedRuns : foldedWhole;
  return stretches(items).flatMap(part => (part.isWork ? folded(part.items, over) : part.items));
}

// The stretch that has the call `key`, whole, or undefined when there's none. With `runs`, the run of calls
// in it that has the call, with what was thought among them, and without what was said around it.
export function stretchOf(items, key, runs = false) {
  const has = part => part.some(item => item.role === 'tool' && item.toolUseId === key);
  const stretch = stretches(items).find(part => part.isWork && has(part.items))?.items;
  if (!runs) return stretch;
  return stretch && pieces(stretch).find(({ run }) => run && has(run))?.run;
}

// What ends a stretch among a turn's events, as a page of history ends one: a message of the reader's
// (one sent during a turn too), what a line printed, a compaction, and a turn's end. The events of a
// turn can hold several: a turn that ended a moment ago is still there when the next has begun.
const CUTS = new Set(['message.user', 'message.output', 'compact.end', 'turn.end', 'turn.interrupted', 'turn.error']);

// One stretch of a turn's events with its calls that are over folded, when there are more than `over`.
// Everything up to the last of those to end goes into the fold: the calls, what their subagents did,
// the pictures they showed, and what was said and thought between them. What says how the session
// stands stays where it was, as does a call still going or one that ends in a later stretch, a message
// still being written, and a page the session published. After the fold the events are as they were.
//
// With `runs`, each run of those calls between the messages finished by then is a fold of its own where
// the first of the run was, and the messages stay where they were: see `foldedRuns`. A run with no call of
// its own that ended in it keeps what was thought in it.
function foldedStretch(events, over, runs = false) {
  const isOwn = event => !event.agentId && !event.parentToolUseId;
  const place = new Map(events.map((event, index) => [event, index]));
  const started = new Map(events.filter(event => event.kind === 'tool.start').map(event => [event.toolUseId, event]));
  const isPublished = event => event.name === 'Artifact';
  const ended = events.filter(event => event.kind === 'tool.end' && started.has(event.toolUseId) && !event.interrupted && !isPublished(event));
  const own = ended.filter(event => isOwn(started.get(event.toolUseId)));
  if (own.length <= over) return events;
  const last = place.get(own.at(-1));
  const gone = new Set(ended.filter(event => place.get(event) <= last).map(event => event.toolUseId));
  // A message is over once its last piece has come.
  const written = new Set(events.slice(0, last + 1).filter(event => event.kind === 'message.assistant.delta' && event.final).map(event => event.messageId));
  if (runs) return foldedRunsOf(events, { own, last, gone, written, started });
  const goes = event => {
    switch (event.kind) {
      case 'tool.start': case 'tool.end': case 'tool.images': return gone.has(event.toolUseId);
      case 'message.thinking': return true;
      case 'message.assistant.delta': return written.has(event.messageId);
      default: return false;
    }
  };
  const first = events.findIndex((event, index) => index <= last && goes(event));
  const calls = own.map(event => {
    const { name, input } = started.get(event.toolUseId);
    return bare({ toolUseId: event.toolUseId, name, isError: event.isError, input, item: event.response });
  });
  const { seq, at, sessionId } = events[first];
  const fold = { seq, at, sessionId, kind: 'turn.fold', key: calls[0].toolUseId, calls };
  return [...events.slice(0, first), fold, ...events.slice(first, last + 1).filter(event => !goes(event)), ...events.slice(last + 1)];
}

// A stretch's events up to its last call that's over, each run of calls between what was said a fold, and
// what was said where it was: see `foldedStretch`.
function foldedRunsOf(events, { own, last, gone, written, started }) {
  const isWords = event => event.kind === 'message.assistant.delta' && written.has(event.messageId);
  const goes = event => {
    switch (event.kind) {
      case 'tool.start': case 'tool.end': case 'tool.images': return gone.has(event.toolUseId);
      case 'message.thinking': return true;
      default: return false;
    }
  };
  const ownEnds = new Set(own);
  const out = [];
  let run;
  // A run goes where its first event was: its calls as a fold, or, with none, what was thought in it.
  const close = () => {
    if (!run) return;
    const calls = run.events.filter(event => ownEnds.has(event)).map(event => {
      const { name, input } = started.get(event.toolUseId);
      return bare({ toolUseId: event.toolUseId, name, isError: event.isError, input, item: event.response });
    });
    const { seq, at, sessionId } = run.events[0];
    const told = calls.length ? [{ seq, at, sessionId, kind: 'turn.fold', key: calls[0].toolUseId, calls }] : run.events.filter(event => event.kind === 'message.thinking');
    out.splice(run.place, 0, ...told);
    run = undefined;
  };
  for (const event of events.slice(0, last + 1)) {
    if (isWords(event)) {
      close();
      out.push(event);
    } else if (goes(event)) {
      run ??= { place: out.length, events: [] };
      run.events.push(event);
    } else out.push(event);
  }
  close();
  return [...out, ...events.slice(last + 1)];
}

// The events of a turn going on, each of its stretches folded on its own, by runs for a client that asks.
export function foldedTurn(events, over, runs = false) {
  const out = [];
  let stretch = [];
  for (const event of events) {
    if (CUTS.has(event.kind)) {
      out.push(...foldedStretch(stretch, over, runs), event);
      stretch = [];
    } else stretch.push(event);
  }
  return [...out, ...foldedStretch(stretch, over, runs)];
}

// What a client asked a page to be folded over, when it asked: a whole number of calls, none or more.
export function foldOverOf(msg) {
  return Number.isInteger(msg?.foldOver) && msg.foldOver >= 0 ? msg.foldOver : undefined;
}

// Whether a client shows what was said between calls, and has each run of calls between folded on its own.
export function foldRunsOf(msg) {
  return msg?.foldRuns === true;
}

// A page as a client that asked for folds gets it.
export function foldedPage(page, over, runs = false) {
  if (over === undefined || !page) return page;
  return {
    ...page,
    ...(Array.isArray(page.items) && { items: foldedItems(page.items, over, runs) }),
    ...(Array.isArray(page.turn) && { turn: foldedTurn(page.turn, over, runs) }),
  };
}