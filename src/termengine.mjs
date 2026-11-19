// What a terminal session's shell and the programs in it print, read as a terminal reads it. The
// session's terminal keeps everything they write in a file (shellmarks.mjs), which is fed to an emulator
// here, so the screen is known as it stands at every byte. The shell's hooks write a mark before each
// command and each prompt, and where a mark falls on the screen is where a command's output starts
// and ends. Nothing on the screen is cleared or looked for.
//
// A command's output is the rows from its mark to the next prompt's. While it runs they're read again
// as they change, so a program that draws over its own rows, or takes the whole screen, shows as it is.
// A line typed into a running program starts a part of its own at the row it was typed on, which is
// what the program prints from then.

import { Terminal } from './vendor/xterm-headless.mjs';
import { lastLines, regionLines, screenLines, trimEnd } from './termtext.mjs';

// The marks: `ESC ] 7773 ; <nonce> ; <kind> ; <fields> BEL`. The nonce is the session's own, so that
// marks from anywhere else, as a file shown with cat or another computer's shell, count for nothing.
export const MARK_CODE = 7773;
// What a program says of itself to the terminal it's in: https://www.superlogical.com/rex/docs/build/program-status.md
const STATUS_CODE = 7501;
const SCROLLBACK_ROWS = 4000;
// What's sent of a command's output while it runs, and when it's over. A page lays out every line again
// each time the output is replaced, which a phone does in a frame's time for about a hundred lines, so
// that's the window while it runs. The whole of it comes once at the end, where a hitch is a single one.
// (Measured on MessageKit's page, 2026-11-19: 100 lines of 80 in 4 ms, 300 in 12; 2,000 in about 90.)
export const LIVE = { maxLines: 100, maxChars: 12 * 1024 };
export const FINAL = { maxLines: 2000, maxChars: 200 * 1024 };
// The rows at the end of a part that's over which are looked at again, for a program drawing over them.
const SEALED_ROWS = 40;

const ESC = 0x1b;
const BEL = 0x07;
const BACKSLASH = 0x5c;
const NAME_START = Buffer.from([ESC, 0x6b]);
const NAME_BYTES = 1024;

const decoded = text => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

const rowOf = marker => (marker && !marker.isDisposed && marker.line >= 0 ? marker.line : 0);

export class TerminalEngine {
  #term;
  #nonce;
  #emit;
  #writing = Promise.resolve();
  #offset = 0;
  #run;
  #nextPart = 0;
  #isReady = false;
  #isWorking = true;
  // What the program going on said of itself, where it says: at work, or waiting.
  #said;
  #held;

  constructor({ columns = 80, rows = 24, nonce, emit = () => {} }) {
    this.#term = new Terminal({ cols: columns, rows, scrollback: SCROLLBACK_ROWS, allowProposedApi: true });
    // xterm.js takes a marker away when the row it's on is erased, as a mark on what was written there
    // would have nothing left to be on. The markers here say where rows are, erased or not: a program
    // that clears the screen and draws again is still drawing in the rows of its command. This reaches
    // into the emulator, so it's checked against the copy kept in vendor/ by this module's tests.
    this.#term._core._bufferService.buffers.normal.clearMarkers = () => {};
    this.#nonce = nonce;
    this.#emit = emit;
    this.#term.parser.registerOscHandler(MARK_CODE, data => this.#onMark(data));
    this.#term.parser.registerOscHandler(STATUS_CODE, data => this.#onStatus(data));
  }

  // Whether the shell has shown its first prompt.
  get isReady() { return this.#isReady; }

  get isRunning() { return this.#run !== undefined; }

  // The command going on: its number, and the parts it has.
  get running() {
    return this.#run && { seq: this.#run.seq, command: this.#run.command, parts: this.#run.parts.map(part => part.id) };
  }

  // The part the next line typed into the command going on will be.
  get nextPart() { return this.#nextPart; }

  // The shell has gone without a prompt: whatever was going on is over, as far as it got.
  end() {
    if (this.#run) this.#finish(undefined);
  }

  // Whether a program has the screen to itself, as an editor or a pager does.
  get isFullScreen() { return this.#term.buffer.active.type === 'alternate'; }

  get columns() { return this.#term.cols; }

  get rows() { return this.#term.rows; }

  // How many bytes of the stream have been read.
  get offset() { return this.#offset; }

  // What the program in front asked of the terminal: whether a paste is to be marked as one.
  get takesMarkedPaste() { return this.#term.modes.bracketedPasteMode; }

  // More of the stream. Settles once it's on the screen.
  feed(chunk) {
    const shown = this.#withoutNames(chunk);
    this.#writing = this.#writing.then(() => new Promise(resolve => { this.#term.write(shown, resolve); })).then(() => { this.#offset += chunk.length; });
    return this.#writing;
  }

  // tmux and screen take `ESC k name ESC \` for a window's name, and a shell's setup can write one
  // before each command when it's in one of them, as oh-my-zsh does. The emulator is neither, and
  // would print the name as the first thing the command wrote. One cut off at the end of what's fed is
  // kept for the next of it.
  #withoutNames(chunk) {
    const data = this.#held ? Buffer.concat([this.#held, chunk]) : Buffer.from(chunk);
    this.#held = undefined;
    const kept = [];
    let from = 0;
    while (from < data.length) {
      const start = data.indexOf(NAME_START, from);
      if (start < 0) {
        const endsInEscape = data[data.length - 1] === ESC;
        kept.push(data.subarray(from, endsInEscape ? data.length - 1 : data.length));
        if (endsInEscape) this.#held = data.subarray(data.length - 1);
        break;
      }
      kept.push(data.subarray(from, start));
      let end = -1;
      for (let at = start + 2; at < data.length; at++) {
        if (data[at] === BEL) { end = at + 1; break; }
        if (data[at] !== ESC) continue;
        if (at + 1 < data.length) end = data[at + 1] === BACKSLASH ? at + 2 : at;
        break;
      }
      if (end >= 0) {
        from = end;
      } else if (data.length - start > NAME_BYTES) {
        // Too long to be a name: only what started it goes.
        from = start + 2;
      } else {
        this.#held = data.subarray(start);
        break;
      }
    }
    return kept.length === 1 ? kept[0] : Buffer.concat(kept);
  }

  // Settles once everything fed so far is on the screen.
  settled() { return this.#writing; }

  resize(columns, rows) {
    this.#writing = this.#writing.then(() => {
      if (columns !== this.#term.cols || rows !== this.#term.rows) this.#term.resize(columns, rows);
    });
    return this.#writing;
  }

  dispose() { this.#term.dispose(); }

  #onMark(data) {
    const [nonce, kind, ...fields] = data.split(';');
    if (nonce !== this.#nonce) return true;
    if (kind === 'S') {
      const [pid, tty, name] = fields;
      this.#emit({ type: 'shell', pid: Number(pid), tty: decoded(tty ?? ''), name });
    } else if (kind === 'C') {
      const [seq, ...command] = fields;
      this.#begin(Number(seq), decoded(command.join(';')));
    } else if (kind === 'P') {
      const [seq, exitCode, ...cwd] = fields;
      this.#prompt(Number(seq), Number(exitCode), decoded(cwd.join(';')));
    }
    return true;
  }

  #onStatus(data) {
    const state = /(?:^|:)state=([^:]*)/.exec(data)?.[1];
    if (state !== undefined) {
      this.#said = state === 'working';
      this.#noteWork();
    }
    // Not handled here alone: the terminal it's meant for reads it too.
    return false;
  }

  // Whether the command going on is at work, or only waits for whoever is at it: as the program says of
  // itself, where it does, and otherwise by whether it has the screen to itself. One that takes the whole
  // screen, as an editor or a pager does, shows there what it's doing and waits to be told what's next.
  // Any other is taken to be at work until it ends.
  #noteWork() {
    const isWorking = this.#said ?? !this.isFullScreen;
    if (this.#isWorking === isWorking) return;
    this.#isWorking = isWorking;
    if (this.#run) this.#emit({ type: 'working', seq: this.#run.seq, working: isWorking });
  }

  // Whether the command going on only waits, as last looked at.
  get isAtRest() { return this.#run !== undefined && !this.#isWorking; }

  get #normal() { return this.#term.buffer.normal; }

  get #cursorRow() { return this.#normal.baseY + this.#normal.cursorY; }

  // A mark on the row the cursor is on, which stays with that row as the screen scrolls.
  #markHere(offset = 0) {
    return this.isFullScreen ? undefined : this.#term.registerMarker(offset);
  }

  #begin(seq, command) {
    // A command whose end was never said is over now.
    if (this.#run) this.#finish(undefined);
    this.#said = undefined;
    this.#isWorking = true;
    const start = this.#markHere();
    const top = this.#markHere(-this.#normal.cursorY);
    this.#run = {
      seq, command, parts: [this.#part(start)],
      // The rows of the screen above where the command starts, as they are now: a program that draws
      // over them has taken the screen from its top, and its output starts there.
      above: top && start && top.line < start.line ? { marker: top, rows: this.#eachRow(top.line, start.line) } : undefined,
    };
    this.#emit({ type: 'command', seq, command, part: this.#run.parts[0].id });
  }

  #part(marker) {
    return { id: this.#nextPart++, marker, wantsMarker: !marker, sent: undefined, sealed: undefined };
  }

  #prompt(seq, exitCode, cwd) {
    if (this.#run) this.#finish(Number.isFinite(exitCode) ? exitCode : undefined);
    const first = !this.#isReady;
    this.#isReady = true;
    this.#emit({ type: 'prompt', seq, cwd, ...(Number.isFinite(exitCode) && { exitCode }), ...(first && { first: true }) });
  }

  #rows(from, to, toColumn = 0) {
    return regionLines(this.#normal, from, to, { columns: this.#term.cols, toColumn });
  }

  #eachRow(from, to) {
    return regionLines(this.#normal, from, to, { columns: this.#term.cols, joined: false });
  }

  // The last row of the screen with anything on it, at the cursor or under it.
  #lastRow() {
    const normal = this.#normal;
    const cursor = this.#cursorRow;
    const cell = normal.getNullCell();
    for (let y = normal.length - 1; y > cursor; y--) {
      const line = normal.getLine(y);
      if (!line) continue;
      for (let x = 0; x < this.#term.cols; x++) {
        const at = line.getCell(x, cell);
        if ((at.getChars() && at.getChars() !== ' ') || !at.isBgDefault() || at.isInverse()) return y;
      }
    }
    return cursor;
  }

  // Where each part starts and ends now. A part typed while a program had the screen to itself gets its
  // row once the program gives the screen back.
  #spans(end) {
    const { parts } = this.#run;
    if (!this.isFullScreen) {
      for (const part of parts) {
        if (!part.wantsMarker) continue;
        part.marker = this.#markHere();
        part.wantsMarker = false;
      }
    }
    return parts.map((part, index) => {
      const next = parts[index + 1];
      // One that never got a row, as when the command ended with the screen still taken, printed nothing of its own.
      return { part, from: part.wantsMarker ? end : rowOf(part.marker), to: next && !next.wantsMarker ? rowOf(next.marker) : end };
    });
  }

  // A program that has drawn over the rows above its command's own has taken the screen from the top.
  #checkAbove() {
    const run = this.#run;
    const { above } = run;
    if (!above || this.isFullScreen) return;
    const [first] = run.parts;
    if (above.marker.isDisposed || !first.marker || first.marker.isDisposed) {
      run.above = undefined;
      return;
    }
    // Rows that have scrolled off the top of the screen can't be drawn over, so the first one that reads
    // differently is where the program started drawing.
    const now = this.#eachRow(above.marker.line, above.marker.line + above.rows.length);
    const changed = above.rows.findIndex((row, index) => row !== now[index]);
    if (changed < 0) return;
    first.marker.dispose();
    first.marker = this.#term.registerMarker(above.marker.line + changed - this.#cursorRow);
    above.marker.dispose();
    run.above = undefined;
  }

  // A part that's over which the program has since drawn over joins the part after it: the two are one
  // picture, which is under the last line typed.
  #mergeRedrawn() {
    const { parts } = this.#run;
    for (let index = 0; index < parts.length - 1;) {
      const part = parts[index];
      const next = parts[index + 1];
      const isLost = !part.marker || part.marker.isDisposed || next.wantsMarker || !next.marker || next.marker.isDisposed;
      if (isLost || part.sealed === undefined || this.#sealOf(part, rowOf(next.marker)) === part.sealed) {
        index += 1;
        continue;
      }
      next.marker = part.marker;
      parts.splice(index, 1);
      if (part.sent) this.#emit({ type: 'output', seq: this.#run.seq, part: part.id, text: '', running: false, columns: this.#term.cols });
    }
  }

  #sealOf(part, to) {
    return this.#rows(Math.max(rowOf(part.marker), to - SEALED_ROWS), to).join('\n');
  }

  #say(part, text, extra) {
    const said = JSON.stringify([text, extra]);
    if (part.sent === said) return;
    part.sent = said;
    this.#emit({ type: 'output', seq: this.#run.seq, part: part.id, text, columns: this.#term.cols, ...extra });
  }

  // Reads the command going on again, and says what has changed of it.
  flush() {
    const run = this.#run;
    if (!run) return;
    // Looked at here, and not as the screen changes hands: a program that gives the screen back as it
    // ends is over by the next look, and nothing is said of work it never went back to.
    this.#noteWork();
    this.#checkAbove();
    if (!this.isFullScreen) this.#mergeRedrawn();
    const end = this.#lastRow() + 1;
    const spans = this.#spans(end);
    const last = spans.at(-1);
    if (this.isFullScreen) {
      // The screen is the last part's, whatever it printed before the program took it.
      const lines = screenLines(this.#term.buffer.active, { columns: this.#term.cols, rows: this.#term.rows });
      this.#say(last.part, lines.join('\n'), { running: true, screen: true, rows: this.#term.rows });
      return;
    }
    const from = Math.max(last.from, last.to - 2 * LIVE.maxLines);
    const { lines } = lastLines(trimEnd(this.#rows(from, last.to)), LIVE);
    this.#say(last.part, lines.join('\n'), { running: true });
  }

  // A line is about to be typed into the program going on: what it prints from here is that line's
  // part, and the part before is as it stands. Returns the new part, or nothing with no command going on.
  split() {
    const run = this.#run;
    if (!run) return undefined;
    this.#checkAbove();
    if (!this.isFullScreen) this.#mergeRedrawn();
    const before = run.parts.at(-1);
    const part = this.#part(this.#markHere());
    run.parts.push(part);
    // What the part before printed outside the screen a program has to itself, which the new part takes.
    const to = part.wantsMarker ? this.#cursorRow : rowOf(part.marker);
    if (!before.wantsMarker) {
      const { lines } = lastLines(trimEnd(this.#rows(rowOf(before.marker), to)), FINAL);
      this.#say(before, lines.join('\n'), { running: false });
      before.sealed = part.wantsMarker ? undefined : this.#sealOf(before, to);
    } else {
      this.#say(before, '', { running: false });
    }
    this.flush();
    return part.id;
  }

  #finish(exitCode) {
    const run = this.#run;
    this.#checkAbove();
    if (!this.isFullScreen) this.#mergeRedrawn();
    const normal = this.#normal;
    const spans = this.#spans(this.#cursorRow);
    spans.forEach(({ part, from, to }, index) => {
      const isLast = index === spans.length - 1;
      // The last part ends where the cursor is, part of the way along its row when the command left it there.
      const rows = isLast ? this.#rows(from, this.#cursorRow, normal.cursorX) : this.#rows(from, to);
      const { lines } = lastLines(trimEnd(rows), FINAL);
      const extra = { running: false, ...(isLast && exitCode !== undefined && { exitCode }) };
      if (isLast || part.sealed === undefined) this.#say(part, lines.join('\n'), extra);
    });
    for (const { part } of spans) part.marker?.dispose();
    run.above?.marker.dispose();
    run.above = undefined;
    this.#run = undefined;
    this.#emit({ type: 'finished', seq: run.seq, part: spans.at(-1).part.id, ...(exitCode !== undefined && { exitCode }) });
  }

  // A place on the screen to read from later: the row the cursor is on now.
  here() { return this.#markHere(); }

  // What has been printed under the row of a place, up to the cursor.
  since(place) {
    if (!place || place.isDisposed) return '';
    const lines = trimEnd(this.#rows(place.line + 1, this.#cursorRow, this.#normal.cursorX));
    return lastLines(lines, FINAL).lines.join('\n');
  }

  // The whole screen as it stands, for a client that's shown one.
  screen() {
    const active = this.#term.buffer.active;
    if (this.isFullScreen) return screenLines(active, { columns: this.#term.cols, rows: this.#term.rows });
    return trimEnd(regionLines(active, active.baseY, active.baseY + this.#term.rows, { columns: this.#term.cols }));
  }
}
