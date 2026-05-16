import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return (b << 16) | a;
}

function deflateStore(data) {
  const chunks = [];
  const chunkSize = 65535;
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.slice(i, i + chunkSize);
    const isLast = i + chunkSize >= data.length;
    chunks.push(new Uint8Array([isLast ? 1 : 0]));
    chunks.push(new Uint8Array([chunk.length & 0xff, (chunk.length >> 8) & 0xff]));
    chunks.push(new Uint8Array([(~chunk.length) & 0xff, (~chunk.length >> 8) & 0xff]));
    chunks.push(chunk);
  }

  const adler = adler32(data);
  const zlib = [
    new Uint8Array([0x78, 0x01]),
    ...chunks,
    uint32BE(adler),
  ];
  return concat(zlib);
}

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const crcData = concat([typeBytes, data]);
  const crc = crc32(crcData);
  return concat([uint32BE(data.length), typeBytes, data, uint32BE(crc)]);
}

function generatePng(size, r, g, b) {
  const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array([
    ...uint32BE(size), ...uint32BE(size),
    8, 2, 0, 0, 0,
  ]);

  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = new Uint8Array(1 + size * 3);
    row[0] = 0;
    for (let x = 0; x < size; x++) {
      const dx = x - size / 2 + 0.5;
      const dy = y - size / 2 + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const radius = size * 0.45;
      if (dist <= radius) {
        const innerR = size * 0.25;
        const isInner = dist <= innerR;
        row[1 + x * 3] = isInner ? 255 : r;
        row[1 + x * 3 + 1] = isInner ? 255 : g;
        row[1 + x * 3 + 2] = isInner ? 255 : b;
      } else {
        row[1 + x * 3] = 0;
        row[1 + x * 3 + 1] = 0;
        row[1 + x * 3 + 2] = 0;
      }
    }
    rawRows.push(row);
  }

  const rawData = concat(rawRows);
  const compressed = deflateStore(rawData);

  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

const outDir = 'public/icons';
if (!existsSync(outDir)) {
  mkdirSync(outDir, { recursive: true });
}

const sizes = [16, 48, 128];
for (const size of sizes) {
  const png = generatePng(size, 74, 144, 217);
  writeFileSync(join(outDir, `icon${size}.png`), png);
}
console.log('Icons generated successfully.');
