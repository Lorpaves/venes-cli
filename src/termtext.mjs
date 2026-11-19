// What a terminal emulator's screen says, as text a client can draw: lines with only the escape
// sequences that colour them. Each line stands by itself: it starts in the plain look and ends in it,
// so any run of lines can be cut out and shown.

const ESC = '\u001b';

function colour(base, bright, extended, isPalette, isRGB, value) {
  if (isPalette) {
    if (value < 8) return String(base + value);
    if (value < 16) return String(bright + value - 8);
    return `${extended};5;${value}`;
  }
  if (isRGB) return `${extended};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`;
  return undefined;
}

// The codes that give a cell its look, or an empty string for the plain one.
function lookOf(cell) {
  if (cell.isAttributeDefault()) return '';
  const codes = [];
  if (cell.isBold()) codes.push('1');
  if (cell.isDim()) codes.push('2');
  if (cell.isItalic()) codes.push('3');
  if (cell.isUnderline()) codes.push('4');
  if (cell.isInverse()) codes.push('7');
  if (cell.isInvisible()) codes.push('8');
  if (cell.isStrikethrough()) codes.push('9');
  const front = colour(30, 90, 38, cell.isFgPalette(), cell.isFgRGB(), cell.getFgColor());
  if (front) codes.push(front);
  const back = colour(40, 100, 48, cell.isBgPalette(), cell.isBgRGB(), cell.getBgColor());
  if (back) codes.push(back);
  return codes.join(';');
}

// Whether a cell shows anything: a character, or a space on a background or with its colours swapped.
function shows(cell) {
  const chars = cell.getChars();
  if (chars && chars !== ' ') return true;
  return !cell.isBgDefault() || Boolean(cell.isInverse());
}

// Whether anything was ever written to a cell, even a space.
const isWritten = cell => cell.getWidth() === 0 || cell.getChars() !== '' || !cell.isAttributeDefault();

// One row. Spaces at its end that show nothing go, unless the row runs on into the next (`whole`), where
// they're part of the line. `limit` stops it at a column.
export function rowText(line, columns, { whole = false, limit = columns, cell = undefined } = {}) {
  let end = Math.min(limit, columns, line.length);
  const keeps = whole ? isWritten : shows;
  while (end > 0 && !keeps(line.getCell(end - 1, cell))) end -= 1;
  let out = '';
  let look = '';
  for (let x = 0; x < end; x++) {
    const at = line.getCell(x, cell);
    // The second half of a wide character.
    if (at.getWidth() === 0) continue;
    const wanted = lookOf(at);
    if (wanted !== look) {
      out += wanted ? `${ESC}[0;${wanted}m` : `${ESC}[0m`;
      look = wanted;
    }
    out += at.getChars() || ' ';
  }
  return look ? `${out}${ESC}[0m` : out;
}

// Rows `from` up to `to` of a buffer, and `toColumn` columns of row `to` when there are any, as lines:
// rows the terminal wrapped are joined into the line they were printed as, unless each row is wanted by itself.
export function regionLines(buffer, from, to, { columns, toColumn = 0, joined = true }) {
  const lines = [];
  const cell = buffer.getNullCell();
  const last = toColumn > 0 ? to : to - 1;
  for (let y = Math.max(from, 0); y <= last && y < buffer.length; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    const next = y < last ? buffer.getLine(y + 1) : undefined;
    const text = rowText(line, columns, { whole: Boolean(next?.isWrapped), limit: y === to ? toColumn : columns, cell });
    if (joined && line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  // A row that ran on into the next kept the spaces at its end, and those at the end of the whole line
  // show nothing.
  return joined ? lines.map(line => (line.endsWith(' ') ? line.replace(/ +$/, '') : line)) : lines;
}

// The screen a program has to itself, a line to each row, without the empty rows at its foot.
export function screenLines(buffer, { columns, rows }) {
  const lines = [];
  const cell = buffer.getNullCell();
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.baseY + y);
    lines.push(line ? rowText(line, columns, { cell }) : '');
  }
  while (lines.length && !lines.at(-1)) lines.pop();
  return lines;
}

// The text of a line, as it reads.
export const plain = line => line.replace(/\u001b\[[0-9;:]*m/g, '');

// Whether a look's codes give a space something to show: a background, or the colours swapped.
function showsSpace(params) {
  const codes = params.split(';').map(Number);
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    if (code === 7 || code === 48 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) return true;
    // A colour for the characters, which comes with its own numbers after it.
    if (code === 38) index += codes[index + 1] === 5 ? 2 : 4;
  }
  return false;
}

// Whether a line shows anything at all.
export function isBlank(line) {
  let seen = false;
  for (const [token, params] of line.matchAll(/\u001b\[([0-9;:]*)m|[^\u001b]+/g)) {
    if (params !== undefined) seen = showsSpace(params);
    else if (seen || token.trim()) return false;
  }
  return true;
}

// Lines that show nothing go from the end.
export function trimEnd(lines) {
  let end = lines.length;
  while (end > 0 && isBlank(lines[end - 1])) end -= 1;
  return end === lines.length ? lines : lines.slice(0, end);
}

// At most `maxLines` lines and `maxChars` characters, from the end, as a terminal's own scrollback keeps
// them, and how many lines went.
export function lastLines(lines, { maxLines, maxChars }) {
  let start = Math.max(0, lines.length - maxLines);
  let size = 0;
  for (let index = start; index < lines.length; index++) size += lines[index].length + 1;
  while (start < lines.length - 1 && size > maxChars) {
    size -= lines[start].length + 1;
    start += 1;
  }
  return { lines: start ? lines.slice(start) : lines, skipped: start };
}
