// What a terminal session's screen says, in the form a client draws a command's output in: lines of
// text with only the escape sequences that colour it, as a program wrote them, so that a client can
// draw each colour its own way. The screen comes from `rex`'s vt format or `tmux capture-pane -e`,
// whose other sequences only move the cursor or say what isn't text.

const ESC = '\u001b';
const BEL = '\u0007';
// An SGR code that resets the look: empty, or 0, alone or first.
const RESET = /^0*(;|$)/;
// Programs reset often, so what's in force is a few codes at most.
const MAX_CARRIED_CODES = 32;

const isFinal = code => code >= 0x40 && code <= 0x7e;
const isIntermediate = code => code >= 0x20 && code <= 0x2f;

// Spaces at the end of a line show nothing, and tmux keeps them where it joins lines it wrapped. The
// colours set among them still count for the lines after.
const TRAILING = /(?:\u001b\[[0-9;:]*m| )+$/;

function trimmedLine(line) {
  const match = TRAILING.exec(line);
  if (!match) return line;
  return line.slice(0, match.index) + (match[0].match(/\u001b\[[0-9;:]*m/g) ?? []).join('');
}

// The text with only the escape sequences that colour it. A cursor moved along is the spaces it passes
// over.
function coloursOnly(vt) {
  let out = '';
  for (let i = 0; i < vt.length;) {
    const char = vt[i];
    if (char === ESC) {
      const kind = vt[i + 1];
      if (kind === '[') {
        let end = i + 2;
        while (end < vt.length && !isFinal(vt.charCodeAt(end))) end++;
        const params = vt.slice(i + 2, end);
        if (vt[end] === 'm') out += vt.slice(i, end + 1);
        else if (vt[end] === 'C') out += ' '.repeat(Math.min(Number(params) || 1, 1000));
        i = end + 1;
      } else if (kind === ']' || kind === 'P' || kind === '_' || kind === '^' || kind === 'X') {
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
    if (char !== '\r') out += char;
    i += 1;
  }
  return out;
}

// Each line, with its colours.
export function vtLines(vt) {
  return coloursOnly(vt).split('\n').map(trimmedLine);
}

// What an escape sequence that sets the look does to whether a space shows: on a background, or with
// the colours swapped, it does.
function seenOnASpace({ background, inverse }, params) {
  const codes = params.split(/[;:]/).map(code => Number(code) || 0);
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    if (code === 0) {
      background = false;
      inverse = false;
    } else if (code === 7) {
      inverse = true;
    } else if (code === 27) {
      inverse = false;
    } else if (code === 49) {
      background = false;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      background = true;
    } else if (code === 38 || code === 48) {
      if (code === 48) background = true;
      // The colour itself comes after: `5;n`, or `2;r;g;b`.
      if (codes[i + 1] === 5) i += 2;
      else if (codes[i + 1] === 2) i += 4;
    }
  }
  return { background, inverse };
}

// A screen that a program has to itself, a line each as `vtLines` gives output, but with the spaces at
// a line's end that show something: a bar across such a screen is spaces on a background.
export function screenLines(vt) {
  let seen = { background: false, inverse: false };
  return coloursOnly(vt).split('\n').map(line => {
    let kept = '';
    let pending = '';
    for (const [token, params] of line.matchAll(/\u001b\[([0-9;:]*)m|[^\u001b]+|\u001b/g)) {
      if (params !== undefined) {
        seen = seenOnASpace(seen, params);
        pending += token;
        continue;
      }
      for (const char of token) {
        if (char === ' ' && !seen.background && !seen.inverse) {
          pending += char;
        } else {
          kept += pending + char;
          pending = '';
        }
      }
    }
    // What set the look after the last thing that shows still counts for the lines under it.
    return kept + (pending.match(/\u001b\[[0-9;:]*m/g) ?? []).join('');
  });
}

// The text of a line, as it reads.
export const plain = line => line.replace(/\u001b\[[0-9;:]*m/g, '');

// A line without its spaces, which a terminal may add or take away where it joins what it wrapped.
export const squashed = text => text.replace(/\s+/g, '');

// The colours in force where line `index` starts, which the lines above it set, to start a part of the
// output that begins there.
export function styleBefore(lines, index) {
  let codes = [];
  for (const line of lines.slice(0, index)) {
    for (const [, params] of line.matchAll(/\u001b\[([0-9;:]*)m/g)) {
      // A code that resets starts afresh, and may set something after.
      if (RESET.test(params)) codes = [];
      codes.push(params);
      if (codes.length > MAX_CARRIED_CODES) codes.shift();
    }
  }
  return codes.map(params => `${ESC}[${params}m`).join('');
}

// The output under a command's own line. The hooks draw that line again at the top of the cleared
// screen, unless the command cleared the screen again itself.
export function outputBody(lines, command) {
  const [first = ''] = lines;
  const typed = squashed(command.replace(/\n/g, ' '));
  return typed && squashed(plain(first)).endsWith(typed) ? lines.slice(1) : lines;
}

// Lines that show nothing go from the end.
export function trimEnd(lines) {
  let end = lines.length;
  while (end > 0 && !plain(lines[end - 1]).trim()) end -= 1;
  return lines.slice(0, end);
}

// The output once the prompt is back, without it, or undefined while it isn't there yet. A command
// that printed no newline at its end shares its last line with the prompt.
export function withoutPrompt(lines, prompt) {
  const trimmed = trimEnd(lines);
  const last = trimmed.at(-1);
  const wanted = prompt.trimEnd();
  if (last === undefined || !wanted || !plain(last).trimEnd().endsWith(wanted)) return undefined;
  const cut = last.lastIndexOf(wanted);
  const rest = cut < 0 ? '' : last.slice(0, cut);
  return trimEnd([...trimmed.slice(0, -1), plain(rest).trim() ? rest.replace(/\s+$/, '') : '']);
}

// At most `maxLines` lines and `maxChars` characters, from the end, as the terminal's own scrollback
// keeps them. The first line kept starts in the colours the lines before it left.
export function capped(lines, { maxLines, maxChars }) {
  let start = Math.max(0, lines.length - maxLines);
  let size = lines.slice(start).reduce((sum, line) => sum + line.length + 1, 0);
  while (start < lines.length - 1 && size > maxChars) {
    size -= lines[start].length + 1;
    start += 1;
  }
  if (start === 0) return lines.join('\n');
  return styleBefore(lines, start) + lines.slice(start).join('\n');
}
