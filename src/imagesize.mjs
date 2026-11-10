// A picture's size in pixels, read from the start of its base64 without decoding the rest, so that a
// page can say how big each picture is before anything fetches it. PNG, JPEG, GIF and WebP, the kinds
// Claude Code takes. A JPEG turned by its EXIF orientation is as it shows, with its sides swapped.

// What a JPEG walk gives up after: past it, the picture isn't one this reads.
const MAX_SEGMENTS = 64;
const EXIF_ORIENTATION = 0x0112;

// Reads any bytes of a base64 string, decoding only the groups of four characters that hold them.
function bytesOf(base64) {
  const size = Math.floor(base64.length / 4) * 3;
  return {
    size,
    read(offset, count) {
      if (offset < 0 || count <= 0 || offset + count > size) return undefined;
      const start = Math.floor(offset / 3) * 4;
      const end = Math.ceil((offset + count) / 3) * 4;
      const chunk = Buffer.from(base64.slice(start, end), 'base64');
      const skip = offset - (start / 4) * 3;
      return chunk.length >= skip + count ? chunk.subarray(skip, skip + count) : undefined;
    },
  };
}

const sized = (width, height) => (width > 0 && height > 0 ? { width, height } : {});

function png(bytes) {
  const head = bytes.read(0, 24);
  if (!head || head.readUInt32BE(0) !== 0x89504e47 || head.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  return sized(head.readUInt32BE(16), head.readUInt32BE(20));
}

function gif(bytes) {
  const head = bytes.read(0, 10);
  if (!head || !/^GIF8[79]a$/.test(head.toString('latin1', 0, 6))) return undefined;
  return sized(head.readUInt16LE(6), head.readUInt16LE(8));
}

function webp(bytes) {
  const head = bytes.read(0, 30);
  if (!head || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WEBP') return undefined;
  switch (head.toString('latin1', 12, 16)) {
    case 'VP8 ':
      return sized(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff);
    case 'VP8L': {
      const bits = head.readUInt32LE(21);
      return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
    }
    case 'VP8X':
      return sized(head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1);
    default:
      return {};
  }
}

// Whether an EXIF block turns the picture a quarter, from its first directory's orientation tag.
function turnsQuarter(bytes, segment, length) {
  const head = bytes.read(segment + 4, 6);
  if (!head || head.toString('latin1') !== 'Exif\0\0') return false;
  const tiff = segment + 10;
  const order = bytes.read(tiff, 2)?.toString('latin1');
  if (order !== 'II' && order !== 'MM') return false;
  const little = order === 'II';
  const u16 = at => { const b = bytes.read(at, 2); return b && (little ? b.readUInt16LE(0) : b.readUInt16BE(0)); };
  const u32 = at => { const b = bytes.read(at, 4); return b && (little ? b.readUInt32LE(0) : b.readUInt32BE(0)); };
  const directory = u32(tiff + 4);
  if (directory === undefined || directory + 2 > length) return false;
  const entries = u16(tiff + directory) ?? 0;
  for (let index = 0; index < entries; index += 1) {
    const entry = tiff + directory + 2 + index * 12;
    if (entry + 12 > segment + 2 + length) return false;
    if (u16(entry) === EXIF_ORIENTATION) return [5, 6, 7, 8].includes(u16(entry + 8));
  }
  return false;
}

function jpeg(bytes) {
  const start = bytes.read(0, 2);
  if (!start || start[0] !== 0xff || start[1] !== 0xd8) return undefined;
  let offset = 2;
  let quarter = false;
  for (let count = 0; count < MAX_SEGMENTS; count += 1) {
    const marker = bytes.read(offset, 4);
    if (!marker || marker[0] !== 0xff) return {};
    const kind = marker[1];
    if (kind === 0xff) { offset += 1; continue; }
    if (kind === 0x01 || (kind >= 0xd0 && kind <= 0xd8)) { offset += 2; continue; }
    if (kind === 0xd9 || kind === 0xda) return {};
    const length = marker.readUInt16BE(2);
    const isFrame = kind >= 0xc0 && kind <= 0xcf && kind !== 0xc4 && kind !== 0xc8 && kind !== 0xcc;
    if (isFrame) {
      const frame = bytes.read(offset + 5, 4);
      if (!frame) return {};
      const height = frame.readUInt16BE(0);
      const width = frame.readUInt16BE(2);
      return quarter ? sized(height, width) : sized(width, height);
    }
    if (kind === 0xe1 && !quarter) quarter = turnsQuarter(bytes, offset, length);
    offset += 2 + length;
  }
  return {};
}

// `{ width, height }` in pixels as the picture shows, or `{}` when it can't be told.
export function imageSize(base64) {
  if (typeof base64 !== 'string' || base64.length < 16) return {};
  const bytes = bytesOf(base64);
  try {
    return png(bytes) ?? jpeg(bytes) ?? gif(bytes) ?? webp(bytes) ?? {};
  } catch {
    return {};
  }
}
