// What goes between the helper and a client: a JSON value a line, each ended by a line feed and by
// nothing else. JSON leaves a line separator or a paragraph separator in a string as it is, and Node's
// readline takes either for a line's end, so a message with one in it, as a file's text can have, came
// apart there. Lines are split here by the line feed alone, and what's written has those two escaped,
// for a reader that still splits on them.

// Hears each of a stream's lines as text, without the line feed that ended it or a carriage return
// before that. A line with nothing in it is passed over.
export function onLines(stream, onLine) {
  // The line so far, as the pieces it came in: bytes, so that a character cut in two by a piece's end is whole again.
  let kept = [];
  stream.on('data', piece => {
    const bytes = typeof piece === 'string' ? Buffer.from(piece) : piece;
    let from = 0;
    for (let at = bytes.indexOf(0x0a, from); at >= 0; at = bytes.indexOf(0x0a, from)) {
      kept.push(bytes.subarray(from, at));
      const line = Buffer.concat(kept).toString('utf8');
      kept = [];
      from = at + 1;
      const text = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (text) onLine(text);
    }
    if (from < bytes.length) kept.push(bytes.subarray(from));
  });
}

// A value as its line.
export function lineOf(value) {
  return `${JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`;
}
