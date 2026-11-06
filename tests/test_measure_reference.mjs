import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { decodePng } from "../scripts/measure_reference.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "measure_reference.mjs");

function png(width, height, pixel) {
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  }
  const chunk = (kind, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const data = Buffer.concat([Buffer.from(kind, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(data) >>> 0);
    return Buffer.concat([length, data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

function reference(x, y) {
  if (x >= 10 && x < 30 && y >= 10 && y < 30) return [48, 60, 53, 255]; // #303C35 forest ink
  if (x >= 40 && x < 70 && y >= 15 && y < 45) {
    return x >= 50 && x < 60 && y >= 25 && y < 35 ? [210, 120, 60, 255] : [0, 255, 0, 255]; // ochre on chroma green
  }
  return [250, 248, 241, 255]; // #FAF8F1 warm paper
}

function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-measure-test-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, "ref.png"), png(80, 60, reference));
  return folder;
}

const run = (args, cwd) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8" });

test("direct mode reads colors, maps boxes to CSS and keys out the extract background", (t) => {
  const folder = setup(t);
  const out = path.join(folder, "direct-out");
  const result = run(["ref.png", "--color", "paper=0,0,8,8", "--color", "ink=12,12,12,12", "--box", "card=10,10,20,20",
    "--extract", "badge=40,15,30,30", "--key-color", "#00FF00", "--despill", "--css-width", "160", "--out-dir", out], folder);
  assert.equal(result.status, 0, result.stderr);
  const regions = Object.fromEntries(JSON.parse(result.stdout).regions.map((region) => [region.name, region]));
  assert.equal(regions.paper.color.median_hex, "#FAF8F1");
  assert.equal(regions.ink.color.median_hex, "#303C35");
  assert.deepEqual(regions.card.css_box, [20, 20, 40, 40]);
  assert.match(result.stdout, /"css_box": \[\r?\n\s+20\.0,/);
  const badge = decodePng(fs.readFileSync(path.join(out, "badge.png")));
  assert.deepEqual([badge.width, badge.height], [30, 30]);
  assert.equal(badge.getpixel(0, 0)[3], 0);
  assert.deepEqual([...badge.getpixel(15, 15)], [210, 120, 60, 255]);
});

test("manifest mode writes measurements and annotations and refuses an existing output folder", (t) => {
  const folder = setup(t);
  fs.writeFileSync(path.join(folder, "manifest.json"), JSON.stringify({
    reference: "ref.png",
    css_viewport_width: 160,
    regions: [
      { name: "bg", kind: "color", box: [0, 0, 8, 8] },
      { name: "col_a", kind: "box", box: [10, 10, 20, 20], group: "cols" },
      { name: "col_b", kind: "box", box: [40, 10, 20, 20], group: "cols" },
    ],
  }));
  const result = run(["--manifest", "manifest.json", "--out-dir", "measured"], folder);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual([summary.regions, summary.groups, summary.output], [3, 1, "measured"]);
  const measured = JSON.parse(fs.readFileSync(path.join(folder, "measured", "measurements.json"), "utf8"));
  assert.equal(measured.groups[0].median_gap, 10);
  assert.ok(fs.statSync(path.join(folder, "measured", "annotations.svg")).isFile());
  const again = run(["--manifest", "manifest.json", "--out-dir", "measured"], folder);
  assert.equal(again.status, 2);
  assert.match(again.stderr, /^측정 실패：\[Errno \d+\] File exists: 'measured'/);
});

test("the PNG reader covers the 8-bit color types and leaves other PNGs to Chrome", () => {
  const image = decodePng(png(3, 2, (x, y) => [x * 10, y * 20, 30, 255]));
  assert.deepEqual([...image.getpixel(2, 1)], [20, 20, 30, 255]);
  const sixteenBit = png(1, 1, () => [0, 0, 0, 255]);
  sixteenBit[24] = 16;
  assert.equal(decodePng(sixteenBit), null);
  assert.equal(decodePng(Buffer.from("not a png")), null);
});

test("usage errors exit 2 with the argparse message", (t) => {
  const folder = setup(t);
  const result = run(["ref.png", "--c", "x=0,0,1,1"], folder);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /error: ambiguous option: --c could match --color, --css-width/);
  assert.match(run(["ref.png", "--box", "b=70,50,20,20"], folder).stderr, /영역 밖이거나 넓이가 올바르지 않습니다/);
});
