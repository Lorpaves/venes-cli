// A terminal's screen as `rex capture --format=vt` and `tmux capture-pane -e` give it: its text, with
// the escape sequences that say how it looks. Only the look is kept. A cursor moved along is the
// spaces it passes over, and everything else, like a link's address, is dropped.

const ESC = '\u001b';
const BEL = '\u0007';
// xterm's first sixteen. A terminal's theme can change these, and nothing on the screen says how.
const BASIC = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
];
const CUBE = [0, 95, 135, 175, 215, 255];
const FLAGS = ['bold', 'dim', 'italic', 'underline', 'strikethrough', 'inverse'];
// What a space shows of how it looks.
const SEEN_ON_A_SPACE = ['background', 'underline', 'strikethrough', 'inverse'];

const hex = (...rgb) => `#${rgb.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')}`;
const isByte = v => Number.isInteger(v) && v >= 0 && v <= 255;

export function paletteColor(n) {
  if (!isByte(n)) return undefined;
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const i = n - 16;
    return hex(CUBE[Math.floor(i / 36)], CUBE[Math.floor(i / 6) % 6], CUBE[i % 6]);
  }
  const level = 8 + (n - 232) * 10;
  return hex(level, level, level);
}

// 38;5;n and 38;2;r;g;b, or with colons, as 38:5:n and 38:2::r:g:b. The colour, and how many of the
// parameters it took.
function extendedColor(params, i) {
  const [, ...sub] = params[i];
  if (sub.length) {
    if (sub[0] === 5) return [paletteColor(sub[1]), 1];
    const rgb = sub.slice(-3);
    return [sub[0] === 2 && sub.length >= 4 && rgb.every(isByte) ? hex(...rgb) : undefined, 1];
  }
  const kind = params[i + 1]?.[0];
  if (kind === 5) return [paletteColor(params[i + 2]?.[0]), 3];
  if (kind === 2) {
    const rgb = [2, 3, 4].map(n => params[i + n]?.[0]);
    return [rgb.every(isByte) ? hex(...rgb) : undefined, 5];
  }
  return [undefined, 2];
}

export function applySgr(style, text) {
  const params = (text || '0').split(';').map(param => param.split(':').map(v => (v === '' ? undefined : Number(v))));
  const next = { ...style };
  for (let i = 0; i < params.length;) {
    const [code = 0, sub] = params[i];
    if (code === 38 || code === 48 || code === 58) {
      const [color, used] = extendedColor(params, i);
      // 58 is the colour of an underline, which is drawn in the text's own.
      if (code !== 58) next[code === 38 ? 'color' : 'background'] = color;
      i += used;
      continue;
    }
    i += 1;
    if (code === 0) for (const key of Object.keys(next)) delete next[key];
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = sub !== 0;
    else if (code === 7) next.inverse = true;
    else if (code === 9) next.strikethrough = true;
    else if (code === 21) next.underline = true;
    else if (code === 22) { next.bold = false; next.dim = false; }
    else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code === 27) next.inverse = false;
    else if (code === 29) next.strikethrough = false;
    else if (code >= 30 && code <= 37) next.color = BASIC[code - 30];
    else if (code === 39) next.color = undefined;
    else if (code >= 40 && code <= 47) next.background = BASIC[code - 40];
    else if (code === 49) next.background = undefined;
    else if (code >= 90 && code <= 97) next.color = BASIC[code - 82];
    else if (code >= 100 && code <= 107) next.background = BASIC[code - 92];
  }
  for (const [key, value] of Object.entries(next)) if (value === undefined || value === false) delete next[key];
  return next;
}

const isFinal = c => c >= 0x40 && c <= 0x7e;
const isIntermediate = c => c >= 0x20 && c <= 0x2f;

// Each line of the screen, as cells: a character, and how it looks.
export function screenCells(vt) {
  const lines = [[]];
  let line = lines[0];
  let style = {};
  for (let i = 0; i < vt.length;) {
    if (vt[i] === ESC) {
      const kind = vt[i + 1];
      if (kind === '[') {
        let end = i + 2;
        while (end < vt.length && !isFinal(vt.charCodeAt(end))) end++;
        const params = vt.slice(i + 2, end);
        if (vt[end] === 'm') style = applySgr(style, params);
        else if (vt[end] === 'C') {
          // Text the cursor passes over keeps no more of its look than a space would show.
          const passed = Object.fromEntries(Object.entries(style).filter(([key]) => !SEEN_ON_A_SPACE.includes(key)));
          for (let n = Number(params) || 1; n > 0; n--) line.push({ char: ' ', style: passed });
        }
        i = end + 1;
      } else if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
        let end = i + 2;
        while (end < vt.length && vt[end] !== BEL && !(vt[end] === ESC && vt[end + 1] === '\\')) end++;
        i = vt[end] === BEL ? end + 1 : end + 2;
      } else {
        let end = i + 1;
        while (end < vt.length && isIntermediate(vt.charCodeAt(end))) end++;
        i = end + 1;
      }
      continue;
    }
    const code = vt.codePointAt(i);
    const char = String.fromCodePoint(code);
    i += char.length;
    if (char === '\n') {
      line = [];
      lines.push(line);
    } else if (code >= 0x20 && code !== 0x7f) {
      line.push({ char, style });
    }
  }
  return lines;
}

export const plainText = cells => cells.map(cell => cell.char).join('');

// A space that shows nothing, which a line can be trimmed of or broken at.
export const isBlank = ({ char, style }) => char === ' ' && !SEEN_ON_A_SPACE.some(key => style[key]);

const sameLook = (a, b) => a.color === b.color && a.background === b.background && FLAGS.every(flag => !!a[flag] === !!b[flag]);

// Runs of text that look the same: each with its colours, as #rrggbb, and the flags that are set.
export function runsOf(cells) {
  const runs = [];
  for (const { char, style } of cells) {
    const last = runs.at(-1);
    if (last && sameLook(last.style, style)) last.text += char;
    else runs.push({ text: char, style });
  }
  return runs.map(({ text, style }) => ({ text, ...style }));
}
