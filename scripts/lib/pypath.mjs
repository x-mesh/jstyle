// pathlib.Path behavior shared by the Python tool ports.
import fs from "node:fs";
import path from "node:path";

export const WINDOWS = process.platform === "win32";

export function isAbsolutePath(text) {
  if (!WINDOWS) return text.startsWith("/");
  return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.test(text);
}

export function joinPath(base, rel) {
  if (WINDOWS) return path.win32.resolve(base, rel);
  return rel.startsWith("/") ? rel : base.replace(/\/+$/, "") + "/" + rel;
}

const lstat = (target) => {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
};

// os.path.realpath(strict=False): resolve symlinks component by component, so
// "link/.." follows the link before going up, and keep missing parts as text.
export function resolvePath(input) {
  const text = String(input);
  if (WINDOWS) {
    let current = path.win32.resolve(text);
    const rest = [];
    for (;;) {
      try {
        return path.win32.join(fs.realpathSync.native(current), ...rest.reverse());
      } catch {
        const parent = path.win32.dirname(current);
        if (parent === current) return path.win32.join(current, ...rest.reverse());
        rest.push(path.win32.basename(current));
        current = parent;
      }
    }
  }
  let resolved = text.startsWith("/") ? "/" : fs.realpathSync(process.cwd());
  const pending = text.split("/").reverse();
  let links = 0;
  while (pending.length) {
    const part = pending.pop();
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved = path.posix.dirname(resolved);
      continue;
    }
    const next = resolved === "/" ? "/" + part : resolved + "/" + part;
    const info = lstat(next);
    if (!info || !info.isSymbolicLink() || links > 40) {
      resolved = next;
      continue;
    }
    links += 1;
    const target = fs.readlinkSync(next);
    if (target.startsWith("/")) resolved = "/";
    pending.push(...target.split("/").reverse());
  }
  return resolved;
}

// str(PurePath(text)): collapse repeated separators, drop "." parts and the
// trailing separator, and print "." for an empty path.
export function pathStr(text) {
  if (WINDOWS) return path.win32.normalize(text || ".").replace(/\\$/, "") || ".";
  const leading = /^\/\/(?!\/)/.test(text) ? "//" : text.startsWith("/") ? "/" : "";
  const parts = text.split("/").filter((part) => part !== "" && part !== ".");
  return leading + parts.join("/") || (leading || ".");
}

