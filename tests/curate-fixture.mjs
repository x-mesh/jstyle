// Offline fixtures for curate-media.mjs: provider API responses are served by
// a fetch shim loaded with --import, and downloads come from a real local
// HTTP server. No provider credentials or network access are needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
export const SCRIPT = path.join(ROOT, "scripts", "curate-media.mjs");

export function which(name) {
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", [name], { encoding: "utf8" });
  return probe.status === 0 ? probe.stdout.trim().split(/\r?\n/)[0] : null;
}

export const FFMPEG = which("ffmpeg");
export const FFPROBE = which("ffprobe");

export function png() {
  const chunk = (name, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(name, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(8, 0);
  header.writeUInt32BE(6, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array(8).fill([200, 90, 30]).flat())]);
  return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array(6).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
}

// One server per test file, shared by every project created from it.
export async function startServer() {
  const image = png();
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-curate-video-"));
  let video = null;
  if (FFMPEG && FFPROBE) {
    const file = path.join(videoDir, "sample.mp4");
    const made = spawnSync(FFMPEG, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x48:d=0.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", file], { timeout: 20000 });
    assert.equal(made.status, 0, String(made.stderr));
    video = fs.readFileSync(file);
  }
  // spawnSync blocks this thread while the CLI downloads, so the server runs in
  // a worker thread, as the Python suite served from a separate thread.
  const worker = new Worker(SERVER, { eval: true, workerData: { image, video } });
  const port = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    image,
    video,
    close: async () => {
      await worker.terminate();
      fs.rmSync(videoDir, { recursive: true, force: true });
    },
  };
}

const SERVER = `
const http = require("node:http");
const { parentPort, workerData } = require("node:worker_threads");
const image = Buffer.from(workerData.image);
const video = workerData.video ? Buffer.from(workerData.video) : null;
const server = http.createServer((request, response) => {
  const url = request.url;
  let data = image;
  let mime = "image/png";
  if (url.startsWith("/video") && video) [data, mime] = [video, "video/mp4"];
  else if (url.startsWith("/bad") || url.includes("/slideshow/")) [data, mime] = [Buffer.from("<html>upstream error</html>"), "text/html"];
  else if (url.startsWith("/corrupt")) data = image.subarray(0, 24);
  else if (url.startsWith("/large")) data = Buffer.concat([image, Buffer.alloc(2 * 1024 * 1024, "x")]);
  response.writeHead(200, { "Content-Type": mime, "Content-Length": data.length });
  response.on("error", () => {});
  response.end(data);
});
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
`;

function fixturesFor(base, image) {
  const file = { url: base + "/image", size: image.length, md5: createHash("md5").update(image).digest("hex") };
  return {
    "/assets?t=textures": { wood: { name: "Wood", categories: ["wood"], authors: { Artist: "All" } } },
    "/assets?t=models": { "wood-model": { name: "Wood model", tags: ["wood"] } },
    "/files/wood": Object.fromEntries(["Diffuse", "Rough", "nor_gl"].map((key) => [key, { "1k": { jpg: { ...file } } }])),
    "/files/wood-model": { gltf: { "1k": { gltf: { url: base + "/model.gltf", include: { "model.bin": { url: base + "/model.bin" } } } } } },
    "/v2/objects/search": { records: [{ systemNumber: "O1", _primaryTitle: "Wood furniture", _images: { _iiif_image_base_url: base + "/iiif" } }] },
    "/iiif/info.json": { width: 8, height: 6 },
    "/catalogue/v2/images": { results: [{ id: "im1", source: { id: "work1", title: "Wood plate" }, locations: [{ url: base + "/iiif/info.json", locationType: { id: "iiif-image" }, credit: "Creator / Wellcome", license: { label: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } }] }] },
    "/photos/": { results: [{ id: "http://www.loc.gov/item/1/", title: "Wood photograph", image_url: [base + "/a.jpg"], item: { rights_advisory: "Item-specific rights" } }] },
    "/maps/": { results: [{ id: "http://www.loc.gov/item/2/", title: "Wood map", image_url: [base + "/a.jpg"] }] },
    "/collections/historic-american-buildings-landscapes-and-engineering-records/": { results: [
      { id: "http://www.loc.gov/item/photo-only/", title: "Not a drawing", image_url: [base + "/photo.jpg"] },
      { id: "http://www.loc.gov/item/3/", title: "Wood bridge", resources: [{ url: "https://www.loc.gov/resource/hhh.3.sheet", image: base + "/sheet/00001_150px.jpg" }] },
    ] },
    "/search": { collection: { items: [{ href: base + "/manifest", data: [{ nasa_id: "earth", title: "Wood and Earth in orbit", media_type: "image", center: "NASA", photographer: "Photographer" }], links: [{ href: base + "/thumb", render: "image", rel: "preview" }] }] } },
    "/manifest": [base + "/media~orig.jpg"],
    "/w/api.php": { query: { pages: [{ pageid: 11, index: 1, title: "File:Wood engraving map.jpg", imageinfo: [{ url: base + "/commons.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:Wood.jpg", width: 8, height: 6, mime: "image/png", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, LicenseUrl: { value: "https://creativecommons.org/licenses/by-sa/4.0" }, Artist: { value: '<a href="x">Someone</a>' } } }] }] } },
    "/api/v1/artworks/search": { config: { iiif_url: base + "/aic" }, data: [{ id: 5, title: "Wood box", image_id: "img", is_public_domain: true, thumbnail: { width: 8, height: 6 } }] },
    "/api/artworks/": { data: [{ id: 7, title: "Wood chest", url: "https://clevelandart.org/art/7", images: { web: { url: base + "/k.png", width: "8", height: "6" } } }] },
    "/public/collection/v1.1/search": { objectIDs: [1] },
    "/public/collection/v1/objects/1": { objectID: 1, isPublicDomain: true, primaryImage: base + "/m.png", title: "Wood chair" },
    "/api/item/search/jps-cross": { hit: 1, list: [{ id: "cobas-1", common: { id: "cobas-1", title: "나무の상자", titleEn: "&lt;i&gt;Wood&lt;/i&gt; box", contentsRightsType: "ccby", contentsUrl: [base + "/media/tnm/1/image/slideshow_s/1.png"], thumbnailUrl: [base + "/media/tnm/1/image/slideshow_s/1.png"], database: "cobas", contributor: ["Tokyo National Museum"], linkUrl: "https://colbase.nich.go.jp/collection_items/tnm/1" } }] },
    "/search/collection": { orderedItems: [{ id: base + "/rk/1" }] },
    "/rk/1": { id: base + "/rk/1", identified_by: [{ type: "Name", content: "Houten stoel" }, { type: "Name", content: "Wood chair", language: [{ id: "http://vocab.getty.edu/aat/300388277" }] }, { type: "Identifier", content: "BK-1" }], shows: [{ id: base + "/rk/v1" }], subject_of: [{ subject_to: [{ classified_as: [{ id: "https://creativecommons.org/publicdomain/zero/1.0/" }] }] }] },
    "/rk/v1": { digitally_shown_by: [{ id: base + "/rk/d1" }] },
    "/rk/d1": { access_point: [{ id: base + "/iiifr/full/max/0/default.jpg" }] },
  };
}

// A project folder whose name holds URL metacharacters, which exposes missing
// path-to-URL conversion on every OS.
export function createProject(t, server) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jstyle-curate-test-한국어 #%-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const shim = path.join(cwd, "fixture.mjs");
  const project = {
    cwd,
    base: server.base,
    image: server.image,
    fixtures: fixturesFor(server.base, server.image),
    writeShim({ failures = [], cacheRenameFailures = 0 } = {}) {
      let text = `const realFetch = globalThis.fetch;
const fixtures = ${JSON.stringify(project.fixtures)};
const failures = ${JSON.stringify(failures)};
globalThis.fetch = async (input, init) => {
  const u = new URL(input); const key = u.pathname === '/assets' ? u.pathname + u.search : u.pathname;
  if (failures.includes(key)) return new Response('failure', {status:503});
  if (key in fixtures) return new Response(JSON.stringify(fixtures[key]), {headers:{'Content-Type':'application/json'}});
  if (u.hostname === '127.0.0.1') { u.protocol = 'http:'; return realFetch(u, init); }
  throw new Error('Unexpected fixture request: ' + u.href);
};
`;
      if (cacheRenameFailures) {
        text += `
import cacheFs from 'node:fs/promises';
const realRename = cacheFs.rename;
let renameFailures = ${cacheRenameFailures};
cacheFs.rename = async (source, target) => {
  if (String(target).endsWith('.curate-cache.json') && renameFailures !== 0) {
    if (renameFailures > 0) renameFailures--;
    throw Object.assign(new Error('EPERM: simulated Windows cache sharing violation'), {code:'EPERM'});
  }
  return realRename(source, target);
};
`;
      }
      fs.writeFileSync(shim, text);
    },
    cliCommand(args, { fixture = false } = {}) {
      return [...(fixture ? ["--import", pathToFileURL(shim).href] : []), SCRIPT, ...args];
    },
    runCli(args, { fixture = false, ok = true, cwd: dir = cwd, env } = {}) {
      const result = spawnSync(process.execPath, project.cliCommand(args, { fixture }), { cwd: dir, encoding: "utf8", timeout: 40000, ...(env ? { env } : {}) });
      const output = (result.stderr ?? "") + (result.stdout ?? "");
      if (ok) assert.equal(result.status, 0, output);
      else assert.notEqual(result.status, 0, output);
      return result;
    },
  };
  project.writeShim();
  return project;
}
