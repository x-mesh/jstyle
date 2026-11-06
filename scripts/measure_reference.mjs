#!/usr/bin/env node
// Measure colors, layout ratios and crops of a UI reference image, from a JSON
// manifest or straight from the command line. Port of measure_reference.py:
// 8-bit PNGs decode here exactly as the Python standard-library path did;
// other formats decode in Chrome, as Pillow used to read them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { UsageError, parseArgs } from "./lib/argparse.mjs";
import {
  PyError, PyFloat, compareCodePoints, decodeUtf8, fromNodeError, htmlEscape, isBool, isDict, isFloat, isInt, isList,
  isStr, isOSError, isTypeError, isValueError, jsonDumps, jsonLoads, pyRepr, pyReprString, pyRound, pyStr,
  pyStrip, valueError, wrapFs,
} from "./lib/pycompat.mjs";
import { WINDOWS, joinPath, pathStr, resolvePath } from "./lib/pypath.mjs";

const F = (value) => new PyFloat(value);
const keyError = (key) => new PyError("KeyError", pyRepr(key));
const typeError = (message) => new PyError("TypeError", message);
const platformText = (text) => (WINDOWS ? text.replace(/\n/g, "\r\n") : text);

function typeName(value) {
  if (value === null || value === undefined) return "NoneType";
  if (isBool(value)) return "bool";
  if (isInt(value) || typeof value === "number") return "int";
  if (isFloat(value)) return "float";
  if (isStr(value)) return "str";
  if (isList(value)) return "list";
  if (isDict(value)) return "dict";
  return typeof value;
}

// obj[key] with Python's KeyError and TypeError messages.
function item(obj, key) {
  if (isDict(obj)) {
    if (!obj.has(key)) throw keyError(key);
    return obj.get(key);
  }
  if (isList(obj)) throw typeError(`list indices must be integers or slices, not ${typeName(key)}`);
  if (isStr(obj)) throw typeError(`string indices must be integers, not '${typeName(key)}'`);
  throw typeError(`'${typeName(obj)}' object is not subscriptable`);
}

// dict.get exists only on dicts; anything else fails like an AttributeError.
function get(obj, key, fallback = null) {
  if (!isDict(obj)) throw new Error(`'${typeName(obj)}' object has no attribute 'get'`);
  return obj.has(key) ? obj.get(key) : fallback;
}

function iterate(value) {
  if (isList(value)) return value;
  if (isDict(value)) return [...value.keys()];
  if (isStr(value)) return Array.from(value);
  throw typeError(`'${typeName(value)}' object is not iterable`);
}

function truthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (isInt(value)) return value !== 0n;
  if (isFloat(value)) return value.value !== 0;
  if (typeof value === "number") return value !== 0;
  if (isStr(value) || isList(value)) return value.length > 0;
  if (isDict(value)) return value.size > 0;
  return Boolean(value);
}

// int(value) for the JSON values a manifest can hold.
function toInt(value) {
  if (isBool(value)) return value ? 1 : 0;
  if (isInt(value)) return Number(value);
  if (typeof value === "number") return Math.trunc(value);
  if (isFloat(value)) {
    if (!Number.isFinite(value.value)) throw Number.isNaN(value.value) ? valueError("cannot convert float NaN to integer") : new PyError("OverflowError", "cannot convert float infinity to integer");
    return Math.trunc(value.value);
  }
  if (isStr(value)) return intFromText(value, 10);
  throw typeError(`int() argument must be a string, a bytes-like object or a real number, not '${typeName(value)}'`);
}

function intFromText(text, base) {
  const stripped = pyStrip(text);
  const pattern = base === 16 ? /^[+-]?(?:0[xX])?_?[0-9a-fA-F](?:_?[0-9a-fA-F])*$/ : /^[+-]?\d(?:_?\d)*$/;
  if (!pattern.test(stripped)) throw valueError(`invalid literal for int() with base ${base}: ${pyReprString(text)}`);
  const clean = stripped.replace(/_/g, "").replace(/^([+-]?)0[xX]/, "$1");
  return base === 16 ? parseInt(clean, 16) : Number(clean);
}

const isNumber = (value) => isInt(value) || isFloat(value) || typeof value === "number";
const numeric = (value) => (isInt(value) ? Number(value) : isFloat(value) ? value.value : value);

// ---- RGBA images.

class RGBAImage {
  constructor(width, height, pixels) {
    Object.assign(this, { width, height, pixels });
  }

  getpixel(x, y) {
    const at = (y * this.width + x) * 4;
    return this.pixels.subarray(at, at + 4);
  }

  crop(x0, y0, x1, y1) {
    const width = x1 - x0;
    const out = new Uint8Array(width * (y1 - y0) * 4);
    for (let y = y0; y < y1; y += 1) out.set(this.pixels.subarray((y * this.width + x0) * 4, (y * this.width + x1) * 4), (y - y0) * width * 4);
    return new RGBAImage(width, y1 - y0, out);
  }

  toPng() {
    const rows = Buffer.alloc(this.height * (this.width * 4 + 1));
    for (let y = 0; y < this.height; y += 1) {
      rows[y * (this.width * 4 + 1)] = 0;
      rows.set(this.pixels.subarray(y * this.width * 4, (y + 1) * this.width * 4), y * (this.width * 4 + 1) + 1);
    }
    const chunk = (kind, payload) => {
      const head = Buffer.alloc(4);
      head.writeUInt32BE(payload.length);
      const body = Buffer.concat([Buffer.from(kind, "latin1"), payload]);
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n", "latin1"), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
  }
}

const PNG_SIGNATURE = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");

// The 8-bit, non-interlaced PNG reader of the Python standard-library path.
// Returns null for PNG variants it does not cover so Chrome can read them.
export function decodePng(data) {
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  let pos = 8;
  let header = null;
  const idat = [];
  let palette = [];
  let trns = Buffer.alloc(0);
  while (pos + 8 <= data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString("latin1", pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12] };
    else if (type === "PLTE") palette = Array.from({ length: Math.floor(body.length / 3) }, (_, i) => [body[i * 3], body[i * 3 + 1], body[i * 3 + 2]]);
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  if (!header || !header.width || !header.height || header.depth !== 8 || header.interlace !== 0 || ![0, 2, 3, 4, 6].includes(header.color)) return null;
  const { width, height, color } = header;
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[color];
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const recon = new Uint8Array(height * stride);
  let inPos = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[inPos];
    inPos += 1;
    const row = y * stride;
    const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x += 1) {
      let value = raw[inPos];
      inPos += 1;
      const a = x >= bpp ? recon[row + x - bpp] : 0;
      const b = y > 0 ? recon[prev + x] : 0;
      const c = x >= bpp && y > 0 ? recon[prev + x - bpp] : 0;
      if (filter === 1) value = (value + a) & 0xff;
      else if (filter === 2) value = (value + b) & 0xff;
      else if (filter === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = (value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      recon[row + x] = value;
    }
  }
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const off = i * bpp;
    let rgba;
    if (color === 6) rgba = [recon[off], recon[off + 1], recon[off + 2], recon[off + 3]];
    else if (color === 2) rgba = [recon[off], recon[off + 1], recon[off + 2], 255];
    else if (color === 4) rgba = [recon[off], recon[off], recon[off], recon[off + 1]];
    else if (color === 0) rgba = [recon[off], recon[off], recon[off], 255];
    else {
      const index = recon[off];
      const [r, g, b] = palette[index] ?? [0, 0, 0];
      rgba = [r, g, b, index < trns.length ? trns[index] : 255];
    }
    pixels.set(rgba, i * 4);
  }
  return new RGBAImage(width, height, pixels);
}

// Executed inside Chrome: decode without color management, as Pillow does.
async function decodeInPage(base64) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  let bitmap;
  try {
    bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  } catch {
    throw new Error("decode");
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
  let text = "";
  for (let at = 0; at < data.length; at += 0x8000) text += String.fromCharCode.apply(null, data.subarray(at, at + 0x8000));
  return { width: bitmap.width, height: bitmap.height, data: btoa(text) };
}

async function decodeWithChrome(data) {
  const { canvasBrowser } = await import("./prep-image.mjs");
  let browser;
  try {
    browser = await canvasBrowser();
  } catch (error) {
    throw valueError(`이 그림은 Chrome으로 읽어야 합니다: ${error.message}；8-bit PNG로 바꾸거나 Chrome·Chromium·Edge를 설치하세요`);
  }
  try {
    const result = await browser.evaluate(`(${decodeInPage})(${JSON.stringify(data.toString("base64"))})`);
    return new RGBAImage(result.width, result.height, new Uint8Array(Buffer.from(result.data, "base64")));
  } catch (error) {
    throw valueError(`그림을 읽지 못했습니다（${error.message}）；PNG·JPEG·WebP 정지 이미지를 주세요`);
  } finally {
    await browser.close();
  }
}

async function loadRgba(source) {
  const data = wrapFs(() => fs.readFileSync(source));
  return decodePng(data) ?? decodeWithChrome(data);
}

function opaquePixels(crop) {
  const out = [];
  for (let at = 0; at < crop.pixels.length; at += 4) if (crop.pixels[at + 3] === 255) out.push(crop.pixels.subarray(at, at + 4));
  return out;
}

function applyAlphaCleanup(crop, { whiteToAlpha = false, threshold = 248, keyColor = null, keyThreshold = 28, feather = 12, despill = false }) {
  if (!whiteToAlpha && !truthy(keyColor)) return crop;
  let kr = 0;
  let kg = 0;
  let kb = 0;
  if (truthy(keyColor)) {
    if (!isStr(keyColor)) throw new Error(`'${typeName(keyColor)}' object has no attribute 'strip'`);
    const cleaned = pyStrip(keyColor).replace(/^#+/, "");
    if (cleaned.length !== 6) throw valueError("key_color 올바른 형식: 6 자리 16진 색 값，예: #00FF00");
    [kr, kg, kb] = [cleaned.slice(0, 2), cleaned.slice(2, 4), cleaned.slice(4, 6)].map((part) => intFromText(part, 16));
  }
  const out = new Uint8Array(crop.pixels.length);
  for (let at = 0; at < crop.pixels.length; at += 4) {
    let [red, green, blue, alpha] = crop.pixels.subarray(at, at + 4);
    if (truthy(keyColor)) {
      const dist = Math.sqrt((red - kr) ** 2 + (green - kg) ** 2 + (blue - kb) ** 2);
      if (dist <= keyThreshold) alpha = 0;
      else if (feather > 0 && dist <= keyThreshold + feather) alpha = Math.max(0, Math.min(alpha, Math.trunc(alpha * (dist - keyThreshold) / feather)));
      if (despill && alpha > 0) {
        const excess = green - Math.max(red, blue);
        if (excess > 0) {
          const edge = 1.0 - alpha / 255.0;
          green = Math.max(Math.max(red, blue), green - Math.trunc(excess * (0.72 + 0.28 * edge)));
        }
      }
    }
    if (whiteToAlpha && alpha > 0) {
      const bright = Math.max(red, green, blue);
      if (red >= threshold && green >= threshold && blue >= threshold) alpha = 0;
      else if (feather > 0 && bright >= threshold - feather) alpha = Math.max(0, Math.min(alpha, Math.trunc(alpha * (threshold - bright + feather) / feather)));
    }
    out.set([red, green, blue, alpha], at);
  }
  return new RGBAImage(crop.width, crop.height, out);
}

function positive(value, name) {
  if (isBool(value) || !isNumber(value) || !Number.isFinite(numeric(value)) || numeric(value) <= 0) throw valueError(`${name} 유한한 양수여야 합니다`);
  return value;
}

function integer(value, name) {
  if (isBool(value) || !(isInt(value) || (typeof value === "number" && Number.isInteger(value)))) throw valueError(`${name} 정수여야 합니다`);
  return value;
}

function boxChecked(box, size) {
  if (!isList(box) || box.length !== 4) throw valueError("box 필요한 값: [x,y,width,height]");
  const [x, y, w, h] = box.map((value) => Number(integer(value, "box 좌표")));
  if (Math.min(x, y) < 0 || Math.min(w, h) <= 0 || x + w > size[0] || y + h > size[1]) {
    throw valueError(`표시 ${pyStr(box)} 영역 밖이거나 넓이가 올바르지 않습니다（원본 크기 ${size[0]}x${size[1]}）；자동으로 짧게 자르지 않습니다`);
  }
  return [x, y, w, h];
}

function distribution(values) {
  values = [...values].sort((a, b) => a - b);
  const quantile = (p) => {
    const pos = (values.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return F(pyRound(values[lo] + (values[hi] - values[lo]) * (pos - lo), 3));
  };
  return { median: quantile(0.5), p10: quantile(0.1), p90: quantile(0.9) };
}

// statistics.median: the middle int, or the mean of the two middle ints as a float.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : F((sorted[mid - 1] + sorted[mid]) / 2);
}

const hex2 = (value) => value.toString(16).toUpperCase().padStart(2, "0");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

function writeText(target, text) {
  wrapFs(() => fs.writeFileSync(target, platformText(text), "utf8"));
}

export async function measureData(data, { baseDir, out = null, manifestBytes = null, allowExistingOut = false }) {
  const reference = item(data, "reference");
  if (!isStr(reference)) throw typeError(`unsupported operand type(s) for /: '${WINDOWS ? "WindowsPath" : "PosixPath"}' and '${typeName(reference)}'`);
  const source = resolvePath(joinPath(baseDir, reference));
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()) throw valueError(`참고 그림이 없습니다：${source}`);
  const im = await loadRgba(source);
  const size = [im.width, im.height];
  const cssWidth = get(data, "css_viewport_width");
  const factor = cssWidth !== null ? numeric(positive(cssWidth, "css_viewport_width")) / im.width : null;
  const regions = [];
  const names = new Set();
  const takeName = (entry) => {
    const name = item(entry, "name");
    if (!isStr(name) || !pyStrip(name) || names.has(name)) throw valueError("표시 이름은 비어 있거나 겹치면 안 됩니다");
    names.add(name);
    return name;
  };

  const extracted = [];
  for (const entry of iterate(get(data, "regions", []))) {
    const name = takeName(entry);
    const kind = get(entry, "kind", "box");
    if (!(isStr(kind) && ["box", "color", "extract"].includes(kind))) throw valueError("kind 지원 범위: box、color 또는 extract");
    const [x, y, w, h] = boxChecked(item(entry, "box"), size);
    const boxType = get(entry, "box_type", kind === "color" ? "sample" : "element");
    if (!(isStr(boxType) && ["element", "ink", "sample"].includes(boxType)) || (kind === "color" && boxType !== "sample")) {
      throw valueError("box_type 필요한 값: element、ink 또는 sample；색 영역에 허용되는 값: sample");
    }
    const region = new Map([
      ["name", name],
      ["kind", kind],
      ["box_type", boxType],
      ["box", [x, y, w, h]],
      ["normalized_box", [x / im.width, y / im.height, w / im.width, h / im.height].map((value) => F(pyRound(value, 6)))],
      ["boundary_evidence", "Agent 고른 표시 범위，비율과 색을 뽑는 데 씀，고정 픽셀 좌표로 묶지 않습니다"],
    ]);
    if (factor !== null) region.set("css_box", [x, y, w, h].map((value) => F(pyRound(value * factor, 3))));
    if (entry.has("selector")) region.set("selector", entry.get("selector"));
    region.set("dom_comparable", boxType === "element");
    if (entry.has("group")) {
      if (boxType !== "element") throw valueError("반복 격자는 요소 상자만 받습니다，글자 영역이나 색을 잰 영역을 섞어 쓰지 않습니다");
      const group = entry.get("group");
      if (!isStr(group) || !pyStrip(group)) throw valueError("group 비어 있지 않은 문자열이어야 합니다");
      region.set("group", group);
    }
    if (kind === "color") {
      const inset = Number(integer(get(entry, "inset", 0), "inset"));
      if (inset < 0 || inset * 2 >= Math.min(w, h)) throw valueError("inset 읽어 낼 영역이 올바르지 않게 됩니다");
      const crop = im.crop(x + inset, y + inset, x + w - inset, y + h - inset);
      const pixels = opaquePixels(crop);
      if (!pixels.length) throw valueError(`${name} 불투명한 색 표본이 없습니다`);
      const channels = [0, 1, 2].map((channel) => distribution(pixels.map((pixel) => pixel[channel])));
      const rgb = channels.map((channel) => pyRound(channel.median.value));
      region.set("color", new Map([
        ["median_hex", "#" + rgb.map(hex2).join("")],
        ["rgb_channels", channels.map((channel) => new Map(Object.entries(channel)))],
        ["opaque_samples", pixels.length],
        ["excluded_nonopaque", crop.width * crop.height - pixels.length],
        ["sample_box", [x + inset, y + inset, w - inset * 2, h - inset * 2]],
        ["max_channel_p90_minus_p10", F(pyRound(Math.max(...channels.map((channel) => channel.p90.value - channel.p10.value)), 3))],
        ["meaning", "부분 영역 픽셀의 중간값，뽑아내는 데 씀 CSS 변수의 색 값"],
      ]));
    }
    if (kind === "extract" || truthy(get(entry, "extract"))) {
      const crop = applyAlphaCleanup(im.crop(x, y, x + w, y + h), {
        whiteToAlpha: truthy(get(entry, "white_to_alpha", false)),
        threshold: toInt(get(entry, "threshold", 248n)),
        keyColor: get(entry, "key_color"),
        keyThreshold: toInt(get(entry, "key_threshold", 28n)),
        feather: toInt(get(entry, "feather", 12n)),
        despill: truthy(get(entry, "despill", false)),
      });
      const outFile = pathStr(joinPath(out !== null ? out : baseDir, `${name}.png`));
      extracted.push([outFile, crop.toPng()]);
      region.set("extracted_file", outFile);
    }
    regions.push(region);
  }

  const groups = [];
  const groupNames = [...new Set(regions.filter((region) => region.has("group")).map((region) => region.get("group")))].sort(compareCodePoints);
  for (const name of groupNames) {
    const members = regions.filter((region) => region.get("group") === name).sort((a, b) => a.get("box")[0] - b.get("box")[0]);
    if (members.length < 2) throw valueError("반복 격자는 표시 두 개 이상이 필요합니다");
    const gaps = members.slice(1).map((member, index) => member.get("box")[0] - (members[index].get("box")[0] + members[index].get("box")[2]));
    const column = (index) => members.map((member) => member.get("box")[index]);
    groups.push(new Map([
      ["name", name],
      ["members", members.map((member) => member.get("name"))],
      ["x_gaps", gaps],
      ["median_width", median(column(2))],
      ["median_height", median(column(3))],
      ["median_gap", median(gaps)],
      ["y_spread", Math.max(...column(1)) - Math.min(...column(1))],
      ["width_spread", Math.max(...column(2)) - Math.min(...column(2))],
      ["meaning", "가로 반복 구조의 측정 참고값"],
    ]));
  }

  const scans = [];
  for (const spec of iterate(get(data, "vertical_scans", []))) {
    const name = takeName(spec);
    const [x, y, , h] = boxChecked([item(spec, "x"), item(spec, "y"), 1, item(spec, "height")], size);
    const floor = Number(integer(item(spec, "min_channel"), "min_channel"));
    const spread = Number(integer(item(spec, "max_channel_spread"), "max_channel_spread"));
    const runMin = Number(integer(get(spec, "min_run", 1), "min_run"));
    if (!(floor >= 0 && floor <= 255) || !(spread >= 0 && spread <= 255) || runMin < 1) throw valueError("스캔 기준값이 올바르지 않습니다");
    const runs = [];
    let start = null;
    for (let yy = y; yy <= y + h; yy += 1) {
      const p = yy < y + h ? im.getpixel(x, yy) : null;
      const low = p && Math.min(p[0], p[1], p[2]);
      const match = p !== null && p[3] === 255 && low >= floor && Math.max(p[0], p[1], p[2]) - low <= spread;
      if (match && start === null) start = yy;
      if (!match && start !== null) {
        if (yy - start >= runMin) runs.push(new Map([["y_start", start], ["y_end_exclusive", yy], ["height", yy - start]]));
        start = null;
      }
    }
    scans.push(new Map([["name", name], ["configuration", spec], ["runs", runs], ["meaning", "주어진 색 기준을 만족하는 이어진 픽셀 구간"]]));
  }

  if (!regions.length && !scans.length) throw valueError("영역이나 스캔을 하나 이상 지정하세요");

  const result = new Map([
    ["source", source],
    ["source_sha256", sha256(fs.readFileSync(source))],
    ["source_size", size],
    ["css_mapping", new Map([
      ["assumed_viewport_width", cssWidth],
      ["css_per_image_pixel", factor === null ? null : F(factor)],
      ["meaning", "비율 환산용 참고값，반응형 화면에는 다음을 씁니다: Grid / Flexbox 고정 픽셀 위치를 쓰는 대신"],
    ])],
    ["regions", regions],
    ["groups", groups],
    ["vertical_scans", scans],
  ]);
  if (data.has("expected")) {
    result.set("expected", data.get("expected"));
    result.set("expected_assets", get(data, "expected_assets", new Map()));
  }
  if (manifestBytes !== null) result.set("input_manifest_sha256", sha256(manifestBytes));

  if (out !== null) {
    if (!allowExistingOut && fs.existsSync(out)) throw fromNodeError(Object.assign(new Error("exists"), { code: "EEXIST", path: out }));
    wrapFs(() => fs.mkdirSync(out, { recursive: true }));
    writeText(joinPath(out, "measurements.json"), jsonDumps(result, { indent: 2 }));
    const encoded = im.toPng().toString("base64");
    const svg = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${im.width}" height="${im.height}" viewBox="0 0 ${im.width} ${im.height}">`,
      `<image width="${im.width}" height="${im.height}" href="data:image/png;base64,${encoded}"/>`,
    ];
    for (const region of regions) {
      const [x, y, w, h] = region.get("box");
      const label = htmlEscape(region.get("name"));
      const color = region.get("kind") === "box" ? "#36edcc" : region.get("kind") === "extract" ? "#ff7a45" : "#f6cb46";
      svg.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${color}" stroke-width="2"/>`
        + `<text x="${x + 3}" y="${y + 15}" fill="${color}" stroke="#000" stroke-width="3" paint-order="stroke" font-size="13" font-family="sans-serif">${label}</text>`);
    }
    svg.push("</svg>");
    writeText(joinPath(out, "annotations.svg"), svg.join("\n"));
  }

  for (const [file, png] of extracted) {
    wrapFs(() => fs.mkdirSync(path.dirname(file), { recursive: true }));
    wrapFs(() => fs.writeFileSync(file, png));
  }
  return result;
}

async function measure(manifestPath, out) {
  const raw = wrapFs(() => fs.readFileSync(manifestPath));
  const data = jsonLoads(decodeUtf8(raw));
  return measureData(data, { baseDir: path.dirname(manifestPath), out, manifestBytes: raw });
}

function parseSpec(spec, kind, extra = null) {
  if (!spec.includes("=")) throw valueError(`--${kind} 올바른 형식: 이름=x,y,width,height，받은 값:：${spec}`);
  const at = spec.indexOf("=");
  const coords = spec.slice(at + 1);
  const parts = coords.split(",").map(pyStrip);
  if (parts.length !== 4) throw valueError(`--${kind} 좌표에 필요한 값: x,y,width,height 정수 네 개，받은 값:：${coords}`);
  const entry = new Map([["name", pyStrip(spec.slice(0, at))], ["kind", kind], ["box", parts.map((part) => intFromText(part, 10))]]);
  for (const [key, value] of Object.entries(extra ?? {})) entry.set(key, value);
  return entry;
}

const PROG = "measure_reference.mjs";
const USAGE = `usage: ${PROG} [-h] [--manifest MANIFEST] [--out-dir OUT_DIR]
                             [--color NAME=X,Y,W,H] [--box NAME=X,Y,W,H]
                             [--extract NAME=X,Y,W,H] [--css-width CSS_WIDTH]
                             [--white-to-alpha] [--key-color KEY_COLOR]
                             [--despill]
                             [image]`;
const HELP = `${USAGE}

표본 읽기 UI 참고 그림의 실제 색、배치 비율과 부분 이미지 파일；지원 JSON 목록 또는 명령줄에서 바로 재기。

positional arguments:
  image                 참고 그림 경로（명령줄에서 바로 색 재기）

options:
  -h, --help            show this help message and exit
  --manifest MANIFEST   표시 목록 JSON 경로（목록 모드）
  --out-dir OUT_DIR     출력 폴더（목록 모드에서 필수；직접 재기 모드에서 선택 사항）
  --color NAME=X,Y,W,H  부분 영역의 중간 16진 색 값 읽기
  --box NAME=X,Y,W,H    부분 영역의 픽셀 상자와 비율 재기
  --extract NAME=X,Y,W,H
                        부분 그림을 잘라 내보내기: PNG
  --css-width CSS_WIDTH
                        가정한 넓은 화면 CSS 화면 너비（예: 1440），환산에 씀 css_box
  --white-to-alpha      다음을 --extract 내보낼 파일의 흰색에 가까운 바탕을 투명하게 바꾸기
  --key-color KEY_COLOR
                        다음을 --extract 내보낼 파일의 지정한 바탕색（예: #00FF00）투명하게 바꾸기
  --despill             함께 쓰기 --key-color 가장자리의 번진 색 지우기

자주 쓰는 명령：
  # 1) 명령줄에서 색과 배치 비율을 바로 잽니다（직접 적을 필요 없음 JSON 목록）
  jstyle measure design.png \\
    --color bg=40,20,80,30 --color cta=1180,920,160,40 \\
    --box col1=48,176,464,696 --css-width 1440

  # 2) 만든 결과에서 UI 디자인 그림에서 일부 뽑기/텍스처 파일（필요하면 흰색이나 지정 색을 투명하게 바꿉니다）
  jstyle measure design.png \\
    --extract jstyle_frame=548,348,440,428 --out-dir assets/extracted

  # 3) 사용 manifest.json 한꺼번에 재고 표시 상자를 만듭니다 annotations.svg
  jstyle measure --manifest manifest.json --out-dir measured/

8-bit PNG는 바로 읽고, 그 밖의 PNG·JPEG·WebP는 Chrome·Chromium·Edge로 읽습니다.
`;

const CLI = {
  options: [
    { flags: ["-h", "--help"], action: "help" },
    { flags: ["--manifest"], dest: "manifest", action: "store" },
    { flags: ["--out-dir"], dest: "outDir", action: "store" },
    { flags: ["--color"], dest: "color", action: "append" },
    { flags: ["--box"], dest: "box", action: "append" },
    { flags: ["--extract"], dest: "extract", action: "append" },
    { flags: ["--css-width"], dest: "cssWidth", action: "store", type: "float" },
    { flags: ["--white-to-alpha"], dest: "whiteToAlpha", action: "store_true" },
    { flags: ["--key-color"], dest: "keyColor", action: "store" },
    { flags: ["--despill"], dest: "despill", action: "store_true" },
  ],
  positional: { dest: "image", nargs: "?" },
};

const exitWith = (code, message) => {
  process.stderr.write(platformText(message));
  return code;
};

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv, CLI);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    return exitWith(2, `${USAGE}\n${PROG}: error: ${error.message}\n`);
  }
  if (args.help) {
    process.stdout.write(platformText(HELP));
    return 0;
  }
  const out = args.outDir === null ? null : pathStr(args.outDir);
  try {
    if (args.manifest !== null) {
      if (out === null) throw valueError("사용 --manifest 다음을 지정해야 합니다: --out-dir");
      const result = await measure(pathStr(args.manifest), out);
      const summary = new Map([
        ["status", "표시 영역 측정을 마쳤습니다，디자인 관계는 따로 판단해야 합니다"],
        ["regions", result.get("regions").length],
        ["groups", result.get("groups").length],
        ["output", out],
      ]);
      process.stdout.write(platformText(jsonDumps(summary) + "\n"));
      return 0;
    }
    if (args.image === null) {
      process.stdout.write(platformText(HELP));
      return 2;
    }
    const extra = { white_to_alpha: args.whiteToAlpha, key_color: args.keyColor, despill: args.despill };
    const regions = [
      ...args.color.map((spec) => parseSpec(spec, "color")),
      ...args.box.map((spec) => parseSpec(spec, "box")),
      ...args.extract.map((spec) => parseSpec(spec, "extract", extra)),
    ];
    const data = new Map([["reference", resolvePath(args.image)], ["regions", regions]]);
    if (args.cssWidth !== null) data.set("css_viewport_width", F(args.cssWidth));
    const result = await measureData(data, { baseDir: resolvePath("."), out, allowExistingOut: true });
    process.stdout.write(platformText(jsonDumps(result, { indent: 2 }) + "\n"));
    return 0;
  } catch (error) {
    const caught = fromNodeError(error);
    if (isValueError(caught) || isOSError(caught) || isTypeError(caught) || (caught instanceof PyError && caught.type === "KeyError")) {
      return exitWith(2, `측정 실패：${caught.message}\n`);
    }
    throw error;
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}

