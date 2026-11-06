// The argparse rules the Python tools relied on, so usage errors, exit
// codes and option prefixes keep working after the port: exact option, then a
// unique "--prefix", then negative numbers and strings with spaces count as
// positionals; one positional run is consumed and later ones are extras.
import { pyFloat, pyReprString } from "./pycompat.mjs";

export class UsageError extends Error {}

// spec.options: [{ flags, dest, action: "help" | "store_true" | "store" | "append", type }]
// spec.positional: { dest, nargs: "+" | "?" }
export function parseArgs(argv, spec) {
  const longFlags = spec.options.flatMap((option) => option.flags.filter((flag) => flag.startsWith("--")));
  const byFlag = new Map(spec.options.flatMap((option) => option.flags.map((flag) => [flag, option])));
  const result = { [spec.positional.dest]: spec.positional.nargs === "+" ? [] : null };
  for (const option of spec.options) {
    if (option.action === "store_true") result[option.dest] = false;
    if (option.action === "append") result[option.dest] = [];
    if (option.action === "store") result[option.dest] = null;
  }

  const classify = (arg) => {
    if (!arg.startsWith("-") || arg === "-") return { kind: "positional" };
    const equals = arg.indexOf("=");
    const [flag, explicit] = equals >= 0 && arg.startsWith("--") ? [arg.slice(0, equals), arg.slice(equals + 1)] : [arg, null];
    if (byFlag.has(flag)) return { kind: "option", option: byFlag.get(flag), flag, explicit };
    if (flag.startsWith("--")) {
      const matches = longFlags.filter((name) => name.startsWith(flag));
      if (matches.length > 1) throw new UsageError(`ambiguous option: ${flag} could match ${matches.join(", ")}`);
      if (matches.length === 1) return { kind: "option", option: byFlag.get(matches[0]), flag: matches[0], explicit };
    }
    if (/^-\d+$|^-\d*\.\d+$/.test(arg) || arg.includes(" ")) return { kind: "positional" };
    return { kind: "unknown" };
  };

  const convert = (option, flag, text) => {
    if (option.type !== "float") return text;
    try {
      return pyFloat(text);
    } catch {
      throw new UsageError(`argument ${option.flags.join("/")}: invalid float value: ${pyReprString(text)}`);
    }
  };

  const extras = [];
  let run = "before";
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      for (const rest of argv.slice(index + 1)) (run === "after" ? extras : positionals).push(rest);
      break;
    }
    const kind = classify(arg);
    if (kind.kind === "positional") {
      if (run === "after") extras.push(arg);
      else {
        positionals.push(arg);
        run = "inside";
      }
      continue;
    }
    if (run === "inside") run = "after";
    if (kind.kind === "unknown") {
      extras.push(arg);
      continue;
    }
    const { option, flag, explicit } = kind;
    const name = option.flags.join("/");
    if (option.action === "help") return { help: true };
    if (option.action === "store_true") {
      if (explicit !== null) throw new UsageError(`argument ${name}: ignored explicit argument ${pyReprString(explicit)}`);
      result[option.dest] = true;
      continue;
    }
    let value;
    if (explicit !== null) value = explicit;
    else if (index + 1 < argv.length && argv[index + 1] !== "--" && classify(argv[index + 1]).kind === "positional") value = argv[++index];
    else throw new UsageError(`argument ${name}: expected one argument`);
    value = convert(option, flag, value);
    if (option.action === "append") result[option.dest].push(value);
    else result[option.dest] = value;
  }
  if (spec.positional.nargs === "+") {
    if (!positionals.length) throw new UsageError(`the following arguments are required: ${spec.positional.dest}`);
    result[spec.positional.dest] = positionals;
  } else {
    result[spec.positional.dest] = positionals[0] ?? null;
    extras.unshift(...positionals.slice(1));
  }
  if (extras.length) throw new UsageError(`unrecognized arguments: ${extras.join(" ")}`);
  return result;
}
