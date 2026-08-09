#!/usr/bin/env node
// Genererar PNG-ikoner (pixel-G på azul botten) utan externa beroenden.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BG = [42, 79, 208], FG = [255, 255, 255], DOT = [255, 211, 77];
// 16×16-rutnät: G-glyf + punkt
const GRID = [
  "................",
  "................",
  "................",
  "....XXXXXX......",
  "...XX....XX.....",
  "...XX...........",
  "...XX...........",
  "...XX...........",
  "...XX...XXXX....",
  "...XX.....XX....",
  "...XX.....XX....",
  "....XXXXXXX.....",
  "..............OO",
  "..............OO",
  "................",
  "................",
];

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(size, file) {
  const cell = size / 16;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const ch = GRID[Math.floor(y / cell)][Math.floor(x / cell)];
      const c = ch === "X" ? FG : ch === "O" ? DOT : BG;
      row[1 + x * 3] = c[0]; row[2 + x * 3] = c[1]; row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  writeFileSync(file, png);
  console.log(file, png.length, "bytes");
}
makePng(512, "public/icon-512.png");
makePng(180, "public/icon-180.png");
