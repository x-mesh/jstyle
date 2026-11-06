import fs from "node:fs";
import zlib from "node:zlib";

import { findChrome } from "../scripts/chrome.mjs";

export function findBrowser() {
  try {
    return findChrome();
  } catch {
    return null;
  }
}

function encodePng(width, height, colorType, rows) {
  const chunk = (kind, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(kind, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

// RGBA PNG whose pixel(x, y) returns [r, g, b, a].
export function writePng(file, width, height, pixel) {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  fs.writeFileSync(file, encodePng(width, height, 6, rows));
}

export function writeSolidPng(file, width, height, rgb) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(width).fill(rgb).flat())]);
  fs.writeFileSync(file, encodePng(width, height, 2, Buffer.concat(Array(height).fill(row))));
}
