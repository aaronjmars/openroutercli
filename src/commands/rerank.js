import { stdin } from "node:process";
import {
  parseArgs,
  authFromValues,
  numberOption,
  loadJson,
  applyRequestFields,
  MEDIA_FIELD_HELP,
  MEDIA_FIELD_OPTIONS,
} from "../args.js";
import { api } from "../api.js";
import { mediaUrl } from "../media.js";
import { c, outln, printResult } from "../output.js";

const HELP = `Usage: openrouter rerank --model <id> --query <q> [doc...] [options]

Rerank documents against a query.

Options:
  -m, --model <id>      Reranking model (required)
      --query <text>    Query string (required)
  -d, --doc <text>      Document (repeatable). Or pass docs as positionals.
      --docs-file <p>   Read docs from file (one per line). - for stdin.
      --image-doc <url|path> Image document (repeatable, multimodal models);
                        local files are sent as data URLs
      --top-n <n>       Return only the top N
      --provider <json|@file>
      --extra <json|@file> Extra fields merged into the body (last)
${MEDIA_FIELD_HELP}`;

async function readDocsFromStdin() {
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function rerankCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    query: { type: "string" },
    doc: { type: "string", short: "d", multiple: true },
    "docs-file": { type: "string" },
    "image-doc": { type: "string", multiple: true },
    "top-n": { type: "string" },
    provider: { type: "string" },
    extra: { type: "string" },
    ...MEDIA_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error("--model is required");
  if (!values.query) throw new Error("--query is required");

  let docs = [...(values.doc || []), ...positionals];
  if (values["docs-file"]) {
    if (values["docs-file"] === "-") docs = docs.concat(await readDocsFromStdin());
    else {
      const { readFile } = await import("node:fs/promises");
      const text = await readFile(values["docs-file"], "utf8");
      docs = docs.concat(
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
    }
  }
  for (const img of values["image-doc"] || []) docs.push({ image: await mediaUrl(img) });
  if (!docs.length)
    throw new Error("No documents. Pass via positionals, --doc, --docs-file or --image-doc.");

  const body = {
    model: values.model,
    query: values.query,
    documents: docs,
  };
  if (values["top-n"]) body.top_n = numberOption(values["top-n"], "--top-n");
  if (values.provider) body.provider = await loadJson(values.provider, "--provider");
  await applyRequestFields(body, values);
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

  const data = await api("POST", "/rerank", {
    auth: authFromValues(values),
    body,
  });
  printResult(data, () => {
    const results = data.results || data.data || [];
    for (const r of results) {
      const idx = r.index;
      const score = r.relevance_score ?? r.score;
      const doc = docs[idx];
      const text =
        (r.document && r.document.text) ||
        (typeof doc === "string" ? doc : doc?.text || (doc?.image ? "[image]" : ""));
      outln(`${c.bold(score?.toFixed?.(4) ?? score)}  ${c.dim(`#${idx}`)}  ${text.slice(0, 120)}`);
    }
  });
  return 0;
}
