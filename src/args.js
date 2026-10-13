import { parseArgs as nodeParseArgs } from "node:util";
import { stdin } from "node:process";
import { isJsonMode } from "./output.js";

const GLOBAL_OPTIONS = {
  key: { type: "string", short: "k" },
  "base-url": { type: "string" },
  referer: { type: "string" },
  title: { type: "string" },
  categories: { type: "string" },
  json: { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  help: { type: "boolean", short: "h" },
};

export function parseArgs(argv, options = {}) {
  const merged = { ...GLOBAL_OPTIONS, ...options };
  return nodeParseArgs({
    args: argv,
    options: merged,
    allowPositionals: true,
    strict: true,
  });
}

// parseArgs yields strings; a bare Number() turns a typo into NaN, which
// JSON.stringify serializes as null: an API request that silently means
// something else. Fail on the CLI instead.
export function numberOption(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (String(value).trim() === "" || !Number.isFinite(n)) {
    throw new Error(`Invalid number for ${flag}: "${value}"`);
  }
  return n;
}

export const PAGINATION_OPTIONS = {
  offset: { type: "string" },
  limit: { type: "string" },
};

export function paginationQuery(values) {
  const query = {};
  if (values.offset) query.offset = values.offset;
  if (values.limit) query.limit = values.limit;
  return query;
}

export function authFromValues(values) {
  const out = {};
  if (values.key) out.key = values.key;
  if (values["base-url"]) out.baseUrl = values["base-url"];
  if (values.referer) out.referer = values.referer;
  if (values.title) out.title = values.title;
  if (values.categories) out.categories = values.categories;
  return out;
}

export async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data.trim() || null;
}

export function shouldStream(values) {
  return (
    values.stream || (!values["no-stream"] && !values.raw && !isJsonMode() && process.stdout.isTTY)
  );
}

// JSON from an inline string or `@file`. Errors name the flag.
export async function loadJson(value, flag) {
  if (value == null) return undefined;
  const text = value.startsWith("@")
    ? await (async () => {
        const { readFile } = await import("node:fs/promises");
        return readFile(value.slice(1), "utf8");
      })()
    : value;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON for ${flag}: ${err.message}`);
  }
}

// Request fields shared by inference endpoints. session_id / user / trace are
// on every one; service_tier only on chat, messages and responses (media
// commands use MEDIA_FIELD_OPTIONS below).
export const REQUEST_FIELD_OPTIONS = {
  "session-id": { type: "string" },
  user: { type: "string" },
  trace: { type: "string" },
  "service-tier": { type: "string" },
};

export const REQUEST_FIELD_HELP = `      --session-id <id>    Group related requests into one session (max 256 chars)
      --user <id>          Your end-user id (abuse tracking, per-user analytics)
      --trace <json|@file> Observability trace: trace_id, trace_name, span_name,
                           generation_name, parent_span_id
      --service-tier <t>   auto | default | fast | flex | priority | scale | ultrafast
`;

export async function applyRequestFields(body, values) {
  if (values["session-id"]) body.session_id = values["session-id"];
  if (values.user) body.user = values.user;
  if (values.trace) body.trace = await loadJson(values.trace, "--trace");
  if (values["service-tier"]) body.service_tier = values["service-tier"];
  return body;
}

// service_tier is not part of the media request schemas (images, videos,
// speech, transcription, embeddings, rerank), so those commands drop it.
export const MEDIA_FIELD_OPTIONS = Object.fromEntries(
  Object.entries(REQUEST_FIELD_OPTIONS).filter(([name]) => name !== "service-tier"),
);
export const MEDIA_FIELD_HELP = REQUEST_FIELD_HELP.replace(/^.*--service-tier.*\n/m, "");
