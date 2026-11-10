import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { imageSize } from '../../src/imagesize.mjs';

const b64 = buffer => buffer.toString('base64');

// A real PNG, `width` by `height`, of one colour.
function png(width, height) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const pixels = zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

const segment = (kind, body) => {
  const head = Buffer.from([0xff, kind, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
};

// The EXIF block a camera writes, with only the orientation in its first directory.
function exif(orientation, little = true) {
  const tiff = Buffer.alloc(26);
  tiff.write(little ? 'II' : 'MM', 0, 'latin1');
  const u16 = (value, at) => (little ? tiff.writeUInt16LE(value, at) : tiff.writeUInt16BE(value, at));
  const u32 = (value, at) => (little ? tiff.writeUInt32LE(value, at) : tiff.writeUInt32BE(value, at));
  u16(42, 2);
  u32(8, 4);
  u16(1, 8);
  u16(0x0112, 10);
  u16(3, 12);
  u32(1, 14);
  u16(orientation, 18);
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}

// The start of a JPEG `width` by `height`, with what comes before its frame and a scan after it.
function jpeg(width, height, { before = [], frame = 0xc0 } = {}) {
  const sof = Buffer.from([8, 0, 0, 0, 0, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  const jfif = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, ...before, segment(frame, sof), segment(0xda, Buffer.alloc(10)), Buffer.alloc(64, 0x55)]);
}

test('a PNG says its size from its header', () => {
  assert.deepEqual(imageSize(b64(png(64, 40))), { width: 64, height: 40 });
  assert.deepEqual(imageSize(b64(png(1, 1))), { width: 1, height: 1 });
});

test('a JPEG says its size from its frame, after whatever comes first', () => {
  assert.deepEqual(imageSize(b64(jpeg(4032, 3024))), { width: 4032, height: 3024 });
  const comment = segment(0xfe, Buffer.alloc(40000, 0x41));
  const table = segment(0xdb, Buffer.alloc(130, 1));
  assert.deepEqual(imageSize(b64(jpeg(800, 600, { before: [comment, table] }))), { width: 800, height: 600 });
  assert.deepEqual(imageSize(b64(jpeg(1200, 900, { frame: 0xc2 }))), { width: 1200, height: 900 }, 'progressive');
  // A Huffman table's marker sits among the frames' and isn't one.
  assert.deepEqual(imageSize(b64(jpeg(10, 20, { before: [segment(0xc4, Buffer.alloc(30, 2))] }))), { width: 10, height: 20 });
});

test('a JPEG turned a quarter by its EXIF orientation says the size it shows at', () => {
  for (const orientation of [5, 6, 7, 8]) {
    assert.deepEqual(imageSize(b64(jpeg(4032, 3024, { before: [exif(orientation)] }))), { width: 3024, height: 4032 }, `orientation ${orientation}`);
  }
  for (const orientation of [1, 2, 3, 4]) {
    assert.deepEqual(imageSize(b64(jpeg(4032, 3024, { before: [exif(orientation)] }))), { width: 4032, height: 3024 }, `orientation ${orientation}`);
  }
  assert.deepEqual(imageSize(b64(jpeg(4032, 3024, { before: [exif(6, false)] }))), { width: 3024, height: 4032 }, 'big-endian EXIF');
});

test('a GIF and the three kinds of WebP say their sizes', () => {
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00\x00\x00\x00', 'latin1');
  assert.deepEqual(imageSize(b64(Buffer.concat([gif, Buffer.alloc(20)]))), { width: 320, height: 240 });
  const riff = (kind, body) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from(kind, 'latin1'), Buffer.alloc(4), body]);
  const lossy = Buffer.alloc(14);
  lossy.set([0x9d, 0x01, 0x2a], 3);
  lossy.writeUInt16LE(640, 6);
  lossy.writeUInt16LE(480, 8);
  assert.deepEqual(imageSize(b64(riff('VP8 ', lossy))), { width: 640, height: 480 });
  const lossless = Buffer.alloc(10);
  lossless[0] = 0x2f;
  lossless.writeUInt32LE((300 - 1) | ((200 - 1) << 14), 1);
  assert.deepEqual(imageSize(b64(riff('VP8L', lossless))), { width: 300, height: 200 });
  const extended = Buffer.alloc(10);
  extended.writeUIntLE(2000 - 1, 4, 3);
  extended.writeUIntLE(1000 - 1, 7, 3);
  assert.deepEqual(imageSize(b64(riff('VP8X', extended))), { width: 2000, height: 1000 });
});

test('anything else, or a picture cut short, says nothing', () => {
  assert.deepEqual(imageSize('QUJD'), {});
  assert.deepEqual(imageSize(b64(Buffer.from('not a picture at all, just some words'))), {});
  assert.deepEqual(imageSize(b64(png(64, 40).subarray(0, 20))), {});
  assert.deepEqual(imageSize(b64(jpeg(800, 600).subarray(0, 12))), {});
  assert.deepEqual(imageSize(undefined), {});
  assert.deepEqual(imageSize(b64(Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xda, Buffer.alloc(10)), Buffer.alloc(40)]))), {}, 'a scan before any frame');
});
