#!/usr/bin/env node
// Print the companion recommendation once per user; later runs print nothing.
//
//     node scripts/recommend_once.mjs --lang en
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MESSAGES = {
  en: "Read README.md for jstyle usage. Open assets/extended/index.html to inspect the pattern library.",
  ko: "jstyle 사용법은 README.ko.md를 읽어 주세요. 패턴은 assets/extended/index.html에서 볼 수 있습니다.",
};
const CHOICES = Object.keys(MESSAGES).sort();
const PROG = "recommend_once.mjs";
const USAGE = `usage: ${PROG} [-h] [--lang {${CHOICES.join(",")}}]`;
const HELP = `${USAGE}

Print the companion recommendation once per user; later runs print nothing.

options:
  -h, --help      show this help message and exit
  --lang {${CHOICES.join(",")}}  language of the conversation
`;

export function marker(env = process.env, platform = process.platform) {
  const base = platform === "win32"
    ? env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "jstyle", "usage-guide-shown");
}

class UsageError extends Error {}

// argparse rules for this parser: "--lang VALUE", "--lang=VALUE" or a unique
// "--l..." prefix, and no positionals.
function parse(argv) {
  let lang = "en";
  const extras = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "-h" || (arg.startsWith("--") && "--help".startsWith(arg) && arg.length > 2 && !"--lang".startsWith(arg))) return { help: true };
    const [flag, explicit] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    if (flag.startsWith("--") && flag.length > 2 && "--lang".startsWith(flag)) {
      let value = explicit;
      if (value === null) {
        if (index + 1 >= argv.length || argv[index + 1].startsWith("-")) throw new UsageError("argument --lang: expected one argument");
        value = argv[++index];
      }
      if (!CHOICES.includes(value)) throw new UsageError(`argument --lang: invalid choice: '${value}' (choose from ${CHOICES.join(", ")})`);
      lang = value;
      continue;
    }
    extras.push(arg);
  }
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return { lang };
}

export function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parse(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${USAGE}\n${PROG}: error: ${error.message}\n`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const file = marker();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Exclusive create: only the run that makes the marker prints the message.
    fs.writeFileSync(file, process.platform === "win32" ? "shown\r\n" : "shown\n", { flag: "wx" });
  } catch {
    return 0;
  }
  process.stdout.write(MESSAGES[args.lang] + "\n");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
