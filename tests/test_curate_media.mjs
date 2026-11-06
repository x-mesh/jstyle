// Media CLI contracts, offline; live providers are checked separately.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import { FFMPEG, FFPROBE, SCRIPT, createProject, startServer } from "./curate-fixture.mjs";

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());

const NEED_FFMPEG = FFMPEG && FFPROBE ? false : "ffmpeg/ffprobe required";
const json = (result) => JSON.parse(result.stdout);
const glob = (dir, pattern) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => pattern.test(name)) : []);
const read = (file) => fs.readFileSync(file, "utf8");

test("help and actionable argument errors", (t) => {
  const p = createProject(t, server);
  assert.ok(p.runCli(["--help"]).stdout.includes("blueprint|map|plate|science|video"));
  for (const args of [["search", "wood", "--kind", "unknown"], ["search", "wood", "--limit", "NaN"], ["search", "wood", "--limt", "2"], ["fetch", "V1", "--out", "a.png", "--dir", "assets"], ["search", "wood", "--sheet=false"], ["unknown"], ["search", "wood", "--resolution", "16k"], ["fetch", "T1", "--maps", "diffuse,all"]]) {
    assert.ok(p.runCli(args, { ok: false }).stderr.includes("node scripts/curate-media.mjs"), args.join(" "));
  }
  assert.equal(fs.existsSync(path.join(p.cwd, ".curate-cache.json")), false);
});

test("all kinds and no false blueprints", (t) => {
  const p = createProject(t, server);
  for (const kind of ["texture", "design", "photo", "blueprint", "map", "plate", "science", "video", "all"]) {
    const result = json(p.runCli(["search", "wood", "--kind", kind, "--limit", "15"], { fixture: true }));
    assert.ok(result.items.length, kind);
    assert.deepEqual(result.errors, [], kind);
    if (kind === "all") {
      assert.deepEqual(new Set(result.items.map((i) => i.provider)), new Set(["polyhaven", "vam", "loc", "wellcome", "nasa", "commons", "met", "aic", "cleveland", "japan", "rijks"]));
    }
    if (kind === "blueprint") {
      assert.ok(result.items.every((i) => i.imageUrl.includes("/sheet/")));
      assert.ok(result.items.every((i) => !i.previewUrl.includes("_150px")));
    }
  }
});

test("refs survive other searches and texture is downloadable", (t) => {
  const p = createProject(t, server);
  const a = json(p.runCli(["search", "wood", "--kind", "texture"], { fixture: true })).items[0];
  assert.equal(a.ref, "T1");
  assert.equal(a.imageUrl, p.base + "/image");
  assert.notEqual(a.imageUrl, a.previewUrl);
  assert.deepEqual(new Set(Object.keys(a.textureMaps)), new Set(["diffuse", "roughness", "normal"]));
  p.runCli(["search", "wood", "--kind", "design"], { fixture: true });
  const b = json(p.runCli(["search", "wood", "--kind", "texture"], { fixture: true })).items[0];
  assert.equal(a.ref, b.ref);
  assert.ok("V1" in JSON.parse(read(path.join(p.cwd, ".curate-cache.json"))).items);
});

test("batch fetch maps integrity sheet credits and no overwrite", { skip: NEED_FFMPEG }, (t) => {
  const p = createProject(t, server);
  p.runCli(["search", "wood", "--kind", "texture"], { fixture: true });
  p.runCli(["search", "wood", "--kind", "design"], { fixture: true });
  const result = json(p.runCli(["fetch", "V1,T1", "--maps", "all", "--dir", "assets", "--sheet"], { fixture: true }));
  assert.equal(result.count, 4);
  assert.ok(result.files.every((i) => i.width === 8 && i.height === 6 && i.integrity === "full-decode"));
  assert.equal(result.files[0].originalWidth, 8);
  assert.ok(fs.existsSync(path.join(p.cwd, "assets/sheet.html")));
  const log = read(path.join(p.cwd, "assets/SOURCES.md"));
  assert.ok(log.includes("License:"));
  assert.ok(log.includes("Powered by Poly Haven"));
  assert.ok(log.includes("Victoria and Albert Museum"));
  const repeated = json(p.runCli(["fetch", "T1", "--dir", "assets"], { fixture: true }));
  assert.ok(repeated.files[0].saved.endsWith("-1.png"));
  assert.deepEqual(glob(path.join(p.cwd, "assets"), /\.part$/), []);
  assert.deepEqual(glob(p.cwd, /\.lock$/), []);
});

test("direct URL partial failure and limit", (t) => {
  const p = createProject(t, server);
  let result = json(p.runCli(["fetch", p.base + "/image", p.base + "/bad", "--dir", "assets"], { ok: false }));
  assert.equal(result.count, 1);
  assert.equal(result.errors.length, 1);
  assert.ok(read(path.join(p.cwd, "assets/SOURCES.md")).includes("Rights not verified"));
  result = json(p.runCli(["fetch", p.base + "/large", "--max-mb", "1"], { ok: false }));
  assert.equal(result.count, 0);
  assert.ok(result.errors[0].message.includes("max-mb"));
});

test("explicit file and missing ref", (t) => {
  const p = createProject(t, server);
  p.runCli(["fetch", p.base + "/image", "--out", "assets/sample.png"]);
  const r = json(p.runCli(["fetch", p.base + "/image", "--out", "assets/sample.png"], { ok: false }));
  assert.ok(r.errors[0].message.includes("파일이 이미 있습니다"));
  assert.deepEqual(fs.readFileSync(path.join(p.cwd, "assets/sample.png")), p.image);
  p.runCli(["fetch", "V999"], { ok: false });
  p.runCli(["fetch", "file:///etc/passwd"], { ok: false });
});

test("corrupt image and MD5 rejected before delivery", { skip: NEED_FFMPEG }, (t) => {
  const p = createProject(t, server);
  let result = json(p.runCli(["fetch", p.base + "/corrupt", "--sheet"], { ok: false }));
  assert.equal(result.count, 0);
  p.fixtures["/files/wood"].Diffuse["1k"].jpg = { url: p.base + "/image", size: p.image.length, md5: "0".repeat(32) };
  p.writeShim();
  p.runCli(["search", "wood", "--kind", "texture"], { fixture: true });
  result = json(p.runCli(["fetch", "T1"], { fixture: true, ok: false }));
  assert.ok(result.errors[0].message.includes("MD5"));
  assert.deepEqual(glob(path.join(p.cwd, "assets"), /^T1/), []);
});

test("source failure distinct from zero matches", (t) => {
  const p = createProject(t, server);
  p.writeShim({ failures: ["/v2/objects/search"] });
  let result = json(p.runCli(["search", "wood", "--kind", "all"], { fixture: true }));
  assert.equal(result.errors[0].source, "vam");
  p.writeShim({ failures: ["/catalogue/v2/images", "/w/api.php", "/api/item/search/jps-cross"] });
  p.runCli(["search", "wood", "--kind", "plate"], { fixture: true, ok: false });
  p.fixtures["/catalogue/v2/images"] = { results: [] };
  p.fixtures["/w/api.php"] = { query: { pages: [] } };
  p.fixtures["/api/item/search/jps-cross"] = { hit: 0, list: [] };
  p.writeShim();
  result = json(p.runCli(["search", "wood", "--kind", "plate"], { fixture: true }));
  assert.equal(result.count, 0);
  assert.deepEqual(result.errors, []);
});

test("preview escapes text and reports dimensions", (t) => {
  const p = createProject(t, server);
  p.fixtures["/v2/objects/search"].records[0]._primaryTitle = "Wood <script>boom</script>";
  p.writeShim();
  p.runCli(["search", "wood", "--kind", "design"], { fixture: true });
  p.runCli(["preview", "V1", "--sheet", "--dir", "previews"]);
  const html = read(path.join(p.cwd, "previews/candidates.html"));
  assert.ok(html.includes("&lt;script&gt;boom&lt;/script&gt;"));
  assert.ok(html.includes("naturalWidth"));
  assert.ok(html.includes("읽기 실패"));
});

test("video download and first frame poster", { skip: NEED_FFMPEG }, (t) => {
  const p = createProject(t, server);
  p.fixtures["/search"].collection.items[0].data[0].media_type = "video";
  p.fixtures["/manifest"] = [p.base + "/video~medium.mp4", p.base + "/video~orig.mov"];
  p.writeShim();
  p.runCli(["search", "earth", "--kind", "video"], { fixture: true });
  const record = json(p.runCli(["fetch", "N1", "--sheet"], { fixture: true })).files[0];
  assert.ok(record.poster.endsWith("-poster.jpg"));
  assert.ok(fs.statSync(record.poster).isFile());
  assert.deepEqual([record.width, record.height], [64, 48]);
  assert.equal(record.integrity, "full-decode");
  assert.ok(read(path.join(p.cwd, "assets/SOURCES.md")).includes("first-frame poster"));
});

test("failed video rendition falls back without losing reason", { skip: NEED_FFMPEG }, (t) => {
  const p = createProject(t, server);
  p.fixtures["/search"].collection.items[0].data[0].media_type = "video";
  p.fixtures["/manifest"] = [p.base + "/bad~medium.mp4", p.base + "/video~preview.mp4"];
  p.writeShim();
  p.runCli(["search", "earth", "--kind", "video"], { fixture: true });
  const data = json(p.runCli(["fetch", "N1", "--sheet"], { fixture: true }));
  assert.deepEqual(data.errors, []);
  assert.ok(data.files[0].url.endsWith("~preview.mp4"));
  assert.ok(data.files[0].warnings.length);
  assert.ok(fs.existsSync(data.files[0].poster));
});

test("missing tools keep download and report unfinished sheet", (t) => {
  const p = createProject(t, server);
  const result = spawnSync(process.execPath, [SCRIPT, "fetch", p.base + "/image", "--sheet"], { cwd: p.cwd, env: { ...process.env, PATH: "" }, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 1);
  const data = JSON.parse(result.stdout);
  assert.equal(data.count, 1);
  assert.ok(fs.existsSync(data.files[0].saved));
  assert.equal(data.files[0].integrity, "signature-and-length-only");
  assert.ok(data.errors[0].message.includes("ffprobe"));
});

test("concurrent searches merge cache without reassigning refs", async (t) => {
  const p = createProject(t, server);
  const children = ["texture", "design", "map", "plate"].map((kind) => {
    const child = spawn(process.execPath, p.cliCommand(["search", "wood", "--kind", kind], { fixture: true }), { cwd: p.cwd });
    // Registered before the folder cleanup, so it runs first even when an assertion fails.
    t.after(() => child.exitCode === null && child.kill());
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    return new Promise((resolve) => child.on("close", (code) => resolve([code, output])));
  });
  for (const [code, output] of await Promise.all(children)) assert.equal(code, 0, output);
  const items = JSON.parse(read(path.join(p.cwd, ".curate-cache.json"))).items;
  assert.deepEqual(new Set(Object.keys(items)), new Set(["T1", "T2", "V1", "L1", "W1", "C1", "M1", "A1", "K1", "J1"]));
  const ids = Object.values(items).map((i) => `${i.provider}\0${i.sourceId}`);
  assert.equal(ids.length, new Set(ids).size);
});

test("cache replace retries busy files and preserves cache on failure", (t) => {
  const p = createProject(t, server);
  p.runCli(["search", "wood", "--kind", "design"], { fixture: true });
  p.writeShim({ cacheRenameFailures: 2 });
  const result = json(p.runCli(["search", "wood", "--kind", "texture", "--refresh"], { fixture: true }));
  assert.ok(result.items.length);
  const cache = path.join(p.cwd, ".curate-cache.json");
  assert.ok("V1" in JSON.parse(read(cache)).items);
  const previous = fs.readFileSync(cache);
  p.writeShim({ cacheRenameFailures: -1 });
  const failed = p.runCli(["search", "wood", "--kind", "texture"], { fixture: true, ok: false });
  assert.ok(failed.stderr.includes("EPERM"));
  assert.deepEqual(fs.readFileSync(cache), previous);
  assert.deepEqual(glob(p.cwd, /\.tmp$/), []);
  assert.deepEqual(glob(p.cwd, /\.lock$/), []);
});

test("map selection, video renditions and animation filter", async (t) => {
  const { selectMap, selectNasaFile, interleave } = await import(pathToFileURL(SCRIPT).href);
  assert.equal(selectMap({ nor_gl: { "2k": { jpg: { url: "gl" } } }, nor_dx: { "1k": { jpg: { url: "dx" } } } }, ["nor_gl"], "1k").url, "gl");
  assert.equal(selectMap({ Diffuse: { "1k": { jpg: { url: "small" } }, "8k": { jpg: { url: "large" } } } }, ["Diffuse"], "4k").url, "small");
  assert.equal(selectNasaFile(["a~orig.mov", "a~preview.mp4", "a~medium.mp4"], "video"), "a~medium.mp4");
  assert.equal(selectNasaFile(["a~thumb.jpg", "a~orig.jpg"], "image"), "a~orig.jpg");
  assert.equal(interleave([[{ provider: "a", sourceId: "1" }, { provider: "a", sourceId: "2" }], [{ provider: "b", sourceId: "3" }]], 2)[1].provider, "b");
  const p = createProject(t, server);
  p.fixtures["/search"].collection.items.unshift({ data: [{ nasa_id: "animation", title: "Launch Animation", media_type: "video" }], links: [{ href: p.base + "/thumb", render: "image" }] });
  p.writeShim();
  const result = json(p.runCli(["search", "wood", "--kind", "video"], { fixture: true }));
  assert.deepEqual(result.items.map((r) => r.sourceId), ["earth"]);
});

test("relevance, rights and pixel facts", async () => {
  const { matchCount, rightsUse, describePixels } = await import(pathToFileURL(SCRIPT).href);
  assert.equal(matchCount("White Maple Veneer configuration figure", ["fig"]), 0);
  assert.equal(matchCount("Figs and leaves", ["fig"]), 1);
  assert.equal(matchCount("Plate 3, fig. 2: the heart", ["fig"]), 0);
  assert.equal(matchCount("Old maps of Ghent", ["ghent", "map"]), 2);
  for (const [text, use] of [["CC BY-NC 4.0", "reference"], ["V&A terms: permitted non-commercial uses only; commercial publication requires licensing", "reference"], ["CC BY-ND 4.0", "reference"], ["Public domain", "page"], ["CC BY-SA 4.0", "page"], ["CC0", "page"], ["No known restrictions on publication.", "page"], ["NASA media usage guidelines; generally not subject to US copyright; verify third-party credits", "page"], ["Third-party rights mentioned; check item credits", "check"], ["Rights not specified in search; check Rights & Access on item page", "check"], ["GFDL", "check"]]) {
    assert.equal(rightsUse(text), use, text);
  }
  const n = 48;
  const half = Buffer.alloc(n * n * 3, 250);
  for (let y = n / 2; y < n; y++) for (let x = 0; x < n; x++) half.fill((x + y) % 2 ? 0 : 255, (y * n + x) * 3, (y * n + x) * 3 + 3);
  const split = describePixels(half);
  assert.ok(split.calm.includes("top") && !split.calm.includes("bottom"));
  assert.equal(split.edgeFlat, false);
  const paper = describePixels(Buffer.alloc(n * n * 3, 240));
  assert.deepEqual([paper.paper, paper.tone, paper.mono, paper.edge, paper.calm.length], [true, "light", true, "#f0f0f0", 5]);
});

test("off-subject filtered, uses sorted and queries combined", (t) => {
  const p = createProject(t, server);
  p.fixtures["/photos/"].results.push({ id: "http://www.loc.gov/item/9/", title: "America at work", image_url: [p.base + "/b.jpg"] });
  p.writeShim();
  const result = json(p.runCli(["search", "wood", "--kind", "photo"], { fixture: true }));
  assert.equal(result.filtered, 1);
  assert.ok(!result.items.map((i) => i.title).includes("America at work"));
  const order = ["page", "check", "reference"];
  const uses = result.items.map((i) => i.use);
  assert.deepEqual(uses, [...uses].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
  const design = json(p.runCli(["search", "wood | chair", "--kind", "design"], { fixture: true }));
  assert.deepEqual(design.queries, ["wood", "chair"]);
  assert.equal(design.items.at(-1).use, "reference");
  assert.equal(design.items.at(-1).provider, "vam");
  const page = json(p.runCli(["search", "wood", "--kind", "design", "--use", "page"], { fixture: true }));
  assert.ok(page.items.length);
  assert.ok(page.items.every((i) => i.use === "page"));
  p.runCli(["search", "wood", "--use", "free"], { ok: false });
});

test("search sheet writes readable PNG and look", { skip: NEED_FFMPEG }, (t) => {
  const p = createProject(t, server);
  const result = json(p.runCli(["search", "wood", "--kind", "design", "--sheet", "--dir", "cand"], { fixture: true }));
  assert.deepEqual(fs.readFileSync(result.sheetImage).subarray(0, 8), Buffer.from("\x89PNG\r\n\x1a\n", "latin1"));
  assert.ok(fs.existsSync(path.join(p.cwd, "cand/candidates.html")));
  const look = result.items[0].look;
  assert.deepEqual(new Set(Object.keys(look)), new Set(["tone", "mono", "edge", "edgeFlat", "paper", "calm", "ratio"]));
  assert.ok(Math.abs(look.ratio - 1.33) < 0.005, String(look.ratio));
  const fetched = json(p.runCli(["fetch", "V1", "--dir", "ref", "--sheet"], { fixture: true }));
  assert.equal(fetched.files[0].use, "reference");
  assert.ok(fetched.files[0].warnings.some((w) => w.includes("참고로만")));
  assert.ok(fs.existsSync(fetched.sheetImage));
  assert.ok(read(path.join(p.cwd, "ref/SOURCES.md")).includes("Use: reference only"));
});

test("Japan and Rijks records and ColBase fallback", (t) => {
  const p = createProject(t, server);
  const design = json(p.runCli(["search", "wood", "--kind", "design", "--limit", "10"], { fixture: true })).items;
  const japan = design.find((i) => i.provider === "japan");
  assert.deepEqual([japan.use, japan.detail.split(" · ")[0]], ["page", "Wood box"]);
  assert.ok(japan.imageUrl.includes("/slideshow/"));
  assert.ok(japan.attribution.includes("ColBase"));
  const rijks = design.find((i) => i.provider === "rijks");
  assert.deepEqual([rijks.title, rijks.license, rijks.use], ["Wood chair", "CC0", "page"]);
  assert.ok(rijks.imageUrl.endsWith("/iiifr/full/!2400,2400/0/default.jpg"));
  const got = json(p.runCli(["fetch", japan.ref], { fixture: true })).files[0];
  assert.ok(got.url.includes("/slideshow_s/"));
  assert.ok(got.warnings.some((w) => w.includes("쓸 수 있는 버전으로 바꿨습니다")));
  const cjk = json(p.runCli(["search", "상자", "--kind", "design"], { fixture: true }));
  assert.equal(cjk.items[0].provider, "japan");
  assert.ok(cjk.count > 1);
});

test("fetch resolves cache in target dir or parent when cwd changes", (t) => {
  const p = createProject(t, server);
  const sub = path.join(p.cwd, "subproject");
  fs.mkdirSync(sub);
  p.runCli(["search", "wood", "--kind", "design", "--dir", "candidates"], { fixture: true, cwd: sub });
  assert.ok(fs.statSync(path.join(sub, ".curate-cache.json")).isFile());
  const fetched = json(p.runCli(["fetch", "V1", "--dir", path.join(sub, "assets")], { fixture: true }));
  assert.equal(fetched.count, 1);
  assert.ok(fs.statSync(fetched.files[0].saved).isFile());
});
