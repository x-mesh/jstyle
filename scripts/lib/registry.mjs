// Running jstyle servers leave one record each in ~/.jstyle/servers so that
// `jstyle ps` can list them (and give back their URLs) and `jstyle stop` can
// end them. A record goes away when its server exits; a record whose process
// is gone is pruned on the next listing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function jstyleHome() {
  return process.env.JSTYLE_HOME || path.join(os.homedir(), ".jstyle");
}

export function registryDir() {
  return path.join(jstyleHome(), "servers");
}

const recordFile = (pid) => path.join(registryDir(), `${pid}.json`);

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

// Records hold URLs with tokens, so only the owner may read them.
export function writeRecord(record) {
  const dir = registryDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = recordFile(record.pid);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function removeRecord(pid) {
  try {
    fs.unlinkSync(recordFile(pid));
  } catch {
    // Already gone.
  }
}

export function listRecords() {
  let names;
  try {
    names = fs.readdirSync(registryDir());
  } catch {
    return [];
  }
  const records = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    const file = path.join(registryDir(), name);
    let record;
    try {
      record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (!Number.isInteger(record?.pid) || !isAlive(record.pid)) {
      removeRecord(Number(name.slice(0, -5)));
      continue;
    }
    records.push(record);
  }
  return records.sort((a, b) => a.port - b.port);
}
