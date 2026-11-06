import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import zlib from "node:zlib";

import { findChrome } from "../scripts/chrome.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCRIPT = path.join(ROOT, "scripts", "shoot.mjs");
const WINDOWS = process.platform === "win32";

function which(name) {
  const extensions = WINDOWS ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const extension of extensions) {
      const file = path.join(dir, name + extension);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // Not in this PATH entry.
      }
    }
  }
  return null;
}

function findBrowser() {
  try {
    return findChrome();
  } catch {
    return null;
  }
}

const BROWSER = findBrowser();
const FFMPEG = which("ffmpeg");
const FFPROBE = which("ffprobe");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function run(command, args, { cwd = ROOT, env = process.env, timeout = 10, input, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeout} s: ${command} ${args.join(" ")}`));
    }, timeout * 1000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // Python text mode reads CRLF as LF; several assertions compare whole lines.
    const decode = (chunks) => (binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n"));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout: decode(stdout), stderr: decode(stderr) });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

const node = (args, options) => run(process.execPath, [SCRIPT, ...args], options);

async function check(promise) {
  const result = await promise;
  assert.equal(result.status, 0, result.stderr.toString());
  return result;
}

function tempDir(t, prefix) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

async function dry(...args) {
  let ok = true;
  if (typeof args.at(-1) === "object") ok = args.pop().ok;
  const result = await node(["page.html", "--dry-run", ...args]);
  assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
  return ok ? JSON.parse(result.stdout) : result.stderr;
}

const FAIL = { ok: false };

function includes(haystack, needle, message) {
  assert.ok(haystack.includes(needle), message ?? `${JSON.stringify(needle)} not found in:\n${haystack}`);
}

function excludes(haystack, needle, message) {
  assert.ok(!haystack.includes(needle), message ?? `${JSON.stringify(needle)} unexpectedly found in:\n${haystack}`);
}

function indexOf(haystack, needle) {
  const index = haystack.indexOf(needle);
  assert.notEqual(index, -1, `${JSON.stringify(needle)} not found in:\n${haystack}`);
  return index;
}

function almostEqual(actual, expected, delta = 5e-8, message) {
  assert.ok(Math.abs(actual - expected) <= delta, message ?? `${actual} != ${expected} within ${delta}`);
}

const count = (text, needle) => text.split(needle).length - 1;
const replaceText = (text, from, to) => text.split(from).join(to);
const read = (file) => fs.readFileSync(file, "utf8");
const readJson = (file) => JSON.parse(read(file));
const report = (dir) => readJson(path.join(dir, "report.json"));
const journalRows = (file) => read(file).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const sameBytes = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));
const isFile = (file) => fs.existsSync(file) && fs.statSync(file).isFile();
const shellQuote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";

function pngSize(file) {
  const data = fs.readFileSync(file);
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

function listDir(dir, keep) {
  try {
    return fs.readdirSync(dir).filter(keep);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

function writeSolidPng(file, width, height, rgb) {
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
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: width * 3 }, (_, i) => rgb[i % 3])]);
  const pixels = zlib.deflateSync(Buffer.concat(Array(height).fill(row)));
  fs.writeFileSync(file, Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", pixels), chunk("IEND", Buffer.alloc(0))]));
}

async function framePixel(file, x = 20, y = 20) {
  const result = await run("ffmpeg", ["-v", "error", "-i", file, "-vf", `format=rgb24,crop=1:1:${x}:${y}`, "-frames:v", "1",
    "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { binary: true, timeout: 10 });
  assert.equal(result.status, 0, result.stderr.toString());
  assert.equal(result.stdout.length, 3);
  return [...result.stdout];
}

const ENCODER_WRITER = `import {readFileSync} from 'node:fs'; import {basename} from 'node:path';
const source=readFileSync(process.argv[1],'utf8');
const writer=source.slice(source.indexOf('function screencastList('),source.indexOf('async function record('));
const frames=JSON.parse(process.argv[2]);const finished=Number(process.argv[3]);
process.stdout.write(eval(writer+'; screencastList(frames,finished)'));`;

test("encoder keeps short feedback at its original time", { skip: FFMPEG ? false : "ffmpeg is needed to inspect encoded frames" }, async (t) => {
  const folder = tempDir(t, "jstyle-shoot-encoding-");
  for (const [name, color] of [["red", [255, 0, 0]], ["blue", [0, 0, 255]], ["green", [0, 255, 0]]]) {
    const ppm = Buffer.concat([Buffer.from("P6\n64 64\n255\n"), Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => color[i % 3]))]);
    await check(run("ffmpeg", ["-y", "-v", "error", "-f", "image2pipe", "-i", "-", "-frames:v", "1", path.join(folder, name + ".jpg")],
      { input: ppm, binary: true }));
  }
  // Exercise the production concat writer without timing a real browser animation.
  const frames = [["red", 0], ["blue", 0.949], ["green", 0.965], ["blue", 2.13]].map(([name, t]) => ({ name: name + ".jpg", t }));
  let result = await check(run(process.execPath, ["--input-type=module", "-e", ENCODER_WRITER, SCRIPT, JSON.stringify(frames), "2.146"]));
  const list = path.join(folder, "list.txt");
  fs.writeFileSync(list, result.stdout);
  const video = path.join(folder, "record.mp4");
  await check(run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list,
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30", "-pix_fmt", "yuv420p", video], { binary: true }));
  let decoded = (await check(run("ffmpeg", ["-v", "error", "-i", video, "-vf", "format=rgb24,crop=1:1:32:32", "-pix_fmt", "rgb24",
    "-f", "rawvideo", "-"], { binary: true }))).stdout;
  // The 949ms blue feedback overlaps the 30fps sample at frame 28; default JPEG
  // time-base rounding used to erase it while the separately saved JPEG survived.
  const [red, green, blue] = decoded.subarray(28 * 3, 29 * 3);
  assert.ok(red < 50, String(red));
  assert.ok(green < 50, String(green));
  assert.ok(blue > 180, String(blue));
  // The end screenshot must also survive an ending halfway between output ticks.
  const tailFrames = [{ name: "red.jpg", t: 0 }, { name: "blue.jpg", t: 0.95 }];
  result = await check(run(process.execPath, ["--input-type=module", "-e", ENCODER_WRITER, SCRIPT, JSON.stringify(tailFrames), ".950"]));
  fs.writeFileSync(list, result.stdout);
  await check(run("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", "fps=30", "-pix_fmt", "yuv420p", video],
    { binary: true }));
  decoded = (await check(run("ffmpeg", ["-v", "error", "-i", video, "-vf", "format=rgb24,crop=1:1:32:32", "-pix_fmt", "rgb24",
    "-f", "rawvideo", "-"], { binary: true }))).stdout;
  assert.ok(decoded.at(-1) > 180, "The appended screenshot must be the encoded last frame");
  assert.ok(decoded.length / (3 * 30) < 3, "A sub-second recording must not be padded to three seconds");
});

test("help", async () => {
  const result = await node(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  includes(result.stdout, "사용법");
});

test("timeout scale validation", async () => {
  const plan = await dry("--timeout-scale", "2");
  assert.equal(plan.options["timeout-scale"], "2");
  for (const value of ["0", "-1", "0.5", "NaN", "Infinity", "slow"]) {
    const message = await dry("--timeout-scale", value, FAIL);
    includes(message, "받은 값: " + value);
    includes(message, "--timeout-scale 2");
  }
});

test("missing target", async () => {
  const result = await node([]);
  assert.notEqual(result.status, 0);
});

test("unknown option", async () => {
  for (const args of [["--xxx"], ["--xxx", "value"]]) {
    const result = await node(args);
    assert.equal(result.status, 1, args.join(" "));
    includes(result.stderr, "알 수 없는 선택지 --xxx");
    includes(result.stderr, "이렇게 쓰려던 것인가요:");
    assert.equal(result.stdout, "");
  }
});

test("missing option value", async () => {
  for (const option of ["--out", "--size", "--states", "--param", "--zoom", "--steps", "--hold", "--wait", "--compare", "--timeout-scale", "--selector"]) {
    for (const following of [[], ["--force"]]) {
      const result = await node([option, ...following]);
      assert.equal(result.status, 1, `${option} ${following.join(" ")}`);
      assert.equal(result.stderr, `shoot：${option} 값 하나가 필요합니다\n`);
    }
  }
});

test("console locale does not change argv or output encoding", async () => {
  // The Python suite ran under a GBK console in CI; this keeps that encoding in the child environment.
  const gbk = { ...process.env, LC_ALL: "zh_CN.GBK", LC_CTYPE: "zh_CN.GBK", LANG: "zh_CN.GBK" };
  for (const args of [["page.html", "--dry-run", "--steps", "고친 뒤 저장: click text=전"], ["--xxx"], ["page.html", "--dry-run", "--steps", "clik .open"]]) {
    const utf8 = await node(args);
    const legacy = await node(args, { env: gbk });
    assert.deepEqual(legacy, utf8, args.join(" "));
  }
  const plan = JSON.parse((await node(["page.html", "--dry-run", "--steps", "고친 뒤 저장: click text=전"], { env: gbk })).stdout);
  assert.equal(plan.groups[0].name, "고친 뒤 저장");
  assert.equal(plan.groups[0].steps[0].selector.value, "전");
});

test("selector parsing and incompatible modes", async () => {
  for (const [raw, expected] of [[".card", { kind: "css", value: ".card" }],
    ['text="Save"', { kind: "text", value: "Save" }],
    ['button:has-text("Save")', { kind: "has-text", css: "button", value: "Save" }]]) {
    assert.deepEqual((await dry("--selector", raw)).selector, expected, raw);
  }
  assert.equal((await dry("--selector=.card", "--thumb")).selector.value, ".card");
  for (const flag of ["--full", "--record", "--motion", "--entry", "--evidence"]) {
    const message = await dry("--selector", ".card", flag, FAIL);
    includes(message, "--selector");
    includes(message, flag);
  }
  includes(await dry("--selector", "   ", FAIL), "선택자가 없습니다");
});

test("multiple targets dry run", async () => {
  for (const args of [["a.html", "b.html", "c.html"], ["a.html,b.html,c.html"]]) {
    const result = await node([...args, "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.target, "a.html");
    assert.deepEqual(plan.targets, ["a.html", "b.html", "c.html"]);
  }
  assert.ok(!("targets" in (await dry())));
  includes((await dry("other.html", "--no-sheet")).flags, "no-sheet");
});

test("explorer directory and manifest dry run", async (t) => {
  const folder = tempDir(t, "jstyle-explore-cli-");
  const plan = async (target, ok = true) => {
    const result = await node([target, "--dry-run"]);
    assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
    return ok ? JSON.parse(result.stdout) : result.stderr;
  };
  includes(await plan(folder, false), "폴더에서 안을 찾을 수 없습니다 HTML");
  for (const name of ["b.html", "a.html", "style-explorer.html"]) fs.writeFileSync(path.join(folder, name), "<div>Candidate</div>");
  const expected = ["a.html", "b.html"].map((name) => path.join(folder, name));
  assert.deepEqual((await plan(folder)).targets, expected);
  fs.writeFileSync(path.join(folder, "index.html"), "<div>Index</div>");
  assert.equal((await plan(folder)).target, folder);
  assert.ok(!("targets" in (await plan(folder))));
  const manifest = path.join(folder, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ candidates: [
    { kind: "html", source: "b.html", id: "beta", name: "두 번째 안" },
    { source: "a.html", id: "alpha", name: "첫 번째 안" },
    { kind: "image", source: "sample.png" },
    { kind: "html", source: "https://example.test/page.html" },
  ] }));
  for (const target of [folder, manifest]) {
    const parsed = await plan(target);
    assert.equal(parsed.target, expected[1]);
    assert.deepEqual(parsed.targets, [...expected].reverse());
  }
  fs.writeFileSync(manifest, "{bad json");
  includes(await plan(folder, false), "읽을 수 없습니다 manifest");
});

test("dry run corpus regressions", async () => {
  // Twenty corpus patterns; project-specific classes, labels and text are neutralized.
  const cases = [
    ['click "[data-thread=sample]"', "click", "[data-thread=sample]"],
    ['click [data-id="sample"]', "click", '[data-id="sample"]'],
    ['click \'.cause [data-latest-release]\'', "click", ".cause [data-latest-release]"],
    ["click .nav button[data-view=sample]", "click", ".nav button[data-view=sample]"],
    ['click [aria-label="Send money"]', "click", '[aria-label="Send money"]'],
    ['click "[aria-label=\\"Send money\\"]"', "click", '[aria-label="Send money"]'],
    ['click \'[aria-label="Start Sample task"]\'', "click", '[aria-label="Start Sample task"]'],
    ['click ".nav button:nth-child(3)"', "click", ".nav button:nth-child(3)"],
    ['hover "[data-message=sample] .reaction"', "hover", "[data-message=sample] .reaction"],
    ['drag "[data-tile=\\"1\\"] .tile-paper" 240 0', "drag", '[data-tile="1"] .tile-paper'],
    ['drag [data-id="sample"] 214 -350', "drag", '[data-id="sample"]'],
    ['drag ".sample-line:nth-child(2)" 45 0', "drag", ".sample-line:nth-child(2)"],
    ["type #message-input 예시 내용", "type", "#message-input"],
    ['type [aria-label="Message box"] 안녕하세요', "type", '[aria-label="Message box"]'],
    ['type "#search" Sample', "type", "#search"],
    ["click text=More", "click", "More"],
    ['click button:has-text("Undo")', "click", "Undo"],
    ["wait450", "wait", null],
    ["key ControlOrMeta+A", "key", null],
    ["key Meta+r", "key", null],
  ];
  for (const [raw, action, selector] of cases) {
    const step = (await dry("--steps", raw)).groups[0].steps[0];
    assert.equal(step.action, action, raw);
    if (selector !== null) assert.equal(step.selector.value, selector, raw);
  }
});

test("dry run balanced steps and parameters", async () => {
  const parsed = await dry("--steps", 'open: click [data-label="a;b"]; click :is([data-label="a;b"]); '
    + 'type ".form input" "hello; world"; select #choice "Second item"; '
    + "wait450; wait 450ms; wait 0.5s; key Shift+Tab",
  "--steps", 'click :has-text(\'Undo; action\')', "--mark", '1=text="a;b"');
  const steps = parsed.groups[0].steps;
  assert.equal(parsed.groups[0].name, "open");
  assert.equal(steps.length, 8);
  assert.deepEqual(steps[2].params, { text: "hello; world" });
  assert.deepEqual(steps[3].params, { value: "Second item" });
  assert.deepEqual(steps.slice(4, 7).map((s) => s.params.ms), [450, 450, 500]);
  assert.equal(parsed.groups[1].name, null);
  assert.equal(parsed.marks[0].selector.kind, "text");
  for (const [raw, expected] of [['type #input "text [without a closing bracket"', "text [without a closing bracket"],
    ["type #input don't stop", "don't stop"],
    ['type "body [aria-label="Message box"]" "hello world"', "hello world"]]) {
    assert.equal((await dry("--steps", raw)).groups[0].steps[0].params.text, expected);
  }
  for (const [raw, action] of [["doubleclick .a", "dblclick"], ["press Control+A", "key"],
    ['fill #input "hello"', "fill"], ["sleep 0.5s", "wait"], ["waitfor text=Ready", "waitfor"]]) {
    assert.equal((await dry("--steps=" + raw)).groups[0].steps[0].action, action);
  }
});

test("fill parses as replacement action", async () => {
  for (const [raw, kind, value, text] of [
    ['fill ".form input" "hello world"', "css", ".form input", "hello world"],
    ['fill [aria-label="Message box"] ""', "css", '[aria-label="Message box"]', ""],
    ['fill text="Old message" new', "text", "Old message", "new"],
    ["fill textarea:has-text('Old message') new", "has-text", "Old message", "new"],
  ]) {
    const step = (await dry("--steps", raw)).groups[0].steps[0];
    assert.equal(step.action, "fill", raw);
    assert.equal(step.selector.kind, kind, raw);
    assert.equal(step.selector.value, value, raw);
    assert.deepEqual(step.params, { text }, raw);
  }
  includes(await dry("--steps", "fill #field", FAIL), '예: fill #field "hello world"');
});

test("dry run does not launch or write and shares errors", async (t) => {
  const folder = tempDir(t, "jstyle-shoot-dry-");
  const output = path.join(folder, "never-created");
  const env = { ...process.env, CHROME_PATH: path.join(folder, "no-browser") };
  const args = ["missing-page.html", "--out", output];
  let result = await node([...args, "--dry-run", "--steps", "click .nav button"], { env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).groups[0].steps[0].selector.kind, "css");
  assert.ok(!fs.existsSync(output));
  const errors = [];
  for (const extra of [[], ["--dry-run"]]) {
    result = await node([...args, ...extra, "--steps", "drag .tile 20 nope"], { env });
    assert.equal(result.status, 1);
    errors.push(result.stderr);
  }
  assert.equal(errors[0], errors[1]);
});

test("option forms aliases and errors", async () => {
  const parsed = await dry("--size=desktop,phone,mobile,800x600", "--zoom", "1,2", "--query=a=1&b=2", "--states", "idle,done");
  assert.deepEqual(parsed.sizes, [{ w: 1440, h: 900 }, { w: 390, h: 844 }, { w: 800, h: 600 }]);
  assert.deepEqual(parsed.zooms, [1, 2]);
  assert.deepEqual((await dry("--size", "mobile")).sizes, [{ w: 390, h: 844 }]);
  assert.ok(parsed.notices.some((n) => n.includes("크기 겹친 항목을 뺐습니다")), parsed.notices.join("\n"));
  assert.deepEqual((await dry()).sizes, [{ w: 390, h: 844 }]);
  assert.equal((await dry("--thumb")).options.wait, "150");
  includes(await dry("--thumb", "--full", FAIL), "--thumb 작은 미리보기에만 씁니다");
  for (const flag of ["--full", "--thumb", "--mask", "--sheet", "--record", "--motion", "--entry", "--evidence"]) {
    const error = await dry(flag, "extra", FAIL);
    includes(error, "page.html 와 extra");
    includes(error, flag + " 인수를 받지 않음");
  }
  for (const [args, expected] of [
    [["--zoon", "2"], "--zoom"],
    [["--motion", ".respond"], "--motion 인수를 받지 않음"],
    [["--full", "extra"], "page.html 와 extra"],
    [["--record=true"], "인수를 받지 않음"], [["--zoom=0"], "--zoom 1,2"],
    [["--size=0x900"], "--size desktop"], [["--wait=abc"], "--wait 1000"],
    [["--steps", "clik .open"], "이렇게 쓰려던 것인가요: click"],
    [["--steps", "drag .a 1 nope"], "drag .tiles .paper 240 0"],
    [["--steps", "wait nope"], "wait 450ms"],
    [["--steps", 'click [aria-label="x]'], "짝이 맞지 않습니다"],
    [["--steps", "key Invalid+A"], "ControlOrMeta+A"],
    [["--steps", "same: click .a", "--steps", "same: click .b"], "이름이 겹칩니다"],
  ]) {
    includes(await dry(...args, FAIL), expected);
  }
});

test("action names are valid group names", async () => {
  for (const [name, body] of [["scroll", "scroll 950; wait 300"], ["hover", "hover .x"], ["click", "click .x"], ["sleep", "wait 0"]]) {
    const group = (await dry("--steps", name + ": " + body)).groups[0];
    assert.equal(group.name, name);
    assert.equal(group.id, name);
    assert.equal(group.steps[0].raw, body.split(";")[0]);
  }
});

test("glued numbers only apply to numeric options", async () => {
  const compact = await dry("--hold1000", "--wait450", "--zoom1,2", "--timeout-scale2", "--steps", "wait450; wait0.5s; sleep450");
  const spaced = await dry("--hold", "1000", "--wait", "450", "--zoom", "1,2", "--timeout-scale", "2", "--steps", "wait450; wait0.5s; sleep450");
  assert.deepEqual(compact, spaced);
  assert.deepEqual(compact.groups[0].steps.map((step) => step.params.ms), [450, 500, 450]);
  for (const arg of ["--out123", "--size390x844", "--states123", "--full1000", "--steps450"]) includes(await dry(arg, FAIL), "알 수 없는 선택지");
  for (const arg of ["--hold1000ms", "--wait450ms", "--zoom0", "--timeout-scale0.5"]) includes(await dry(arg, FAIL), "받은 값:");
});

test("stitch and sequence options validate without launching", async (t) => {
  const temp = tempDir(t, "jstyle-shoot-stitch-cli-");
  const image = path.join(temp, "before image.png");
  fs.writeFileSync(image, "checked by the browser only when rendering");
  const output = path.join(temp, "not-created");
  const stitchRun = async (args, ok = false) => {
    const result = await node([...args, "--dry-run", "--out", output]);
    assert.equal(result.status, ok ? 0 : 1, result.stdout + result.stderr);
    assert.ok(!fs.existsSync(output));
    return ok ? JSON.parse(result.stdout) : result.stderr;
  };
  let plan = await stitchRun(["--stitch", image, "--label", "바꾸기 전", "--stitch=" + image, "--label=바꾼 뒤", "--columns2"], true);
  assert.ok(!("target" in plan));
  assert.deepEqual(plan.stitch, [{ path: image, label: "바꾸기 전" }, { path: image, label: "바꾼 뒤" }]);
  assert.equal(plan.options.columns, "2");
  for (const [args, hint] of [
    [["--stitch"], "--stitch before.png"],
    [["--label", "바꾸기 전"], '--stitch before.png --label "바꾸기 전"'],
    [["--stitch", image, "--label", "앞", "--label", "뒤"], "--label"],
    [["--stitch", path.join(temp, "missing.png")], "모음의 1 번째 이미지"],
    [["--stitch", temp], "파일이 아닙니다"],
    [["page.html", "--stitch", image], "그림 모음에는 페이지나 캡처가 필요하지 않습니다"],
    [["--stitch", image, image, image], "이미지마다 앞에 적어야 합니다: --stitch"],
    [["--stitch", image, "--record"], "그림 모음에는 페이지나 캡처가 필요하지 않습니다"],
    [["--stitch", image, "--frames", "8"], "그림 모음에는 페이지나 캡처가 필요하지 않습니다"],
    [["--frames", "8"], "페이지나 그림 모음 입력이 없습니다"],
    [["page.html", "--record", "--frames"], "--record --frames 8"],
    [["page.html", "--columns", "2"], "--record --frames 8 --columns 4"],
    [["--stitch", image, "--columns", "0"], "--columns 2"],
    [["--stitch", image, "--columns", "2.5"], "--columns 2"],
  ]) {
    const message = await stitchRun(args);
    includes(message, hint);
    includes(message, "받은 값:");
    includes(message, "예:");
  }
  for (const value of ["0", "1", "-1", "2.5", "NaN", "121", "99999999999999999"]) {
    includes(await stitchRun(["page.html", "--record", "--frames", value]), "받은 값: " + value);
  }
  plan = await stitchRun(["page.html", "--record", "--frames8", "--columns4"], true);
  assert.equal(plan.options.frames, "8");
  assert.equal(plan.options.columns, "4");
  assert.equal((await dry("--evidence", "--frames", "6")).options.frames, "6");
  assert.equal((await dry("--frames8")).options.frames, "8");
  includes(await dry("--frames8", "--selector", ".card", FAIL), "--frames");
  includes(await dry("--frames8", "--thumb", FAIL), "--frames");
  includes(await dry("--record", "--frams", FAIL), "--frames 8");
  includes(await dry("--stitc", FAIL), "--stitch before.png");
});

test("stitch scale crop forms and actionable errors", async (t) => {
  const temp = tempDir(t, "jstyle-stitch-scale-cli-");
  const image = path.join(temp, "image with spaces.png");
  fs.writeFileSync(image, "decode only on render");
  const stitchRun = async (args, ok = true) => {
    const result = await node([...args, "--dry-run"]);
    assert.equal(result.status, ok ? 0 : 1, args.join(" ") + "\n" + result.stdout + result.stderr);
    if (!ok) {
      includes(result.stderr, "받은 값:");
      includes(result.stderr, "예:");
      includes(result.stderr, "node scripts/shoot.mjs --stitch");
    }
    return ok ? JSON.parse(result.stdout) : result.stderr;
  };
  for (const crop of ["10,20,300,200", "10 20 300 200", "[10px，20px，300px，200px]", "10×20×300×200", "10 px 20 px 300 px 200 px"]) {
    const plan = await stitchRun(["--stitch", image, "--match-width240px", "--stitch=" + image, "--match-width=300 px", "--crop", crop]);
    assert.deepEqual(plan.stitch.map((item) => item.matchWidth), [240, 300]);
    assert.deepEqual(plan.options.crop, { x: 10, y: 20, width: 300, height: 200 });
  }
  for (const scale of ["0.8", ".8x", "80%", "4/5", "0.8×"]) {
    const plan = await stitchRun(["--stitch", image, "--scale=" + scale]);
    almostEqual(plan.stitch[0].scale, 0.8);
  }
  for (const args of [
    ["--scale", "1"], ["--match-width", "240"], ["page.html", "--crop", "0,0,10,10"],
    ["--stitch", image, "--scale", "0"], ["--stitch", image, "--scale", "1/0"],
    ["--stitch", image, "--scale", "NaN"], ["--stitch", image, "--scale"],
    ["--stitch", image, "--scale="], ["--stitch", image, "--match-width="],
    ["--stitch", image, "--match-width", "-20"], ["--stitch", image, "--match-width"],
    ["--stitch", image, "--scale1", "--scale2"],
    ["--stitch", image, "--match-width240", "--stitch", image],
    ["--stitch", image, "--match-width240", "--stitch", image, "--scale1"],
    ["--stitch", image, "--crop", "-1,0,20,20"],
    ["--stitch", image, "--crop", "0,0,0,20"],
    ["--stitch", image, "--crop", "0,0,20"], ["--stitch", image, "--crop"],
    ["--stitch", image, "--crop="], ["--stitch", image, "--crop", "1px0,0,20,20"],
    ["--stitch", image, "--crop", "0,0,20,20", "--crop", "0,0,30,30"],
  ]) {
    await stitchRun(args, false);
  }
});

test("sequence sampling is uniform and holds sparse frames", async () => {
  const javascript = `import {readFileSync} from 'node:fs';
const source=readFileSync(process.argv[1],'utf8');
const sample=eval('('+source.slice(source.indexOf('function sequenceFrames('),source.indexOf('function screencastList('))+')');
console.log(JSON.stringify(sample([{name:'red.jpg',t:10},{name:'blue.jpg',t:10.8},{name:'green.jpg',t:11.7}],12,5)));`;
  const result = await check(run(process.execPath, ["--input-type=module", "-e", javascript, SCRIPT]));
  const samples = JSON.parse(result.stdout);
  assert.deepEqual(samples.map((frame) => frame.timeMs), [0, 500, 1000, 1500, 2000]);
  assert.deepEqual(samples.map((frame) => frame.path), ["red.jpg", "red.jpg", "blue.jpg", "blue.jpg", "green.jpg"]);
  assert.deepEqual(samples.map((frame) => frame.sourceTimeMs), [0, 0, 800, 800, 1700]);
});

const SAMPLE_PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
<style>
body { margin: 0; padding: 24px; background: #fde68a; font: 20px sans-serif; }
body[data-state="b"] { background: #bfdbfe; }
button { padding: 16px; }
</style></head><body><h1 id="state"></h1><button id="go">전환</button>
<script>
const state = new URLSearchParams(location.search).get('state') || 'a';
function show(value) {
  document.body.dataset.state = value;
  document.querySelector('#state').textContent = value;
}
show(state);
document.querySelector('#go').onclick = () => show(document.body.dataset.state === 'a' ? 'b' : 'a');
</script></body></html>`;

function setup(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-shoot-test-"));
  const profileRoot = path.join(folder, "profiles");
  fs.mkdirSync(profileRoot);
  const ctx = {
    folder,
    page: path.join(folder, "sample.html"),
    profileRoot,
    env: { ...process.env, CHROME_PATH: BROWSER, TMPDIR: profileRoot, TMP: profileRoot, TEMP: profileRoot },
    cleanups: [],
  };
  fs.writeFileSync(ctx.page, SAMPLE_PAGE);
  t.after(async () => {
    for (const cleanup of ctx.cleanups.reverse()) await cleanup();
    fs.rmSync(folder, { recursive: true, force: true });
  });
  return ctx;
}

function browserTest(name, skip, fn) {
  if (typeof skip === "function") [skip, fn] = [false, skip];
  test(name, { skip: BROWSER ? skip : "Chrome, Chromium or Edge is not installed" }, (t) => fn(setup(t), t));
}

const ffmpegSkip = (reason) => (FFMPEG ? false : reason);
const writePage = (ctx, html) => fs.writeFileSync(ctx.page, html);
const editPage = (ctx, from, to) => writePage(ctx, replaceText(read(ctx.page), from, to));
const profiles = (ctx) => listDir(ctx.profileRoot, (name) => name.startsWith("jstyle-shoot-"));

async function shoot(ctx, output, ...args) {
  const result = await node([ctx.page, "--out", output, ...args], { env: ctx.env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

async function shootTargets(ctx, output, targets, ...args) {
  const result = await node([...targets, "--out", output, ...args], { env: ctx.env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}

async function runFailure(ctx, output, ...args) {
  const result = await node([ctx.page, "--out", output, ...args], { env: ctx.env, timeout: 110 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  return result;
}

async function browserLeftovers(ctx) {
  const needle = path.basename(ctx.folder);
  let found = [];
  let folders = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (WINDOWS) {
      const script = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and "
        + `$_.CommandLine.Contains('${needle}') -and $_.CommandLine.Contains('user-data-dir') } | ForEach-Object { $_.Name }`;
      found = (await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60 })).stdout.split(/\s+/).filter(Boolean);
    } else {
      const listing = (await run("ps", ["-axww", "-o", "command="], { timeout: 60 })).stdout;
      found = listing.split("\n").filter((line) => line.includes(needle) && line.includes("--user-data-dir=")).map((line) => line.slice(0, 120));
    }
    folders = profiles(ctx);
    if (!found.length && !folders.length) break;
    await sleep(250);
  }
  return { found, folders };
}

async function assertNoBrowserLeftovers(ctx) {
  const { found, folders } = await browserLeftovers(ctx);
  assert.deepEqual(found, [], "browser processes were left running");
  assert.deepEqual(folders, [], "temporary profiles were left behind");
}

function assertArtifacts(output, names) {
  for (const name of names) {
    const artifact = path.join(output, name);
    assert.ok(isFile(artifact), name);
    const data = fs.readFileSync(artifact);
    assert.ok(data.length > 0, name);
    if (name.endsWith(".png")) assert.ok(data.subarray(0, 8).equals(PNG_SIGNATURE), name);
    else if (name.endsWith(".jpg")) assert.ok(data[0] === 0xff && data[1] === 0xd8, name);
  }
}

browserTest("selector crops first visible element and scrolls", async (ctx) => {
  writePage(ctx, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><style>
body{margin:0;min-height:2600px;background:#f00;scroll-behavior:smooth}
header{position:sticky;top:0;height:60px;background:#f00;z-index:10}
.card{position:absolute;top:1800px;left:30px;width:160px;height:100px;background:#00ff00}
.tall{position:absolute;top:1100px;left:30px;width:160px;height:600px;background:#00ff00}
</style><header>Sticky</header><div class="card" hidden></div><div class="card">Save</div>
<div class="tall">Tall card</div>
<div class="card" style="top:2100px;background:blue">Later</div>
<script>Object.defineProperty(document,'images',{get(){
if(scrollY<1)console.error('selector-did-not-scroll');return [];}})</script>`);
  for (const [selector, extra, size] of [[".card", [], [160, 100]], ["text=Save", ["--thumb"], [80, 50]],
    [".tall", [], [160, 600]],
    ['div:text-is("Save")', ["--mask", "--mark", ".card"], [160, 100]]]) {
    const output = path.join(ctx.folder, `crop-${size[0]}-${size[1]}-${extra.length}`);
    await shoot(ctx, output, "--selector", selector, ...extra);
    assert.deepEqual(report(output)[0].issues, [], selector);
    assert.deepEqual(pngSize(path.join(output, "page.png")), size, selector);
    if (FFMPEG) {
      assert.deepEqual(await framePixel(path.join(output, "page.png"), size[0] - 10, 10), [0, 255, 0], selector);
      assert.deepEqual(await framePixel(path.join(output, "page.png"), 10, size[1] >= 100 ? 80 : 40), [0, 255, 0], selector);
    }
    if (extra.includes("--mask")) {
      for (const file of ["page-masked.png", "page-marked.png"]) assert.deepEqual(pngSize(path.join(output, file)), size, file);
    }
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("selector missing hidden and zero size fail", async (ctx) => {
  writePage(ctx, '<!doctype html><div hidden id="hidden">Hidden</div><div id="zero" style="width:0;height:0"></div>');
  for (const [selector, diagnostic] of [[".missing", "요소를 찾을 수 없습니다"], ["#hidden", "모두 보이지 않습니다"], ["#zero", "크기: 0"]]) {
    const result = await runFailure(ctx, path.join(ctx.folder, "bad-crop"), "--selector", selector);
    includes(result.stderr, "--selector");
    includes(result.stderr, diagnostic);
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("multi target shared server browser and auto sheet", async (ctx) => {
  // Local storage survives navigation only when both the browser profile and
  // server origin stay the same. The next page requires its predecessor's count.
  const pages = [];
  for (const [index, [name, color]] of [["a", "#ff0000"], ["b", "#00ff00"], ["c", "#0000ff"]].entries()) {
    const page = path.join(ctx.folder, name, name + ".html");
    fs.mkdirSync(path.dirname(page));
    fs.writeFileSync(page, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:,"><style>body{margin:0;background:${color}}</style><div>안 ${name}</div>
<script>
const count=Number(localStorage.getItem('count') || 0);
if(count!==${index}) console.error('browser-or-server-restarted');
localStorage.setItem('count',String(count+1));
fetch('../shared.txt').then(r=>r.text()).then(t=>{if(t!=='shared')console.error('shared-root-missing')});
</script>`);
    pages.push(page);
  }
  fs.writeFileSync(path.join(ctx.folder, "shared.txt"), "shared");
  let output = path.join(ctx.folder, "batch");
  const result = await shootTargets(ctx, output, pages, "--thumb");
  assertArtifacts(output, ["a.png", "b.png", "c.png", "sheet.png"]);
  const entries = report(output);
  assert.deepEqual(entries.map((r) => r.file), ["a.png", "b.png", "c.png", "sheet.png"]);
  assert.ok(entries.every((r) => r.issues.length === 0), JSON.stringify(entries));
  const overview = entries.at(-1);
  assert.equal(overview.columns, 3);
  assert.deepEqual(overview.items.map((item) => item.label), ["a", "b", "c"]);
  assert.deepEqual(pngSize(path.join(output, "sheet.png")), [overview.width, overview.height]);
  if (FFMPEG) {
    const colors = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
    for (const [i, tile] of overview.items.entries()) {
      assert.deepEqual(await framePixel(path.join(output, "sheet.png"), tile.x + 10, tile.y + 100), colors[i]);
    }
  }
  includes(result.stderr, "[4/4] sheet.png");
  output = path.join(ctx.folder, "comma");
  await shootTargets(ctx, output, [pages.slice(0, 2).join(",")], "--thumb", "--no-sheet");
  assertArtifacts(output, ["a.png", "b.png"]);
  assert.ok(!fs.existsSync(path.join(output, "sheet.png")));
  await assertNoBrowserLeftovers(ctx);
});

browserTest("explore directory manifest and index browser", async (ctx) => {
  const folder = path.join(ctx.folder, "explore");
  fs.mkdirSync(folder);
  for (const file of ["a.html", "b.html", "style-explorer.html"]) fs.copyFileSync(ctx.page, path.join(folder, file));
  let output = path.join(ctx.folder, "scanned");
  await shootTargets(ctx, output, [folder], "--thumb");
  assertArtifacts(output, ["a.png", "b.png", "sheet.png"]);
  assert.ok(!fs.existsSync(path.join(output, "style-explorer.png")));
  fs.copyFileSync(ctx.page, path.join(folder, "index.html"));
  output = path.join(ctx.folder, "index");
  await shootTargets(ctx, output, [folder], "--thumb");
  assertArtifacts(output, ["page.png"]);
  assert.ok(!fs.existsSync(path.join(output, "sheet.png")));
  const manifest = path.join(folder, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify({ candidates: [
    { kind: "html", source: "a.html", id: "sheet", name: "첫 번째 안" },
    { kind: "html", source: "b.html", id: "sheet", name: "두 번째 안" },
  ] }));
  for (const [i, target] of [folder, manifest].entries()) {
    output = path.join(ctx.folder, `manifest-${i}`);
    await shootTargets(ctx, output, [target], "--thumb", "--selector", "#go");
    assertArtifacts(output, ["sheet-2.png", "sheet-3.png", "sheet.png"]);
    assert.deepEqual(report(output).at(-1).items.map((tile) => tile.label), ["첫 번째 안", "두 번째 안"]);
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("states masks and sheets", async (ctx) => {
  const output = path.join(ctx.folder, "shots");
  await shoot(ctx, output, "--states", "a,b", "--mask", "--sheet");
  assertArtifacts(output, ["a.png", "b.png", "a-masked.png", "b-masked.png", "sheet.png", "sheet-masked.png", "report.json"]);
  const entries = report(output);
  assert.deepEqual(entries.map((entry) => entry.state), ["a", "b"]);
  assert.deepEqual(entries.map((entry) => entry.issues), [[], []]);
  assert.deepEqual(entries.map((entry) => entry.lint), [[], []]);
  assert.ok(!sameBytes(path.join(output, "a.png"), path.join(output, "b.png")));
  assert.ok(!sameBytes(path.join(output, "a.png"), path.join(output, "a-masked.png")));
  assert.deepEqual(profiles(ctx), [], "Temporary browser profiles leaked");
});

browserTest("stitch local images without page preserves order ratio and korean labels", async (ctx) => {
  const [first, second, third] = ["앞 'one.png", "after.png", "square.png"].map((name) => path.join(ctx.folder, name));
  writeSolidPng(first, 120, 60, [255, 0, 0]);
  writeSolidPng(second, 60, 120, [0, 0, 255]);
  writeSolidPng(third, 90, 90, [0, 255, 0]);
  const output = path.join(ctx.folder, "stitch");
  const result = await node(["--stitch", first, "--label", "바꾸기 전", "--stitch", second, "--label", "바꾼 뒤", "--stitch", third,
    "--columns", "2", "--out", output], { env: ctx.env, timeout: 30 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = report(output)[0];
  assert.equal(entry.file, "stitch.png");
  assert.equal(entry.columns, 2);
  assert.deepEqual(entry.issues, []);
  assert.deepEqual(entry.items.map((item) => item.label), ["바꾸기 전", "바꾼 뒤", ""]);
  assert.deepEqual(entry.items.map((item) => [item.width, item.height]), [[120, 60], [60, 120], [90, 90]]);
  assert.deepEqual(pngSize(path.join(output, "stitch.png")), [entry.width, entry.height]);
  assert.deepEqual(fs.readdirSync(output).sort(), ["report.json", "stitch.png"]);
  if (FFMPEG) {
    const colors = [[255, 0, 0], [0, 0, 255], [0, 255, 0]];
    for (const [i, item] of entry.items.entries()) {
      assert.deepEqual(await framePixel(path.join(output, "stitch.png"), item.x + Math.floor(item.width / 2), item.y + Math.floor(item.height / 2)), colors[i]);
    }
    const captions = [];
    for (const [i, item] of entry.items.slice(0, 2).entries()) {
      const left = 24 + (i === 0 ? 0 : 176);
      const crop = await check(run("ffmpeg", ["-v", "error", "-i", path.join(output, "stitch.png"), "-vf", `crop=160:24:${left}:${item.labelY}`,
        "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { binary: true }));
      captions.push(crop.stdout);
    }
    assert.ok(!captions[0].equals(captions[1]), "Different Korean glyphs must not render as identical missing-font boxes");
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("stitch normalizes common elements and crops after scaling", async (ctx) => {
  // Different overall widths with the same content rendered at 1x and 2x.
  const first = path.join(ctx.folder, "reference.svg");
  const second = path.join(ctx.folder, "screenshot.svg");
  for (const [file, width, height, viewWidth] of [[first, 1000, 700, 1000], [second, 1600, 1400, 800]]) {
    fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${viewWidth} 700"><rect width="100%" height="100%" fill="lime"/>`
      + '<rect width="100" height="700" fill="red"/></svg>');
  }
  for (const [name, firstOptions, secondOptions, crop, expected] of [
    ["widths", ["--match-width", "100px"], ["--match-width200"], [], [[640, 448], [512, 448]]],
    ["crop", ["--scale", "1"], ["--scale", "50%"], ["--crop", "25,20,500,300"], [[500, 300], [500, 300]]],
  ]) {
    const output = path.join(ctx.folder, name);
    const result = await node(["--stitch", first, ...firstOptions, "--stitch", second, ...secondOptions, ...crop, "--out", output],
      { env: ctx.env, timeout: 30 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const entry = report(output)[0];
    assert.deepEqual(entry.items.map((item) => [item.width, item.height]), expected, name);
    assert.deepEqual(entry.items.map((item) => item.scale), [1, 0.5], name);
    const [a, b] = entry.items;
    almostEqual(a.renderScale * 100, b.renderScale * 200);
    if (crop.length) {
      assert.deepEqual(a.sourceCrop, { x: 25, y: 20, width: 500, height: 300 });
      assert.deepEqual(b.sourceCrop, { x: 50, y: 40, width: 1000, height: 600 });
    }
    if (FFMPEG) {
      const boundary = crop.length ? 75 : 64;
      for (const item of entry.items) {
        assert.deepEqual(await framePixel(path.join(output, "stitch.png"), item.x + boundary - 2, item.y + 10), [255, 0, 0], name);
        assert.deepEqual(await framePixel(path.join(output, "stitch.png"), item.x + boundary + 2, item.y + 10), [0, 255, 0], name);
      }
    }
  }
  for (const [options, hint] of [[["--crop", "0,0,1200,300"], "자르기 영역이 이미지 밖입니다"],
    [["--match-width", "2000"], "물체의 너비가 원본을 넘습니다"]]) {
    const output = path.join(ctx.folder, "invalid");
    const result = await node(["--stitch", first, ...options, "--out", output], { env: ctx.env, timeout: 30 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    includes(result.stderr, hint);
    includes(result.stderr, "예: node scripts/shoot.mjs");
    assert.ok(!fs.existsSync(path.join(output, "stitch.png")));
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("stitch wraps labels and reports decode errors", async (ctx) => {
  const image = path.join(ctx.folder, "sample.svg");
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="red"/></svg>');
  const output = path.join(ctx.folder, "wrapped");
  let result = await node(["--stitch", image, "--label", "한국어 설명".repeat(30), "--columns", "5", "--out", output], { env: ctx.env, timeout: 30 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = report(output)[0];
  assert.equal(entry.columns, 1);
  assert.deepEqual([entry.items[0].width, entry.items[0].height], [640, 320]);
  assert.ok(entry.items[0].labelHeight > 32);
  assert.ok(entry.height >= entry.items[0].y + 320 + entry.items[0].labelHeight);
  fs.writeFileSync(image, '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1"><rect width="1500" height="1" fill="red"/></svg>');
  const thin = path.join(ctx.folder, "thin");
  result = await node(["--stitch", image, "--out", thin], { env: ctx.env, timeout: 30 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const tile = report(thin)[0].items[0];
  assert.deepEqual([tile.width, tile.height], [640, 1]);
  const corrupt = path.join(ctx.folder, "corrupt.png");
  fs.writeFileSync(corrupt, "not an image");
  result = await node(["--stitch", image, "--stitch", corrupt, "--out", path.join(ctx.folder, "corrupt")], { env: ctx.env, timeout: 30 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stderr, " 2 번째 이미지를 디코딩할 수 없습니다，받은 값: " + corrupt);
  includes(result.stderr, "예: --stitch before.png");
  await assertNoBrowserLeftovers(ctx);
});

browserTest("mark draws numbered boxes without touching plain shot", async (ctx) => {
  const output = path.join(ctx.folder, "marked");
  const result = await shoot(ctx, output, "--mark", "#go; h1");
  assertArtifacts(output, ["page.png", "page-marked.png"]);
  includes(result.stdout, "page-marked.png");
  assert.ok(!sameBytes(path.join(output, "page.png"), path.join(output, "page-marked.png")));
  const plain = path.join(ctx.folder, "plain");
  await shoot(ctx, plain);
  assert.ok(sameBytes(path.join(output, "page.png"), path.join(plain, "page.png")), "Marks must not leak into the plain screenshot");
});

browserTest("mark accepts explicit numbers", async (ctx) => {
  const [numbered, byOrder, reversedOrder] = ["numbered", "by-order", "reversed"].map((name) => path.join(ctx.folder, name));
  await shoot(ctx, numbered, "--mark", "2=#go; 1=h1");
  await shoot(ctx, byOrder, "--mark", "h1; #go");
  await shoot(ctx, reversedOrder, "--mark", "#go; h1");
  assert.ok(sameBytes(path.join(numbered, "page-marked.png"), path.join(byOrder, "page-marked.png")));
  assert.ok(!sameBytes(path.join(numbered, "page-marked.png"), path.join(reversedOrder, "page-marked.png")),
    "Explicit numbers must decide the labels, not the order");
});

browserTest("mark reports missing elements", async (ctx) => {
  const output = path.join(ctx.folder, "missing");
  const result = await node([ctx.page, "--out", output, "--mark", "#go; .nope"], { env: ctx.env, timeout: 90 });
  assert.notEqual(result.status, 0);
  includes(result.stderr, ".nope");
});

browserTest("force overwrites existing output", async (ctx) => {
  const output = path.join(ctx.folder, "shots");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "page.png"), "old screenshot");
  await shoot(ctx, output, "--force");
  assertArtifacts(output, ["page.png", "report.json"]);
});

browserTest("thumb and file url resolution", async (ctx) => {
  const output = path.join(ctx.folder, "thumb-shots");
  const result = await node([pathToFileURL(ctx.page).href, "--size", "desktop", "--thumb", "--out", output], { env: ctx.env, timeout: 60 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertArtifacts(output, ["page.png", "report.json"]);
  const entry = report(output)[0];
  assert.ok(entry.thumb);
  assert.deepEqual(entry.lint, []);
  assert.deepEqual(pngSize(path.join(output, "page.png")), [720, 450]);
  await assertNoBrowserLeftovers(ctx);
});

browserTest("preview denies sibling paths and escaping symlinks", async (ctx) => {
  const outside = ctx.folder + "-private";
  fs.mkdirSync(outside);
  ctx.cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
  const at = (name) => path.join(ctx.folder, name);
  fs.writeFileSync(path.join(outside, "secret.txt"), "test-only-secret");
  fs.symlinkSync(path.join(outside, "secret.txt"), at("leak.txt"));
  fs.mkdirSync(at("nested"));
  fs.writeFileSync(at("nested/okay.txt"), "allowed-resource");
  fs.writeFileSync(at(".env.production.local"), "synthetic-secret");
  fs.mkdirSync(at(".git"));
  fs.writeFileSync(at(".git/config"), "synthetic-git-config");
  fs.writeFileSync(at("credentials.json"), '{"token":"synthetic"}');
  fs.writeFileSync(at("server.pem"), "synthetic-private-key");
  fs.symlinkSync(at(".env.production.local"), at("env.txt"));
  fs.symlinkSync(at(".git"), at("nested/hidden"), "dir");
  fs.writeFileSync(at("nested/module.mjs"), 'export const value = "module-works";');
  const blocked = ["/..%2f" + path.basename(outside) + "%2fsecret.txt", "/leak.txt", "/%E0%A4%A",
    "/.env.production.local", "/%2eenv.production.local", "/.git/config",
    "/credentials.json", "/server.pem", "/env.txt", "/nested/hidden/config"];
  const probe = replaceText(`<script>(async () => {
          for (const path of PATHS) {
            const response = await fetch(path);
            if (response.status !== 404) console.error('SECURITY_LEAK:' + path);
          }
          const allowed = await fetch('/nested/okay.txt');
          if (await allowed.text() !== 'allowed-resource') console.error('LEGIT_RESOURCE_BLOCKED');
          const module = await import('/nested/module.mjs');
          if (module.value !== 'module-works') console.error('LEGIT_RESOURCE_BLOCKED');
          console.error('AUDIT_FINISHED');
        })().catch(() => console.error('AUDIT_FAILED'));</script>`, "PATHS", JSON.stringify(blocked));
  editPage(ctx, "</body>", probe + "</body>");
  const output = path.join(ctx.folder, "boundary-shots");
  await shoot(ctx, output, "--wait", "4000");
  const issues = report(output)[0].issues.join("\n");
  includes(issues, "AUDIT_FINISHED");
  for (const marker of ["SECURITY_LEAK", "LEGIT_RESOURCE_BLOCKED", "AUDIT_FAILED"]) excludes(issues, marker);
});

browserTest("state labels do not become output paths", async (ctx) => {
  const output = path.join(ctx.folder, "safe-states");
  const states = ["../escaped", '<label & "quoted">'];
  await shoot(ctx, output, "--states", states.join(","), "--mask", "--sheet");
  const entries = report(output);
  assert.deepEqual(entries.map((entry) => entry.state), states);
  for (const entry of entries) {
    assert.match(entry.file, /^state-\d+-[0-9a-f]{12}\.png$/);
    assert.ok(isFile(path.join(output, entry.file)));
  }
  assert.ok(!fs.existsSync(path.join(ctx.folder, "escaped.png")));
  assertArtifacts(output, ["sheet.png", "sheet-masked.png"]);
});

browserTest("type accepts selectors with quotes", async (ctx) => {
  editPage(ctx, "</body>", '<input data-x="value"></body>');
  const output = path.join(ctx.folder, "quoted-selector");
  await shoot(ctx, output, "--steps", `type 'input[data-x="value"]' hello`);
  assert.deepEqual(report(output)[0].issues, []);
});

browserTest("record steps", async (ctx) => {
  const output = path.join(ctx.folder, "record's output");
  const result = await shoot(ctx, output, "--record", "--steps", "click #go; wait 300", "--hold", "300");
  assertArtifacts(output, ["motion-start.jpg", "motion-mid.jpg", "motion-end.jpg"]);
  assert.ok(!sameBytes(path.join(output, "motion-start.jpg"), path.join(output, "motion-end.jpg")));
  const entries = report(output);
  assert.deepEqual(entries.map((entry) => entry.issues), [[]]);
  assert.ok(!("sequence" in entries[0]));
  assert.deepEqual(listDir(output, (name) => name.includes("sequence")), [], "Default recordings must not create a sequence image");
  assert.deepEqual(profiles(ctx), [], "Temporary browser profiles leaked");
  if (FFMPEG) {
    assert.ok(isFile(path.join(output, "record.mp4")), result.stdout + result.stderr);
    assertArtifacts(output, ["record.mp4"]);
  }
});

browserTest("record sequence has uniform times original ratios and named zoom files", ffmpegSkip("ffmpeg is needed for recording and pixel checks"), async (ctx) => {
  const output = path.join(ctx.folder, "sequence");
  await shoot(ctx, output, "--record", "--steps", "go: click #go", "--zoom", "1,2", "--hold", "250", "--frames", "5", "--columns", "2");
  const entries = report(output);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries.map((item) => item.sequence.file), ["motion-go-sequence.png", "motion-go-@2x-sequence.png"]);
  for (const entry of entries) {
    const sequence = entry.sequence;
    assert.equal(sequence.columns, 2);
    assert.equal(sequence.items.length, 5);
    const times = sequence.frames.map((frame) => frame.timeMs);
    assert.equal(times[0], 0);
    assert.equal(times.at(-1), entry.durationMs);
    const intervals = times.slice(1).map((time, i) => time - times[i]);
    assert.ok(Math.max(...intervals) - Math.min(...intervals) <= 1, String(intervals));
    for (const [i, sample] of sequence.frames.entries()) {
      const tile = sequence.items[i];
      if (!tile) break;
      assert.ok(sample.sourceTimeMs <= sample.timeMs + 1);
      assert.equal(tile.label, `${(sample.timeMs / 1000).toFixed(3)} s`);
      almostEqual(tile.width / tile.height, 390 / 844, 0.002);
      assert.ok(tile.labelHeight > 0);
      assert.ok(tile.y + tile.height + tile.labelHeight <= sequence.height);
    }
    assertArtifacts(output, [sequence.file, entry.frames.start.file, entry.frames.mid.file, entry.frames.end.file]);
    const last = sequence.items.at(-1);
    const pixel = await framePixel(path.join(output, sequence.file), last.x + last.width - 10, last.y + last.height - 10);
    const end = await framePixel(path.join(output, entry.frames.end.file), 300, 800);
    assert.ok(pixel.every((value, i) => Math.abs(value - end[i]) < 8), JSON.stringify([pixel, end]));
    const first = sequence.items[0];
    assert.notDeepEqual(pixel, await framePixel(path.join(output, sequence.file), first.x + first.width - 10, first.y + first.height - 10));
  }
  assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
  await assertNoBrowserLeftovers(ctx);
});

browserTest("record sequence unnamed filename and default columns", async (ctx) => {
  const output = path.join(ctx.folder, "unnamed-sequence");
  await shoot(ctx, output, "--record", "--hold", "100", "--frames", "5");
  const entry = report(output)[0];
  assert.equal(entry.sequence.file, "motion-sequence.png");
  assert.equal(entry.sequence.columns, 4);
  assertArtifacts(output, ["motion-sequence.png", "motion-start.jpg", "motion-mid.jpg", "motion-end.jpg"]);
  assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
});

browserTest("sequence png respects evidence filename collisions", ffmpegSkip("ffmpeg is needed for evidence recording"), async (ctx) => {
  const output = path.join(ctx.folder, "sequence-collision");
  await shoot(ctx, output, "--evidence", "--record", "--states", "motion-entry-sequence", "--hold", "100", "--frames", "2");
  const sequence = report(output).find((item) => "sequence" in item).sequence;
  assert.equal(sequence.file, "motion-entry-2-sequence.png");
  assertArtifacts(output, ["motion-entry-sequence.png", sequence.file, "record-entry-2.mp4"]);
  assert.ok(!sameBytes(path.join(output, "motion-entry-sequence.png"), path.join(output, sequence.file)));
});

browserTest("frames without record skips encoder for actions and evidence", async (ctx) => {
  // Fail on any encoder invocation, even ffmpeg -version; frames must work without it.
  const hook = path.join(ctx.folder, "no-encoder.mjs");
  fs.writeFileSync(hook, `import cp from 'node:child_process'; import {syncBuiltinESMExports} from 'node:module';
const spawn = cp.spawn;
cp.spawn = function(file, ...args) { if (file === 'ffmpeg') throw new Error('encoder must not run'); return spawn.call(this, file, ...args); };
syncBuiltinESMExports();`);
  ctx.env.NODE_OPTIONS = "--import=" + pathToFileURL(hook).href;
  for (const [name, extra] of [["actions", []], ["evidence", ["--evidence"]]]) {
    const output = path.join(ctx.folder, name);
    const result = await shoot(ctx, output, "--frames", "3", "--hold", "100", "--steps", "go: click #go", ...extra);
    const entries = report(output);
    const sequences = entries.filter((entry) => "sequence" in entry).map((entry) => entry.sequence);
    assert.equal(sequences.length, extra.length ? 2 : 1, name);
    includes(result.stdout, "영상을 인코딩하지 않음");
    assert.deepEqual(listDir(output, (file) => file.endsWith(".mp4")), []);
    assert.deepEqual(listDir(output, (file) => file.startsWith("frames")), []);
    for (const sequence of sequences) {
      assertArtifacts(output, [sequence.file]);
      assert.equal(sequence.items.length, 3);
    }
    assert.deepEqual(entries.filter((entry) => "sequence" in entry).map((entry) => entry.issues), sequences.map(() => []));
  }
  await assertNoBrowserLeftovers(ctx);
});

browserTest("record frames follow last action and capture short feedback",
  ffmpegSkip("ffmpeg is needed to inspect frame pixels")
  || (process.env.JSTYLE_SHOOT_SLOW_HOST ? "needs real-time frame capture: a 0.36s flash is missed on slow hosted runners" : false),
  async (ctx) => {
    writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
body{margin:0}#box{position:absolute;left:20px;top:20px;width:120px;height:120px;background:red}
#box.prepared{background:lime}#box.feedback{animation:shake .36s linear}
@keyframes shake{0%,100%{background:red;transform:none}25%,75%{background:blue;transform:translateX(40px)}}
#controls{position:absolute;top:180px}#drag{display:inline-block;width:80px;height:30px}
#tail:hover{animation:tail .8s linear}@keyframes tail{from{opacity:.3}to{opacity:1}}
@keyframes loop{to{transform:rotate(360deg)}}#loop{position:absolute;top:270px;width:40px;height:40px;background:gray;animation:loop 2s linear infinite}
</style><div id="box"></div><div id="controls"><button id="prepare">Prepare</button>
<button id="click">Click</button><button id="double">Double</button><div id="drag">Drag</div>
<input id="edit" value="old"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
<button id="tail">Tail</button></div><div id="loop"></div><script>
const box=document.querySelector('#box');
const feedback=()=>{box.className='feedback'};
document.querySelector('#prepare').onclick=()=>box.className='prepared';
document.querySelector('#click').onclick=feedback;
document.querySelector('#double').ondblclick=feedback;
document.querySelector('#drag').onmouseup=feedback;
document.querySelector('#edit').oninput=feedback;
document.querySelector('#choice').onchange=feedback;
addEventListener('keydown',e=>{if(e.key==='Enter')feedback()});
</script>`);
    const actions = [["click #click", "click"], ["dblclick #double", "dblclick"],
      ["drag #drag 20 0", "drag"], ["type #edit X", "type"],
      ["fill #edit replacement", "fill"], ["select #choice b", "select"], ["key Enter", "key"]];
    for (const [raw, action] of actions) {
      const output = path.join(ctx.folder, action);
      await shoot(ctx, output, "--size", "desktop", "--record", "--wait", "0", "--hold", "100",
        "--steps", `click #prepare; wait 700; ${raw}; wait 500; hover #tail; scroll 0`);
      const entry = report(output)[0];
      assert.deepEqual(entry.sampling, { mode: "action", step: 3, action, raw });
      assert.deepEqual(entry.issues, [], action);
      const frames = entry.frames;
      assert.ok(frames.start.timeMs > 1000, action);
      assert.ok(frames.start.timeMs < frames.mid.timeMs, action);
      assert.ok(frames.mid.timeMs < frames.end.timeMs, action);
      assert.equal(frames.end.timeMs, entry.durationMs, action);
      assert.ok(frames.end.timeMs - frames.mid.timeMs > 500, action);
      const before = await framePixel(path.join(output, frames.start.file), 80, 80);
      const middle = await framePixel(path.join(output, frames.mid.file), 80, 80);
      const after = await framePixel(path.join(output, frames.end.file), 80, 80);
      assert.ok(before[1] > 220, `${action} ${before}`);
      assert.ok(before[0] < 40, `${action} ${before}`);
      assert.ok(middle[2] > 170, `${action} ${middle}`);
      assert.ok(middle[0] < 100, `${action} ${middle}`);
      assert.ok(after[0] > 220, `${action} ${after}`);
      assert.ok(after[2] < 40, `${action} ${after}`);
    }
  });

browserTest("entry recording starts white when the browser is in dark mode",
  ffmpegSkip("ffmpeg is needed to inspect frame pixels")
  || (WINDOWS ? "POSIX launch wrapper; on Windows the CI job with the dark system theme covers this" : false),
  async (ctx) => {
    // A dark system theme makes the browser paint about:blank dark grey. The opening frame of an entry
    // recording must not depend on the host theme.
    const wrapper = path.join(ctx.folder, "dark-browser");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexec " + shellQuote(BROWSER) + ' --force-dark-mode "$@"\n', { mode: 0o755 });
    writePage(ctx, '<!doctype html><link rel="icon" href="data:,"><style>body{margin:0;background:#ffd000}</style><p>entry</p>');
    const output = path.join(ctx.folder, "dark-entry");
    const result = await node([ctx.page, "--out", output, "--record", "--entry", "--wait", "0", "--hold", "50"],
      { env: { ...ctx.env, CHROME_PATH: wrapper }, timeout: 90 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const first = await framePixel(path.join(output, "record.mp4"));
    assert.ok(first.every((channel) => channel > 245), String(first));
  });

browserTest("entry frames span content to stable", ffmpegSkip("ffmpeg is needed to inspect frame pixels"), async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
body{margin:0;background:#ffd000}#box{width:200px;height:200px;background:blue;animation:appear .6s linear both}
@keyframes appear{from{opacity:0}to{opacity:1}}
</style><div id="box"></div>`);
  const output = path.join(ctx.folder, "entry-timing");
  await shoot(ctx, output, "--record", "--entry", "--wait", "0", "--hold", "50");
  const entry = report(output)[0];
  assert.deepEqual(entry.sampling, { mode: "entry" });
  const frames = entry.frames;
  assert.ok(frames.start.timeMs < frames.mid.timeMs);
  assert.ok(frames.mid.timeMs < frames.end.timeMs);
  assert.equal(frames.end.timeMs, entry.durationMs);
  assert.ok(entry.durationMs > 600);
  const first = await framePixel(path.join(output, "record.mp4"));
  assert.ok(first.every((channel) => channel > 245), String(first));
  const start = await framePixel(path.join(output, frames.start.file));
  const middle = await framePixel(path.join(output, frames.mid.file));
  const end = await framePixel(path.join(output, frames.end.file));
  assert.ok(start[0] > middle[0] + 30, JSON.stringify([start, middle]));
  assert.ok(middle[0] > end[0] + 30, JSON.stringify([middle, end]));
  assert.ok(end[0] < 20, String(end));
  assert.ok(end[2] > 230, String(end));
});

browserTest("record without changing actions keeps head middle tail sampling", async (ctx) => {
  const output = path.join(ctx.folder, "no-action-timing");
  await shoot(ctx, output, "--record", "--steps", "wait 200; hover #go", "--hold", "100");
  const entry = report(output)[0];
  assert.deepEqual(entry.sampling, { mode: "recording" });
  const frames = entry.frames;
  assert.equal(frames.start.timeMs, 0);
  assert.ok(frames.start.timeMs <= frames.mid.timeMs);
  assert.ok(frames.mid.timeMs <= frames.end.timeMs);
  assert.ok(frames.end.timeMs <= entry.durationMs);
  assert.ok(sameBytes(path.join(output, frames.start.file), path.join(output, frames.end.file)));
});

browserTest("mask preserves current color icons", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,"></head><body>
<svg width="80" height="80" viewBox="0 0 80 80" style="color:#16a34a">
<circle cx="40" cy="40" r="32" fill="currentColor" /></svg>
</body></html>`);
  const output = path.join(ctx.folder, "icons");
  await shoot(ctx, output, "--mask");
  assert.ok(sameBytes(path.join(output, "page.png"), path.join(output, "page-masked.png")), "Masking text must preserve icons using currentColor");
});

browserTest("record preserves final hold", FFMPEG && FFPROBE ? false : "ffmpeg and ffprobe are required to check recording duration", async (ctx) => {
  const output = path.join(ctx.folder, "hold");
  await shoot(ctx, output, "--record", "--steps", "click #go; wait 300", "--hold", "2000");
  const result = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", path.join(output, "record.mp4")]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Number(JSON.parse(result.stdout).format.duration) >= 2.0);
});

browserTest("motion probe", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,"><style>
body{margin:0}.hero{height:1800px}.stage{position:sticky;top:0;height:800px;overflow:hidden}
#figure,#word{position:absolute;left:300px;width:400px;height:300px;background:#888}#word{top:400px;background:#444}
@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
h1{animation:rise .5s ease-out both}#go{transition:transform .3s}#go.on{transform:translateX(40px)}
.reveal{height:600px;opacity:0;transition:opacity .3s}.reveal.in{opacity:1}
</style></head><body><section class="hero"><div class="stage"><div id="figure"></div><div id="word"></div></div></section>
<h1>Hi</h1><button id="go" onclick="this.classList.add('on')">Go</button>
<div style="height:1200px"></div><div class="reveal">Later</div>
<script>addEventListener('scroll',()=>{const p=Math.min(scrollY/1000,1);figure.style.transform=\`scale(\${1-p*.2})\`;word.style.transform=\`scale(\${1+p*.25})\`});
new IntersectionObserver(e=>e.forEach(x=>x.isIntersecting&&x.target.classList.add('in'))).observe(document.querySelector('.reveal'))</script>
</body></html>`);
  let output = path.join(ctx.folder, "motion");
  await shoot(ctx, output, "--motion", "--size", "1280x800", "--steps", "click #go");
  const probe = report(output)[0];
  assert.deepEqual(probe.issues, []);
  assert.ok(["load", "steps", "hero", "scroll"].every((k) => probe.motion[k].elements), JSON.stringify(probe.motion));
  assert.ok(probe.motion.hero.layers >= 2);

  writePage(ctx, `<!doctype html><html><head><link rel="icon" href="data:,"></head>
<body><h1>Still</h1><div style="height:1600px"></div></body></html>`);
  output = path.join(ctx.folder, "still");
  await shoot(ctx, output, "--motion", "--size", "1280x800");
  const issues = report(output)[0].issues.join("\n");
  includes(issues, "처음 들어올 때：움직임을 찾지 못했습니다");
  includes(issues, "스크롤：스크롤에 따른 변화를 찾지 못했습니다");
});

browserTest("motion skips scroll check on single screen", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head><link rel="icon" href="data:,"><style>
html,body{margin:0;height:100%;overflow:hidden}
@keyframes rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
h1{animation:rise .5s ease-out both}</style></head><body><h1>Game</h1></body></html>`);
  const output = path.join(ctx.folder, "single-screen");
  const result = await shoot(ctx, output, "--motion");
  const probe = report(output)[0];
  assert.deepEqual(probe.issues, []);
  assert.ok(!probe.motion.scroll.scrollable);
  includes(result.stdout, "페이지에 스크롤이 없습니다");
});

browserTest("record entry captures first appearance", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head><link rel="icon" href="data:,"><style>
body{margin:0;background:#fde68a}
@keyframes rise{from{opacity:0;transform:translateY(160px)}to{opacity:1;transform:none}}
h1{margin:40px;height:300px;background:#1e3a8a;animation:rise .3s ease-out both}</style></head>
<body><h1></h1></body></html>`);
  // 첫 등장 0.3 초 만에 끝남：기본 녹화를 시작할 때는 이미 끝났습니다，있는 것만 --entry 녹화에 담을 수 있습니다
  const late = path.join(ctx.folder, "late");
  await shoot(ctx, late, "--record", "--hold", "300");
  assert.ok(sameBytes(path.join(late, "motion-start.jpg"), path.join(late, "motion-end.jpg")));
  const output = path.join(ctx.folder, "entry");
  await shoot(ctx, output, "--record", "--entry", "--hold", "300");
  assertArtifacts(output, ["motion-start.jpg", "motion-mid.jpg", "motion-end.jpg"]);
  assert.ok(!sameBytes(path.join(output, "motion-start.jpg"), path.join(output, "motion-end.jpg")));
});

browserTest("missing favicon is not reported as a page problem", async (ctx) => {
  writePage(ctx, '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>작은 시안</title></head>'
    + '<body><h1 style="font-size:32px">아이콘이 없는 시안</h1></body></html>');
  const output = path.join(ctx.folder, "no-favicon");
  await shoot(ctx, output, "--size", "1280x900");
  assert.deepEqual(report(output)[0].issues, []);
});

browserTest("reports page problems", async (ctx) => {
  editPage(ctx, "</body>", `
<div style="width:2000px">넘침</div><img src="missing.png">
<script>console.error('shoot-test-error'); throw new Error('shoot-test-exception');</script>
</body>`);
  for (const args of [[], ["--record", "--hold", "300"]]) {
    const output = path.join(ctx.folder, args.length ? "problem-record" : "problem-shots");
    await shoot(ctx, output, "--size", "1280x900", ...args);
    const issues = report(output)[0].issues.join("\n");
    for (const expected of ["shoot-test-error", "shoot-test-exception", "가로 넘침", "이미지를 읽지 못했습니다"]) includes(issues, expected);
  }
});

browserTest("lint flags default patterns", async (ctx) => {
  writePage(ctx, `<!doctype html><html lang="ko"><head><meta charset="utf-8"><link rel="icon" href="data:,"><style>
body{margin:0;padding:40px;font:16px/1.7 sans-serif;color:#222;background:#fff}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;margin:0}
h1{font-size:48px;margin:0 0 24px;background:linear-gradient(90deg,#7c3aed,#06b6d4);background-clip:text;-webkit-background-clip:text;color:transparent}
.num{font-size:12px;margin:0}h2{font-size:28px;margin:4px 0 24px}
.card{border:1px solid #ddd;border-radius:16px;padding:24px;margin:16px 0}
.quote{border-left:4px solid #e11d48;padding:12px 16px}.low{color:#c8c8c8}
.dense{font-size:10px;line-height:1.2;width:600px}.ghost{opacity:0}
</style></head><body><p class="eyebrow">Smart Ledger</p><h1>가계부를 더 쉽게 씁니다</h1>
<p class="num">01 / 계정</p><h2>모든 계정을 한눈에 봅니다</h2>
<div class="card">바깥쪽<div class="card">안쪽 카드의 글</div></div>
<div class="quote">좋은 도구는 쓰는 동안 존재를 잊게 합니다。</div><p class="low">아주 흐린 설명 글，색이 거의 보이지 않습니다。</p>
<p class="dense">매우 긴 본문 문단입니다，글자와 줄 간격이 아주 작습니다，한 줄이 매우 깁니다，줄을 바꿔 읽을 때 눈이 너무 멀리 움직입니다，매우 긴 본문 문단입니다，글자와 줄 간격이 아주 작습니다，한 줄이 매우 깁니다，줄을 바꿔 읽을 때 눈이 너무 멀리 움직입니다。</p>
<ul><li><span>🚀</span> 빠름</li><li><span>💰</span> 절약</li></ul><div><span>WORKSPACE OVERVIEW</span> <span>CONTENT OBJECT</span></div>
<p class="ghost">이 부분이 계속 투명한 채로 있습니다</p>
<p>이 페이지에는 한국어가 충분히 많습니다，한국어 화면인지 판단할 때 씁니다。이 페이지에는 한국어가 충분히 많습니다，한국어 화면인지 판단할 때 씁니다。이 페이지에는 한국어가 충분히 많습니다，한국어 화면인지 판단할 때 씁니다。</p>
</body></html>`);
  const output = path.join(ctx.folder, "lint");
  const result = await shoot(ctx, output, "--size", "1440x900");
  const entry = report(output)[0];
  assert.deepEqual(entry.issues, []);
  const rules = new Set(entry.lint.map((item) => item.rule));
  for (const rule of ["contrastLow", "smallText", "tightLeading", "stuck"]) assert.ok(rules.has(rule), rule);
  for (const removed of ["eyebrow", "numbered", "gradientText", "sideStripe", "emojiIcon",
    "englishLabel", "grayOnColor", "longMeasure", "headingSpacing", "sourceSplit"]) assert.ok(!rules.has(removed), removed);
  includes(result.stdout, "읽기 쉬움과 그리기 안내");
});

browserTest("lint spares interaction boundaries attachments and empty slots", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
body{margin:0}.outer{border-radius:12px;background:#eee;padding:12px;width:340px}
.box{border:1px solid #777;border-radius:8px;padding:8px;width:260px;min-height:56px;background:white}
.popup{position:absolute;top:0;left:420px}.fixed{position:fixed;top:90px;left:420px}
</style><form class="outer"><textarea></textarea>
<div class="box"><strong>draft.svg</strong><small>SVG · 1 KB</small><button>지우기</button></div>
<div class="box"><strong>draft.svg</strong><small>읽는 중</small><button>다시 시도</button></div>
<div class="box popup">안 <div class="box">선택지</div></div>
<div class="box fixed">안</div></form>
<div class="outer"><div class="box" role="listbox">안</div><div class="box" role="menu">메뉴</div>
<div class="box" role="dialog">대화</div><div class="box" role="tooltip">설명</div>
<div class="box" popover="manual" id="popover">겹쳐 뜨는 영역</div><div class="box"></div></div>
<script>popover.showPopover()</script>`);
  const output = path.join(ctx.folder, "semantic-cards");
  await shoot(ctx, output, "--size", "desktop");
  const hints = report(output)[0].lint;
  assert.ok(!hints.some((h) => h.rule === "nestedCards"), JSON.stringify(hints));
});

browserTest("lint allows content cards inside panels and editors", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
.outer{border-radius:12px;background:#eee;padding:12px;width:340px}
.box{border:1px solid #777;border-radius:8px;padding:8px;width:260px;min-height:56px}
</style><div class="outer" style="position:relative;height:100px"><div class="box" style="position:absolute;left:12px;top:12px">실제 내용 카드</div></div>
<form class="outer"><textarea></textarea><div class="box"><h3>다른 내용 패널</h3><p>설명</p><button>조작</button></div></form>`);
  const output = path.join(ctx.folder, "real-cards");
  await shoot(ctx, output, "--size", "desktop");
  const hints = report(output)[0].lint;
  assert.ok(!hints.some((h) => h.rule === "nestedCards"), JSON.stringify(hints));
});

browserTest("lint requires body contrast of 4 5", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head><link rel="icon" href="data:,"><style>
body{margin:0;padding:40px;font:16px/1.6 sans-serif;color:#222;background:#fff}
body::before{content:"";position:absolute;left:0;top:0;width:12px;height:12px;background:#111}
.soft{color:#8a8a8a}
.low{color:#aaa}
.faint{color:#eee}
.faint-tiny{color:#eee;font-size:10px;line-height:1.2;width:280px}
.seg{position:relative;display:inline-block;padding:8px 16px}
.seg-pill{position:absolute;inset:0;background:#111;border-radius:8px}
.seg-label{position:relative;color:#fff}
.pseudo-seg{position:relative;display:inline-block;padding:8px 16px;color:#fff}
.pseudo-seg::before{content:"";position:absolute;inset:0;background:#111;border-radius:8px;z-index:-1}
</style></head><body>
<p class="soft">Secondary text at about 3.5 to 1 contrast is spared by the 3.0 floor.</p>
<p class="low">Body text at about 2.3 to 1 contrast still fails the 3.0 floor.</p>
<p class="faint">Body text at 1.16 to 1 on a plain white background must also be reported.</p>
<p class="faint-tiny">흰 바탕에서 거의 보이지 않고 글자도 작은 문단입니다、줄 간격이 좁은 여러 줄 한국어 본문，대비가 낮아도 배치 검사를 건너뛰지 않는지 봅니다。</p>
<div class="seg"><span class="seg-pill"></span><span class="seg-label">Active Tab</span></div>
<div class="pseudo-seg">Pseudo Pill Tab</div>
</body></html>`);
  const output = path.join(ctx.folder, "soft");
  await shoot(ctx, output, "--size", "1280x800");
  const lint = Object.fromEntries(report(output)[0].lint.map((item) => [item.rule, item]));
  assert.ok("contrastLow" in lint);
  assert.equal(lint.contrastLow.count, 3);
  assert.ok("smallText" in lint);
  assert.ok("tightLeading" in lint);
});

browserTest("lint spares css triangles and neutral dividers", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head><link rel="icon" href="data:,"><style>
body{margin:0;padding:40px;font:16px/1.6 sans-serif;color:#222}
.play{width:0;height:0;border-top:12px solid transparent;border-bottom:12px solid transparent;border-left:20px solid #e11d48}
aside{border-right:1px solid #ddd;height:200px;width:200px}
blockquote{border-left:4px solid #e11d48;padding:8px 16px;margin:16px 0}
nav a{display:block;position:relative;padding:8px 16px;width:120px}
nav a[aria-current="page"]{border-left:3px solid #2563eb}
nav a.active::before{content:"";position:absolute;left:0;top:4px;width:3px;height:32px;background:#2563eb}
@keyframes rise{from{opacity:0}to{opacity:1}}h1{animation:rise .6s ease-out both;font-size:40px;margin:48px 0 12px}
</style></head><body><span class="play"></span><aside>Sidebar</aside><blockquote>Quoted passage with semantic blockquote border.</blockquote>
<nav><a href="#a" aria-current="page">Overview</a><a href="#b" class="active">Settings</a><a href="#c">Billing</a></nav>
<p>Intro paragraph above the heading.</p>
<h1>Plain heading</h1><p>Body text that follows the heading closely.</p></body></html>`);
  const output = path.join(ctx.folder, "clean");
  await shoot(ctx, output, "--size", "1280x800");
  assert.deepEqual(report(output)[0].lint, []);
});

browserTest("compare against reference", async (ctx) => {
  const reference = path.join(ctx.folder, "reference");
  await shoot(ctx, reference, "--states", "a", "--size", "800x600");
  const same = path.join(ctx.folder, "same");
  await shoot(ctx, same, "--states", "a", "--size", "800x600", "--compare", path.join(reference, "a.png"));
  let entry = report(same)[0];
  assertArtifacts(same, ["a-compare.png"]);
  assert.ok(entry.compare.overall < 1, String(entry.compare.overall));
  const other = path.join(ctx.folder, "other");
  const result = await shoot(ctx, other, "--states", "b", "--size", "800x600", "--compare", path.join(reference, "a.png"));
  entry = report(other)[0];
  assert.ok(entry.compare.overall > 20, String(entry.compare.overall));
  assert.equal(Object.keys(entry.compare.cells).length, 9);
  includes(result.stdout, "차이가 뚜렷한 픽셀 비율:");
  const missing = await node([ctx.page, "--compare", path.join(ctx.folder, "nope.png")], { env: ctx.env, timeout: 30 });
  assert.notEqual(missing.status, 0);
  includes(missing.stderr, "참고 그림을 찾을 수 없습니다");
});

browserTest("reports blank webgl canvas", async (ctx) => {
  // 같은 캔버스에서 이미 받음: 2d 맥락，다시 받기 webgl 반드시 실패함，다음을 흉내 내는 데 씁니다:“캡처했지만 캔버스가 비어 있습니다”
  editPage(ctx, "</body>", `
<canvas id="bad"></canvas><canvas id="good"></canvas>
<script>
const bad = document.querySelector('#bad'); bad.getContext('2d'); bad.getContext('webgl');
const good = document.querySelector('#good'); good.getContext('webgl2') || good.getContext('webgl');
</script></body>`);
  const output = path.join(ctx.folder, "webgl");
  await shoot(ctx, output);
  includes(report(output)[0].issues.join("\n"), "WebGL：1 개 캔버스에서 그리기 컨텍스트를 만들지 못함");
});

browserTest("fill replaces and fires events while type inserts at cursor", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,">
<input id="insert" value="seed"><input id="replace" value="old value">
<textarea aria-label="Message box">old text</textarea><input id="empty" value="old value">
<div id="rich" contenteditable="true">old content</div><button id="verify">Verify</button>
<script>
const insert=document.querySelector('#insert'); insert.onfocus=()=>insert.setSelectionRange(2,2);
const changes={};
for(const el of document.querySelectorAll('#replace,textarea,#empty,#rich')) {
  changes[el.id||'textarea']=[];
  for(const event of ['input','change'])el.addEventListener(event,e=>{
    if(!e.bubbles)console.error('fill-event-not-bubbling');
    changes[el.id||'textarea'].push([event,el.isContentEditable?el.textContent:el.value]);
  });
}
document.querySelector('#verify').onclick=()=>{
  if(insert.value!=='seXed')console.error('type-did-not-insert-at-cursor');
  for(const [key,value] of Object.entries({replace:'new value',textarea:'new text',empty:'',rich:'new content'})) {
    const el=key==='textarea'?document.querySelector('textarea'):document.getElementById(key);
    if((el.isContentEditable?el.textContent:el.value)!==value ||
       JSON.stringify(changes[key])!==JSON.stringify([['input',value],['change',value]]))console.error('fill-failed-'+key);
  }
};</script>`);
  const output = path.join(ctx.folder, "fill");
  await shoot(ctx, output, "--size", "desktop", "--steps", 'type #insert X; fill #replace "new value"; '
    + 'fill [aria-label="Message box"] "new text"; fill #empty ""; '
    + 'fill #rich "new content"; click #verify');
  assert.deepEqual(report(output)[0].issues, []);
});

browserTest("fill rejects non editable elements with context", async (ctx) => {
  const result = await runFailure(ctx, path.join(ctx.folder, "fill-invalid"), "--steps", "fill #go hello");
  includes(result.stderr, " 1 단계「fill #go hello」");
  includes(result.stderr, "fill 입력창이 필요합니다、입력창 또는 편집 가능한 요소");
  includes(result.stderr, '예: fill #message "hello world"');
});

browserTest("click doubleclick and hover warn about blocker and still execute", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
#target,.veil{position:absolute;left:20px;top:20px;width:120px;height:60px}.veil{z-index:2}
#verify{position:absolute;left:200px;top:20px}</style>
<button id="target">Target</button><div class="veil">Overlay</div><button id="verify">Verify</button>
<script>
let clicks=0,doubles=0,hovers=0,hits=0;
document.querySelector('.veil').onclick=()=>clicks++;
document.querySelector('.veil').ondblclick=()=>doubles++;
document.querySelector('.veil').onmouseenter=()=>hovers++;
document.querySelector('#target').onclick=()=>hits++;
document.querySelector('#verify').onclick=()=>{
if(clicks!==3 || doubles!==1 || hovers!==1 || hits!==0)console.error('blocked-actions-not-executed');
};</script>`);
  const output = path.join(ctx.folder, "blocked");
  const result = await shoot(ctx, output, "--steps", "hover #target; click #target; dblclick #target; click #verify");
  const issues = report(output)[0].issues;
  assert.equal(issues.length, 3, JSON.stringify(issues));
  for (const [index, action] of ["hover", "click", "dblclick"].entries()) {
    const message = ` ${index + 1} 단계「${action} #target」：가운데를 가린 요소: div.veil 가리고 있음`;
    includes(issues[index], message);
    includes(result.stdout, message);
    includes(issues[index], "동작은 그대로 실행합니다");
  }
  includes(result.stdout, "찾음 3 개 문제");
});

browserTest("descendant at center is not a blocker and mark does not warn", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
#target{width:120px;height:60px}#target span{display:block;width:100%;height:100%}</style>
<button id="target"><span>Target</span></button><button id="disabled" disabled>Disabled</button>
<script>let count=0;document.querySelector('#target').onclick=()=>count++;
document.querySelector('#target').ondblclick=()=>{if(count!==3)console.error('descendant-click-failed')};</script>`);
  const output = path.join(ctx.folder, "descendant");
  const result = await shoot(ctx, output, "--steps", "hover #target; click #target; dblclick #target", "--mark", "#disabled");
  assert.deepEqual(report(output)[0].issues, []);
  excludes(result.stdout, "안내：");
});

browserTest("disabled reasons are warnings and do not stop actions", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>button{width:100px;height:50px}</style>
<button id="disabled" disabled>Disabled</button><button id="aria" aria-disabled="true">Aria</button>
<button id="pointer" style="pointer-events:none">Pointer</button>
<fieldset disabled><button id="inherited">Inherited</button></fieldset><button id="verify">Verify</button>
<script>let count=0;document.querySelector('#aria').onclick=()=>count++;
document.querySelector('#verify').onclick=()=>{if(count!==1)console.error('aria-action-stopped')};</script>`);
  const output = path.join(ctx.folder, "disabled");
  const result = await shoot(ctx, output, "--size", "desktop", "--steps", "hover #disabled; click #aria; "
    + "dblclick #pointer; click #inherited; click #verify");
  const issues = report(output)[0].issues;
  for (const [step, reason] of [["hover #disabled", "disabled"], ["click #aria", 'aria-disabled="true"'],
    ["dblclick #pointer", "pointer-events: none"], ["click #inherited", "disabled"]]) {
    assert.ok(issues.some((issue) => issue.includes(`「${step}」：대상이 비활성 상태입니다（${reason}）`)), JSON.stringify(issues));
    includes(result.stdout, reason);
  }
  assert.ok(!issues.some((issue) => issue.includes("콘솔 오류")), JSON.stringify(issues));
  includes(result.stdout, `찾음 ${issues.length} 개 문제`);
});

browserTest("action warnings are in recording and motion reports", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
#target,#overlay{position:absolute;top:20px;left:20px;width:100px;height:50px}#overlay{z-index:2}</style>
<button id="target" aria-disabled="true">Target</button><div id="overlay">Overlay</div>`);
  const output = path.join(ctx.folder, "warning-record");
  let result = await shoot(ctx, output, "--motion", "--record", "--steps", "click #target", "--hold", "0");
  const entries = report(output);
  assert.equal(entries.length, 2);
  assert.ok("motion" in entries[0]);
  for (const entry of entries) {
    assert.ok(entry.issues.some((issue) => issue.includes("가운데를 가린 요소: div#overlay 가리고 있음")), JSON.stringify(entry));
    assert.ok(entry.issues.some((issue) => issue.includes('aria-disabled="true"')), JSON.stringify(entry));
  }
  includes(result.stdout, "가운데를 가린 요소: div#overlay 가리고 있음");
  includes(result.stdout, `찾음 ${entries.reduce((sum, r) => sum + r.issues.length, 0)} 개 문제`);
  // A later failure must not erase warnings already raised by the recording.
  const failed = path.join(ctx.folder, "warning-before-failure");
  result = await runFailure(ctx, failed, "--record", "--steps", "click #target; click .missing", "--hold", "0");
  const entry = report(failed)[0];
  assert.ok(entry.failed);
  assert.ok(entry.issues.some((issue) => issue.includes("가운데를 가린 요소: div#overlay 가리고 있음")), JSON.stringify(entry));
  assert.ok(entry.issues.some((issue) => issue.includes('aria-disabled="true"')), JSON.stringify(entry));
  assert.ok(entry.issues.some((issue) => issue.includes("요소를 찾을 수 없습니다 .missing")), JSON.stringify(entry));
  includes(result.stdout, `찾음 ${entry.issues.length} 개 문제`);
  assert.deepEqual(listDir(failed, (name) => name.startsWith("frames")), []);
});

browserTest("missing elements explain iframe and open shadow root scope", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,">
<iframe srcdoc="<button id='framed'>Framed</button>"></iframe><iframe srcdoc="<p>Another frame</p>"></iframe>
<div id="host"></div><div id="closed"></div><script>
const root=document.querySelector('#host').attachShadow({mode:'open'});
root.innerHTML='<button id="shadowed">Shadowed</button><div id="nested"></div>';
root.querySelector('#nested').attachShadow({mode:'open'}).innerHTML='<button>Nested</button>';
document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<button>Closed</button>';
</script>`);
  for (const args of [["--steps", "click #framed"], ["--steps", "click text=Shadowed"],
    ["--steps", "fill #shadowed hello"], ["--mark", "#shadowed"]]) {
    const result = await runFailure(ctx, path.join(ctx.folder, "scope"), ...args);
    includes(result.stderr, "요소를 찾을 수 없습니다");
    includes(result.stderr, "첫 문서 안에서만 요소를 찾습니다，페이지 안에 있음: 2 개 iframe、2 개 열린 shadow root");
  }
  writePage(ctx, '<!doctype html><link rel="icon" href="data:,"><body></body>');
  const result = await runFailure(ctx, path.join(ctx.folder, "no-roots"), "--steps", "click .missing");
  excludes(result.stderr, "첫 문서 안에서만 요소를 찾습니다");
});

browserTest("missing element scope counts iframes and shadow roots independently", async (ctx) => {
  for (const [markup, expected] of [
    ['<iframe srcdoc="<p>Frame</p>"></iframe>', "1 개 iframe、0 개 열린 shadow root"],
    [`<div id="host"></div><script>document.querySelector('#host').attachShadow({mode:'open'}).innerHTML='<p>Shadow</p>';</script>`,
      "0 개 iframe、1 개 열린 shadow root"],
  ]) {
    writePage(ctx, '<!doctype html><link rel="icon" href="data:,">' + markup);
    const result = await runFailure(ctx, path.join(ctx.folder, "root-counts"), "--steps", "click .missing");
    includes(result.stderr, expected);
  }
});

browserTest("actions text selectors and marks", async (ctx) => {
  writePage(ctx, `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>
body{margin:0;padding:20px}button{padding:12px}.hidden{display:none}</style>
<div class="nav"><button aria-label="Send money">More</button><button id="double">Undo</button></div>
<input aria-label="Message box"><select id="choice"><option value="a">First</option><option value="b">Second item</option></select>
<div id="status"></div><button class="hidden">More</button><div data-label="a;b">Semicolon</div>
<script>
let count=0; document.querySelector('[aria-label]').onclick=()=>count++;
document.querySelector('#double').ondblclick=()=>count+=10;
document.querySelector('#double').onmouseenter=()=>document.body.dataset.hover='yes';
for(const event of ['input','change']) document.querySelector('#choice').addEventListener(event,()=>document.body.dataset[event]='yes');
setTimeout(()=>{const b=document.createElement('button');b.textContent='Ready';document.body.append(b)},700);
setInterval(()=>document.querySelector('#status').textContent=JSON.stringify({count,text:document.querySelector('input').value,choice:document.querySelector('select').value,hover:document.body.dataset.hover,input:document.body.dataset.input,change:document.body.dataset.change}),30);
</script>`);
  const output = path.join(ctx.folder, "actions");
  const result = await shoot(ctx, output, "--steps", 'click text=More; click [aria-label="Send money"]; '
    + 'click "[aria-label=\\"Send money\\"]"; hover button:has-text("Undo"); '
    + 'doubleclick button:has-text(\'Undo\'); fill [aria-label="Message box"] "hello world"; '
    + 'press ControlOrMeta+A; type "body input" "replacement"; select #choice b; '
    + 'select #choice "Second item"; waitfor text=Ready; sleep 0.1s; '
    + 'click [data-label="a;b"]; click :has-text("Semicolon")',
  "--mark", '1=text=More; 2=button:has-text("Undo")');
  assertArtifacts(output, ["page.png", "page-marked.png"]);
  // The report includes console output only on errors, so assert browser state through a guard.
  editPage(ctx, "setInterval(()=>document", `setTimeout(()=>{
if(count!==13 || document.querySelector('input').value!=='replacement' || document.querySelector('select').value!=='b' || document.body.dataset.hover!=='yes' || document.body.dataset.input!=='yes' || document.body.dataset.change!=='yes') console.error('action-guard-failed');
},2600);setInterval(()=>document`);
  await shoot(ctx, path.join(ctx.folder, "guard"), "--steps", 'click text=More; click [aria-label="Send money"]; '
    + 'click "[aria-label=\\"Send money\\"]"; hover button:has-text("Undo"); '
    + 'dblclick button:has-text("Undo"); type [aria-label="Message box"] "hello world"; '
    + 'key ControlOrMeta+A; type "body input" replacement; select #choice "Second item"; wait 2000');
  assert.deepEqual(report(path.join(ctx.folder, "guard"))[0].issues, [], result.stdout);
});

browserTest("selector errors include context and hints", async (ctx) => {
  for (const [raw, expected] of [
    ['wait 0; click [id="missing"]', [" 2 단계", 'click [id="missing"]', 'id="go"']],
    ["click text=전", null],
    ["click text=없는 대상으로 바꾸기", ["보이는 글", "전환"]],
    ["click body .missing", ['"body" 일치 1 개 요소']],
    ["click button:unknown", ["올바르지 않음: CSS", 'text="Send money"', 'button:has-text("Undo")']],
    ["waitfor .missing", [" 1 단계", "waitfor .missing", "요소를 찾을 수 없습니다"]],
  ]) {
    if (expected === null) {
      // Containment fallback succeeds. Python skipped this under a non-UTF-8 filesystem encoding because it
      // encoded argv in that charset; Node always hands argv to the child as UTF-8, so it always runs here.
      await shoot(ctx, path.join(ctx.folder, "contained"), "--steps", raw);
      continue;
    }
    const result = await runFailure(ctx, path.join(ctx.folder, "missing"), "--steps", raw);
    for (const text of expected) includes(result.stderr, text);
  }
  await runFailure(ctx, path.join(ctx.folder, "mark-invalid"), "--mark", "button:unknown");
});

browserTest("playwright selectors find the intended elements", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>button{margin:8px}</style>
<button onclick="hits.push('contains')">Save draft</button>
<button onclick="hits.push('exact')">Save</button>
<button onclick="hits.push('wrong')">Save more</button>
<button data-select="0842" onclick="hits.push('numeric')">Numeric</button>
<div><button class="item" onclick="hits.push('wrong')">First</button></div>
<p>Different sibling</p><button class="item" onclick="hits.push('nth')">Second</button>
<button onclick="hits.push('bare')">Unique nested <span>Target</span></button>
<button onclick="hits.push('chain')">4 replies</button>
<button data-label='literal :has-text("x") &gt;&gt; nth=1' onclick="hits.push('literal')">Literal</button>
<button id="verify" onclick="if(hits.join(',')!=='contains,exact,numeric,nth,bare,chain,literal')console.error(hits)">Verify</button>
<script>const hits=[];</script>`);
  const output = path.join(ctx.folder, "playwright");
  await shoot(ctx, output, "--size", "desktop", "--steps",
    `click button:has-text("Save draft"); click button:text-is('Save');
click [data-select=0842]; click ".item >> nth=1"; click :has-text("Target");
click button:has-text(4):has-text(replies); click [data-label='literal :has-text("x") >> nth=1']; click #verify`,
    "--mark", '1=button:text-is("Save"); 2=[data-select=0842]; 3=.item >> nth=1');
  assert.deepEqual(report(output)[0].issues, []);
  assertArtifacts(output, ["page.png", "page-marked.png"]);
  // Corpus calls also omit text quotes and escape nested quotes around the whole selector.
  await shoot(ctx, path.join(ctx.folder, "unquoted-text"), "--steps", 'hover "button:text-is(Save)"; hover "button:has-text(\\"Save draft\\")"');
});

browserTest("playwright exact text and nth do not fall back", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,">
<button>Save more</button><button class="item" hidden>Hidden</button><button class="item">Visible</button>`);
  let result = await runFailure(ctx, path.join(ctx.folder, "exact-missing"), "--steps", 'wait 0; click button:text-is("Save")');
  includes(result.stderr, " 2 단계");
  includes(result.stderr, "요소를 찾을 수 없습니다");
  result = await runFailure(ctx, path.join(ctx.folder, "hidden-nth"), "--steps", "click .item >> nth=0");
  includes(result.stderr, "모두 보이지 않습니다");
  result = await runFailure(ctx, path.join(ctx.folder, "missing-nth"), "--steps", "click .item >> nth=2");
  includes(result.stderr, "요소를 찾을 수 없습니다");
  await shoot(ctx, path.join(ctx.folder, "last-nth"), "--steps", "hover .item >> nth=-1");
});

browserTest("unsupported playwright combinations give context and copyable examples", async (ctx) => {
  for (const [selector, rewrite] of [['button:has-text("Save") > span', 'text="Save"'],
    [".item >> nth=one", ".item >> nth=1"],
    [':is(button:has-text("Save"))', 'text="Save"'],
    ['button:has-text("Save") >> text=Draft', 'text="Save"']]) {
    const result = await runFailure(ctx, path.join(ctx.folder, "unsupported"), "--steps", "wait 0; hover " + selector);
    includes(result.stderr, " 2 단계");
    includes(result.stderr, "받은 값: " + selector);
    includes(result.stderr, "예: hover " + rewrite);
  }
  let result = await runFailure(ctx, path.join(ctx.folder, "unsupported-mark"), "--mark", ".item >> nth=one");
  includes(result.stderr, "--mark");
  includes(result.stderr, "받은 값: .item >> nth=one");
  result = await runFailure(ctx, path.join(ctx.folder, "unsupported-fill"), "--steps", 'fill ".item >> nth=one" hello');
  includes(result.stderr, '예: fill ".item >> nth=1" "hello"');
});

browserTest("visible element does not scroll and offscreen does", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
body{margin:0;height:2400px}#top{position:absolute;top:40px}#bottom{position:absolute;top:1800px}</style>
<button id="top">Top</button><button id="bottom">Bottom</button><script>
let last=0;topButton=document.querySelector('#top');topButton.onmouseenter=()=>{if(scrollY!==0)console.error('visible-scrolled')};
topButton.onclick=()=>{if(scrollY!==0)console.error('visible-scrolled')};
document.querySelector('#bottom').onclick=()=>{if(scrollY===0)console.error('offscreen-not-scrolled')};
</script>`);
  await shoot(ctx, path.join(ctx.folder, "scroll"), "--size", "desktop", "--steps", "hover #top; click #top; click #bottom");
  assert.deepEqual(report(path.join(ctx.folder, "scroll"))[0].issues, []);
});

browserTest("query multiple zooms and groups reset", async (ctx) => {
  editPage(ctx, "</body>", `<script>
if(new URLSearchParams(location.search).get('a')!=='1' || new URLSearchParams(location.search).get('b')!=='two words')console.error('query-missing');
document.querySelector('#go').addEventListener('click',()=>{if(document.body.dataset.state!=='b')console.error('group-not-reset')});
</script></body>`);
  const output = path.join(ctx.folder, "multiple");
  await shoot(ctx, output, "--size=desktop", "--zoom=1,2", "--query", "a=1&b=two+words", "--states", "a",
    "--steps", "open: click body #go", "--steps", "send: click #go");
  assertArtifacts(output, ["a-open.png", "a-send.png", "a-open-@2x.png", "a-send-@2x.png"]);
  const entries = report(output);
  assert.ok(entries.every((r) => r.issues.length === 0), JSON.stringify(entries));
  assert.deepEqual(entries.map((r) => r.zoom), [1, 1, 2, 2]);
  const aliases = path.join(ctx.folder, "aliases");
  await shoot(ctx, aliases, "--size", "phone,800x600", "--query", "a=1&b=two+words");
  assertArtifacts(aliases, ["page-390x844.png", "page-800x600.png"]);
});

browserTest("named and unnamed record groups", async (ctx) => {
  const output = path.join(ctx.folder, "record-groups");
  await shoot(ctx, output, "--record", "--hold=100", "--wait=0", "--steps", "open: click #go", "--steps", "click #go");
  assertArtifacts(output, ["motion-open-start.jpg", "motion-open-mid.jpg", "motion-open-end.jpg", "motion-2-end.jpg"]);
  if (FFMPEG) assertArtifacts(output, ["record-open.mp4", "record-2.mp4"]);
  assert.equal(report(output).length, 2);
});

browserTest("evidence all artifacts and partial failure", ffmpegSkip("ffmpeg is needed for complete evidence"), async (ctx) => {
  const output = path.join(ctx.folder, "evidence");
  const evidence = await shoot(ctx, output, "--evidence", "--states=a,b", "--hold=100", "--steps", "toggle: click #go");
  includes(evidence.stdout, "점검자에게 전달：");
  includes(evidence.stdout, "reviewer-manual.md");
  assertArtifacts(output, ["a.png", "b.png", "a-masked.png", "b-masked.png", "sheet.png", "sheet-masked.png",
    "a-@2x.png", "record-entry.mp4", "motion-entry-start.jpg", "motion-entry-mid.jpg", "motion-entry-end.jpg",
    "record-toggle.mp4", "motion-toggle-start.jpg", "motion-toggle-mid.jpg", "motion-toggle-end.jpg"]);
  assert.ok(report(output).some((r) => r.file === "motion-probe-toggle"));
  assert.ok(!fs.existsSync(path.join(output, "b-@2x.png")), "Default evidence still gives only the first state a 2x shot");
  const failed = path.join(ctx.folder, "partial");
  const result = await runFailure(ctx, failed, "--evidence", "--hold=100", "--steps", "broken: click .missing", "--steps", "good: click #go");
  assertArtifacts(failed, ["page.png", "page-@2x.png", "record-entry.mp4", "record-good.mp4", "report.json"]);
  assert.equal(report(failed).reduce((sum, r) => sum + Number(r.failed ?? false), 0), 2);
  includes(result.stdout, "실패");
});

browserTest("evidence explicit zooms cover each state and entry starts blank", ffmpegSkip("ffmpeg is needed for complete evidence"), async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
body{margin:0;background:#223344}#box{width:120px;height:120px;background:blue;animation:appear .36s linear both}
@keyframes appear{from{opacity:0}to{opacity:1}}#go{position:absolute;top:200px}
</style><div id="box"></div><button id="go">Change</button><script>
if(innerWidth!==800 || innerHeight!==600)console.error('zoom-changed-layout');
if(new URLSearchParams(location.search).get('state')==='b')document.body.style.background='#441122';
document.querySelector('#go').onclick=()=>document.body.style.background='#151515';
</script>`);
  for (const [option, zooms] of [["--zoom=1", [1]], ["--zoom=1,2", [1, 2]], ["--zoom=2,3", [2, 3]]]) {
    const output = path.join(ctx.folder, "evidence-" + zooms.join("-"));
    await shoot(ctx, output, "--evidence", "--states", "a,b", "--size", "800x600", option, "--hold", "50", "--steps", "change: click #go");
    const entries = report(output);
    const shots = entries.filter((entry) => entry.file.endsWith(".png"));
    assert.deepEqual(shots.map((entry) => [entry.zoom, entry.state]), zooms.flatMap((zoom) => ["a", "b"].map((state) => [zoom, state])), option);
    assert.ok(shots.every((entry) => entry.issues.length === 0), JSON.stringify(shots));
    for (const zoom of zooms) {
      const suffix = zoom === 1 ? "" : `-@${zoom}x`;
      for (const state of ["a", "b"]) {
        const name = `${state}${suffix}.png`;
        assert.deepEqual(pngSize(path.join(output, name)), [800 * zoom, 600 * zoom], name);
        assertArtifacts(output, [name, `${state}${suffix}-masked.png`]);
      }
      // Single-zoom sheets keep their existing names.
      const sheetSuffix = zooms.length > 1 ? suffix : "";
      assertArtifacts(output, [`sheet${sheetSuffix}.png`, `sheet${sheetSuffix}-masked.png`]);
    }
    if (!zooms.includes(1)) assert.ok(!fs.existsSync(path.join(output, "a.png")));
    if (!zooms.includes(2)) assert.ok(!fs.existsSync(path.join(output, "a-@2x.png")));
    const entry = entries.find((item) => item.group === "entry");
    assert.equal(entry.sampling.mode, "entry");
    const first = await framePixel(path.join(output, "record-entry.mp4"));
    assert.ok(first.every((channel) => channel > 245), String(first));
    // Content frames must belong to the new page, not the previous dark completed page.
    assert.notDeepEqual(await framePixel(path.join(output, entry.frames.start.file)), [21, 21, 21]);
    assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
  }
});

const FAULT_PRELOAD = `import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const originalTimer=globalThis.setTimeout;let watchdog;
globalThis.setTimeout=(callback,delay,...args)=>{const timer=originalTimer(callback,delay,...args);if(delay>=90000)watchdog={callback,delay,timer};return timer};
const previous=existsSync(process.env.SHOOT_TEST_JOURNAL)?readFileSync(process.env.SHOOT_TEST_JOURNAL,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const Native=globalThis.WebSocket;let captures=previous.filter(row=>'capture' in row).length,connections=0;
const drops=new Set((process.env.SHOOT_TEST_DROPS||'').split(',').map(Number));
const write=row=>appendFileSync(process.env.SHOOT_TEST_JOURNAL,JSON.stringify(row)+'\\n');
globalThis.WebSocket=class extends Native {
 constructor(...args){super(...args);write({connection:++connections});
   const substituted=new WeakSet();
   this.addEventListener('message',event=>{
    if(substituted.has(event)||!process.env.SHOOT_TEST_STALE)return;
    const msg=JSON.parse(event.data);
    if(msg.method!=='Page.screencastFrame')return;
    event.stopImmediatePropagation();msg.params.data=readFileSync(process.env.SHOOT_TEST_STALE).toString('base64');
    const replacement=new MessageEvent('message',{data:JSON.stringify(msg)});substituted.add(replacement);this.dispatchEvent(replacement);
   });
 }
 send(data){const msg=JSON.parse(data);if(msg.method==='Page.captureScreenshot'){
   write({capture:++captures,timeout:watchdog.delay});
   if(drops.has(captures)){clearTimeout(watchdog.timer);originalTimer(watchdog.callback,100);return;}
 }return super.send(data)}
};`;

// Keep a real Chrome/CDP transport. Only selected responses are suppressed; accelerate
// those watchdogs after recording the production timeout value, leaving all other timers intact.
function faultEnv(ctx, drops = "", stale = null) {
  const preload = path.join(ctx.folder, "fault.mjs");
  const journal = path.join(ctx.folder, "fault.jsonl");
  fs.writeFileSync(preload, FAULT_PRELOAD);
  const env = { ...ctx.env, NODE_OPTIONS: "--import=" + pathToFileURL(preload).href, SHOOT_TEST_DROPS: drops, SHOOT_TEST_JOURNAL: journal };
  if (stale) env.SHOOT_TEST_STALE = stale;
  return { env, journal };
}

const TRANSPORT_FAULT_PRELOAD = `import {appendFileSync,readFileSync,existsSync} from 'node:fs';
const path=process.env.SHOOT_TEST_TRANSPORT_JOURNAL,mode=process.env.SHOOT_TEST_TRANSPORT;
const rows=()=>existsSync(path)?readFileSync(path,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
const write=row=>appendFileSync(path,JSON.stringify(row)+'\\n');
const fault=()=>process.env.SHOOT_TEST_ALWAYS==='1'||!rows().some(row=>row.fault);
const original=globalThis.setTimeout;let watchdog;
globalThis.setTimeout=(callback,delay,...args)=>{
 const stage=delay===45000||delay===90000?'launch':null;
 if(mode==='launch'&&stage){write({stage,timeout:delay});if(fault()){write({fault:mode});return original(callback,1000,...args)}}
 const timer=original(callback,delay,...args);
 if(delay===30000||delay===60000||delay===120000)watchdog={callback,delay,timer};
 if(mode==='connect'&&String(callback).includes('브라우저 연결')&&delay>=30000){
  write({stage:'connect',timeout:delay});
  if(fault()){write({fault:mode});clearTimeout(timer);return original(callback,100,...args)}
 }
 return timer;
};
const Native=globalThis.WebSocket;
globalThis.WebSocket=class extends Native {
 // The watchdog records the fault before onopen is assigned; decide once per socket.
 constructor(...args){super(...args);this.dropOpen=mode==='connect'&&fault()}
 set onopen(callback){super.onopen=this.dropOpen?null:callback}
 send(data){const msg=JSON.parse(data);
  const selected=mode==='setup'?msg.method==='Target.createTarget':mode==='navigate'?msg.method==='Page.navigate':mode==='cdp'&&msg.method==='Runtime.evaluate'&&msg.params.expression.includes('"value":"#hang"');
  if(selected){write({stage:mode,timeout:watchdog.delay});if(fault()){write({fault:mode});clearTimeout(watchdog.timer);original(watchdog.callback,100);return}}
  return super.send(data);
 }
};`;

function transportFaultEnv(ctx, mode, always = false) {
  const preload = path.join(ctx.folder, "transport-fault.mjs");
  const journal = path.join(ctx.folder, "transport-fault.jsonl");
  fs.writeFileSync(preload, TRANSPORT_FAULT_PRELOAD);
  const env = { ...ctx.env, NODE_OPTIONS: "--import=" + pathToFileURL(preload).href, SHOOT_TEST_TRANSPORT: mode,
    SHOOT_TEST_ALWAYS: always ? "1" : "0", SHOOT_TEST_TRANSPORT_JOURNAL: journal };
  return { env, journal };
}

async function startServer(ctx, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  ctx.cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  return server.address().port;
}

browserTest("browser timeout retries once", WINDOWS ? "POSIX launch wrapper" : false, async (ctx) => {
  const wrapper = path.join(ctx.folder, "chrome-wrapper");
  const marker = path.join(ctx.folder, "launch-count");
  // Accelerate the startup watchdog, but launch a real browser on the second run.
  fs.writeFileSync(wrapper, "#!/bin/sh\nif [ ! -f " + shellQuote(marker) + " ]; then\n"
    + "touch " + shellQuote(marker) + "\nexec sleep 60\nfi\nexec " + shellQuote(BROWSER) + ' "$@"\n', { mode: 0o755 });
  const { env, journal } = transportFaultEnv(ctx, "launch");
  env.CHROME_PATH = wrapper;
  const output = path.join(ctx.folder, "retried");
  const result = await node([ctx.page, "--out", output], { env, timeout: 110 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stderr, "45 초 안에 시작하지 못했습니다");
  includes(result.stderr, "한 번 더 시도합니다");
  includes(result.stderr, "--timeout-scale 2");
  includes(result.stderr, "여러 작업을 동시에 하면 느려질 수 있습니다");
  assertArtifacts(output, ["page.png", "report.json"]);
  assert.deepEqual(profiles(ctx), []);
  assert.deepEqual(journalRows(journal).filter((row) => row.stage === "launch").map((row) => row.timeout), [45000, 90000]);
});

browserTest("navigation aborted once is retried", async (ctx) => {
  const requests = [];
  const port = await startServer(ctx, (request, response) => {
    if (request.url !== "/page") {
      response.writeHead(404);
      response.end();
      return;
    }
    requests.push(request.url);
    if (requests.length === 1) {
      // A response without content cancels the navigation: the browser reports net::ERR_ABORTED.
      response.writeHead(204);
      response.end();
      return;
    }
    const body = Buffer.from('<!doctype html><link rel="icon" href="data:,"><h1>loaded</h1>');
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": String(body.length) });
    response.end(body);
  });
  const output = path.join(ctx.folder, "aborted-once");
  const result = await node([`http://127.0.0.1:${port}/page`, "--out", output], { env: ctx.env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(requests.length, 2, JSON.stringify(requests));
  assertArtifacts(output, ["page.png", "report.json"]);
});

browserTest("navigation timeout retries only once", async (ctx) => {
  for (const [always, expected] of [[false, 0], [true, 1]]) {
    const { env, journal } = transportFaultEnv(ctx, "navigate", always);
    fs.rmSync(journal, { force: true });
    const output = path.join(ctx.folder, `navigation-timeout-${always}`);
    const result = await node([ctx.page, "--out", output], { env, timeout: 90 });
    assert.equal(result.status, expected, result.stdout + result.stderr);
    assert.deepEqual(journalRows(journal).filter((row) => row.fault === "navigate").map((row) => row.fault),
      always ? ["navigate", "navigate"] : ["navigate"]);
    if (!always) assertArtifacts(output, ["page.png", "report.json"]);
  }
});

browserTest("run leaves no browser process or profile", async (ctx) => {
  const output = path.join(ctx.folder, "clean");
  await shoot(ctx, output);
  assertArtifacts(output, ["page.png", "report.json"]);
  await assertNoBrowserLeftovers(ctx);
});

browserTest("launcher that hands off and exits is ready and cleaned", WINDOWS ? "POSIX launch wrapper" : false, async (ctx) => {
  // The spawned process starts the real browser in the background and exits at once. Its stderr never
  // reaches the tool, so readiness has to come from the DevToolsActivePort file in the profile.
  const wrapper = path.join(ctx.folder, "hand-off");
  fs.writeFileSync(wrapper, "#!/bin/sh\nnohup " + shellQuote(BROWSER) + ' "$@" >/dev/null 2>&1 &\nexit 0\n', { mode: 0o755 });
  const output = path.join(ctx.folder, "handed-off");
  const result = await node([ctx.page, "--out", output], { env: { ...ctx.env, CHROME_PATH: wrapper }, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assertArtifacts(output, ["page.png", "report.json"]);
  await assertNoBrowserLeftovers(ctx);
});

browserTest("browser that never becomes ready is killed by profile", WINDOWS ? "POSIX launch wrapper" : false, async (ctx) => {
  // The launcher exits while a real browser keeps running on a profile inside the tool's temporary folder,
  // so no readiness signal ever appears. Killing the spawned process would not reach that browser.
  const launcher = path.join(ctx.folder, "never-ready.mjs");
  fs.writeFileSync(launcher, `import {spawn} from 'node:child_process';
const args=process.argv.slice(2).map(a=>a.startsWith('--user-data-dir=')?a+'/elsewhere':a);
spawn(${JSON.stringify(BROWSER)},args,{stdio:'ignore',detached:true}).unref();`);
  const wrapper = path.join(ctx.folder, "never-ready");
  fs.writeFileSync(wrapper, "#!/bin/sh\nexec " + shellQuote(process.execPath) + " " + shellQuote(launcher) + ' "$@"\n', { mode: 0o755 });
  const result = await node([ctx.page, "--out", path.join(ctx.folder, "never")], { env: { ...ctx.env, CHROME_PATH: wrapper }, timeout: 90 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stderr, "브라우저를 열지 못했습니다");
  await assertNoBrowserLeftovers(ctx);
});

browserTest("text matching priority and combo modifiers", async (ctx) => {
  writePage(ctx, `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>button{padding:12px}</style>
<section><span>More</span><button id="clickable">More</button></section>
<div><button id="deep"><span>Deep</span></button></div><button id="partial">Send money now</button>
<div hidden><div><button>More</button></div></div><input id="edit"><button id="verify">Verify</button>
<script>
const hits=[];for(const id of ['clickable','deep','partial'])document.getElementById(id).onclick=()=>hits.push(id);
const keys=[];addEventListener('keydown',e=>keys.push([e.key,e.metaKey,e.ctrlKey,e.shiftKey]));
document.getElementById('verify').onclick=()=>{
if(hits.join(',')!=='clickable,deep,partial')console.error('text-priority-failed');
if(!keys.some(k=>k[0]==='A'&&k[1]) || !keys.some(k=>k[0]==='A'&&k[2]) || !keys.some(k=>k[0]==='Tab'&&k[3]))console.error('combo-modifiers-failed');
};</script>`);
  const output = path.join(ctx.folder, "priorities");
  await shoot(ctx, output, "--steps", 'click text=More; click text=Deep; click text="Send money"; '
    + "click #edit; key Meta+A; key Control+A; key Shift+Tab; click #verify");
  assert.deepEqual(report(output)[0].issues, []);
});

browserTest("mark and waitfor accept later visible css match", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><button class="target" hidden>Hidden</button>
<button class="target">Shown</button><div class="delayed" style="opacity:0">Ready</div>
<script>setTimeout(()=>document.querySelector('.delayed').style.opacity=1,800)</script>`);
  const output = path.join(ctx.folder, "visible-match");
  await shoot(ctx, output, "--steps", "waitfor .target; waitfor .delayed", "--mark", ".target");
  assertArtifacts(output, ["page.png", "page-marked.png"]);
});

browserTest("single zoom preserves sheet and record names", async (ctx) => {
  let output = path.join(ctx.folder, "zoom-sheet");
  await shoot(ctx, output, "--zoom", "2", "--states", "a,b", "--sheet", "--mask");
  assertArtifacts(output, ["a-@2x.png", "sheet.png", "sheet-masked.png"]);
  output = path.join(ctx.folder, "zoom-record");
  await shoot(ctx, output, "--zoom", "2", "--record", "--steps", "click #go", "--hold", "100");
  assertArtifacts(output, ["motion-start.jpg", "motion-mid.jpg", "motion-end.jpg"]);
  if (FFMPEG) assertArtifacts(output, ["record.mp4"]);
});

browserTest("hidden matches report count reason and visible example", async (ctx) => {
  const cases = [
    ['style="display:none"', "", "display:none"],
    ['style="visibility:hidden"', "", "visibility:hidden"],
    ['style="width:0;height:0;padding:0;border:0"', "", "크기: 0"],
    ["", "display:none", "조상 요소가 가림: div#container 숨기기：display:none"],
    ["", "visibility:hidden", "조상 요소가 가림: div#container 숨기기：visibility:hidden"],
    ["", "opacity:0", "조상 요소가 가림: div#container 숨기기：opacity:0"],
  ];
  for (const [attrs, parentStyle, reason] of cases) {
    writePage(ctx, `<!doctype html><link rel="icon" href="data:,">
<button data-view="activity">Activity</button><div id="container" style="${parentStyle}">
<button data-view="accounts" ${attrs}>Accounts</button><button data-view="accounts" ${attrs}>Accounts 2</button></div>`);
    const result = await runFailure(ctx, path.join(ctx.folder, "hidden"), "--size", "desktop", "--steps", 'click [data-view="accounts"]');
    includes(result.stderr, "찾음 2 개 요소");
    includes(result.stderr, reason);
    excludes(result.stderr, "요소를 찾을 수 없습니다");
    includes(result.stderr, "보이게 하는 앞 단계를 먼저 실행하세요");
    includes(result.stderr, '예: click [data-view="activity"]');
  }
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><details id="tools">
<summary>Tools</summary><button data-view="accounts">Accounts</button></details>`);
  const result = await runFailure(ctx, path.join(ctx.folder, "closed"), "--steps", 'click [data-view="accounts"]');
  includes(result.stderr, "details 펼치지 않음");
  includes(result.stderr, "예: click #tools > summary");
  await shoot(ctx, path.join(ctx.folder, "opened"), "--steps", 'click #tools > summary; click [data-view="accounts"]');
});

browserTest("all actions choose first visible match", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>button{padding:12px}</style>
<button class="target" hidden>Hidden</button><button class="target">Visible</button>
<input class="edit" hidden><input class="edit">
<select class="choice" hidden><option value="a">A</option><option value="b">B</option></select>
<select class="choice"><option value="a">A</option><option value="b">B</option></select>
<button class="double" hidden>Hidden</button><button class="double">Double</button>
<div class="drag" hidden>Hidden</div><div class="drag" style="width:100px;height:50px">Drag</div>
<button id="verify">Verify</button><script>
let clicked=0, hovered=false, doubled=false, dragged=false;
const target=document.querySelectorAll('.target')[1]; target.onclick=()=>clicked++; target.onmouseenter=()=>hovered=true;
document.querySelectorAll('.double')[1].ondblclick=()=>doubled=true;
document.querySelectorAll('.drag')[1].onmousedown=()=>dragged=true;
document.querySelector('#verify').onclick=()=>{
if(clicked!==1 || !hovered || !doubled || !dragged || document.querySelectorAll('.edit')[1].value!=='hello' || document.querySelectorAll('.choice')[1].value!=='b')console.error('visible-match-failed');
};</script>`);
  const output = path.join(ctx.folder, "visible-actions");
  await shoot(ctx, output, "--size", "desktop", "--steps", "hover .target; click .target; dblclick .double; "
    + "drag .drag 20 0; type .edit hello; select .choice b; waitfor .target; click #verify");
  assert.deepEqual(report(output)[0].issues, []);
  // waitfor must continue polling matches that exist but are still hidden.
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><button id="later" hidden>Ready</button>
<script>setTimeout(()=>document.querySelector('#later').hidden=false,700)</script>`);
  await shoot(ctx, path.join(ctx.folder, "later"), "--wait", "0", "--steps", "waitfor #later; click #later");
});

browserTest("selector examples and text hints are relevant", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><p>Alpha unrelated</p><p>Send monez</p>
<button>Send money now</button><button data-view="accounts" hidden>Hidden</button>
<button data-view="activity">Activity</button>`);
  for (const action of ["click", "hover", "dblclick"]) {
    const result = await runFailure(ctx, path.join(ctx.folder, action), "--steps", action + ' [data-view="missing"]');
    includes(result.stderr, "예: " + action + ' [data-view="activity"]');
    assert.ok(indexOf(result.stderr, 'data-view="activity"') < indexOf(result.stderr, 'data-view="accounts"'), result.stderr);
  }
  // A CSS-filtered text search misses; the text hint search covers the visible page.
  let result = await runFailure(ctx, path.join(ctx.folder, "text-hint"), "--steps", 'click a:has-text("Send money")');
  includes(result.stderr, '예: click text="Send money now"');
  assert.ok(indexOf(result.stderr, '보이는 글 "Send money now"') < indexOf(result.stderr, '보이는 글 "Send monez"'), result.stderr);
  result = await runFailure(ctx, path.join(ctx.folder, "similar"), "--steps", 'click text="Send monet"');
  assert.ok(indexOf(result.stderr, '보이는 글 "Send monez"') < indexOf(result.stderr, '보이는 글 "Alpha unrelated"'), result.stderr);
  writePage(ctx, '<!doctype html><link rel="icon" href="data:,"><body></body>');
  result = await runFailure(ctx, path.join(ctx.folder, "generic"), "--steps", "hover .missing");
  includes(result.stderr, "예: hover .open");
});

browserTest("failed recordings clean temporary frames", async (ctx) => {
  let failed = path.join(ctx.folder, "failed-record");
  await runFailure(ctx, failed, "--record", "--steps", "broken: click .missing", "--hold", "0");
  assert.deepEqual(listDir(failed, (name) => name.startsWith("frames")), []);
  failed = path.join(ctx.folder, "failed-evidence");
  await runFailure(ctx, failed, "--evidence", "--steps", "broken: click .missing", "--steps", "good: click #go", "--hold", "100");
  assert.deepEqual(listDir(failed, (name) => name.startsWith("frames")), []);
  assertArtifacts(failed, ["motion-good-end.jpg", "motion-entry-end.jpg", "report.json"]);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("connection and setup timeouts retry the whole invocation", async (ctx) => {
  for (const mode of ["connect", "setup", "cdp"]) {
    const { env, journal } = transportFaultEnv(ctx, mode);
    fs.rmSync(journal, { force: true });
    writePage(ctx, `<!doctype html><link rel="icon" href="data:,">
<button id="hang">Ready</button><script>const query=new URLSearchParams(location.search);if(query.get('state')!=='done'||query.get('extra')!=='1')console.error(location.search);</script>`);
    const output = path.join(ctx.folder, mode);
    const result = await node([ctx.page, "--out", output, "--size", "800x600", "--states", "done", "--query", "extra=1", "--zoom", "2",
      "--timeout-scale", "2", "--steps", "hover: hover #hang; wait450"], { env, timeout: 30 });
    assert.equal(result.status, 0, mode + "\n" + result.stdout + result.stderr);
    assert.equal(count(result.stderr, "한 번 더 시도합니다"), 1, mode);
    includes(result.stderr, "--timeout-scale 4");
    assert.deepEqual(journalRows(journal).filter((row) => row.stage === mode).map((row) => row.timeout), [60000, 120000], mode);
    const entries = report(output);
    assert.deepEqual(entries.map((row) => row.file), ["done-hover-@2x.png"]);
    assert.equal(entries[0].size, "800x600");
    assert.deepEqual(entries[0].issues, []);
    assert.deepEqual(profiles(ctx), []);
  }
});

browserTest("persistent startup connection and setup timeouts stop after one retry", async (ctx) => {
  for (const mode of [...(WINDOWS ? [] : ["launch"]), "connect", "setup"]) {
    const { env, journal } = transportFaultEnv(ctx, mode, true);
    fs.rmSync(journal, { force: true });
    if (mode === "launch") {
      const wrapper = path.join(ctx.folder, "never-ready");
      fs.writeFileSync(wrapper, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
      env.CHROME_PATH = wrapper;
    }
    const result = await node([ctx.page, "--out", path.join(ctx.folder, mode)], { env, timeout: 20 });
    assert.equal(result.status, 1, mode + "\n" + result.stdout + result.stderr);
    assert.equal(count(result.stderr, "한 번 더 시도합니다"), 1, mode);
    assert.deepEqual(journalRows(journal).filter((row) => row.stage === mode).map((row) => row.timeout),
      mode === "launch" ? [45000, 90000] : [30000, 60000], mode);
    assert.deepEqual(profiles(ctx), []);
  }
});

browserTest("screenshot timeout reopens and retries once", async (ctx) => {
  const { env, journal } = faultEnv(ctx, "1");
  const output = path.join(ctx.folder, "screenshot-retry");
  const result = await node([ctx.page, "--out", output, "--timeout-scale", "2"], { env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const events = journalRows(journal);
  assert.equal(events.filter((row) => "connection" in row).length, 2);
  assert.deepEqual(events.filter((row) => "capture" in row).map((row) => row.timeout), [180000, 360000]);
  includes(result.stderr, "한 번 더 시도합니다");
  includes(result.stderr, "--timeout-scale 4");
  assert.equal(report(output).length, 1);
  assertArtifacts(output, ["page.png", "report.json"]);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("masked screenshot timeout replays state and finishes batch", async (ctx) => {
  const { env, journal } = faultEnv(ctx, "2");
  const output = path.join(ctx.folder, "masked-retry");
  const result = await node([ctx.page, "--out", output, "--states", "a,b", "--mask"], { env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  includes(result.stderr, "[4/4]");
  includes(result.stderr, "--mask");
  const entries = report(output);
  assert.deepEqual(entries.map((entry) => entry.file), ["a.png", "b.png"]);
  assert.deepEqual(entries.map((entry) => entry.issues), [[], []]);
  assertArtifacts(output, ["a.png", "a-masked.png", "b.png", "b-masked.png"]);
  assert.ok(!sameBytes(path.join(output, "a.png"), path.join(output, "a-masked.png")));
  assert.ok(!sameBytes(path.join(output, "a-masked.png"), path.join(output, "b-masked.png")));
  const events = journalRows(journal);
  assert.equal(events.filter((row) => "connection" in row).length, 2);
  // A full rerun captures the first plain image again, rather than only retrying the mask.
  assert.deepEqual(events.filter((row) => "capture" in row).map((row) => row.timeout), [90000, 90000, 180000, 180000, 180000, 180000]);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("second screenshot timeout marks item failed and continues evidence", ffmpegSkip("ffmpeg is needed for evidence"), async (ctx) => {
  const { env } = faultEnv(ctx, "1,2");
  const output = path.join(ctx.folder, "screenshot-failed-evidence");
  const result = await node([ctx.page, "--out", output, "--evidence", "--hold", "100", "--steps", "toggle: click #go"], { env, timeout: 90 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const entries = report(output);
  assert.ok(entries[0].failed);
  includes(entries[0].issues.at(-1), "Page.captureScreenshot 180 초");
  assert.ok(!entries.some((row) => row.file === "browser"));
  assert.ok(entries.some((row) => row.file === "motion-probe-toggle"));
  assertArtifacts(output, ["page-@2x.png", "record-entry.mp4", "record-toggle.mp4", "report.json"]);
  includes(result.stderr, "[5/5]");
  assert.doesNotMatch(result.stdout, /\[\d+\/\d+\]/);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("screenshot retry cannot reopen browser aborts", WINDOWS ? "POSIX browser wrapper" : false, async (ctx) => {
  const { env } = faultEnv(ctx, "1");
  const wrapper = path.join(ctx.folder, "cannot-reopen");
  const marker = path.join(ctx.folder, "launched");
  fs.writeFileSync(wrapper, "#!/bin/sh\nif [ -f " + shellQuote(marker) + " ]; then exit 1; fi\n"
    + "touch " + shellQuote(marker) + "\nexec " + shellQuote(BROWSER) + ' "$@"\n', { mode: 0o755 });
  const output = path.join(ctx.folder, "restart-failed");
  const result = await node([ctx.page, "--out", output, "--evidence"], { env: { ...env, CHROME_PATH: wrapper }, timeout: 90 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stderr, "브라우저를 열지 못했습니다");
  assert.equal(report(output).at(-1).file, "browser");
  assert.deepEqual(listDir(output, (name) => name.startsWith("record") && name.endsWith(".mp4")), []);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("stale screencast warns preserves stream and appends screenshot", ffmpegSkip("ffmpeg is needed to inspect recording"), async (ctx) => {
  writePage(ctx, '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>body{margin:0;background:#182838}'
    + "#box{position:absolute;left:60px;top:40px;width:240px;height:160px;border:4px solid #ffff00}</style><div id=\"box\"></div>");
  const stale = path.join(ctx.folder, "stale.jpg");
  await check(run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i",
    "color=c=0x182838:s=390x844,drawbox=x=60:y=40:w=248:h=168:color=yellow:t=4,"
    + "drawbox=x=304:y=44:w=4:h=160:color=0x182838:t=fill", "-frames:v", "1", stale], { binary: true }));
  const { env } = faultEnv(ctx, "", stale);
  const output = path.join(ctx.folder, "stale-stream");
  const result = await node([ctx.page, "--out", output, "--record", "--hold", "100"], { env, timeout: 90 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = report(output)[0];
  assert.equal(entry.consistency.status, "mismatch");
  includes(entry.warnings[0], "일부를 찍지 못했을 수 있습니다");
  includes(result.stdout, "멈춘 마지막 모습의 기준: motion-end.jpg 기준");
  assert.ok(sameBytes(path.join(output, "record-stream-end.jpg"), stale));
  assert.ok(entry.consistency.pixelRatio < 0.005, "A thin missing border must survive whole-viewport dilution");
  assert.ok((await framePixel(path.join(output, "motion-end.jpg"), 306, 80))[1] > 220);
  const last = await run("ffmpeg", ["-v", "error", "-sseof", "-0.04", "-i", path.join(output, "record.mp4"),
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-vf", "format=rgb24,crop=1:1:306:80", "-"], { binary: true });
  assert.equal(last.status, 0, last.stderr.toString());
  assert.ok(last.stdout[1] > 220, String([...last.stdout]));
  assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
});

browserTest("cdp request times out in current step", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><button id="prepare">Prepare</button><button id="hang">Hang</button>
<script>document.querySelector('#prepare').onclick=()=>{document.querySelector('#hang').getBoundingClientRect=()=>{while(true){}}};</script>`);
  const output = path.join(ctx.folder, "cdp-timeout");
  const start = performance.now();
  const { env, journal } = transportFaultEnv(ctx, "cdp", true);
  const result = await node([ctx.page, "--out", output, "--size", "desktop", "--steps", "click #prepare; click #hang"], { env, timeout: 20 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const elapsed = (performance.now() - start) / 1000;
  includes(result.stderr, " 2 단계「click #hang」");
  includes(result.stderr, "CDP Runtime.evaluate 30 초 안에 응답하지 않았습니다");
  includes(result.stderr, "CDP Runtime.evaluate 60 초 안에 응답하지 않았습니다");
  assert.equal(count(result.stderr, "한 번 더 시도합니다"), 1);
  assert.deepEqual(journalRows(journal).filter((row) => row.stage === "cdp").map((row) => row.timeout), [30000, 60000]);
  assert.ok(elapsed < 20, String(elapsed));
  assert.deepEqual(profiles(ctx), []);
  assert.ok(report(output).some((r) => r.failed));
});

browserTest("browser disconnect interrupts steps and cleans frames", WINDOWS ? "POSIX browser kill wrapper" : false, async (ctx) => {
  const pidFile = path.join(ctx.folder, "chrome.pid");
  const wrapper = path.join(ctx.folder, "chrome-kill-wrapper");
  fs.writeFileSync(wrapper, "#!/bin/sh\necho $$ > " + shellQuote(pidFile) + "\nexec " + shellQuote(BROWSER) + ' "$@"\n', { mode: 0o755 });
  const port = await startServer(ctx, (request, response) => {
    response.writeHead(200);
    response.end("ok");
    process.kill(Number(read(pidFile).trim()), "SIGKILL");
  });
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><button id="kill">Kill</button>
<script>document.querySelector('#kill').onclick=()=>setTimeout(()=>fetch('http://127.0.0.1:${port}/kill'),250);</script>`);
  const output = path.join(ctx.folder, "disconnect");
  const start = performance.now();
  const result = await node([ctx.page, "--out", output, "--record", "--hold", "100", "--steps", "disconnect: click #kill; wait 60000"],
    { env: { ...ctx.env, CHROME_PATH: wrapper }, timeout: 15 });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  includes(result.stderr, " 2 단계「wait 60000」");
  includes(result.stderr, "브라우저 연결이 갑자기 끊겼습니다");
  assert.ok(performance.now() - start < 10000);
  assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
  assert.deepEqual(profiles(ctx), []);
});

browserTest("deduplicated states sizes zooms and filename collisions", async (ctx) => {
  let output = path.join(ctx.folder, "deduplicated");
  let result = await shoot(ctx, output, "--states", "a,a,b,a", "--size", "desktop,1440x900,phone,mobile", "--zoom", "1,1.0");
  assert.equal(report(output).length, 4);
  for (const message of ["상태 겹친 항목을 뺐습니다", "크기 겹친 항목을 뺐습니다", "배율 겹친 항목을 뺐습니다"]) includes(result.stdout, message);
  output = path.join(ctx.folder, "group-collision");
  result = await shoot(ctx, output, "--states", "a,a-b", "--steps", "b-c: wait 0", "--steps", "c: wait 0");
  assert.equal(new Set(report(output).map((r) => r.file)).size, 4);
  assertArtifacts(output, ["a-b-c.png", "a-b-c-2.png"]);
  includes(result.stdout, "파일 이름이 겹칩니다，다르게 나눴습니다");
  output = path.join(ctx.folder, "variant-collision");
  await shoot(ctx, output, "--states", "a,a-masked,sheet", "--mask", "--sheet");
  assertArtifacts(output, ["a.png", "a-masked.png", "a-masked-2.png", "a-masked-2-masked.png",
    "sheet.png", "sheet-masked.png", "sheet-2.png", "sheet-2-masked.png"]);
  assert.equal(listDir(output, (name) => name.endsWith(".png")).length, 8);
});

browserTest("screenshots wait for finite animations and transitions", async (ctx) => {
  writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
@keyframes enter{from{opacity:0;transform:translateY(40px)}to{opacity:1;transform:none}}
#box{animation:enter .7s both;transition:margin-left .6s;margin-left:0}
</style><button id="go">Go</button><div id="box">Ready</div><script>
document.querySelector('#go').onclick=()=>document.querySelector('#box').style.marginLeft='100px';
const capture=()=>{
const s=getComputedStyle(document.querySelector('#box'));
if(s.opacity!=='1'||parseFloat(s.marginLeft)<99)console.error('captured-during-motion');
};
// Screenshot checks read document.images; inspect its computed styles at that moment.
Object.defineProperty(document,'images',{get(){capture();return []}});
</script>`);
  const output = path.join(ctx.folder, "settled");
  await shoot(ctx, output, "--wait", "0", "--steps", "click #go");
  const entry = report(output)[0];
  assert.deepEqual(entry.issues, []);
  assert.ok(entry.animationWaitMs > 600, String(entry.animationWaitMs));
  assert.ok(entry.animationWaitMs <= 2000, String(entry.animationWaitMs));
});

browserTest("screenshot animation wait is capped and skips infinite", async (ctx) => {
  for (const [duration, expectedWait] of [["60s", true], ["60s infinite", false]]) {
    writePage(ctx, `<!doctype html><link rel="icon" href="data:,"><style>
@keyframes slow{from{transform:translateX(0)}to{transform:translateX(100px)}}
div{animation:slow ${duration}}</style><div>Ready</div>`);
    const output = path.join(ctx.folder, expectedWait ? "finite-cap" : "infinite");
    await shoot(ctx, output, "--wait", "0");
    const waited = report(output)[0].animationWaitMs;
    if (expectedWait) {
      assert.ok(waited >= 1950, String(waited));
      assert.ok(waited <= 2000, String(waited));
    } else {
      assert.equal(waited, 0);
    }
  }
  // Recording and motion probing continue to observe the animation from the original timing.
  const output = path.join(ctx.folder, "record-unsettled");
  await shoot(ctx, output, "--wait", "0", "--record", "--entry", "--hold", "100");
  assert.ok(!("animationWaitMs" in report(output)[0]));
  await shoot(ctx, path.join(ctx.folder, "motion-unsettled"), "--wait", "0", "--motion");
  assert.ok(!("animationWaitMs" in report(path.join(ctx.folder, "motion-unsettled"))[0]));
});

browserTest("disconnect during encoding exits without waiting for encoder", WINDOWS ? "POSIX browser and encoder wrappers" : false, async (ctx) => {
  const browserPid = path.join(ctx.folder, "browser.pid");
  const wrapper = path.join(ctx.folder, "chrome-encoder-wrapper");
  fs.writeFileSync(wrapper, "#!/bin/sh\necho $$ > " + shellQuote(browserPid) + "\nexec " + shellQuote(BROWSER) + ' "$@"\n', { mode: 0o755 });
  const encoderReady = path.join(ctx.folder, "encoder-ready");
  const fakeBin = path.join(ctx.folder, "bin");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "ffmpeg"), '#!/bin/sh\nif [ "$1" = "-version" ]; then exit 0; fi\n'
    + "touch " + shellQuote(encoderReady) + "\nexec sleep 60\n", { mode: 0o755 });
  const poll = setInterval(() => {
    if (fs.existsSync(encoderReady)) {
      clearInterval(poll);
      process.kill(Number(read(browserPid)), "SIGKILL");
    }
  }, 20);
  try {
    const output = path.join(ctx.folder, "encoder-disconnect");
    const start = performance.now();
    const result = await node([ctx.page, "--out", output, "--record", "--hold", "100"],
      { env: { ...ctx.env, CHROME_PATH: wrapper, PATH: fakeBin + path.delimiter + process.env.PATH }, timeout: 15 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(fs.existsSync(encoderReady));
    includes(result.stderr, "브라우저 연결이 갑자기 끊겼습니다");
    assert.ok(performance.now() - start < 10000);
    assert.deepEqual(listDir(output, (name) => name.startsWith("frames")), []);
    assert.deepEqual(profiles(ctx), []);
  } finally {
    clearInterval(poll);
  }
});

browserTest("unicode group names are safe unique and report original labels", async (ctx) => {
  const dryRun = await node([ctx.page, "--dry-run", "--steps", "고친 뒤 저장: click .save"]);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const parsed = JSON.parse(dryRun.stdout);
  assert.equal(parsed.groups[0].name, "고친 뒤 저장");
  assert.equal(parsed.groups[0].reportName, "고친 뒤 저장");
  assert.equal(parsed.groups[0].id, "고친-뒤-저장");

  const output = path.join(ctx.folder, "unicode-groups");
  await shoot(ctx, output, "--steps", "가/나: click #go", "--steps", "가:나: click #go");
  const shots = report(output).filter((entry) => entry.group);
  assert.deepEqual(shots.map((entry) => entry.group), ["가/나", "가:나"]);
  assert.ok(isFile(path.join(output, "page-가-나.png")));
  assert.ok(isFile(path.join(output, "page-가-나-2.png")));
  const help = await node(["--help"]);
  includes(help.stdout, "고친 뒤 저장");
});

browserTest("motion no steps explains interaction probe", async (ctx) => {
  writePage(ctx, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;overflow:hidden}</style></head><body><button>Open</button></body></html>`);
  const output = path.join(ctx.folder, "motion-interaction-hint");
  await shoot(ctx, output, "--motion");
  const probe = report(output)[0];
  assert.ok(probe.issues.some((issue) => issue.includes("--steps") && issue.includes("조작 효과")), JSON.stringify(probe.issues));
});
