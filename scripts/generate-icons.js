// ==========================================================================
//  scripts/generate-icons.js
//  Pure Node.js PNG icon generator (zero external build tools / dependencies).
//  Generates retro pixel-art NES Tetris icons for PWA manifest.
// ==========================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ICONS_DIR = path.join(ROOT, 'icons');

// Standard CRC32 implementation for PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcData = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcData), 0);

  return Buffer.concat([lenBuf, crcData, crcBuf]);
}

/**
 * Encodes RGBA buffer to a valid PNG Buffer.
 */
function encodePNG(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk: 13 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 bits per channel
  ihdr[9] = 6; // Color type 6: RGBA
  ihdr[10] = 0; // Compression (deflate)
  ihdr[11] = 0; // Filter (standard)
  ihdr[12] = 0; // Interlace (none)
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // Scanlines with filter byte 0 (None)
  const scanlineLength = width * 4 + 1;
  const rawData = Buffer.alloc(height * scanlineLength);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * scanlineLength;
    rawData[rawOffset] = 0; // filter byte: none
    rgbaBuffer.copy(rawData, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(rawData, { level: 9 });
  const idatChunk = makeChunk('IDAT', compressed);
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * RGBA Pixel Buffer drawing canvas
 */
class PixelCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.buffer = Buffer.alloc(width * height * 4, 0);
  }

  setPixel(x, y, r, g, b, a = 255) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const offset = (y * this.width + x) * 4;
    this.buffer[offset] = r;
    this.buffer[offset + 1] = g;
    this.buffer[offset + 2] = b;
    this.buffer[offset + 3] = a;
  }

  fillRect(px, py, w, h, r, g, b, a = 255) {
    const x0 = Math.max(0, Math.floor(px));
    const y0 = Math.max(0, Math.floor(py));
    const x1 = Math.min(this.width, Math.floor(px + w));
    const y1 = Math.min(this.height, Math.floor(py + h));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        this.setPixel(x, y, r, g, b, a);
      }
    }
  }

  toPNG() {
    return encodePNG(this.width, this.height, this.buffer);
  }
}

// Authentic NES Tetris Palettes
const PURPLE_PALETTE = {
  face: [184, 0, 184],      // #b800b8
  light: [248, 120, 248],   // #f878f8
  dark: [104, 0, 104],      // #680068
  sheen: [252, 252, 252],   // #fcfcfc
  outline: [0, 0, 0, 180],
};

const RED_PALETTE = {
  face: [228, 0, 88],       // #e40058
  light: [248, 120, 152],   // #f87898
  dark: [168, 0, 32],       // #a80020
  sheen: [252, 252, 252],   // #fcfcfc
  outline: [0, 0, 0, 180],
};

/**
 * Draws an authentic NES-style beveled block.
 */
function drawBlock(canvas, px, py, size, palette = PURPLE_PALETTE) {
  const bevel = Math.max(1, Math.round(size / 8));
  const inner = size - 1;

  // Outline
  canvas.fillRect(px, py, size, 1, 0, 0, 0, 128);
  canvas.fillRect(px, py + 1, 1, inner, 0, 0, 0, 128);

  // Face
  canvas.fillRect(px + 1, py + 1, inner, inner, ...palette.face);

  // Top and left light bevel
  canvas.fillRect(px + 1, py + 1, inner, bevel, ...palette.light);
  canvas.fillRect(px + 1, py + 1, bevel, inner, ...palette.light);

  // Bottom and right dark bevel
  canvas.fillRect(px + 1, py + size - bevel, inner, bevel, ...palette.dark);
  canvas.fillRect(px + size - bevel, py + 1, bevel, inner, ...palette.dark);

  // Miter top-right and bottom-left bevel corners
  for (let i = 0; i < bevel; i++) {
    for (let j = 0; j < bevel; j++) {
      const trX = size - bevel + i;
      const trY = 1 + j;
      if (trX + trY < size) {
        canvas.setPixel(px + trX, py + trY, ...palette.light);
      }
      const blX = 1 + i;
      const blY = size - bevel + j;
      if (blX + blY < size) {
        canvas.setPixel(px + blX, py + blY, ...palette.light);
      }
    }
  }

  // Sheen pixel (spec §6.2)
  canvas.fillRect(px + bevel + 1, py + bevel + 1, bevel, bevel, ...palette.sheen);
}

/**
 * Generates an icon of the specified square dimensions.
 */
export function generateIcon(size) {
  const canvas = new PixelCanvas(size, size);

  // Black background
  canvas.fillRect(0, 0, size, size, 0, 0, 0, 255);

  // Subtle retro arcade grid dots (every 16th relative step)
  const dotStep = Math.max(8, Math.round(size / 16));
  for (let y = dotStep; y < size; y += dotStep) {
    for (let x = dotStep; x < size; x += dotStep) {
      canvas.setPixel(x, y, 26, 26, 46, 255); // #1a1a2e
    }
  }

  // T-Piece Layout: 3 blocks wide, 2 blocks high
  // Top: [0, 0], [1, 0], [2, 0]
  // Bottom: [1, 1]
  const blockSize = Math.round(size * 0.22);
  const totalW = blockSize * 3;
  const totalH = blockSize * 2;
  const startX = Math.round((size - totalW) / 2);
  const startY = Math.round((size - totalH) / 2);

  // T-piece blocks with authentic purple / red accents
  const blocks = [
    { col: 0, row: 0, palette: PURPLE_PALETTE },
    { col: 1, row: 0, palette: RED_PALETTE },    // Center block accented with authentic NES red
    { col: 2, row: 0, palette: PURPLE_PALETTE },
    { col: 1, row: 1, palette: PURPLE_PALETTE },
  ];

  for (const b of blocks) {
    const bx = startX + b.col * blockSize;
    const by = startY + b.row * blockSize;
    drawBlock(canvas, bx, by, blockSize, b.palette);
  }

  return canvas.toPNG();
}

function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
  }

  const sizes = [192, 512];
  for (const size of sizes) {
    const filePath = path.join(ICONS_DIR, `icon-${size}.png`);
    const pngBuffer = generateIcon(size);
    fs.writeFileSync(filePath, pngBuffer);
    console.log(`Generated: ${filePath} (${pngBuffer.length} bytes, ${size}x${size})`);
  }
}

// Run directly when executed
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
