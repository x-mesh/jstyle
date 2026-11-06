// Python 3.13 semantics that build_explorer depends on and JavaScript does not
// share: str whitespace, json number/key handling and error messages, urllib
// parsing, and OSError text. The Node builder must produce the same manifest
// errors, payload bytes and fingerprints as the Python builder it replaces.
import { constants as osConstants } from "node:os";
import { isIP } from "node:net";

// Characters for which str.isspace() is true. JavaScript's \s and trim() add
// U+FEFF and miss U+001C-U+001F and U+0085.
export const PY_SPACE = "\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0                　";
export const PY_SPACE_CLASS = "\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export function isPySpace(char) {
  return char !== "" && PY_SPACE.includes(char);
}

export function pyStrip(text) {
  let start = 0;
  let end = text.length;
  while (start < end && PY_SPACE.includes(text[start])) start += 1;
  while (end > start && PY_SPACE.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

export function pyLstrip(text, chars) {
  let start = 0;
  while (start < text.length && chars.includes(text[start])) start += 1;
  return text.slice(start);
}

const SPLIT = new RegExp(`[${PY_SPACE_CLASS}]+`, "u");

export function pySplit(text) {
  return pyStrip(text).split(SPLIT).filter(Boolean);
}

// Python orders str by code point; JavaScript's < compares UTF-16 units.
export function compareCodePoints(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const diff = left[index].codePointAt(0) - right[index].codePointAt(0);
    if (diff) return diff;
  }
  return left.length - right.length;
}

export function codePointLength(text) {
  let length = 0;
  for (const _ of text) length += 1;
  return length;
}

export class PyError extends Error {
  constructor(type, message, extra = {}) {
    super(message);
    this.type = type;
    Object.assign(this, extra);
  }
}

const VALUE_ERRORS = new Set(["ValueError", "JSONDecodeError", "UnicodeDecodeError", "UnicodeEncodeError", "ManifestError"]);
const OS_ERRORS = new Set(["OSError", "FileExistsError", "FileNotFoundError", "IsADirectoryError", "NotADirectoryError", "PermissionError"]);

export const isValueError = (error) => error instanceof PyError && VALUE_ERRORS.has(error.type);
export const isOSError = (error) => error instanceof PyError && OS_ERRORS.has(error.type);
export const isTypeError = (error) => error instanceof PyError && error.type === "TypeError";

export const valueError = (message) => new PyError("ValueError", message);

const STRERROR = {
  ENOENT: ["FileNotFoundError", "No such file or directory"],
  EEXIST: ["FileExistsError", "File exists"],
  EISDIR: ["IsADirectoryError", "Is a directory"],
  ENOTDIR: ["NotADirectoryError", "Not a directory"],
  EACCES: ["PermissionError", "Permission denied"],
  EPERM: ["PermissionError", "Operation not permitted"],
  ENOSPC: ["OSError", "No space left on device"],
  EROFS: ["OSError", "Read-only file system"],
  ENAMETOOLONG: ["OSError", "File name too long"],
  ELOOP: ["OSError", "Too many levels of symbolic links"],
  EBUSY: ["OSError", "Resource busy"],
};

// Node fs errors become the "[Errno N] text: 'path'" form str(OSError) prints.
export function fromNodeError(error) {
  if (error instanceof PyError || !error || typeof error.code !== "string" || !(error.code in osConstants.errno)) {
    if (error && typeof error.code === "string" && error.syscall) {
      return new PyError("OSError", `[Errno ${Math.abs(error.errno ?? 0)}] ${error.message}`);
    }
    return error;
  }
  const [type, text] = STRERROR[error.code] ?? ["OSError", error.code];
  const number = osConstants.errno[error.code];
  const paths = [error.path, error.dest].filter((item) => item !== undefined).map(pyReprString);
  const where = paths.length ? `: ${paths.join(" -> ")}` : "";
  return new PyError(type, `[Errno ${number}] ${text}${where}`);
}

export function wrapFs(action) {
  try {
    return action();
  } catch (error) {
    throw fromNodeError(error);
  }
}

// ---- Python value model for JSON: int -> BigInt, float -> PyFloat, dict -> Map.

export class PyFloat {
  constructor(value) {
    this.value = value;
  }
}

export const isInt = (value) => typeof value === "bigint";
export const isFloat = (value) => value instanceof PyFloat;
export const isDict = (value) => value instanceof Map;
export const isList = Array.isArray;
export const isStr = (value) => typeof value === "string";
export const isBool = (value) => typeof value === "boolean";

export function numberValue(value) {
  if (isInt(value)) return value;
  if (isFloat(value)) return value.value;
  if (isBool(value)) return value ? 1n : 0n;
  return undefined;
}

// Python ==, enough for comparing parsed JSON against literals.
export function pyEquals(a, b) {
  const left = numberValue(a);
  const right = numberValue(b);
  if (left !== undefined && right !== undefined) {
    if (typeof left === "bigint" && typeof right === "bigint") return left === right;
    return Number(left) === Number(right);
  }
  if (isStr(a) || isStr(b)) return a === b;
  if (a === null || b === null) return a === b;
  if (isList(a) && isList(b)) return a.length === b.length && a.every((item, index) => pyEquals(item, b[index]));
  if (isDict(a) && isDict(b)) {
    if (a.size !== b.size) return false;
    for (const [key, value] of a) if (!b.has(key) || !pyEquals(value, b.get(key))) return false;
    return true;
  }
  return false;
}

export function floatRepr(value) {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const [mantissa, exponentText] = value.toExponential().split("e");
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith("-");
  const digits = mantissa.replace("-", "").replace(".", "");
  let text;
  if (exponent >= -4 && exponent < 16) {
    if (exponent >= 0) {
      const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, "0");
      const fraction = digits.slice(exponent + 1);
      text = whole + "." + (fraction || "0");
    } else {
      text = "0." + "0".repeat(-exponent - 1) + digits;
    }
  } else {
    const fraction = digits.slice(1);
    const sign = exponent < 0 ? "-" : "+";
    text = digits[0] + (fraction ? "." + fraction : "") + "e" + sign + String(Math.abs(exponent)).padStart(2, "0");
  }
  return (negative ? "-" : "") + text;
}

// ---- json.loads (CPython 3.13 C scanner messages and positions).

const JSON_WS = " \t\n\r";
const NUMBER = /(-?(?:0|[1-9][0-9]*))(\.[0-9]+)?([eE][-+]?[0-9]+)?/y;
const ESCAPES = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
const INT_MAX_STR_DIGITS = 4300;

function jsonError(message, doc, pos) {
  const lineno = doc.slice(0, pos).split("\n").length;
  const lineStart = pos === 0 ? 0 : doc.lastIndexOf("\n", pos - 1) + 1;
  const colno = codePointLength(doc.slice(lineStart, pos)) + 1;
  const charPos = codePointLength(doc.slice(0, pos));
  return new PyError("JSONDecodeError", `${message}: line ${lineno} column ${colno} (char ${charPos})`, { msg: message, lineno, colno, pos: charPos });
}

class StopScan {
  constructor(index) {
    this.index = index;
  }
}

function hexValue(text) {
  return /^[0-9a-fA-F]{4}$/.test(text) ? parseInt(text, 16) : -1;
}

function scanString(doc, end) {
  const begin = end - 1;
  let out = "";
  for (;;) {
    let next = end;
    let char = "";
    for (; next < doc.length; next += 1) {
      char = doc[next];
      if (char === '"' || char === "\\") break;
      if (char.charCodeAt(0) <= 0x1f) throw jsonError("Invalid control character at", doc, next);
    }
    if (char !== '"' && char !== "\\") throw jsonError("Unterminated string starting at", doc, begin);
    out += doc.slice(end, next);
    next += 1;
    if (char === '"') return [out, next];
    if (next === doc.length) throw jsonError("Unterminated string starting at", doc, begin);
    char = doc[next];
    if (char !== "u") {
      end = next + 1;
      if (!(char in ESCAPES)) throw jsonError("Invalid \\escape", doc, end - 2);
      out += ESCAPES[char];
      continue;
    }
    next += 1;
    end = next + 4;
    if (end >= doc.length) throw jsonError("Invalid \\uXXXX escape", doc, next - 1);
    let code = hexValue(doc.slice(next, end));
    if (code < 0) throw jsonError("Invalid \\uXXXX escape", doc, end - 5);
    next = end;
    if (code >= 0xd800 && code <= 0xdbff && end + 6 < doc.length && doc[next] === "\\" && doc[next + 1] === "u") {
      end += 6;
      const low = hexValue(doc.slice(next + 2, end));
      if (low < 0) throw jsonError("Invalid \\uXXXX escape", doc, end - 5);
      if (low >= 0xdc00 && low <= 0xdfff) code = 0x10000 + (((code - 0xd800) << 10) | (low - 0xdc00));
      else end -= 6;
    }
    out += String.fromCodePoint(code);
  }
}

function skipWs(doc, index) {
  while (index < doc.length && JSON_WS.includes(doc[index])) index += 1;
  return index;
}

function scanOnce(doc, index) {
  if (index >= doc.length) throw new StopScan(index);
  const char = doc[index];
  if (char === '"') return scanString(doc, index + 1);
  if (char === "{") return scanObject(doc, index + 1);
  if (char === "[") return scanArray(doc, index + 1);
  if (char === "n" && doc.startsWith("null", index)) return [null, index + 4];
  if (char === "t" && doc.startsWith("true", index)) return [true, index + 4];
  if (char === "f" && doc.startsWith("false", index)) return [false, index + 5];
  if (char === "N" && doc.startsWith("NaN", index)) return [new PyFloat(NaN), index + 3];
  if (char === "I" && doc.startsWith("Infinity", index)) return [new PyFloat(Infinity), index + 8];
  if (char === "-" && doc.startsWith("-Infinity", index)) return [new PyFloat(-Infinity), index + 9];
  NUMBER.lastIndex = index;
  const match = NUMBER.exec(doc);
  if (!match) throw new StopScan(index);
  const end = index + match[0].length;
  if (match[2] || match[3]) return [new PyFloat(Number(match[0])), end];
  const digits = match[1].replace("-", "");
  if (digits.length > INT_MAX_STR_DIGITS) {
    throw valueError(`Exceeds the limit (${INT_MAX_STR_DIGITS} digits) for integer string conversion: value has ${digits.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  }
  return [BigInt(match[1]), end];
}

function scanObject(doc, index) {
  const result = new Map();
  index = skipWs(doc, index);
  if (index >= doc.length || doc[index] !== "}") {
    for (;;) {
      if (index >= doc.length || doc[index] !== '"') throw jsonError("Expecting property name enclosed in double quotes", doc, index);
      const [key, afterKey] = scanString(doc, index + 1);
      index = skipWs(doc, afterKey);
      if (index >= doc.length || doc[index] !== ":") throw jsonError("Expecting ':' delimiter", doc, index);
      index = skipWs(doc, index + 1);
      const [value, afterValue] = scanOnce(doc, index);
      result.set(key, value);
      index = skipWs(doc, afterValue);
      if (index < doc.length && doc[index] === "}") break;
      if (index >= doc.length || doc[index] !== ",") throw jsonError("Expecting ',' delimiter", doc, index);
      const comma = index;
      index = skipWs(doc, index + 1);
      if (index < doc.length && doc[index] === "}") throw jsonError("Illegal trailing comma before end of object", doc, comma);
    }
  }
  return [result, index + 1];
}

function scanArray(doc, index) {
  const result = [];
  index = skipWs(doc, index);
  if (index >= doc.length || doc[index] !== "]") {
    for (;;) {
      const [value, afterValue] = scanOnce(doc, index);
      result.push(value);
      index = skipWs(doc, afterValue);
      if (index < doc.length && doc[index] === "]") break;
      if (index >= doc.length || doc[index] !== ",") throw jsonError("Expecting ',' delimiter", doc, index);
      const comma = index;
      index = skipWs(doc, index + 1);
      if (index < doc.length && doc[index] === "]") throw jsonError("Illegal trailing comma before end of array", doc, comma);
    }
  }
  return [result, index + 1];
}

export function jsonLoads(doc) {
  if (doc.startsWith("﻿")) throw jsonError("Unexpected UTF-8 BOM (decode using utf-8-sig)", doc, 0);
  let value;
  let end;
  try {
    [value, end] = scanOnce(doc, skipWs(doc, 0));
  } catch (error) {
    if (error instanceof StopScan) throw jsonError("Expecting value", doc, error.index);
    throw error;
  }
  end = skipWs(doc, end);
  if (end !== doc.length) throw jsonError("Extra data", doc, end);
  return value;
}

// ---- json.dumps(ensure_ascii=False).

function encodeString(text) {
  return '"' + text.replace(/[\x00-\x1f\\"]/g, (char) => {
    const known = { "\\": "\\\\", '"': '\\"', "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" }[char];
    return known ?? "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0");
  }) + '"';
}

function floatJson(value) {
  if (Number.isNaN(value)) return "NaN";
  if (value === Infinity) return "Infinity";
  if (value === -Infinity) return "-Infinity";
  return floatRepr(value);
}

export function jsonDumps(value, { sortKeys = false, indent = null, separators = indent === null ? [", ", ": "] : [",", ": "] } = {}) {
  const [itemSep, keySep] = separators;
  // With indent, items go on their own lines; empty containers stay "[]" and "{}".
  const join = (parts, open, close, level) => {
    if (indent === null) return open + parts.join(itemSep) + close;
    const inner = "\n" + " ".repeat(indent * (level + 1));
    return open + inner + parts.join(itemSep + inner) + "\n" + " ".repeat(indent * level) + close;
  };
  const encode = (item, level = 0) => {
    if (item === null || item === undefined) return "null";
    if (item === true) return "true";
    if (item === false) return "false";
    if (isInt(item)) return item.toString();
    if (isFloat(item)) return floatJson(item.value);
    if (typeof item === "number") return Number.isInteger(item) ? String(item) : floatJson(item);
    if (isStr(item)) return encodeString(item);
    if (isList(item)) return item.length ? join(item.map((entry) => encode(entry, level + 1)), "[", "]", level) : "[]";
    const entries = isDict(item) ? [...item] : Object.entries(item);
    if (!entries.length) return "{}";
    if (sortKeys) entries.sort(([a], [b]) => compareCodePoints(a, b));
    return join(entries.map(([key, entry]) => encodeString(key) + keySep + encode(entry, level + 1)), "{", "}", level);
  };
  return encode(value);
}

// ---- round(): CPython rounds the exact binary value half to even.

function exactParts(value) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  const biased = Number((bits >> 52n) & 0x7ffn);
  let mantissa = bits & ((1n << 52n) - 1n);
  if (biased) mantissa |= 1n << 52n;
  return { negative: bits >> 63n === 1n, mantissa, exponent: biased ? biased - 1075 : -1074 };
}

// round(value, digits) for a finite float; digits null gives round(value) as an int.
export function pyRound(value, digits = null) {
  if (!Number.isFinite(value)) {
    if (digits === null) throw valueError(Number.isNaN(value) ? "cannot convert float NaN to integer" : "cannot convert float infinity to integer");
    return value;
  }
  const places = digits ?? 0;
  const { negative, mantissa, exponent } = exactParts(value);
  let numerator = mantissa * 10n ** BigInt(Math.max(places, 0));
  let denominator = 10n ** BigInt(Math.max(-places, 0));
  if (exponent >= 0) numerator <<= BigInt(exponent);
  else denominator <<= BigInt(-exponent);
  let quotient = numerator / denominator;
  const twice = (numerator % denominator) * 2n;
  if (twice > denominator || (twice === denominator && quotient % 2n === 1n)) quotient += 1n;
  if (digits === null) return Number(negative ? -quotient : quotient);
  const rounded = Number(`${negative ? "-" : ""}${quotient}e${-places}`);
  return rounded === 0 && negative ? -0 : rounded;
}

// ---- repr()/str() of parsed JSON values, used in messages.

const NONPRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

export function pyReprString(text) {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = "";
  for (const char of text) {
    if (char === quote || char === "\\") out += "\\" + char;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (char !== " " && NONPRINTABLE.test(char)) {
      const code = char.codePointAt(0);
      if (code < 0x100) out += "\\x" + code.toString(16).padStart(2, "0");
      else if (code < 0x10000) out += "\\u" + code.toString(16).padStart(4, "0");
      else out += "\\U" + code.toString(16).padStart(8, "0");
    } else out += char;
  }
  return quote + out + quote;
}

export function pyRepr(value) {
  if (isStr(value)) return pyReprString(value);
  return pyStr(value);
}

export function pyStr(value) {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (isInt(value)) return value.toString();
  if (typeof value === "number") return String(value);
  if (isFloat(value)) return floatRepr(value.value);
  if (isStr(value)) return value;
  if (isList(value)) return "[" + value.map(pyRepr).join(", ") + "]";
  if (isDict(value)) return "{" + [...value].map(([key, entry]) => pyRepr(key) + ": " + pyRepr(entry)).join(", ") + "}";
  return String(value);
}

// ---- Numbers from text: int() and float() accept any Unicode decimal digit.

const DECIMAL = /\p{Nd}/u;

function digitValue(char) {
  const code = char.codePointAt(0);
  let start = code;
  // Unicode encodes each decimal digit set as a contiguous 0-9 run.
  while (start > code - 9 && DECIMAL.test(String.fromCodePoint(start - 1))) start -= 1;
  return (code - start) % 10;
}

export function asciiDigits(text) {
  return Array.from(text, (char) => (DECIMAL.test(char) && !/[0-9]/.test(char) ? String(digitValue(char)) : char)).join("");
}

const FLOAT_TEXT = /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const FLOAT_SPECIAL = /^[+-]?(?:inf|infinity|nan)$/i;

export function pyFloat(text) {
  const stripped = asciiDigits(pyStrip(text));
  if (FLOAT_SPECIAL.test(stripped)) {
    const negative = stripped.startsWith("-");
    if (/nan/i.test(stripped)) return NaN;
    return negative ? -Infinity : Infinity;
  }
  if (!FLOAT_TEXT.test(stripped)) throw valueError(`could not convert string to float: ${pyReprString(text)}`);
  return Number(stripped.replace(/_/g, ""));
}

// ---- urllib.parse.

const C0_OR_SPACE = Array.from({ length: 0x21 }, (_, code) => String.fromCharCode(code)).join("");
const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

function splitNetloc(url, start) {
  let delim = url.length;
  for (const char of "/?#") {
    const at = url.indexOf(char, start);
    if (at >= 0) delim = Math.min(delim, at);
  }
  return [url.slice(start, delim), url.slice(delim)];
}

function partition(text, separator) {
  const at = text.indexOf(separator);
  return at < 0 ? [text, "", ""] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function rpartition(text, separator) {
  const at = text.lastIndexOf(separator);
  return at < 0 ? ["", "", text] : [text.slice(0, at), separator, text.slice(at + separator.length)];
}

function checkBracketedHost(hostname) {
  if (hostname.startsWith("v")) {
    if (!/^v[a-fA-F0-9]+\.[\s\S]+$/.test(hostname)) throw valueError("IPvFuture address is invalid");
    return;
  }
  const [address] = partition(hostname, "%");
  const kind = isIP(address);
  if (kind === 0) throw valueError(`${pyReprString(hostname)} does not appear to be an IPv4 or IPv6 address`);
  if (kind === 4) throw valueError("An IPv4 address cannot be in brackets");
}

function checkBracketedNetloc(netloc) {
  const [, , hostAndPort] = rpartition(netloc, "@");
  const [before, open, bracketed] = partition(hostAndPort, "[");
  if (open) {
    if (before) throw valueError("Invalid IPv6 URL");
    const [hostname, , port] = partition(bracketed, "]");
    if (port && !port.startsWith(":")) throw valueError("Invalid IPv6 URL");
    checkBracketedHost(hostname);
  }
}

function checkNetloc(netloc) {
  if (!netloc || /^[\x00-\x7f]*$/.test(netloc)) return;
  const stripped = netloc.replaceAll("@", "").replaceAll(":", "").replaceAll("#", "").replaceAll("?", "");
  const normalized = stripped.normalize("NFKC");
  if (stripped === normalized) return;
  for (const char of "/?#@:") {
    if (normalized.includes(char)) {
      throw valueError(`netloc ${pyReprString(netloc)} contains invalid characters under NFKC normalization`);
    }
  }
}

export class SplitResult {
  constructor(scheme, netloc, path, query, fragment) {
    Object.assign(this, { scheme, netloc, path, query, fragment });
  }

  hostinfo() {
    const [, , hostinfo] = rpartition(this.netloc, "@");
    const [, open, bracketed] = partition(hostinfo, "[");
    let hostname;
    let port;
    if (open) {
      let rest;
      [hostname, , rest] = partition(bracketed, "]");
      [, , port] = partition(rest, ":");
    } else {
      [hostname, , port] = partition(hostinfo, ":");
    }
    return [hostname, port || null];
  }

  get hostname() {
    const [hostname] = this.hostinfo();
    if (!hostname) return null;
    const [host, percent, zone] = partition(hostname, "%");
    return host.toLowerCase() + percent + zone;
  }

  get port() {
    let [, port] = this.hostinfo();
    if (port === null) return null;
    if (!/^[0-9]+$/.test(port)) throw valueError(`Port could not be cast to integer value as ${pyReprString(port)}`);
    port = Number(port);
    if (!(port >= 0 && port <= 65535)) throw valueError("Port out of range 0-65535");
    return port;
  }

  userinfo() {
    const [userinfo, has] = rpartition(this.netloc, "@");
    if (!has) return [null, null];
    const [username, hasPassword, password] = partition(userinfo, ":");
    return [username, hasPassword ? password : null];
  }

  get username() {
    return this.userinfo()[0];
  }

  get password() {
    return this.userinfo()[1];
  }
}

export function urlsplit(url) {
  url = pyLstrip(url, C0_OR_SPACE).replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  let query = "";
  let fragment = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z]/.test(url[0]) && SCHEME_CHARS.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    [netloc, url] = splitNetloc(url, 2);
    if ((netloc.includes("[") && !netloc.includes("]")) || (netloc.includes("]") && !netloc.includes("["))) {
      throw valueError("Invalid IPv6 URL");
    }
    if (netloc.includes("[") && netloc.includes("]")) checkBracketedNetloc(netloc);
  }
  if (url.includes("#")) [url, , fragment] = partition(url, "#");
  if (url.includes("?")) [url, , query] = partition(url, "?");
  checkNetloc(netloc);
  return new SplitResult(scheme, netloc, url, query, fragment);
}

const UTF8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

export function unquote(text) {
  if (!text.includes("%")) return text;
  return text.replace(/[\x00-\x7f]+/g, (run) => {
    const bytes = [];
    for (let index = 0; index < run.length; index += 1) {
      if (run[index] === "%" && /^[0-9a-fA-F]{2}$/.test(run.slice(index + 1, index + 3))) {
        bytes.push(parseInt(run.slice(index + 1, index + 3), 16));
        index += 2;
      } else {
        bytes.push(run.charCodeAt(index));
      }
    }
    return UTF8.decode(Uint8Array.from(bytes));
  });
}

// ---- Strict UTF-8 decoding with UnicodeDecodeError text.

function utf8Error(bytes, start, end, reason) {
  const where = end - start === 1
    ? `byte 0x${bytes[start].toString(16).padStart(2, "0")} in position ${start}`
    : `bytes in position ${start}-${end - 1}`;
  return new PyError("UnicodeDecodeError", `'utf-8' codec can't decode ${where}: ${reason}`);
}

export function decodeUtf8(bytes) {
  let index = 0;
  while (index < bytes.length) {
    const first = bytes[index];
    if (first < 0x80) {
      index += 1;
      continue;
    }
    let need;
    let low = 0x80;
    let high = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) need = 1;
    else if (first >= 0xe0 && first <= 0xef) {
      need = 2;
      if (first === 0xe0) low = 0xa0;
      if (first === 0xed) high = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      need = 3;
      if (first === 0xf0) low = 0x90;
      if (first === 0xf4) high = 0x8f;
    } else throw utf8Error(bytes, index, index + 1, "invalid start byte");
    for (let step = 1; step <= need; step += 1) {
      const at = index + step;
      if (at >= bytes.length) throw utf8Error(bytes, index, bytes.length, "unexpected end of data");
      const byte = bytes[at];
      const [min, max] = step === 1 ? [low, high] : [0x80, 0xbf];
      if (byte < min || byte > max) throw utf8Error(bytes, index, at, "invalid continuation byte");
    }
    index += need + 1;
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}

// ---- Small stdlib helpers.

export function shlexQuote(text) {
  if (!text) return "''";
  if (!/[^\w@%+=:,./-]/.test(text)) return text;
  return "'" + text.replaceAll("'", "'\"'\"'") + "'";
}

export function htmlEscape(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

export function universalNewlines(text) {
  return text.replace(/\r\n?/g, "\n");
}
