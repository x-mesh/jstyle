#!/usr/bin/env node
// Build a portable, offline design comparison from a local manifest.
// Port of build_explorer.py; messages, payload bytes and fingerprints match
// the Python builder so existing manifests and comparison pages carry over.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UsageError, parseArgs as parseCli } from "./lib/argparse.mjs";
import { HTMLParser, unescape as htmlUnescape } from "./lib/html-parser.mjs";
import { WINDOWS, isAbsolutePath, joinPath, resolvePath } from "./lib/pypath.mjs";
import {
  PY_SPACE, PY_SPACE_CLASS, PyError, asciiDigits, compareCodePoints, decodeUtf8, fromNodeError, htmlEscape, isBool,
  isDict, isFloat, isInt, isList, isOSError, isPySpace, isStr, isTypeError, isValueError, jsonDumps, jsonLoads,
  pyEquals, pyFloat, pyLstrip, pyReprString, pySplit, pyStr, pyStrip, shlexQuote, universalNewlines, unquote,
  urlsplit, valueError, wrapFs,
} from "./lib/pycompat.mjs";

const S = PY_SPACE_CLASS;

// ---- pathlib.Path behavior used by the Python builder.

const statOf = (target) => {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
};
const isFile = (target) => Boolean(statOf(target)?.isFile());
const isDirectory = (target) => Boolean(statOf(target)?.isDirectory());
const exists = (target) => statOf(target) !== null;
// PurePath.name: pathlib drops empty and "." components before taking the last one.
function nameOf(target) {
  const parts = String(target).split(WINDOWS ? /[\\/]/ : "/").filter((part) => part !== "" && part !== ".");
  const last = parts.at(-1) ?? "";
  return WINDOWS && /^[A-Za-z]:$/.test(last) && parts.length === 1 ? "" : last;
}
const parentOf = (target) => (WINDOWS ? path.win32 : path.posix).dirname(target);

function suffixOf(target) {
  const name = nameOf(target);
  const at = name.lastIndexOf(".");
  return at > 0 && at < name.length - 1 ? name.slice(at) : "";
}

function stemOf(target) {
  const name = nameOf(target);
  const at = name.lastIndexOf(".");
  return at > 0 && at < name.length - 1 ? name.slice(0, at) : name;
}

const pathKey = (target) => (WINDOWS ? target.toLowerCase() : target);

function isRelativeTo(target, root) {
  const relative = (WINDOWS ? path.win32 : path.posix).relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !(WINDOWS ? path.win32 : path.posix).isAbsolute(relative));
}

// A set of resolved paths compared the way pathlib compares them.
class PathSet {
  #items = new Map();

  constructor(items = []) {
    for (const item of items) this.add(item);
  }

  add(item) {
    this.#items.set(pathKey(item), item);
  }

  has(item) {
    return this.#items.has(pathKey(item));
  }

  values() {
    return [...this.#items.values()];
  }
}

const SKILL_ROOT = resolvePath(fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, ""));
export const TEMPLATE = joinPath(joinPath(SKILL_ROOT, "assets"), "style-explorer.html");
export const MARKER = "/*__JSTYLE_DATA__*/ null";
const CONNECT_CSP = "connect-src 'none'";
export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; "
  + "font-src data:; media-src data:; script-src 'none'; "
  + "form-action 'none'; base-uri 'none'; object-src 'none'";
// Mutable so tests can lower the limits, as the Python tests patch them.
export const limits = { maxResourceBytes: 20 * 1024 * 1024, maxTotalResourceBytes: 100 * 1024 * 1024 };

export class ManifestError extends PyError {
  constructor(problems) {
    super("ManifestError", problems.length === 1
      ? problems[0]
      : `manifest에서 고칠 곳이 ${problems.length}군데 있습니다:\n` + problems.map((problem, index) => `  ${index + 1}. ${problem}`).join("\n"));
    this.problems = problems;
  }
}

function getOr(map, name, fallback) {
  return map.has(name) ? map.get(name) : fallback;
}

function textField(obj, name, { fallback = null, where = "" } = {}) {
  const value = getOr(obj, name, fallback);
  if (!isStr(value) || !pyStrip(value)) throw valueError(`${where}${name} 비어 있지 않은 문자열이어야 합니다`);
  return pyStrip(value);
}

function textList(obj, name, { where = "" } = {}) {
  const values = obj.get(name);
  if (!isList(values) || !values.length) throw valueError(`${where}${name} 비어 있지 않은 문자열 배열이어야 합니다`);
  if (values.some((value) => !isStr(value) || !pyStrip(value))) throw valueError(`${where}${name} 각 항목은 비어 있지 않은 문자열이어야 합니다`);
  return values.map(pyStrip);
}

// ---- CSS.

const CSS_TOKEN = new RegExp(
  String.raw`(?<comment>/\*[\s\S]*?\*/)|(?<string>"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')`
  + String.raw`|(?<ident>(?:[-_a-zA-Z]|\\(?:[0-9a-fA-F]{1,6}[${S}]?|[^\r\n]))`
  + String.raw`(?:[-_a-zA-Z0-9]|\\(?:[0-9a-fA-F]{1,6}[${S}]?|[^\r\n]))*)`
  + String.raw`|(?<space>[${S}]+)|(?<symbol>[\s\S])`, "gu");

function cssTokens(css, offset = 0) {
  return Array.from(css.matchAll(CSS_TOKEN), (match) => ({
    kind: Object.keys(match.groups).find((name) => match.groups[name] !== undefined),
    text: match[0],
    start: offset + match.index,
    end: offset + match.index + match[0].length,
  }));
}

const CSS_ESCAPE = new RegExp(String.raw`\\([0-9a-fA-F]{1,6})(?:[${S}])?|\\([^\r\n])`, "gu");

function cssUnescape(value) {
  return value.replace(CSS_ESCAPE, (_, hex, char) => {
    if (hex !== undefined) {
      const code = parseInt(hex, 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
    }
    return char;
  });
}

const RESOURCE_FUNCTIONS = ["url", "image-set", "-webkit-image-set", "image", "src"];

function checkCss(css, label) {
  const tokens = cssTokens(css).filter((token) => token.kind !== "comment" && token.kind !== "space");
  const checkResource = (value) => {
    const lowered = pyStrip(cssUnescape(value)).toLowerCase();
    if (!lowered.startsWith("data:") && !lowered.startsWith("#")) throw valueError(`${label}: CSS에 외부 파일 참조가 들어 있습니다`);
  };
  tokens.forEach((token, index) => {
    if (token.text === "@" && index + 1 < tokens.length && tokens[index + 1].kind === "ident" && cssUnescape(tokens[index + 1].text).toLowerCase() === "import") {
      throw valueError(`${label}: CSS는 @import 대신 파일 안에 직접 넣어 주세요`);
    }
    const name = token.kind === "ident" ? cssUnescape(token.text).toLowerCase() : "";
    if (!RESOURCE_FUNCTIONS.includes(name)) return;
    if (index + 1 >= tokens.length || tokens[index + 1].text !== "(") return;
    let depth = 1;
    const body = [];
    for (const inner of tokens.slice(index + 2)) {
      if (inner.kind === "symbol" && inner.text === "(") depth += 1;
      else if (inner.kind === "symbol" && inner.text === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      if (name === "url") body.push(inner.kind === "string" ? inner.text.slice(1, -1) : inner.text);
      else if (depth === 1 && inner.kind === "string") checkResource(inner.text.slice(1, -1));
    }
    if (name === "url") checkResource(body.join(""));
  });
}

// Sandboxed previews have no storage; give prototypes an in-memory stand-in so their scripts keep running.
const STORAGE_SHIM = "<script>(()=>{const mem=()=>{const m=new Map();return{get length(){return m.size},"
  + "key:i=>[...m.keys()][i]??null,getItem:k=>m.has(String(k))?m.get(String(k)):null,"
  + "setItem:(k,v)=>{m.set(String(k),String(v))},removeItem:k=>{m.delete(String(k))},clear:()=>m.clear()}};"
  + "for(const n of['localStorage','sessionStorage']){try{window[n].length}catch{"
  + "Object.defineProperty(window,n,{value:mem(),configurable:true})}}})();</script>";

// The element picker runs in every HTML preview. A static preview allows only
// this script by its hash, so the candidate's own scripts stay blocked.
// HTML parsing turns CRLF into LF before the browser hashes a script, so a
// CRLF checkout (Windows autocrlf) would otherwise block the picker.
export const PICK_SCRIPT = readText(joinPath(joinPath(SKILL_ROOT, "assets"), "explorer-pick.js")).replace(/\r\n?/g, "\n").trim();
export const PICK_HASH = "sha256-" + createHash("sha256").update(PICK_SCRIPT, "utf8").digest("base64");

function previewCsp(interactive) {
  // Interactive prototypes may run their own inline scripts, still with no network or external files.
  // 'unsafe-eval' lets declarative libraries such as Alpine.js evaluate their attribute expressions.
  return PREVIEW_CSP.replace("script-src 'none'", interactive ? "script-src 'unsafe-inline' 'unsafe-eval'" : `script-src '${PICK_HASH}'`);
}

const EMBEDDABLE = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
  ".mp4": "video/mp4", ".webm": "video/webm",
};

// Python's built-in mimetypes defaults. Python also reads system mime.types
// files, so its fallback differs between machines; this table is fixed.
const MIME = JSON.parse(fs.readFileSync(new URL("./lib/mime-types.json", import.meta.url), "utf8"));

// genericpath._splitext: leading dots of the file name are not an extension.
function splitext(name) {
  const sep = Math.max(name.lastIndexOf("/"), WINDOWS ? name.lastIndexOf("\\") : -1);
  const dot = name.lastIndexOf(".");
  if (dot > sep) {
    for (let at = sep + 1; at < dot; at += 1) {
      if (name[at] !== ".") return [name.slice(0, dot), name.slice(dot)];
    }
  }
  return [name, ""];
}

function guessType(name) {
  let [base, ext] = splitext(name);
  while (Object.hasOwn(MIME.suffix, ext.toLowerCase())) [base, ext] = splitext(base + MIME.suffix[ext.toLowerCase()]);
  if (Object.hasOwn(MIME.enc, ext)) [base, ext] = splitext(base);
  return MIME.types[ext.toLowerCase()] ?? null;
}

export function readAsset(target, used) {
  const size = wrapFs(() => fs.statSync(target).size);
  const { maxResourceBytes: one, maxTotalResourceBytes: all } = limits;
  if (size > one) {
    throw valueError(`로컬 파일 ${target}의 크기가 ${size} 바이트로, 파일 하나의 최대 크기 ${one} 바이트를 넘습니다. `
      + `파일을 압축하거나 잘라 ${one} 바이트 이내로 줄이고, 같은 경로에 둔 채 다시 실행하세요`);
  }
  const counted = new PathSet([...used.values(), target]);
  const total = counted.values().reduce((sum, item) => sum + wrapFs(() => fs.statSync(item).size), 0);
  if (total > all) {
    throw valueError(`안에 넣은 파일의 총 크기가 ${total} 바이트로, 전체 최대 크기 ${all} 바이트를 넘습니다. `
      + `안에서 참조한 이미지, 글꼴, 영상의 크기를 줄이고 입력 파일 전체가 ${all} 바이트를 넘지 않게 한 뒤 다시 실행하세요`);
  }
  used.add(target);
  return wrapFs(() => fs.readFileSync(target));
}

function readText(target) {
  return universalNewlines(decodeUtf8(wrapFs(() => fs.readFileSync(target))));
}

function readTextAsset(target, used) {
  return universalNewlines(decodeUtf8(readAsset(target, used)));
}

function quoteUrlPath(text) {
  return Array.from(Buffer.from(text, "utf8"), (byte) => {
    const char = String.fromCharCode(byte);
    return /[A-Za-z0-9_.\-~/]/.test(char) ? char : "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }).join("");
}

// PureWindowsPath(ref).as_uri() for absolute drive and UNC paths.
function windowsAsUri(ref) {
  const posix = ref.replace(/\\/g, "/");
  const unc = /^\/\/[^/]+\/+[^/]+/.test(posix);
  const parts = posix.slice(unc ? 2 : 0).split("/").filter((part, index) => part !== "" && part !== "." || index === 0);
  if (unc) return "file:" + quoteUrlPath("//" + parts.join("/"));
  return "file:///" + parts[0] + quoteUrlPath("/" + parts.slice(1).join("/"));
}

function resourceParts(ref) {
  if (WINDOWS && isAbsolutePath(ref)) ref = windowsAsUri(ref);
  return urlsplit(ref);
}

function url2pathname(url) {
  if (!WINDOWS) return unquote(url);
  if (url.startsWith("///")) url = url.slice(2);
  else if (url.startsWith("//localhost/")) url = url.slice(11);
  if (url.startsWith("///")) url = url.slice(1);
  else {
    if (url.startsWith("/") && (url[2] === ":" || url[2] === "|")) url = url.slice(1);
    if (url[1] === "|") url = url[0] + ":" + url.slice(2);
  }
  return unquote(url.replace(/\//g, "\\"));
}

function localFile(ref, base) {
  ref = pyStrip(ref);
  if (!ref || ref.startsWith("#") || ref.toLowerCase().startsWith("data:")) return null;
  let parts;
  try {
    parts = resourceParts(ref);
  } catch (error) {
    if (!isValueError(error)) throw error;
    throw valueError(`파일 주소가 올바르지 않습니다: ${ref}. 참조를 실제 파일의 절대 경로로 바꾼 뒤 다시 만드세요`);
  }
  if ((parts.scheme && parts.scheme.toLowerCase() !== "file") || !["", "localhost"].includes(parts.netloc) || ref.startsWith("//")) {
    const destination = joinPath(base, nameOf(unquote(parts.path)) || "resource.bin");
    const command = `curl -L --fail --output ${shlexQuote(destination)} -- ${shlexQuote(ref)}`;
    throw valueError(`외부 파일은 오프라인에서 쓸 수 없습니다: ${ref}. 먼저 \`${command}\`를 실행하고, `
      + `참조 ${jsonDumps(ref)}를 ${jsonDumps(destination)}로 바꾼 뒤 다시 만드세요`);
  }
  // A file URL's /C:/... is not a Windows filesystem path. Decode it with
  // the platform converter, which also handles percent-escaped filenames.
  const target = resolvePath(joinPath(base, url2pathname(parts.path)));
  if (!isFile(target)) {
    throw valueError(`로컬 파일을 찾을 수 없습니다: ${ref}(찾은 경로: ${target}). `
      + `파일을 ${jsonDumps(target)}에 저장하거나, 참조를 실제 파일의 절대 경로로 바꾼 뒤 다시 만드세요`);
  }
  return target;
}

function resourceUrl(ref, base, used) {
  const target = localFile(ref, base);
  if (target === null) return ref;
  const mime = EMBEDDABLE[suffixOf(target).toLowerCase()] || guessType(nameOf(target)) || "application/octet-stream";
  const { fragment } = resourceParts(ref);
  return `data:${mime};base64,` + readAsset(target, used).toString("base64") + (fragment ? "#" + fragment : "");
}

function compareEdits(a, b) {
  return a[0] - b[0] || a[1] - b[1] || compareCodePoints(a[2], b[2]);
}

function applyEdits(content, edits) {
  for (const [start, end, replacement] of [...edits].sort((a, b) => compareEdits(b, a))) {
    content = content.slice(0, start) + replacement + content.slice(end);
  }
  return content;
}

// base64.b64decode without validate: drop non-alphabet bytes, then demand padding.
function b64decode(payload) {
  let data = "";
  let padding = 0;
  for (const char of payload) {
    if (/[A-Za-z0-9+/]/.test(char)) {
      if (padding) break;
      data += char;
    } else if (char === "=") {
      padding += 1;
      if ((data.length + padding) % 4 === 0) break;
    }
  }
  if (data.length % 4 === 1) {
    throw valueError(`Invalid base64-encoded string: number of data characters (${data.length}) cannot be 1 more than a multiple of 4`);
  }
  if (data.length % 4 && (data.length + padding) % 4) throw valueError("Incorrect padding");
  return Buffer.from(data, "base64");
}

function embedCss(css, base, used, stack = []) {
  const tokens = cssTokens(css).filter((token) => token.kind !== "comment" && token.kind !== "space");
  const edits = [];
  const closing = (index) => {
    let depth = 0;
    for (let end = index; end < tokens.length; end += 1) {
      if (tokens[end].kind !== "symbol") continue;
      if (tokens[end].text === "(") depth += 1;
      else if (tokens[end].text === ")") {
        depth -= 1;
        if (depth === 0) return end;
      }
    }
    return tokens.length - 1;
  };
  const value = (start, end) => {
    let raw = pyStrip(cssTokens(css.slice(start, end)).filter((token) => token.kind !== "comment").map((token) => token.text).join(""));
    if ((raw[0] === "'" || raw[0] === '"') && raw.length && raw.at(-1) === raw[0]) raw = raw.slice(1, -1);
    return cssUnescape(raw);
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    const name = token.kind === "ident" ? cssUnescape(token.text).toLowerCase() : "";
    if (token.text === "@" && i + 2 < tokens.length && cssUnescape(tokens[i + 1].text).toLowerCase() === "import") {
      const first = i + 2;
      let last = first;
      let ref;
      if (tokens[first].kind === "string") {
        ref = value(tokens[first].start, tokens[first].end);
      } else if (cssUnescape(tokens[first].text).toLowerCase() === "url" && first + 1 < tokens.length && tokens[first + 1].text === "(") {
        last = closing(first + 1);
        ref = value(tokens[first + 1].end, tokens[last].start);
      } else {
        throw valueError('CSS @import를 읽을 수 없습니다. @import "이미 있는 파일의 절대 경로.css"; 형식으로 고치세요');
      }
      let end = last + 1;
      while (end < tokens.length && tokens[end].text !== ";") {
        if (tokens[end].text === "(") end = closing(end);
        end += 1;
      }
      let condition = pyStrip(css.slice(tokens[last].end, end < tokens.length ? tokens[end].start : css.length));
      const target = localFile(ref, base);
      let imported;
      if (target === null) {
        // Embedded imports have no local base; decode and check them as well.
        if (!ref.toLowerCase().startsWith("data:text/css")) throw valueError('CSS @import에는 로컬 CSS 파일을 쓰세요. 예: @import "./style.css";');
        const comma = ref.indexOf(",");
        if (comma < 0) throw valueError("not enough values to unpack (expected 2, got 1)");
        const header = ref.slice(0, comma);
        const payload = ref.slice(comma + 1);
        imported = header.toLowerCase().includes(";base64") ? decodeUtf8(b64decode(payload)) : unquote(payload);
        imported = embedCss(imported, base, used, stack);
      } else if (stack.some((item) => pathKey(item) === pathKey(target))) {
        imported = ""; // Browsers ignore cyclic imports too.
      } else {
        imported = embedCss(readTextAsset(target, used), parentOf(target), used, [...stack, target]);
      }
      // Preserve import layer/supports/media conditions when moving the CSS inline.
      const wrappers = [];
      for (const keyword of ["layer", "supports"]) {
        const match = new RegExp(`^${keyword}(?![\\p{L}\\p{N}_])`, "iu").exec(condition);
        if (!match) continue;
        let rest = pyLstrip(condition.slice(match[0].length), PY_SPACE);
        let argument = "";
        if (rest.startsWith("(")) {
          let depth = 0;
          for (let pos = 0; pos < rest.length; pos += 1) {
            depth += (rest[pos] === "(") - (rest[pos] === ")");
            if (depth === 0) {
              [argument, rest] = [rest.slice(1, pos), pyLstrip(rest.slice(pos + 1), PY_SPACE)];
              break;
            }
          }
        }
        wrappers.push(keyword === "layer" ? "@layer " + argument : "@supports (" + argument + ")");
        condition = rest;
      }
      if (condition) wrappers.push("@media " + condition);
      for (const wrapper of wrappers.reverse()) imported = wrapper + "{" + imported + "}";
      edits.push([token.start, end < tokens.length ? tokens[end].end : css.length, imported]);
      i = end + 1;
      continue;
    }
    if (RESOURCE_FUNCTIONS.includes(name) && i + 1 < tokens.length && tokens[i + 1].text === "(") {
      const end = closing(i + 1);
      if (name === "url") {
        const ref = value(tokens[i + 1].end, tokens[end].start);
        const url = resourceUrl(ref, base, used);
        if (url !== ref) edits.push([token.start, tokens[end].end, 'url("' + url + '")']);
        i = end + 1;
        continue;
      }
      let depth = 0;
      for (const inner of tokens.slice(i + 2, end)) {
        if (inner.kind === "symbol") depth += (inner.text === "(") - (inner.text === ")");
        if (depth === 0 && inner.kind === "string") {
          const ref = value(inner.start, inner.end);
          const url = resourceUrl(ref, base, used);
          if (url !== ref) edits.push([inner.start, inner.end, '"' + url + '"']);
        }
      }
    }
    i += 1;
  }
  return applyEdits(css, edits);
}

// Largest "url 1200w" / "url 2x" entry of a srcset; an entry without a descriptor counts as 1x.
// Parsed as the HTML spec does: a URL runs to the next whitespace, so data URLs keep their commas.
function widestCandidate(srcset) {
  let best = null;
  let bestSize = -1;
  let i = 0;
  const n = srcset.length;
  while (i < n) {
    while (i < n && (isPySpace(srcset[i]) || srcset[i] === ",")) i += 1;
    let start = i;
    while (i < n && !isPySpace(srcset[i])) i += 1;
    let url = srcset.slice(start, i);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
    } else {
      start = i;
      while (i < n && srcset[i] !== ",") i += 1;
      descriptor = pyStrip(srcset.slice(start, i));
    }
    let size = 1;
    if (descriptor.endsWith("w") || descriptor.endsWith("x")) {
      try {
        size = pyFloat(descriptor.slice(0, -1));
      } catch (error) {
        if (!isValueError(error)) throw error;
      }
    }
    if (url && size > bestSize) [best, bestSize] = [url, size];
  }
  return best;
}

const HTML_ATTR = new RegExp(
  `(?<lead>[${S}]+(?<name>[^${S}=/>]+)[${S}]*=[${S}]*)(?:"(?<double>[^"]*)"|'(?<single>[^']*)'|(?<bare>[^${S}>]+))`, "gu");

// Edit only real tags and styles, preserving comments, text and inline script bodies.
class LocalAssets extends HTMLParser {
  constructor(content, base, used, interactive, { shell = false } = {}) {
    super({ convertCharrefs: false });
    Object.assign(this, { content, base, used, interactive, shell });
    this.edits = [];
    this.inStyle = false;
    this.script = null;
    this.deferred = [];
  }

  handleStarttag(tag, attrList) {
    const attrs = new Map(attrList);
    const raw = this.getStarttagText();
    const start = this.index;
    if (tag === "link" && pySplit((attrs.get("rel") || "").toLowerCase()).includes("stylesheet") && attrs.get("href")) {
      const target = localFile(attrs.get("href"), this.base);
      if (target !== null) {
        let css = embedCss(readTextAsset(target, this.used), parentOf(target), this.used, [target]);
        if (attrs.get("media")) css = "@media " + attrs.get("media") + "{" + css + "}";
        this.edits.push([start, start + raw.length, "<style>" + css.replace(/<\/style/giu, "<\\/style") + "</style>"]);
        return;
      }
    }
    if (tag === "script" && attrs.get("src")) {
      const target = localFile(attrs.get("src"), this.base);
      if (target !== null) {
        let code;
        if (this.interactive) {
          code = readTextAsset(target, this.used);
        } else {
          readAsset(target, this.used);
          code = "";
        }
        code = code.replace(/<\/script/giu, "<\\/script");
        const module = (attrs.get("type") || "").toLowerCase() === "module";
        let replacement = this.interactive ? (module ? '<script type="module">' : "<script>") + code + "</script>" : "";
        if (attrs.has("defer") && !module) {
          // Inline scripts ignore defer; keep their original execution after the DOM.
          this.deferred.push(replacement);
          replacement = "";
        }
        this.script = [start, replacement];
        return;
      }
    }
    if (tag === "style") this.inStyle = true;

    const attribute = (whole, ...rest) => {
      const groups = rest.at(-1);
      const name = groups.name.toLowerCase();
      if (this.shell && tag === "a" && name === "href") return whole; // Template navigation is not an offline resource dependency.
      const ref = htmlUnescape([groups.double, groups.single, groups.bare].find((item) => item !== undefined));
      const hasSrc = Boolean(pyStrip(attrs.get("src") || ""));
      if (name === "src" && tag === "img" && !hasSrc && widestCandidate(attrs.get("srcset") || "")) {
        return ""; // An empty src gives way to the srcset candidate below, so the tag keeps one src.
      }
      if (name === "srcset" && tag === "img") {
        // The page shows one fixed size, so one file is enough: keep src, or take the widest candidate.
        if (hasSrc || !widestCandidate(ref)) return "";
        return groups.lead.replaceAll(groups.name, "src") + '"' + htmlEscape(resourceUrl(widestCandidate(ref), this.base, this.used)) + '"';
      }
      let result;
      if (name === "style") result = embedCss(ref, this.base, this.used);
      else if (["src", "poster", "data", "href", "xlink:href"].includes(name)) result = resourceUrl(ref, this.base, this.used);
      else return whole;
      return result === ref ? whole : groups.lead + '"' + htmlEscape(result) + '"';
    };

    const replacement = raw.replace(HTML_ATTR, attribute);
    if (replacement !== raw) this.edits.push([start, start + raw.length, replacement]);
  }

  handleEndtag(tag) {
    if (tag === "style") this.inStyle = false;
    if (tag === "script" && this.script !== null) {
      const [start, replacement] = this.script;
      const end = this.content.indexOf(">", this.index) + 1;
      this.edits.push([start, end, replacement]);
      this.script = null;
    }
  }

  handleData(data) {
    if (this.inStyle) {
      const replacement = embedCss(data, this.base, this.used);
      if (replacement !== data) this.edits.push([this.index, this.index + data.length, replacement]);
    }
  }

  result() {
    this.feed(this.content);
    this.close();
    if (this.script !== null) {
      const [start, replacement] = this.script;
      this.edits.push([start, this.content.length, replacement]);
    }
    let content = applyEdits(this.content, this.edits);
    if (this.deferred.length) {
      let close = content.toLowerCase().lastIndexOf("</body>");
      close = close < 0 ? content.length : close;
      content = content.slice(0, close) + this.deferred.join("") + content.slice(close);
    }
    return content;
  }
}

function embedLocalFiles(content, base, used) {
  return new LocalAssets(content, base, used, false, { shell: true }).result();
}

function ensureHead(content) {
  const parser = new (class extends HTMLParser {
    head = null;
    html = null;
    body = null;
    htmlEnd = null;
    declaration = null;
    headClosed = false;

    handleStarttag(tag) {
      if (tag === "head" && this.head === null) this.head = this.index + this.getStarttagText().length;
      if (tag === "html" && this.html === null) this.html = this.index + this.getStarttagText().length;
      if (tag === "body" && this.body === null) this.body = this.index;
    }

    handleEndtag(tag) {
      if (tag === "head") this.headClosed = true;
      if (tag === "html") this.htmlEnd = this.index;
    }

    handleStartendtag(tag, attrs) {
      this.handleStarttag(tag, attrs);
      if (tag !== "head") this.handleEndtag(tag); // HTML does not allow a self-closing head.
    }

    handleDecl(decl) {
      this.declaration = this.index + decl.length + 3;
    }
  })();
  parser.feed(content);
  if (parser.head === null) {
    const at = parser.html !== null ? parser.html : parser.declaration || 0;
    return content.slice(0, at) + "<head></head>" + content.slice(at);
  }
  if (!parser.headClosed) {
    const at = [parser.body, parser.htmlEnd].find((pos) => pos !== null && pos >= parser.head) ?? content.length;
    return content.slice(0, at) + "</head>" + content.slice(at);
  }
  return content;
}

// Reject resource dependencies; the browser sandbox disables behavior.
class AssetCheck extends HTMLParser {
  styles = [];
  inStyle = false;
  headPosition = null;

  handleStarttag(tag, attrList) {
    const attrs = new Map(attrList);
    if (tag === "head" && this.headPosition === null) this.headPosition = [this.index, this.getStarttagText()];
    if (["iframe", "frame", "object", "embed"].includes(tag)) throw valueError("안의 HTML에는 중첩 문서(iframe, frame, object, embed)를 쓸 수 없습니다. 정지 내용이나 캡처를 주세요");
    if (tag === "style") this.inStyle = true;
    if (attrs.get("style")) this.styles.push(attrs.get("style"));
    if (tag === "base") throw valueError("안의 HTML에는 base 태그를 쓸 수 없습니다. 참조 파일은 HTML 안에 넣어야 합니다");
    if (tag === "meta" && getOr(attrs, "http-equiv", "").toLowerCase() === "refresh") throw valueError("안의 HTML은 자동으로 다른 페이지로 이동하면 안 됩니다");
    for (const key of ["src", "poster", "data", "href", "xlink:href"]) {
      const value = getOr(attrs, key, "") || "";
      if (!value || value.toLowerCase().startsWith("#") || value.toLowerCase().startsWith("data:")) continue;
      throw valueError(`안 HTML 밖의 파일 참조를 포함함 ${tag}.${key}: ${value}`);
    }
    if (attrs.get("srcset")) throw valueError("안 HTML 안에 넣은 파일을 쓰세요: src 대신 srcset");
  }

  handleEndtag(tag) {
    if (tag === "style") this.inStyle = false;
  }

  handleData(data) {
    if (this.inStyle) this.styles.push(data);
  }
}

export function prepareHtml(source, interactive = false, used = null) {
  source = resolvePath(source);
  used = used ?? new PathSet();
  let content = readTextAsset(source, used);
  content = ensureHead(content);
  content = new LocalAssets(content, parentOf(source), used, interactive).result();
  const parser = new AssetCheck();
  parser.feed(content);
  for (const style of parser.styles) checkCss(style, nameOf(source));
  if (parser.headPosition === null) throw new PyError("TypeError", "cannot unpack non-iterable NoneType object");
  // The policy goes first in the document, right after a leading doctype. Any content before the
  // candidate's own <head> makes the browser open <body> early, and a meta placed there is ignored;
  // as the first element, the parser puts it into the implied <head>. Keeping the doctype first
  // keeps the candidate out of quirks mode.
  const lead = /^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(content);
  const at = lead ? lead[0].length : 0;
  const meta = `<meta http-equiv="Content-Security-Policy" content="${previewCsp(interactive)}">`;
  return content.slice(0, at) + meta + (interactive ? STORAGE_SHIM : "") + `<script>${PICK_SCRIPT}</script>` + content.slice(at);
}

function prepareImage(source, used = null) {
  const data = readAsset(source, used ?? new PathSet());
  let mime;
  if (data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1"))) mime = "image/png";
  else if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) mime = "image/jpeg";
  else if (data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") mime = "image/webp";
  else throw valueError(`${nameOf(source)}: 정지 미리보기는 PNG, JPEG, WebP만 지원합니다`);
  return `data:${mime};base64,` + data.toString("base64");
}

const LOOPBACK = ["localhost", "127.0.0.1", "::1"];

// Live candidates only point at a dev server on this machine.
function localUrl(value, label) {
  let parts;
  try {
    parts = urlsplit(value);
    void parts.port; // Reject malformed ports before generating CSP origins.
  } catch (error) {
    if (!isValueError(error)) throw error;
    throw valueError(`${label}값은 올바른 로컬 http(s) 주소여야 합니다. 받은 값: ${value}`);
  }
  if (!["http", "https"].includes(parts.scheme) || !LOOPBACK.includes((parts.hostname || "").toLowerCase()) || parts.username || parts.password) {
    throw valueError(`${label}값으로는 로컬 개발 서버 주소만 쓸 수 있습니다(예: http://localhost:5173/orders). 받은 값: ${value}`);
  }
  return value;
}

const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_])/g;

function palette(value, where) {
  const colors = jsonDumps(value).match(HEX_COLOR) ?? [];
  if (!colors.length) {
    throw valueError(`${where}palette에 쓸 수 있는 16진 색 값이 없습니다(받은 값: ${jsonDumps(value)}). `
      + '"palette": ["#1a2b3c", "#ffffff"]처럼 고치세요');
  }
  return colors;
}

const VIEWPORT_TEXT = new RegExp(`^[${S}]*(\\p{Nd}+)[${S}]*[xX×][${S}]*(\\p{Nd}+)[${S}]*$`, "u");
const MAX_SAFE = 2n ** 53n - 1n;
// Every cell is a live frame on one board, so a matrix stays small enough to load at once.
const MAX_SCREENS = 6;
const MAX_CELLS = 24;
const MAX_SCREEN_NAME = 40;

function pyInt(digits) {
  if (digits.length > 4300) {
    throw valueError(`Exceeds the limit (4300 digits) for integer string conversion: value has ${digits.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  return BigInt(asciiDigits(digits));
}

// Normalize a fixed canvas without changing manifests that omit it.
function nativeViewport(value, where) {
  let dimensions = null;
  if (isStr(value)) {
    const match = VIEWPORT_TEXT.exec(value);
    if (match) dimensions = [pyInt(match[1]), pyInt(match[2])];
  } else if (isDict(value)) {
    dimensions = [getOr(value, "width", null), getOr(value, "height", null)];
  }
  const valid = (n) => {
    if (isInt(n)) return n > 0n && n <= MAX_SAFE;
    if (isFloat(n)) return n.value > 0 && n.value <= Number(MAX_SAFE) && Number.isInteger(n.value);
    return false;
  };
  if (dimensions && dimensions.every(valid)) {
    const [width, height] = dimensions.map((n) => (isInt(n) ? n : BigInt(n.value)));
    return new Map([["width", width], ["height", height]]);
  }
  throw valueError(`${where}nativeViewport의 너비와 높이는 양의 정수여야 합니다(받은 값: ${jsonDumps(value)}). `
    + '예: "1920x1080", "1920×1080" 또는 {"width":1920,"height":1080}');
}

function readManifest(target) {
  if (!isFile(target)) {
    throw valueError(`manifest를 찾을 수 없습니다: ${target}. 먼저 작업 폴더에 manifest.json을 만드세요. 필드 설명은 references/style-explorer.md의 "입력 준비"에 있습니다`);
  }
  let raw;
  try {
    raw = jsonLoads(readText(target));
  } catch (error) {
    if (error instanceof PyError && error.type === "JSONDecodeError") {
      throw valueError(`manifest JSON이 올바르지 않습니다: ${error.lineno}번째 줄 ${error.colno}번째 열, ${error.msg}`);
    }
    throw error;
  }
  if (!isDict(raw)) throw valueError("manifest의 맨 바깥은 candidates 배열을 담은 객체여야 합니다");
  return raw;
}

class HTMLTitle extends HTMLParser {
  inTitle = false;
  parts = [];

  handleStarttag(tag) {
    if (tag.toLowerCase() === "title") this.inTitle = true;
  }

  handleEndtag(tag) {
    if (tag.toLowerCase() === "title") this.inTitle = false;
  }

  handleData(data) {
    if (this.inTitle) this.parts.push(data);
  }
}

function inferredName(kind, source, url, index) {
  if (source && kind === "html") {
    try {
      const title = new HTMLTitle();
      title.feed(readTextAsset(source, new PathSet()));
      const value = pySplit(title.parts.join("")).join(" ");
      if (value) return value;
    } catch (error) {
      if (!isOSError(error) && !isValueError(error)) throw error;
    }
  }
  if (source) return stemOf(source);
  if (url) {
    const parts = urlsplit(url);
    return stemOf(unquote(parts.path)) || parts.hostname || `안 ${index}`;
  }
  return `안 ${index}`;
}

function loadManifestData(raw, manifestPath, { includeManifest }) {
  const problems = [];
  const attempt = (check) => {
    // Run one check; keep its message and carry on so the rest still gets checked.
    try {
      return check();
    } catch (error) {
      if (!isValueError(error)) throw error;
      problems.push(error.message);
      return null;
    }
  };
  const folder = parentOf(manifestPath);

  if (raw.has("schemaVersion") && !pyEquals(raw.get("schemaVersion"), 1n)) problems.push("manifest.schemaVersion은 1이어야 합니다");
  const data = { schemaVersion: 1n };
  for (const [name, fallback] of [["project", null], ["brief", null], ["round", "01"]]) {
    if (raw.has(name) || fallback !== null) {
      const value = attempt(() => textField(raw, name, { fallback, where: "manifest." }));
      if (value !== null) data[name] = value;
    }
  }
  if (raw.has("lang")) {
    if (!["ko", "en"].includes(raw.get("lang"))) problems.push('manifest.lang은 "ko" 또는 "en"이어야 합니다');
    data.lang = raw.get("lang");
  }
  if (raw.has("serve")) {
    const serve = raw.get("serve");
    if (!isDict(serve)) {
      problems.push("serve는 객체여야 합니다. 예: {\"command\": \"pnpm dev\", \"cwd\": \"/프로젝트의 절대 경로\", \"url\": \"http://localhost:3000\"}");
    } else {
      if (!isStr(serve.get("command")) || !pyStrip(serve.get("command"))) problems.push("serve.command 비어 있지 않은 문자열이어야 합니다");
      if (serve.has("cwd") && (!isStr(serve.get("cwd")) || !isAbsolutePath(serve.get("cwd")))) problems.push("serve.cwd 절대 경로여야 합니다");
      if (serve.has("url")) {
        if (!isStr(serve.get("url")) || !pyStrip(serve.get("url"))) problems.push("serve.url은 비어 있지 않은 로컬 http(s) 주소여야 합니다");
        else attempt(() => localUrl(serve.get("url"), "serve.url "));
      }
    }
    data.serve = serve;
  }
  let candidates = raw.get("candidates");
  if (!isList(candidates) || !candidates.length) {
    problems.push("candidates에 디자인 안이 하나 이상 필요합니다");
    candidates = [];
  }
  const seen = new Set();
  const reserved = new Set(candidates
    .filter((c) => isDict(c) && isStr(c.get("id")) && pyStrip(c.get("id")))
    .map((c) => pyStrip(c.get("id"))));
  const inputs = new PathSet([resolvePath(TEMPLATE)]);
  if (includeManifest) inputs.add(resolvePath(manifestPath));
  const output = [];
  let viewport = null;
  if (raw.has("nativeViewport")) {
    const affected = candidates
      .map((c, i) => [c, i + 1])
      .filter(([c]) => isDict(c) && !c.has("nativeViewport"))
      .map(([c, i]) => pyStr(getOr(c, "id", BigInt(i))))
      .join(", ");
    const where = affected ? `manifest(안 ${affected}): ` : "manifest.";
    viewport = attempt(() => nativeViewport(raw.get("nativeViewport"), where));
  }
  // A top-level screens list turns the round into a matrix: rows are pages, columns are directions.
  const matrix = raw.has("screens");
  let screens = null;
  if (matrix) {
    const value = raw.get("screens");
    if (!isList(value) || !value.length || value.some((name) => !isStr(name) || !pyStrip(name))) {
      problems.push('manifest.screens는 비어 있지 않은 문자열 배열이어야 합니다. 예: ["목록", "상세"]');
    } else {
      const names = value.map(pyStrip);
      const before = problems.length;
      const repeated = new Set();
      for (const [at, name] of names.entries()) {
        if ([...name].length > MAX_SCREEN_NAME) problems.push(`manifest.screens의 "${name}": 페이지 이름은 ${MAX_SCREEN_NAME}자까지입니다`);
        if (names.indexOf(name) !== at && !repeated.has(name)) {
          repeated.add(name);
          problems.push(`manifest.screens의 페이지 이름 "${name}"이 겹칩니다`);
        }
      }
      if (names.length > MAX_SCREENS) problems.push(`manifest.screens는 페이지 ${MAX_SCREENS}개까지입니다(받은 수: ${names.length})`);
      if (problems.length === before) screens = names;
    }
    data.screens = screens;
  }
  let cellCount = 0;
  // One screen of a direction: the whole candidate in a plain round, one cell in a matrix.
  // baseline is given only for a whole candidate, whose nativeViewport the caller already read.
  const checkCell = (spec, where, inherited, baseline) => {
    const cell = baseline === undefined;
    const cellViewport = cell && spec.has("nativeViewport") ? attempt(() => nativeViewport(spec.get("nativeViewport"), where)) : inherited;
    let kind = getOr(spec, "kind", "html");
    if (!(isStr(kind) && ["html", "image", "url"].includes(kind))) {
      problems.push(`${where}kind는 "html", "image", "url" 중 하나여야 합니다(받은 값: ${jsonDumps(kind)})`);
      kind = null;
    }
    const interactive = getOr(spec, "interactive", false);
    if (cell ? !isBool(interactive) : !isBool(baseline) || !isBool(interactive)) {
      problems.push(cell ? `${where}interactive는 true 또는 false여야 합니다` : `${where}baseline과 interactive는 true 또는 false여야 합니다`);
    } else if (interactive && kind !== "html" && kind !== null) problems.push(`${where}interactive는 html 안에만 쓸 수 있습니다`);
    let source = null;
    let url = null;
    if (kind === "url") {
      url = attempt(() => localUrl(textField(spec, "url", { where }), `${where}url `));
    } else if (kind) {
      const name = attempt(() => textField(spec, "source", { where }));
      if (name) {
        const sourceFile = () => {
          try {
            // source is a filesystem path, so literal #, ? and % retain their old meaning.
            const direct = resolvePath(joinPath(folder, name));
            if (isFile(direct)) return direct;
            const target = localFile(name, folder);
            if (target === null) throw valueError('로컬 파일을 가리켜야 합니다. 예: "source": "./a.html"');
            return target;
          } catch (error) {
            if (!isValueError(error)) throw error;
            throw valueError(`${where}source: ${error.message}`);
          }
        };
        source = attempt(sourceFile);
        if (source) inputs.add(source);
      }
    }
    return { kind, interactive, source, url, viewport: cellViewport };
  };
  const renderCell = (cell, where) => {
    const { kind, interactive, source, url } = cell;
    try {
      const content = kind === "url" ? url : kind === "html" ? prepareHtml(source, interactive, inputs) : prepareImage(source, inputs);
      return { ...cell, content, sourceLabel: kind === "url" ? url : nameOf(source) };
    } catch (error) {
      if (!isValueError(error)) throw error;
      let message = error.message;
      if (source && message.startsWith(`${nameOf(source)}: `)) message = message.slice(nameOf(source).length + 2);
      problems.push(source ? `${where}${nameOf(source)} ${message}` : `${where}${message}`);
      return null;
    }
  };
  candidates.forEach((candidate, offset) => {
    const index = offset + 1;
    if (!isDict(candidate)) {
      problems.push(`${index}번째 안은 객체여야 합니다`);
      return;
    }
    const before = problems.length;
    let identifier = getOr(candidate, "id", null);
    if (identifier === null) {
      identifier = `candidate-${index}`;
      let suffix = 2;
      while (reserved.has(identifier) || seen.has(identifier)) {
        identifier = `candidate-${index}-${suffix}`;
        suffix += 1;
      }
    } else if (!isStr(identifier) || !pyStrip(identifier)) {
      problems.push(`${index}번째 안의 id는 비어 있지 않은 문자열이어야 합니다`);
      identifier = null;
    } else {
      identifier = pyStrip(identifier);
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(identifier)) {
        problems.push(`안 id "${identifier}"가 올바르지 않습니다. 소문자, 숫자, 하이픈, 밑줄만 쓰고 글자나 숫자로 시작해야 합니다. 예: "a" 또는 "dir-2"`);
      } else if (seen.has(identifier)) {
        problems.push(`안 id "${identifier}"가 겹칩니다. 안마다 다른 id를 쓰세요`);
      }
      seen.add(identifier);
    }
    const where = identifier ? `안 ${identifier}: ` : `${index}번째 안: `;
    const candidateViewport = candidate.has("nativeViewport")
      ? attempt(() => nativeViewport(candidate.get("nativeViewport"), where))
      : viewport;
    const baseline = getOr(candidate, "baseline", false);
    let specs = [];
    if (!matrix) {
      specs = [[null, checkCell(candidate, where, candidateViewport, baseline)]];
    } else {
      if (!isBool(baseline)) problems.push(`${where}baseline은 true 또는 false여야 합니다`);
      const mixed = ["source", "url", "kind", "interactive"].filter((name) => candidate.has(name));
      const cellMap = candidate.has("screens") ? candidate.get("screens") : null;
      if (mixed.length) {
        problems.push(`${where}맨 위에 screens가 있으면 source, url, kind, interactive는 screens 안의 칸에 씁니다. 예: "screens": {"목록": {"source": "a/list.html"}}`);
      } else if (cellMap === null) {
        problems.push(`${where}맨 위에 screens가 있으면 안마다 screens가 필요합니다. 예: "screens": {"목록": {"source": "a/list.html"}}`);
      } else if (!isDict(cellMap)) {
        problems.push(`${where}screens는 페이지 이름을 키로 쓰는 객체여야 합니다. 예: {"목록": {"source": "a/list.html"}}`);
      } else if (screens) {
        // Keys are matched after trimming, so two keys that trim alike would drop one cell without a word.
        const given = new Map();
        for (const [key, cell] of cellMap.entries()) {
          const name = isStr(key) ? pyStrip(key) : key;
          if (given.has(name)) problems.push(`${where}screens의 페이지 이름 "${name}"이 겹칩니다`);
          given.set(name, cell);
        }
        for (const name of given.keys()) {
          if (!screens.includes(name)) problems.push(`${where}screens의 "${name}"은 맨 위 screens에 없습니다. 쓸 수 있는 이름: ${screens.join(", ")}`);
        }
        const known = screens.filter((name) => given.has(name));
        cellCount += known.length;
        if (!known.length) problems.push(`${where}screens에 칸이 하나 이상 필요합니다`);
        for (const name of known) {
          const cell = given.get(name);
          if (!isDict(cell)) problems.push(`${where}${name}: 칸은 객체여야 합니다. 예: {"source": "a/list.html"}`);
          else specs.push([name, checkCell(cell, `${where}${name}: `, candidateViewport)]);
        }
      }
    }
    const colors = candidate.has("palette") ? attempt(() => palette(candidate.get("palette"), where)) : null;
    const texts = {};
    for (const name of ["concept", "typography"]) {
      if (candidate.has(name)) texts[name] = attempt(() => textField(candidate, name, { where }));
    }
    let candidateName = candidate.has("name") ? attempt(() => textField(candidate, "name", { where })) : null;
    const traits = candidate.has("traits") ? attempt(() => textList(candidate, "traits", { where })) : null;
    if (problems.length > before || !specs.length) return;
    const cells = [];
    for (const [screen, spec] of specs) {
      const cell = renderCell(spec, screen === null ? where : `${where}${screen}: `);
      if (!cell) return;
      cells.push({ screen, ...cell });
    }
    const [first] = cells;
    if (candidateName === null) candidateName = inferredName(first.kind, first.source, first.url, index);
    const shown = (cell) => ({ kind: cell.kind, content: cell.content, sourceLabel: cell.sourceLabel });
    const fixed = (cell) => (cell.viewport ? { nativeViewport: cell.viewport } : {});
    output.push({
      id: identifier,
      name: candidateName,
      ...texts,
      ...(colors !== null ? { palette: colors } : {}),
      ...(traits !== null ? { traits } : {}),
      // In a matrix these mirror the first cell, so readers of one screen per direction keep working.
      ...shown(first),
      baseline,
      interactive: first.interactive,
      ...fixed(first),
      ...(matrix ? { screens: cells.map((cell) => ({ screen: cell.screen, ...shown(cell), interactive: cell.interactive, ...fixed(cell) })) } : {}),
    });
  });
  if (output.filter((c) => c.baseline).length > 1) problems.push("기존 화면 안(baseline: true)은 하나만 둘 수 있습니다");
  if (cellCount > MAX_CELLS) problems.push(`manifest: matrix의 칸은 모두 ${MAX_CELLS}개까지입니다(받은 수: ${cellCount}). 안이나 페이지를 줄이세요`);
  if (problems.length) throw new ManifestError(problems);
  // The current version always sits first so every direction is read against it.
  output.sort((a, b) => Number(!a.baseline) - Number(!b.baseline));
  data.candidates = output;
  const canonical = jsonDumps(data, { sortKeys: true, separators: [",", ":"] });
  data.fingerprint = createHash("sha256").update(encodeUtf8(canonical)).digest("hex").slice(0, 24);
  return [data, inputs];
}

// str.encode("utf-8") refuses lone surrogates, which Buffer would replace silently.
function encodeUtf8(text) {
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.exec(text);
  if (lone) {
    const position = [...text.slice(0, lone.index)].length;
    const code = lone[0].charCodeAt(0).toString(16);
    throw new PyError("UnicodeEncodeError", `'utf-8' codec can't encode character '\\u${code}' in position ${position}: surrogates not allowed`);
  }
  return Buffer.from(text, "utf8");
}

function loadManifest(target) {
  target = resolvePath(target);
  return loadManifestData(readManifest(target), target, { includeManifest: true });
}

function loadHtmlFiles(sources) {
  if (!sources.length) throw valueError("폴더에서 안을 찾을 수 없습니다 HTML");
  sources = sources.map(resolvePath);
  const anchor = joinPath(parentOf(sources[0]), ".jstyle-explorer-input.json");
  const raw = new Map([["candidates", sources.map((source) => new Map([["source", source]]))]]);
  return loadManifestData(raw, anchor, { includeManifest: false });
}

const HTML_SUFFIXES = [".html", ".htm"];

function comparePaths(a, b) {
  return WINDOWS ? compareCodePoints(a.toLowerCase(), b.toLowerCase()) : compareCodePoints(a, b);
}

function loadInput(source) {
  const sources = Array.isArray(source) ? source : [source];
  if (sources.length > 1) {
    if (sources.some((item) => !HTML_SUFFIXES.includes(suffixOf(item).toLowerCase()))) throw valueError("여러 입력은 모두 다음이어야 합니다: HTML 파일");
    return loadHtmlFiles(sources);
  }
  const target = resolvePath(sources[0]);
  if (isDirectory(target)) {
    const manifest = joinPath(target, "manifest.json");
    if (isFile(manifest)) return loadManifest(manifest);
    const pages = wrapFs(() => fs.readdirSync(target))
      .map((name) => joinPath(target, name))
      .filter((item) => isFile(item) && HTML_SUFFIXES.includes(suffixOf(item).toLowerCase()) && nameOf(item).toLowerCase() !== "style-explorer.html")
      .sort(comparePaths);
    return loadHtmlFiles(pages);
  }
  if (nameOf(target).toLowerCase() === "manifest.json") return loadManifest(target);
  if (suffixOf(target).toLowerCase() === ".json") return loadManifest(target);
  if (HTML_SUFFIXES.includes(suffixOf(target).toLowerCase())) return loadHtmlFiles([target]);
  throw valueError(`디자인 안 폴더, HTML 파일 또는 manifest.json을 입력해야 합니다: ${target}`);
}

function countOf(text, part) {
  return text.split(part).length - 1;
}

// Python text files translate "\n" to os.linesep when they are written.
const platformText = (text) => (WINDOWS ? text.replace(/\n/g, "\r\n") : text);

export function build(source, output, { force = false, stderr = process.stderr } = {}) {
  output = resolvePath(output);
  const [data, inputs] = loadInput(source);
  if (inputs.has(output) || isRelativeTo(output, SKILL_ROOT)) throw valueError("출력으로 입력을 덮어쓸 수 없습니다. 스킬 설치 폴더에도 쓸 수 없습니다.");
  if (exists(output) && !force) {
    throw new PyError("FileExistsError", `출력 파일이 이미 있습니다: ${output}. 덮어쓰려면 --force를 더하고, 기존 파일을 유지하려면 --output으로 다른 경로를 지정하세요`);
  }
  const template = embedLocalFiles(readText(TEMPLATE), parentOf(TEMPLATE), inputs);
  const skillFile = joinPath(SKILL_ROOT, "SKILL.md");
  const skill = isFile(skillFile) ? readText(skillFile) : "";
  data.edition = new RegExp(`(?:^|(?<=\\n))name:[${S}]*jstyle-pro[${S}]*(?=\\n|$)`, "u").test(skill) ? "pro" : "open";
  if (countOf(template, MARKER) !== 1) throw valueError("템플릿 데이터 입구가 없거나 겹칩니다");
  if (countOf(template, CONNECT_CSP) !== 1) throw valueError("템플릿 연결 정책 입구가 없거나 겹칩니다");
  const origins = new Set();
  for (const candidate of data.candidates) {
    if (candidate.kind !== "url") continue;
    const parts = urlsplit(candidate.content);
    // Browsers reject IPv6 literals in CSP source lists; probe their loopback alias.
    const host = parts.hostname === "::1" ? "localhost" : parts.hostname.toLowerCase();
    const port = parts.port !== null ? `:${parts.port}` : "";
    origins.add(`${parts.scheme}://${host}${port}`);
  }
  // 'self' lets the served page post the picked direction back to jstyle serve.
  const connectCsp = ["connect-src 'self'", ...[...origins].sort(compareCodePoints)].join(" ");
  // A closing script tag in metadata or a nested candidate cannot escape the container.
  const payload = jsonDumps(data).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
  const page = template.split(CONNECT_CSP).join(connectCsp).split(MARKER).join(payload);
  wrapFs(() => fs.mkdirSync(parentOf(output), { recursive: true }));
  if (force) {
    const temp = joinPath(parentOf(output), `tmp${Math.random().toString(36).slice(2, 10)}`);
    try {
      wrapFs(() => fs.writeFileSync(temp, "", { flag: "wx" }));
      const bytes = encodeUtf8(platformText(page));
      wrapFs(() => fs.writeFileSync(temp, bytes));
      wrapFs(() => fs.renameSync(temp, output));
    } finally {
      if (exists(temp)) fs.unlinkSync(temp);
    }
  } else {
    const handle = wrapFs(() => fs.openSync(output, "wx"));
    try {
      wrapFs(() => fs.writeSync(handle, encodeUtf8(platformText(page))));
    } finally {
      fs.closeSync(handle);
    }
  }
  if (origins.size && !("serve" in data)) {
    stderr.write(platformText("안내: 로컬 URL을 쓰는 안이 있습니다. manifest의 serve에 실행 방법을 적으면 나중에 비교 화면을 다시 열기 쉽습니다.\n"));
  }
  return { output, candidates: data.candidates.length, fingerprint: data.fingerprint, bytes: fs.statSync(output).size };
}

const usageLine = (prog) => `usage: ${prog} [-h] [--output OUTPUT] [--force] inputs [inputs ...]`;
const helpText = (prog, command) => `${usageLine(prog)}

디자인 안을 오프라인 비교 화면으로 모읍니다

positional arguments:
  inputs           비교할 폴더, HTML 파일 또는 manifest.json

options:
  -h, --help       show this help message and exit
  --output OUTPUT  만들 HTML 경로. 기본은 입력 옆의 style-explorer.html입니다.
  --force          이미 있는 출력 파일 덮어쓰기

사용법:
  ${command} <비교할 파일 폴더>
  ${command} a.html b.html c.html
  ${command} manifest.json
기본 출력은 입력 옆 style-explorer.html입니다. --force는 덮어쓰기, --output은 다른 경로입니다.

가장 작은 manifest:
  {"candidates": [{"source": "a.html"}, {"source": "b.html"}]}
source는 필수입니다. 이름은 HTML title이나 파일 이름을 씁니다.
concept/typography/palette/traits는 설명을 더하며 비우면 보이지 않습니다.

선택 필드:
  schemaVersion: 기본 1
  lang: ko 또는 en. 비교 도구의 언어이며 기본은 브라우저 언어입니다.
  round: 복사 문구에 들어갈 회차
  nativeViewport: 1920x1080, 1920×1080 또는 {"width":1920,"height":1080}
    전체나 개별 안에 둘 수 있습니다. 기본 desktop1280×900, mobile390×844입니다.
  kind: html, image(PNG/JPEG/WebP), url. url은 source 대신 url을 씁니다.
    localhost, 127.0.0.1, ::1의 개발 서버만 받을 수 있습니다.
  serve: {"command":"실행 명령", "cwd":"프로젝트 절대 경로", "url":"서비스 주소"}
  interactive: 움직이는 단일 HTML. 스크립트는 안에 넣고 외부 통신·파일을 읽지 않습니다.
    저장소는 닫은 뒤 비우며 alert/confirm 대신 페이지 안 대화상자를 씁니다.
  baseline: 기존 화면을 첫 항목으로 보입니다. 한 회차에 최대 하나입니다.
  screens: 페이지 이름 배열. 있으면 행=페이지, 열=안인 matrix가 됩니다.
    안마다 screens에 {"페이지": {source 등 칸 필드}}를 두고 안 단위 source/url/kind/interactive는 쓰지 않습니다.
    빈 칸은 허용하며 페이지 6개, 칸 24개, 이름 40자까지입니다.

source는 manifest 폴더를 기준으로 읽으며 이미지·글꼴·영상·CSS·스크립트는 참조한 파일 기준입니다.
로컬 절대 경로와 폴더 밖 파일도 안에 넣을 수 있습니다. 네트워크 파일은 받지 않습니다.
파일마다 최대 20 MiB, 전체 최대 100 MiB입니다. head가 없으면 보완합니다.
정지 HTML은 스크립트 없이 내용이 보여야 합니다. img srcset은 src 또는 가장 넓은 한 장만 씁니다.
iframe/object/embed/picture source 대신 로컬 img 한 장이나 스크린샷을 씁니다.
id는 소문자·숫자·하이픈·밑줄로 적고 겹치지 않습니다. palette는 색 값 배열을 권합니다.

Node 22 이상이 필요합니다. 스킬 설치 폴더에는 결과를 쓰지 않습니다.
스킬을 바꿔도 이미 만든 비교 화면은 바뀌지 않습니다. 원래 manifest로 --force를 실행합니다.
모든 입력 문제를 한 번에 알리며 실패하면 기존 결과를 고치지 않습니다.
성공은 output/candidates/fingerprint/bytes가 담긴 JSON 한 줄입니다.
`;

const CLI = {
  options: [
    { flags: ["-h", "--help"], action: "help" },
    { flags: ["--output"], dest: "output", action: "store" },
    { flags: ["--force"], dest: "force", action: "store_true" },
  ],
  positional: { dest: "inputs", nargs: "+" },
};

function writeLine(stream, text) {
  stream.write(platformText(text + "\n"));
}

// style-explorer.html beside the first input, or inside it when it is a folder.
export function defaultOutput(inputs) {
  const first = resolvePath(inputs[0]);
  return joinPath(isDirectory(first) ? first : parentOf(first), "style-explorer.html");
}

// prog and command name the caller in usage text; onBuilt receives the build result.
export function main(argv = process.argv.slice(2), { prog = "build_explorer.mjs", command = "node build_explorer.mjs", onBuilt } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 22) {
    writeLine(process.stderr, "Node 22 이상이 필요합니다");
    return 2;
  }
  let args;
  try {
    args = parseCli(argv, CLI);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(platformText(`${usageLine(prog)}\n${prog}: error: ${error.message}\n`));
    return 2;
  }
  if (args.help) {
    process.stdout.write(platformText(helpText(prog, command)));
    return 0;
  }
  const output = args.output ?? defaultOutput(args.inputs);
  try {
    const result = build(args.inputs, output, { force: args.force });
    writeLine(process.stdout, jsonDumps(result));
    onBuilt?.(result);
    return 0;
  } catch (error) {
    const caught = fromNodeError(error);
    if (isValueError(caught) || isOSError(caught) || isTypeError(caught)) {
      writeLine(process.stderr, `비교 화면을 만들지 못했습니다: ${caught.message}`);
      return 1;
    }
    throw error;
  }
}

if (process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}

export { PathSet, resolvePath };
