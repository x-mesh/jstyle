// Runs one build_explorer.mjs call described on stdin for tests/node_builder.py.
import { PyError } from "../scripts/lib/pycompat.mjs";
import { MARKER, PREVIEW_CSP, PathSet, TEMPLATE, build, limits, prepareHtml, readAsset } from "../scripts/build_explorer.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
Object.assign(limits, request.limits ?? {});

const calls = {
  constants: () => ({ TEMPLATE, MARKER, PREVIEW_CSP }),
  build: ({ source, output, force }) => build(source, output, { force }),
  prepare_html: ({ path, interactive, used }) => {
    const set = new PathSet(used ?? []);
    return { content: prepareHtml(path, interactive, set), used: set.values() };
  },
  read_asset: ({ path, used }) => {
    const set = new PathSet(used);
    return { data: readAsset(path, set).toString("base64"), used: set.values() };
  },
};

try {
  process.stdout.write(JSON.stringify({ result: calls[request.call](request) }));
} catch (error) {
  if (!(error instanceof PyError)) throw error;
  process.stdout.write(JSON.stringify({ error: { type: error.type, message: error.message, problems: error.problems ?? null } }));
}
