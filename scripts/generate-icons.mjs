import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';

// ── PNG エンコーディングユーティリティ ──────────────────────────────

function crc32(buf) {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32BE(n) {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function adler32(data) {
  let a = 1, b = 0;
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
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
  return concat([new Uint8Array([0x78, 0x01]), ...chunks, uint32BE(adler)]);
}

function concat(arrays) {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) { result.set(arr, offset); offset += arr.length; }
  return result;
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const crcData = concat([typeBytes, data]);
  return concat([uint32BE(data.length), typeBytes, data, uint32BE(crc32(crcData))]);
}

// ── # アイコン描画 ────────────────────────────────────────────────────

/**
 * (x, y) ピクセルが "#" シンボルの内側かどうかを判定する。
 * "#" は 4 本の矩形バーで構成:
 *   ・左右の縦バー × 2
 *   ・上下の横バー × 2
 */
function isHashPixel(x, y, size) {
  // 縦バーの x 範囲
  const lx1 = Math.round(size * 0.28), lx2 = Math.round(size * 0.43);
  const rx1 = Math.round(size * 0.57), rx2 = Math.round(size * 0.72);
  // 横バーの y 範囲
  const ty1 = Math.round(size * 0.30), ty2 = Math.round(size * 0.45);
  const by1 = Math.round(size * 0.56), by2 = Math.round(size * 0.71);
  // 縦バーが伸びる y 範囲・横バーが伸びる x 範囲
  const vY1 = Math.round(size * 0.08), vY2 = Math.round(size * 0.92);
  const hX1 = Math.round(size * 0.10), hX2 = Math.round(size * 0.90);

  const inLeftBar  = x >= lx1 && x < lx2 && y >= vY1 && y < vY2;
  const inRightBar = x >= rx1 && x < rx2 && y >= vY1 && y < vY2;
  const inTopBar   = y >= ty1 && y < ty2  && x >= hX1 && x < hX2;
  const inBottomBar = y >= by1 && y < by2 && x >= hX1 && x < hX2;

  return inLeftBar || inRightBar || inTopBar || inBottomBar;
}

function generatePng(size) {
  const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = new Uint8Array([
    ...uint32BE(size), ...uint32BE(size),
    8, 2, 0, 0, 0,  // 8bit RGB
  ]);

  // 白背景 / ダークグレーの "#"
  const bgR = 255, bgG = 255, bgB = 255;
  const fgR = 45,  fgG = 45,  fgB = 45;  // #2D2D2D

  const rawRows = [];
  for (let y = 0; y < size; y++) {
    const row = new Uint8Array(1 + size * 3);
    row[0] = 0; // フィルタなし
    for (let x = 0; x < size; x++) {
      const isFg = isHashPixel(x, y, size);
      row[1 + x * 3]     = isFg ? fgR : bgR;
      row[1 + x * 3 + 1] = isFg ? fgG : bgG;
      row[1 + x * 3 + 2] = isFg ? fgB : bgB;
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

// ── 出力 ─────────────────────────────────────────────────────────────

const outDir = 'public/icons';
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

for (const size of [16, 48, 128]) {
  writeFileSync(join(outDir, `icon${size}.png`), generatePng(size));
}
console.log('Icons generated successfully.');
