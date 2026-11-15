// What Codex's own terminal shows, read off the screen, for the one thing it asks that its server
// doesn't: what to do with a plan (0.169.0). The terminal is another client of the thread, and asks
// by itself once a turn ends on a plan:
//
//   Implement this plan?
// › 1. Yes, implement this plan          Switch to Default and start coding
//   2. Yes, clear context and implement  Start a fresh thread (current context: 5% used)
//   3. No, stay in Plan mode             Continue planning with the model
//   enter select · esc back
//
// It goes on asking whatever another client does with the plan, until one of its rows is picked.

const QUESTION = /^\s*Implement this plan\?\s*$/;
const ROW = /^\s*(›\s*)?(\d+)\.\s+(\S.*?)\s*$/;
const FOOTER = /^\s*enter select\b/;
// The row that puts the question away and changes nothing, in the terminal's words.
const STAY = /^No, stay in Plan mode\b/;
// As far up as the question can be from the foot of the screen.
const SEARCH_LINES = 12;

// The question about a plan, when it's what the foot of the screen shows: its rows, each with its
// number and its words, and the number of the one that leaves things as they are.
export function readPlanQuestion(screen) {
  const lines = `${screen ?? ''}`.trimEnd().split('\n').slice(-SEARCH_LINES);
  const asked = lines.findLastIndex(line => QUESTION.test(line));
  if (asked < 0) return undefined;
  const below = lines.slice(asked + 1).filter(line => line.trim());
  // Nothing under it but its rows and the line that says how to pick one.
  if (!below.length || !FOOTER.test(below.at(-1))) return undefined;
  const rows = below.slice(0, -1).map(line => ROW.exec(line)).map(found => found && { number: Number(found[2]), label: found[3], marked: Boolean(found[1]) });
  if (!rows.length || rows.some(row => !row)) return undefined;
  const stay = rows.find(row => STAY.test(row.label));
  return { rows, ...(stay && { stay: stay.number }) };
}
