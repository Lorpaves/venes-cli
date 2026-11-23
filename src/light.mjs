// What a page is told of a tool's call is cut down to what a phone can take in. Claude Code hands a hook
// all a tool returned: a file read is all of the file, an edit comes with the file as it was, and a tool
// that showed a picture has its bytes, twice over in Code Mode. Events go to every client, sit in the log
// and come again with the turn a page opens on, and far from home a megabyte is most of a minute. So a
// call's input and what it returned keep their shape, lose what no page shows, and are cut where they
// run long. What a picture was is asked for by its id, and what was cut ends in an ellipsis.

// The most of any one string, in characters: about what Claude Code lets Claude see of a command's output.
export const TEXT_LIMIT = 32 * 1024;
// The most of a whole input or result, in characters, its keys counted.
export const CALL_BUDGET = 96 * 1024;
const CUT = '\u2026';
// What a value that isn't a string counts as.
const SCALAR = 8;

const PICTURE_URL = /^data:image\/[^;,]+;base64,/;
// A file as it was before an edit, which comes with every edit of it. A page shows the patch.
const UNSHOWN = new Set(['originalFile']);

// Whether `key` of `holder` is a picture's bytes: `base64` beside its kind, or `data` in something that
// says it's base64 or names a media type.
function isPictureBytes(holder, key, value) {
  if (typeof value !== 'string') return false;
  if (key === 'base64') return true;
  if (key !== 'data') return false;
  return holder.type === 'base64' || holder.type === 'image'
    || [holder.media_type, holder.mediaType, holder.mimeType].some(kind => typeof kind === 'string');
}

function cut(text, room) {
  if (text.length <= room) return text;
  let end = Math.max(room, 0);
  // Not between the two halves of a character.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end) + CUT;
}

// `value` with no picture's bytes, no string past `limit` and no more than `budget` in all. An array
// ends where the budget does.
export function lightened(value, { limit = TEXT_LIMIT, budget = CALL_BUDGET } = {}) {
  let left = budget;
  const walk = part => {
    if (typeof part === 'string') {
      if (PICTURE_URL.test(part)) return undefined;
      const kept = cut(part, Math.min(limit, left));
      left -= kept.length;
      return kept;
    }
    if (Array.isArray(part)) {
      const kept = [];
      for (const entry of part) {
        if (left <= 0) break;
        kept.push(walk(entry));
      }
      return kept;
    }
    if (part && typeof part === 'object') {
      const kept = {};
      for (const [key, entry] of Object.entries(part)) {
        if (UNSHOWN.has(key) && typeof entry === 'string') continue;
        if (isPictureBytes(part, key, entry)) continue;
        left -= key.length;
        kept[key] = walk(entry);
      }
      return kept;
    }
    left -= SCALAR;
    return part;
  };
  return walk(value);
}

// A stored call as a page is given it.
function lightItem(item) {
  if (item?.role !== 'tool') return item;
  return {
    ...item,
    ...(item.input !== undefined && { input: lightened(item.input) }),
    ...(item.result !== undefined && { result: lightened(item.result) }),
  };
}

// A page of a session's history, each call in it cut down as a live one is.
export function lightPage(page) {
  return Array.isArray(page?.items) ? { ...page, items: page.items.map(lightItem) } : page;
}

// The most a client is sent of what it missed, in bytes. Past it, it starts over from the sessions as
// they stand and opens its page again. It's small because the app gives a connection twenty seconds to
// say hello and send all of this, and far from home that's what a few kilobytes a second leave room for.
export const REPLAY_BYTES = 64 * 1024;

export function isWorthReplaying(events, limit = REPLAY_BYTES) {
  let bytes = 0;
  for (const event of events) {
    bytes += JSON.stringify(event).length;
    if (bytes > limit) return false;
  }
  return true;
}
