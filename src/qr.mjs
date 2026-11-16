// A QR code drawn here, so that a computer needs nothing installed to show one: the text as its bytes,
// at the lowest level of error correction, which is what a pairing code has always had. What comes
// back is rows of 0s and 1s with one light module around them, as Core Image gives them on a Mac.

// For each version at that level: the error-correction bytes a block has, and how many blocks there are.
const ECC_PER_BLOCK = [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BLOCKS = [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];
const MAX_VERSION = 40;
// The two bits that say which level it is, in the format written beside the corners.
const LEVEL_BITS = 1;

const sizeOf = version => version * 4 + 17;

// How many modules are left for data and error correction once the fixed patterns are drawn.
function rawModules(version) {
  let count = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const aligned = Math.floor(version / 7) + 2;
    count -= (25 * aligned - 10) * aligned - 55;
    if (version >= 7) count -= 36;
  }
  return count;
}

const rawBytes = version => Math.floor(rawModules(version) / 8);
const dataBytes = version => rawBytes(version) - ECC_PER_BLOCK[version] * BLOCKS[version];
// A count of bytes is written in 8 bits up to version 9, and in 16 from there.
const countBits = version => (version <= 9 ? 8 : 16);

// Where the small squares that keep a reader aligned are centred, along each side.
function alignments(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const places = [6];
  for (let at = sizeOf(version) - 7; places.length < count; at -= step) places.splice(1, 0, at);
  return places;
}

// Arithmetic in the field the error correction is worked in: bytes, multiplied modulo x^8+x^4+x^3+x^2+1.
function multiply(a, b) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit--) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product;
}

// The polynomial a block's bytes are divided by, for `degree` bytes of error correction.
function divisor(degree) {
  const terms = new Array(degree).fill(0);
  terms[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      terms[j] = multiply(terms[j], root);
      if (j + 1 < degree) terms[j] ^= terms[j + 1];
    }
    root = multiply(root, 2);
  }
  return terms;
}

function remainder(data, terms) {
  const left = new Array(terms.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ left.shift();
    left.push(0);
    for (let i = 0; i < terms.length; i++) left[i] ^= multiply(terms[i], factor);
  }
  return left;
}

// The text's bytes as the code carries them: what kind they are and how many, the bytes, an end, and
// filling up to what the version holds.
function dataFor(bytes, version) {
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacity = dataBytes(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  return data;
}

// The data cut into blocks, each with its error correction, and the blocks woven together a byte at a time.
function codewords(data, version) {
  const blocks = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const total = rawBytes(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks);
  const terms = divisor(eccLength);
  const parts = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const part = data.slice(at, at + length);
    at += length;
    parts.push({ data: part, ecc: remainder(part, terms) });
  }
  const woven = [];
  for (let i = 0; i <= shortLength - eccLength; i++) {
    for (const part of parts) if (i < part.data.length) woven.push(part.data[i]);
  }
  for (let i = 0; i < eccLength; i++) {
    for (const part of parts) woven.push(part.ecc[i]);
  }
  return woven;
}

// Whether a module is flipped by each of the eight masks, one of which is laid over the data so that
// the code has no large plain areas or shapes a reader takes for a corner.
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  x => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  constructor(version) {
    this.version = version;
    this.size = sizeOf(version);
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    // What's part of a pattern, which no data is written over and no mask flips.
    this.fixed = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.dark[y][x] = dark;
    this.fixed[y][x] = true;
  }

  // The patterns every code of this version has: the three corners, the lines between them, the
  // alignment squares, and room for the format and version, which are written in later.
  drawPatterns() {
    const { size } = this;
    for (let i = 0; i < size; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [centerX, centerY] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const x = centerX + dx;
          const y = centerY + dy;
          if (x < 0 || x >= size || y < 0 || y >= size) continue;
          const ring = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, ring !== 2 && ring !== 4);
        }
      }
    }
    const places = alignments(this.version);
    const last = places.length - 1;
    places.forEach((y, row) => places.forEach((x, column) => {
      // Not where a corner is.
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) this.set(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));
    this.drawFormat(0);
    this.drawVersion();
  }

  // Which level and mask the code has, twice over, with its own error correction.
  drawFormat(mask) {
    const { size } = this;
    const data = (LEVEL_BITS << 3) | mask;
    let rest = data;
    for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    const bits = ((data << 10) | rest) ^ 0x5412;
    const bit = i => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  // Which version it is, twice over, from version 7 on.
  drawVersion() {
    if (this.version < 7) return;
    let rest = this.version;
    for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rest;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, dark);
      this.set(b, a, dark);
    }
  }

  // The bytes, a bit at a time, up and down the code in columns two wide, from the bottom right.
  drawData(bytes) {
    const { size } = this;
    let at = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let step = 0; step < size; step++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - step : step;
          if (this.fixed[y][x] || at >= bytes.length * 8) continue;
          this.dark[y][x] = ((bytes[at >>> 3] >>> (7 - (at & 7))) & 1) === 1;
          at++;
        }
      }
    }
  }

  applyMask(mask) {
    const flips = MASKS[mask];
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.fixed[y][x] && flips(x, y)) this.dark[y][x] = !this.dark[y][x];
      }
    }
  }

  // How hard the code is to read as it stands, by the standard's four counts: long runs of one colour,
  // blocks of one colour, shapes like a corner's, and one colour outweighing the other.
  penalty() {
    const { size, dark } = this;
    let points = 0;
    const lines = [];
    for (let i = 0; i < size; i++) {
      lines.push(dark[i]);
      lines.push(dark.map(row => row[i]));
    }
    const corner = [true, false, true, true, true, false, true, false, false, false, false];
    const matches = (line, at, shape) => shape.every((want, i) => line[at + i] === want);
    const reversed = [...corner].reverse();
    for (const line of lines) {
      for (let at = 0, run = 1; at < size; at++, run++) {
        if (at + 1 < size && line[at + 1] === line[at]) continue;
        if (run >= 5) points += run - 2;
        run = 0;
      }
      for (let at = 0; at + corner.length <= size; at++) {
        if (matches(line, at, corner) || matches(line, at, reversed)) points += 40;
      }
    }
    let darkCount = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (dark[y][x]) darkCount++;
        if (x + 1 < size && y + 1 < size && dark[y][x] === dark[y][x + 1] && dark[y][x] === dark[y + 1][x] && dark[y][x] === dark[y + 1][x + 1]) points += 3;
      }
    }
    points += Math.floor(Math.abs(darkCount * 20 - size * size * 10) / (size * size)) * 10;
    return points;
  }
}

// The smallest version that holds `length` bytes.
export function versionFor(length) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (4 + countBits(version) + length * 8 <= dataBytes(version) * 8) return version;
  }
  throw new Error('That is too long for a QR code.');
}

// The code for `text`, as rows of 0s and 1s, with one light module on every side.
export function qrRows(text) {
  const bytes = [...Buffer.from(text, 'utf8')];
  const version = versionFor(bytes.length);
  const grid = new Grid(version);
  grid.drawPatterns();
  grid.drawData(codewords(dataFor(bytes, version), version));
  // Each mask is tried, and the one that reads most easily is kept.
  let best = { mask: 0, points: Infinity };
  for (let mask = 0; mask < MASKS.length; mask++) {
    grid.applyMask(mask);
    grid.drawFormat(mask);
    const points = grid.penalty();
    if (points < best.points) best = { mask, points };
    grid.applyMask(mask);
  }
  grid.applyMask(best.mask);
  grid.drawFormat(best.mask);
  const light = '0'.repeat(grid.size + 2);
  return [light, ...grid.dark.map(row => `0${row.map(dark => (dark ? '1' : '0')).join('')}0`), light];
}
