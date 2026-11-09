// A hub saves the projects it serves, so a restarted hub on the same address
// brings them back under the same /<slug>/ addresses. Each address has its own
// file: only the process that holds that address writes it.
import fs from "node:fs";
import path from "node:path";

import { jstyleHome } from "./registry.mjs";

const SCHEMA = 1;
export const MAX_PROJECTS = 50;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD = new Set(["0.0.0.0", "::", ""]);

export function hubStoreFile(host, port) {
  const label = LOOPBACK.has(host) ? "loopback" : WILDCARD.has(host) ? "any" : String(host).replace(/[^A-Za-z0-9.-]/g, "_");
  return path.join(jstyleHome(), "hubs", `${label}-${port}.json`);
}

// Entries that do not look like ones this code wrote are skipped, not trusted.
export function readHubStore(file) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error(`저장된 프로젝트 목록을 읽지 못했습니다(${file}): ${error.message}`);
  }
  if (data?.schema !== SCHEMA || !Array.isArray(data.projects)) return [];
  return data.projects.filter((p) => typeof p?.slug === "string" && typeof p.root === "string" && path.isAbsolute(p.root));
}

export function writeHubStore(file, projects) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schema: SCHEMA, projects }, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}
