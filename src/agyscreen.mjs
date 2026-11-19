// What Antigravity's terminal shows, read off the screen: the bar under everything, the prompt it
// asks to do something with, and the question it asks about a folder it doesn't trust yet. Its hooks
// say nothing of any of these, so the screen is the only place to learn them (1.5.8).

// What the bar says of each mode. Asking each time has no name there, and is `default`.
const MODES = { auto: 'auto', plan: 'plan', 'accept-edits': 'acceptEdits' };
// The modes Shift+Tab goes round, in its order.
export const MODE_IDS = ['default', 'acceptEdits', 'auto', 'plan'];
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const IDLE_HINT = /^\?\s+for shortcuts\b/;
const BUSY_HINT = /^esc to cancel\b/;
// The line under a list of choices, which says how to move in it. A page a command opens, as /model's
// list is, has "Keyboard:" before it.
const NAVIGATE = /^\s*(?:Keyboard:\s*)?↑\/↓\s+Navigate\b/;
const ROW = /^\s*(>\s*)?(\d+)\.\s+(\S.*?)\s*$/;
// The rule across the screen that a prompt opens under.
const EDGE = /^\s*─{20,}\s*$/;
// As many lines as a prompt fits in, with room for a long change and rows that wrap.
const SEARCH_LINES = 80;
// It writes one of these while it works, and what it's doing after it.
const SPINNER = /^\s*[⣾⣽⣻⢿⡿⣟⣯⣷]\s+\S/m;
const TRUST_QUESTION = /Do you trust the contents of this project\?/;
// The model's own question to the reader: "Question 1/2: Which colour?", then its rows, the last of which
// opens a line to write on, "Your answer:".
const QUESTION = /^Question (\d+)\/(\d+):\s*(\S.*)$/;
const QUESTION_LINES = 6;
const WRITE_IN = /^Write-in\b/;
const WRITE_IN_OPEN = /^\s*Your answer:/m;
const TRUST_PICKED = /^\s*>\s*Yes, I trust this folder/m;

// The lines it greets with (1.5.12): its name and version, and under them the account with its plan
// in brackets, "name@example.com (Google AI Pro)".
const GREETING = /\bAntigravity CLI \d+\.\d+/;
const ACCOUNT = /\S+@\S+\.\S+[ \t]+\(([^()]{1,40})\)[ \t]*$/;

const linesOf = screen => {
  const lines = screen.trimEnd().split('\n');
  return lines.slice(-SEARCH_LINES);
};

// The plan the account is on, which Antigravity says in one place only: beside the account, on the lines
// it greets with. Its `/usage` lists the limits and not the plan they're for. Nothing once the greeting
// has gone off the screen, or where the line under it isn't an account's.
export function readPlan(screen) {
  const lines = `${screen ?? ''}`.split('\n');
  const at = lines.findIndex(line => GREETING.test(line));
  return (at < 0 ? undefined : ACCOUNT.exec(lines[at + 1] ?? '')?.[1].trim()) || undefined;
}

// The bar at the foot of the screen: whether it's waiting for a message (`idle`), working or asking
// (`busy`), or neither says so, as while something's typed in its box. Then the mode, the model as
// it's shown, and how hard it thinks. Nothing, when the last line isn't the bar.
export function readBar(screen) {
  const line = linesOf(screen).at(-1) ?? '';
  const parts = line.trim().split(/\s{2,}/);
  const settings = parts.at(-1).split(' · ').map(part => part.trim());
  const left = parts.length > 1 ? parts[0] : '';
  const hint = IDLE_HINT.test(left) ? 'idle' : BUSY_HINT.test(left) ? 'busy' : undefined;
  // One part is a hint by itself, as on a screen too narrow for both.
  if (parts.length === 1 && (IDLE_HINT.test(parts[0]) || BUSY_HINT.test(parts[0]))) return undefined;
  const effort = EFFORTS.has(settings.at(-1)) ? settings.pop() : undefined;
  const model = settings.pop();
  if (!model || settings.length > 1 || (settings.length === 1 && !Object.hasOwn(MODES, settings[0]))) return undefined;
  if (!effort && !hint) return undefined;
  return { hint, mode: settings.length ? MODES[settings[0]] : 'default', model, effort };
}

// The prompt open above the bar, or nothing: its `question`, what it's `about` as drawn above that,
// and its `rows`, each with its `number`, `label` and whether it's `marked`. It's drawn with lines
// left empty between its parts, which are passed over.
export function readPrompt(screen) {
  const lines = linesOf(screen);
  let at = lines.length - 1;
  if (!BUSY_HINT.test((lines[at] ?? '').trim())) return undefined;
  const up = () => {
    at -= 1;
    while (at >= 0 && !lines[at].trim()) at -= 1;
  };
  up();
  if (at >= 0 && NAVIGATE.test(lines[at])) up();
  // Up from the last row to the first. A line that isn't a row goes on from the row above it.
  const rows = [];
  let tail = [];
  for (; at >= 0; up()) {
    const match = lines[at].match(ROW);
    if (!match) {
      tail.unshift(lines[at].trim());
      if (tail.length > 3) return undefined;
      continue;
    }
    rows.unshift({ number: Number(match[2]), label: [match[3], ...tail].join(' ').replace(/\s+/g, ' '), marked: Boolean(match[1]) });
    tail = [];
    if (Number(match[2]) === 1) break;
  }
  if (at < 1 || rows.length < 2 || rows.some((row, index) => row.number !== index + 1)) return undefined;
  up();
  if (at < 0) return undefined;
  let question = lines[at].trim();
  // What the model asks the reader is headed by which question it is of how many, needs no question
  // mark, and can run over a line or two.
  let head = at;
  for (let back = 0; back < QUESTION_LINES && head >= 0 && !QUESTION.test(lines[head].trim()) && !EDGE.test(lines[head]); back++) head -= 1;
  if (head >= 0 && QUESTION.test(lines[head].trim())) {
    question = lines.slice(head, at + 1).map(line => line.trim()).filter(Boolean).join(' ');
    at = head;
  } else if (!question.endsWith('?')) {
    return undefined;
  }
  const edge = lines.slice(0, at).findLastIndex(line => EDGE.test(line));
  const about = lines.slice(edge + 1, at).map(line => line.trimEnd()).filter(line => line.trim()).join('\n').trim();
  return { question, about, rows };
}

// A prompt that is the model's question to the reader, and not one that asks whether something may be
// done: what it asks, which it is of how many, the rows to choose from, and the row that opens a line to
// write an answer of one's own on, where there is one. Nothing for any other prompt.
export function questionOf(prompt) {
  const found = QUESTION.exec(prompt?.question ?? '');
  if (!found) return undefined;
  const writeIn = prompt.rows.find(row => WRITE_IN.test(row.label));
  return { text: found[3].trim(), index: Number(found[1]), count: Number(found[2]), rows: prompt.rows.filter(row => row !== writeIn), writeIn };
}

// Whether the line to write an answer on is open, under the row that opens it.
export function asksWriteIn(screen) {
  return WRITE_IN_OPEN.test(linesOf(screen).slice(-8).join('\n'));
}

// Whether something is open that Enter would answer: a prompt, a list such as its commands, or the
// question about a folder.
export function showsDialog(screen) {
  const lines = linesOf(screen);
  let end = lines.length - 2;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  return Boolean(readPrompt(screen)) || (end >= 0 && NAVIGATE.test(lines[end])) || TRUST_QUESTION.test(lines.slice(-20).join('\n'));
}

// Whether a page is open that a command of the terminal's own opened, as /model's list of models is, or
// the list of commands that opens as one is typed: a list to move in, with a line under it that says
// how. Not a prompt that asks whether something may be done, and not the question about a folder.
export function showsPage(screen) {
  if (readPrompt(screen) || TRUST_QUESTION.test(linesOf(screen).slice(-20).join('\n'))) return false;
  const lines = linesOf(screen);
  let end = lines.length - 2;
  while (end >= 0 && !lines[end].trim()) end -= 1;
  return end >= 0 && NAVIGATE.test(lines[end]);
}

// Whether it's waiting for a message, with nothing going and nothing open.
export function isIdle(screen) {
  return readBar(screen)?.hint === 'idle' && !SPINNER.test(linesOf(screen).slice(-8).join('\n'));
}

// Whether Antigravity is what the screen shows at all.
export function isUp(screen) {
  return Boolean(readBar(screen)) || showsDialog(screen);
}

// A document Antigravity wrote for the reader to look over first, as the plan it writes in plan mode is,
// waits behind a line over the box, "1 artifact · /artifact to review", and is answered in the panel
// that command opens: "Action required (1 left)", a row for each, and its keys, "y/n Approve/reject".
const REVIEW_HINT = /(\d+) artifacts? · \/artifact to review/;
const REVIEW_PANEL = /Action required \((\d+) left\)/;
const REVIEW_KEYS = /\by\/n Approve\/reject\b/;
export const REVIEW_COMMAND = '/artifact';
export const REVIEW_YES = 'y';
export const REVIEW_NO = 'n';

// The line is a few up from the bar: over the box, and the rules either side of it.
const REVIEW_HINT_LINES = 12;

// How many documents wait to be looked over, by the line that says so.
export function reviewsWaiting(screen) {
  const found = REVIEW_HINT.exec(linesOf(`${screen ?? ''}`).slice(-REVIEW_HINT_LINES).join('\n'));
  return found ? Number(found[1]) : 0;
}

// The panel the documents are answered in, when it's open: how many are left to answer.
export function readReview(screen) {
  const shown = linesOf(`${screen ?? ''}`).join('\n');
  const found = REVIEW_PANEL.exec(shown);
  return found && REVIEW_KEYS.test(shown) ? { left: Number(found[1]) } : undefined;
}

// What's in the box a message is typed in: the lines between the last two rules, without the mark the
// first begins with. Nothing at all when there's no box to read.
const BOX_MARK = /^>(\s|$)/;
export function boxOf(screen) {
  const lines = linesOf(`${screen ?? ''}`);
  const [top, bottom] = lines.flatMap((line, index) => (EDGE.test(line) ? [index] : [])).slice(-2);
  if (bottom === undefined || bottom - top < 2 || !BOX_MARK.test(lines[top + 1])) return undefined;
  return [lines[top + 1].slice(1), ...lines.slice(top + 2, bottom)].map(line => line.trim()).join('\n').trim();
}

// Whether something's typed there. An empty box can show a line of its own, about the mode it's in,
// which reads like one that's typed: but the bar says how to see the shortcuts only while nothing is.
export function hasTyped(screen) {
  const bar = readBar(screen);
  return Boolean(bar) && bar.hint === undefined && !readReview(screen) && Boolean(boxOf(screen));
}

export const asksTrust = screen => TRUST_QUESTION.test(screen);
export const hasTrustPicked = screen => TRUST_PICKED.test(screen);
