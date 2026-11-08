// Image preparation with real Chrome and only Node standard libraries.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { findBrowser, writePng } from "./png-fixture.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "prep-image.mjs");
const BROWSER = findBrowser();
const env = { ...process.env, ...(BROWSER ? { CHROME_PATH: BROWSER } : {}) };

function runCli(args, code = 0) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args.map(String)], { cwd: ROOT, encoding: "utf8", timeout: 120000, env });
  assert.equal(result.status, code, result.stdout + result.stderr);
  return result;
}

function tempFolder(t, prefix = "jstyle-image-tests-") {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

describe("prep-image CLI", () => {
  test("parse args and Windows file URL", async () => {
    const { parseArgs, fileUrl } = await import(pathToFileURL(SCRIPT).href);
    for (const args of [[], ["-h"], ["--help"], ["--HELP"]]) assert.deepEqual(parseArgs(args), { help: true });
    assert.deepEqual(parseArgs(["--", "--help"]).inputs, ["--help"]);
    assert.deepEqual(parseArgs(["--", "-h"]).inputs, ["-h"]);
    assert.deepEqual(parseArgs(["input.png", "--", "--help"]).inputs, ["input.png", "--help"]);
    assert.equal(fileUrl(String.raw`C:\project\assets\my image#1.webp`, String.raw`C:\project`, "win32"), "assets/my%20image%231.webp");
    assert.equal(fileUrl(String.raw`D:\web\my image#1.webp`, String.raw`C:\project`, "win32"), "file:///D:/web/my%20image%231.webp");
  });

  test("help and actionable validation without browser", () => {
    assert.ok(runCli(["--HELP"]).stdout.includes("사용법"));
    assert.ok(runCli(["--HELP"]).stdout.includes("프로젝트 루트에서 실행"));
    for (const [args, expected] of [[["--widht", "2"], "알 수 없는 선택지"], [["--width", "0px"], "--width 960px"],
      [["--widths", ",,"], "너비 목록이 비어 있습니다"], [["--crop", "16:no"], "--crop 16:9"],
      [["--crop", "0:0"], "--crop 16:9"], [["--focus", "left"], "--focus는 --crop과 함께"],
      [["--crop", "16:9", "--focus", "101%,0%"], "초점이 범위를 넘습니다"],
      [["--format", "avif"], "--format webp"], [["--quality", "101"], "--quality 82"],
      [["--trim=true"], "--trim은 값을 받지 않습니다"], [["--format", "png", "--quality", "80"], "PNG"],
      [["--width", "3", "--widths", "3,6"], "하나만 고르세요"]]) {
      assert.ok(runCli(["input.png", ...args], 1).stderr.includes(expected), args.join(" "));
    }
  });

  test("missing, bad files and empty directory report rerun", (t) => {
    const folder = tempFolder(t, "jstyle-image-cli-");
    fs.writeFileSync(path.join(folder, "bad.png"), "<html>not an image</html>");
    fs.writeFileSync(path.join(folder, "bad.jpg"), Buffer.from("\xff\xd8\xffbroken", "latin1"));
    fs.mkdirSync(path.join(folder, "empty"));
    const result = runCli([path.join(folder, "missing.png"), path.join(folder, "empty"), path.join(folder, "bad.png")], 1);
    const data = JSON.parse(result.stdout);
    assert.equal(data.errors.length, 3);
    assert.ok(data.errors.every((e) => "command" in e && "argv" in e));
    assert.ok(data.errors.every((e) => path.resolve(e.argv[1]) === SCRIPT), "Recovery must work when the skill is invoked from another project directory");
    assert.ok(result.stderr.includes("다시 실행: node"));
    assert.equal(fs.existsSync(path.join(folder, "web-images")), false);
  });

  test("animation signatures are rejected without decoding", (t) => {
    const folder = tempFolder(t, "jstyle-image-cli-");
    const apng = path.join(folder, "animated.png");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(8);
    fs.writeFileSync(apng, Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), length, Buffer.from("acTL"), Buffer.alloc(12)]));
    const webp = path.join(folder, "animated.webp");
    const size = Buffer.alloc(4);
    size.writeUInt32LE(12);
    fs.writeFileSync(webp, Buffer.concat([Buffer.from("RIFF"), size, Buffer.from("WEBPANIM"), Buffer.alloc(4)]));
    const data = JSON.parse(runCli([apng, webp], 1).stdout);
    assert.equal(data.errors.length, 2);
    assert.ok(data.errors.every((e) => e.message.includes("애니메이션")));
  });
});

describe("prep-image in a browser", { skip: BROWSER ? false : "Chrome/Chromium/Edge is needed" }, () => {
  // Noise compresses poorly as PNG but well with lossy WebP. Transparent and
  // partial-alpha boundaries make the alpha check read the delivered file,
  // not its extension.
  function setup(t) {
    const folder = tempFolder(t);
    const source = path.join(folder, "source image.png");
    writePng(source, 180, 120, (x, y) => [(x * 71 + y * 37) % 256, (x * 17 + y * 93) % 256, (x * 117 + y * 7) % 256,
      x < 20 || y < 10 || x >= 160 || y >= 110 ? 0 : x === 20 ? 128 : 255]);
    const out = path.join(folder, "output");
    const prepare = (args, code = 0) => {
      const result = runCli([...args, "--out", out], code);
      return [JSON.parse(result.stdout), result];
    };
    return { folder, source, prepare };
  }

  // Independent browser decode of the saved bytes, including fallback files.
  function pixels(file, points) {
    const js = `import {readFileSync} from 'node:fs';
import {canvasBrowser} from './scripts/prep-image.mjs';
const b=await canvasBrowser();try {const data=readFileSync(process.argv[1]).toString('base64');
console.log(JSON.stringify(await b.evaluate(\`(async()=>{const i=new Image();i.src='data:image/png;base64,\${data}';await i.decode();
const c=document.createElement('canvas');c.width=i.naturalWidth;c.height=i.naturalHeight;const x=c.getContext('2d');x.drawImage(i,0,0);
return {width:c.width,height:c.height,points:\${process.argv[2]}.map(p=>Array.from(x.getImageData(...p,1,1).data))};})()\`)));
}finally {await b.close()}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", js, file, JSON.stringify(points)], { cwd: ROOT, env, encoding: "utf8", timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  test("preserves transparency and never upscales", (t) => {
    const { source, prepare } = setup(t);
    const [data, result] = prepare([source, "--WIDTHS=90px,180,1k", "--FORMAT=WEBP", "--quality=82%"]);
    const record = data.files[0];
    assert.deepEqual(record.outputs.map((o) => [o.width, o.height]), [[90, 60], [180, 120]]);
    assert.ok(record.outputs.every((o) => !o.keptOriginal));
    assert.ok(record.html.includes("180w"));
    assert.ok(!record.html.includes("1000w"));
    assert.ok(record.html.includes('sizes="100vw"'));
    assert.ok(result.stderr.includes("180×120"));
    assert.ok(result.stderr.includes('<img src="'), "Also print directly pasteable HTML without JSON escaping");
    const decoded = pixels(record.outputs.at(-1).saved, [[0, 0], [20, 50], [90, 50]]);
    assert.deepEqual(decoded.points.map((p) => p[3]), [0, 128, 255]);
  });

  test("smaller original is copied with correct type and srcset", (t) => {
    const { folder, prepare } = setup(t);
    const tiny = path.join(folder, "tiny wrong.webp");
    writePng(tiny, 2, 2, () => [1, 2, 3, 255]);
    const [data, result] = prepare([tiny, "--format", "PNG", "--widths", "1,2,100"]);
    const record = data.files[0];
    assert.equal(record.outputs.length, 1);
    const output = record.outputs[0];
    assert.ok(output.keptOriginal);
    assert.deepEqual([output.width, output.height], [2, 2]);
    assert.equal(path.extname(output.saved), ".png");
    assert.deepEqual(fs.readFileSync(output.saved), fs.readFileSync(tiny));
    assert.ok(result.stderr.includes("원본 유지"));
    assert.ok(record.html.includes(" 2w"));
    assert.ok(record.html.includes("%20"));
  });

  test("crop fallback keeps one composition", (t) => {
    const { folder, prepare } = setup(t);
    const solid = path.join(folder, "solid.png");
    writePng(solid, 100, 100, () => [12, 34, 56, 255]);
    const [data] = prepare([solid, "--format", "png", "--crop", "2:1", "--widths", "1,100"]);
    const record = data.files[0];
    assert.equal(record.outputs.length, 1);
    assert.ok(record.outputs[0].keptOriginal);
    assert.deepEqual([record.outputs[0].width, record.outputs[0].height], [100, 100]);
    assert.ok(record.warnings.join("\n").includes("서로 다른 배치"));
  });

  test("batch errors do not block good files or overwrite sources", (t) => {
    const { folder, source, prepare } = setup(t);
    const sourceBytes = fs.readFileSync(source);
    fs.writeFileSync(path.join(folder, "bad.PNG"), "download failed");
    fs.writeFileSync(path.join(folder, "ignored.txt"), "not a picture");
    fs.mkdirSync(path.join(folder, "subdir"));
    fs.writeFileSync(path.join(folder, "subdir", "bad.png"), "skip");
    const other = path.join(folder, "other");
    fs.mkdirSync(other);
    fs.copyFileSync(source, path.join(other, path.basename(source)));
    const [data] = prepare([folder, path.join(other, path.basename(source)), path.join(folder, "missing.jpg"), "--width", "64"], 1);
    assert.equal(data.files.length, 2);
    assert.equal(data.errors.length, 2);
    const saved = data.files.flatMap((f) => f.outputs.map((o) => o.saved));
    assert.equal(new Set(saved).size, 2);
    assert.deepEqual(fs.readFileSync(source), sourceBytes);
    const old = new Map(saved.map((p) => [p, fs.readFileSync(p)]));
    prepare([source, "--width", "64"]);
    for (const [p, bytes] of old) assert.deepEqual(fs.readFileSync(p), bytes);
  });

  test("trim exact alpha bounds, crop focus and sizes", (t) => {
    const { folder, source, prepare } = setup(t);
    let [data] = prepare([source, "--trim", "--resize", "70PX"]);
    let record = data.files[0];
    assert.deepEqual(record.crop, { x: 20, y: 10, width: 140, height: 100 });
    assert.deepEqual([record.outputs[0].width, record.outputs[0].height], [70, 50]);
    // Crop a wide noisy image into left or right squares and check which color dominates.
    const wide = path.join(folder, "wide.png");
    writePng(wide, 200, 100, (x, y) => (x < 100 ? [180 + ((x * y) % 70), (y * 17) % 60, 0, 255] : [0, (y * 17) % 60, 180 + ((x * y) % 70), 255]));
    for (const [focus, x, channel] of [["LEFT", 0, 0], ["100%,0%", 100, 2]]) {
      [data] = prepare([wide, "--ratio", "1/1", "--focus", focus, "--width", "50", "--sizes", "50vw"]);
      record = data.files[0];
      assert.equal(record.crop.x, x);
      assert.ok(record.html.includes('sizes="50vw"'));
      const px = pixels(record.outputs[0].saved, [[25, 25]]).points[0];
      assert.ok(px[channel] > 150, `${focus}: ${px}`);
    }
  });

  test("JPEG rejects alpha but opaque JPEG and PNG encode", (t) => {
    const { folder, source, prepare } = setup(t);
    let [data] = prepare([source, "--format", "jpg"], 1);
    assert.ok(data.errors[0].message.includes("--format webp"));
    assert.equal(data.errors[0].argv[data.errors[0].argv.indexOf("--format") + 1], "webp");
    // The rest of a mixed batch still succeeds, and a truncated JPEG gets a decode error.
    const opaque = path.join(folder, "opaque.png");
    writePng(opaque, 80, 60, (x, y) => [(x * y) % 256, (x * 37) % 256, (y * 17) % 256, 255]);
    fs.writeFileSync(path.join(folder, "broken.jpg"), Buffer.from("\xff\xd8\xffbroken", "latin1"));
    [data] = prepare([opaque, path.join(folder, "broken.jpg"), "--format", "JpG", "--width", "40"], 1);
    assert.equal(data.files.length, 1);
    assert.ok(data.errors[0].message.includes("이미지 디코딩에 실패했습니다"));
    assert.equal(path.extname(data.files[0].outputs[0].saved), ".jpg");
    [data] = prepare([source, "--format", "png", "--width", "30"]);
    const decoded = pixels(data.files[0].outputs[0].saved, [[0, 0], [15, 10]]);
    assert.deepEqual(decoded.points.map((p) => p[3]), [0, 255]);
  });

  test("fully transparent trim and animation fail explicitly", (t) => {
    const { folder, prepare } = setup(t);
    const blank = path.join(folder, "blank.png");
    writePng(blank, 8, 8, () => [0, 0, 0, 0]);
    const gif = path.join(folder, "animated.gif");
    fs.writeFileSync(gif, "GIF89a");
    const [data] = prepare([blank, gif, "--trim"], 1);
    assert.equal(data.errors.length, 2);
    assert.ok(data.errors[0].message.includes("이미지 전체가 투명합니다"));
    assert.ok(data.errors[1].message.includes("정지"));
  });

  test("does not follow symlinks", (t) => {
    const { folder, source, prepare } = setup(t);
    const link = path.join(folder, "linked.png");
    try {
      fs.symlinkSync(source, link);
    } catch {
      t.skip("symlinks unavailable");
      return;
    }
    let [data] = prepare([link], 1);
    assert.ok(data.errors[0].message.includes("심볼릭 링크"));
    [data] = prepare([folder]);
    assert.equal(data.files.length, 1);
  });
});
