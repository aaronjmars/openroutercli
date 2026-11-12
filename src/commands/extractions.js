import { parseArgs, authFromValues, loadJson } from "../args.js";
import { api } from "../api.js";
import { mediaUrl } from "../media.js";
import { printResult } from "../output.js";

const HELP = `Usage: openrouter extract [options]
       openrouter extractions [options]     (same command)

Submit an Extractions request (alpha, POST /api/alpha/extractions): a state
string plus typed fields to extract, compute, estimate or forecast, answered
by an extraction-style System One model such as scaledown/extract. The
request shape is alpha and may change.

Field types: text, number, date, time, datetime, duration, list, estimate,
forecast. Which types a model answers is model-specific (400 otherwise).
Launch models:
  cloudflare/clairic        all field types; text plus up to 4 png/jpeg images
                            (no PDFs); the only one returning p_null
  scaledown/extract         text and list fields; text, or one PDF or image
  inception/mercury-decide  text and list fields; text only
scaledown/extract and inception/mercury-decide take no --reference-date.
With one asset and no --state, the request is file-only (state = its key).

Options:
  -m, --model <id>          Model id (required without --body)
      --state <text|@file>  Text to read from (may be empty with --assets)
      --fields <json|@file> Fields object: {"name": {"type": "text", ...}}
      --assets <json|@file> Named files referenced in state or field
                            instructions: {"ref-name": "<local path>"}
                            (png/jpg/jpeg as image, pdf as document).
                            Every name must be referenced.
      --reference-date <YYYY-MM-DD>
                            Anchors dates written without a year
      --body <json|@file>   Fully-formed request body
      --extra <json>        Extra fields merged into the request

Example:
  openrouter extract -m scaledown/extract \\
    --state "Invoice INV-2291 issued 2026-09-02, net 30. Total \\$1080." \\
    --fields '{"invoice":{"type":"text"},"total":{"type":"text"}}'
  openrouter extract -m scaledown/extract --assets '{"doc":"./invoice.pdf"}' \\
    --fields '{"invoice":{"type":"text"}}'
`;

const ASSET_TYPES = {
  "image/png": ["image", "png"],
  "image/jpeg": ["image", "jpeg"],
  "application/pdf": ["document", "pdf"],
};

async function loadState(value) {
  if (value == null) return undefined;
  if (!value.startsWith("@")) return value;
  const { readFile } = await import("node:fs/promises");
  return readFile(value.slice(1), "utf8");
}

async function assetFromPath(name, src) {
  const lower = src.toLowerCase().split(/[?#]/)[0];
  if (/^https?:\/\//i.test(src)) {
    throw new Error(
      `--assets "${name}": the Extractions API only accepts uploaded files. Give a local file (png/jpg/jpeg/pdf), not a URL.`,
    );
  }
  let mime;
  let b64;
  if (lower.endsWith(".pdf")) {
    const { readFile } = await import("node:fs/promises");
    mime = "application/pdf";
    b64 = (await readFile(src)).toString("base64");
  } else {
    const url = await mediaUrl(src);
    [mime, b64] = url.slice(5).split(";base64,");
  }
  const kind = ASSET_TYPES[mime];
  if (!kind) throw new Error(`--assets "${name}": expected png/jpg/jpeg/pdf, got ${mime}`);
  return { type: kind[0], format: kind[1], data_base64: b64 };
}

export async function extractionsCommand(argv) {
  const { values } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    state: { type: "string" },
    fields: { type: "string" },
    assets: { type: "string" },
    "reference-date": { type: "string" },
    body: { type: "string" },
    extra: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let body = values.body ? await loadJson(values.body, "--body") : null;
  if (!body) {
    if (!values.model) throw new Error("--model is required");
    if (values.state === undefined && values.assets === undefined) {
      throw new Error("--state is required (or --assets for a file-only request)");
    }
    if (!values.fields) throw new Error("--fields is required");
    body = {
      model: values.model,
      state: (await loadState(values.state)) ?? "",
      fields: await loadJson(values.fields, "--fields"),
    };
  }
  if (values["reference-date"] !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values["reference-date"])) {
      throw new Error("--reference-date must be YYYY-MM-DD");
    }
    body.reference_date = values["reference-date"];
  }
  if (values.assets !== undefined) {
    const assets = await loadJson(values.assets, "--assets");
    if (!assets || typeof assets !== "object" || Array.isArray(assets)) {
      throw new Error('--assets must be a JSON object like {"ref": "<path>"}');
    }
    body.assets = {};
    for (const [name, src] of Object.entries(assets)) {
      body.assets[name] = await assetFromPath(name, src);
    }
    // File-only request: a state that is exactly the sole asset's key.
    const names = Object.keys(body.assets);
    if (!values.body && values.state === undefined && names.length === 1) body.state = names[0];
  }
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));
  const data = await api("POST", "/extractions", {
    rootPath: "/api/alpha",
    auth: authFromValues(values),
    body,
  });
  printResult(data);
  return 0;
}
