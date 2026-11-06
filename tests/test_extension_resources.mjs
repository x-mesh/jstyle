// The skill stays usable after relocation: links resolve inside the folder,
// packaged text has no Han characters, and the library page's links work.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { HTMLParser } from "../scripts/lib/html-parser.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const inside = (target) => {
  const relative = path.relative(ROOT, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

test("skill references resolve without installation paths", () => {
  const extended = path.join(ROOT, "references", "extended");
  const sources = [path.join(ROOT, "SKILL.md"), ...fs.readdirSync(extended).filter((name) => name.endsWith(".md")).sort().map((name) => path.join(extended, name))];
  for (const source of sources) {
    for (const [, target] of fs.readFileSync(source, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      if (target.includes("://")) continue;
      const resolved = fs.realpathSync.native(path.resolve(path.dirname(source), target.split("#")[0]));
      assert.ok(inside(resolved), `${path.basename(source)}: ${target}`);
      assert.ok(fs.statSync(resolved).isFile(), `${path.basename(source)}: ${target}`);
    }
  }
});

// Mirrors Path.glob for the patterns package.json uses: "dir/", "dir/*.ext" or a file.
function packaged() {
  const { files } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const out = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.add(full);
    }
  };
  for (const pattern of files) {
    const star = pattern.indexOf("*");
    if (star < 0) {
      const target = path.join(ROOT, pattern);
      if (!fs.existsSync(target)) continue;
      if (fs.statSync(target).isDirectory()) walk(target);
      else out.add(target);
      continue;
    }
    const dir = path.join(ROOT, path.dirname(pattern));
    const suffix = pattern.slice(star + 1);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith(suffix) && fs.statSync(full).isFile()) out.add(full);
    }
  }
  return [...out].sort();
}

test("packaged text has no Han characters", () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const file of packaged()) {
    let text;
    try {
      text = decoder.decode(fs.readFileSync(file));
    } catch {
      continue;
    }
    assert.ok(!/[\u3400-\u4dbf\u4e00-\u9fff]/.test(text), `Use Korean or English in packaged text: ${path.relative(ROOT, file)}`);
  }
});

test("library resources and navigation resolve", () => {
  const source = path.join(ROOT, "assets", "extended", "index.html");
  const targets = [];
  const ids = new Set();
  const parser = new (class extends HTMLParser {
    handleStarttag(tag, attrs) {
      const values = new Map(attrs);
      if (values.has("id")) ids.add(values.get("id"));
      for (const key of ["href", "src"]) if (values.has(key)) targets.push(values.get(key));
    }
  })();
  parser.feed(fs.readFileSync(source, "utf8"));
  for (const target of targets) {
    if (target.startsWith("#")) {
      assert.ok(ids.has(target.slice(1)), target);
      continue;
    }
    assert.ok(!target.includes("://"), target);
    const resolved = fs.realpathSync.native(path.resolve(path.dirname(source), target));
    assert.ok(inside(resolved), target);
    assert.ok(fs.statSync(resolved).isFile(), target);
  }
});
