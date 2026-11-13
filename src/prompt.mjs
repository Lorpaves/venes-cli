// The prompt Claude Code's terminal shows when a tool needs approval, read off the screen, and
// choosing one of its rows there. Past Yes and before No, its rows depend on the tool, the mode and
// the account, like switching to auto mode, and a hook isn't told them, so the screen is the only
// place to learn them. A row is chosen by pressing its number, as a person at the Mac would, so
// Claude Code does all it does for that row.

import { HelperError } from './sessions.mjs';
import { pause, pressKey, readScreen } from './terminal.mjs';

const ROW = /^\s*(❯\s*)?(\d+)\.\s+(\S.*?)\s*$/;
const QUESTION = /^\s*Do you want to .*\?\s*$/;
const FOOTER = /^\s*Esc to \w+/;
// The rule across the screen that a prompt opens under.
const EDGE = /^\s*─{20,}\s*$/;
// A prompt fits in this, with room for a long command and rows that wrap.
const SEARCH_LINES = 80;
// What follows " · " is a note on the row, and a key in brackets is the terminal keyboard's.
const NOTE = /\s+·\s.*$/;
const KEY_HINT = /\s*\((?:shift\+tab|tab|esc|enter|ctrl\+\w+|alt\+\w+|meta\+\w+)\)$/i;
// The box a Bash command is drawn in.
const FRAME = /[│╌─\s]/g;
const PRESS_LIMIT_MS = 3000;
const PRESS_CHECK_MS = 50;
// A plain row is chosen as its number is pressed. One that's still there and marked after this is an
// input, which Enter chooses.
const INPUT_SETTLE_MS = 500;

const labelOf = text => text.replace(NOTE, '').replace(KEY_HINT, '').replace(/\s+/g, ' ').trim();

// The prompt open at the bottom of the screen, or undefined when there's none: its `question`, what
// it's `about` as drawn above that, and its `rows`, each with its `number`, `label`, and whether it's
// `marked`. Rows that wrap are joined.
export function readPrompt(screen) {
  const lines = screen.trimEnd().split('\n').slice(-SEARCH_LINES);
  let end = lines.length - 1;
  const skipBlank = () => { while (end >= 0 && !lines[end].trim()) end -= 1; };
  skipBlank();
  if (end >= 0 && FOOTER.test(lines[end])) {
    end -= 1;
    skipBlank();
  }
  let start = end;
  while (start >= 0 && lines[start].trim() && !QUESTION.test(lines[start])) start -= 1;
  if (start < 0 || !QUESTION.test(lines[start])) return undefined;
  const rows = [];
  for (const line of lines.slice(start + 1, end + 1)) {
    const match = line.match(ROW);
    if (match && Number(match[2]) === rows.length + 1) {
      rows.push({ number: Number(match[2]), text: match[3], marked: Boolean(match[1]) });
    } else if (rows.length) {
      rows.at(-1).text += ` ${line.trim()}`;
    } else {
      return undefined;
    }
  }
  if (rows.length < 2) return undefined;
  const edge = lines.slice(0, start).findLastIndex(line => EDGE.test(line));
  return {
    question: lines[start].trim(),
    about: lines.slice(edge + 1, start).join('\n').trimEnd(),
    rows: rows.map(({ number, text, marked }) => ({ number, label: labelOf(text), marked })),
  };
}

// The rows past the first, which allows the call once, and before the last, which refuses it. A
// prompt of another shape isn't one to offer rows from.
export function choicesOf(prompt) {
  const { rows } = prompt ?? {};
  if (!rows || !/^Yes\b/.test(rows[0].label) || !/^No\b/.test(rows.at(-1).label)) return [];
  return rows.slice(1, -1).map(({ number, label }) => ({ number, label }));
}

// Whether the prompt is about this request, by what the terminal draws of its input. Commands wrap
// and are drawn in a box, so only what's left without spaces and lines is compared.
export function isAbout(prompt, input = {}) {
  const drawn = prompt.about.replace(FRAME, '');
  const shown = text => drawn.includes(text.replace(FRAME, '').slice(0, 40));
  if (typeof input.command === 'string' && input.command.trim()) return shown(input.command.trim().split('\n')[0]);
  if (typeof input.file_path === 'string' && input.file_path) return shown(input.file_path.split('/').pop());
  if (typeof input.url === 'string' && input.url) {
    try {
      return shown(new URL(input.url).hostname);
    } catch {
      return true;
    }
  }
  return true;
}

const isSamePrompt = (a, b) => Boolean(a && b) && a.question === b.question && a.about === b.about
  && a.rows.length === b.rows.length && a.rows.every((row, i) => row.label === b.rows[i].label);

const promptChanged = () => new HelperError('prompt_changed', 'The terminal isn\'t showing that choice any more.');

// Presses the row with this number and label on the prompt the terminal shows, and waits for the
// prompt to go.
export async function chooseRow(session, { number, label }, {
  read = readScreen, press = pressKey, limit = PRESS_LIMIT_MS, inputSettle = INPUT_SETTLE_MS,
} = {}) {
  const before = readPrompt(await read(session));
  if (!before?.rows.some(row => row.number === number && row.label === label)) throw promptChanged();
  await press(session, String(number));
  const pressedAt = Date.now();
  let entered = false;
  for (;;) {
    await pause(PRESS_CHECK_MS);
    const now = readPrompt(await read(session));
    if (!isSamePrompt(before, now)) return;
    const waited = Date.now() - pressedAt;
    if (!entered && waited >= inputSettle && now.rows.find(row => row.marked)?.number === number) {
      entered = true;
      await press(session, 'Enter');
    }
    if (waited >= limit) throw promptChanged();
  }
}
