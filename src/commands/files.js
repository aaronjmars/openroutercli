import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table, writeBinaryOutput } from "../output.js";

const HELP = `Usage: openrouter files <subcommand> [options]

Manage files stored on OpenRouter (backing store for file/PDF inputs).

Subcommands:
  list [options]             List uploaded files
  get <id>                   Get one file's metadata
  upload <path> [options]    Upload a file (multipart)
  download <id> [-o file]    Download file content
  delete <id>                Delete a file

Every subcommand takes:
  --workspace <id>  Workspace UUID (defaults to the key's default workspace)
  --provider <slug> Store/read on your own provider account: openai | anthropic
                    (uses your BYOK key; omit for OpenRouter storage)

upload options:
  --purpose <p>     Ignored: the API no longer takes a purpose (kept so old
                    scripts still run)

list options:
  --limit <n>       Max files (1-1000)
  --cursor <c>      Cursor from a previous page
  --after <id>      OpenAI-style: list after this id
  --after-id <id>   Anthropic-style: list after this id
  --before-id <id>  Anthropic-style reverse cursor (not on OpenRouter storage)
  --order <o>       asc (only asc on OpenRouter storage)
`;

const FILE_SCOPE = {
  workspace: { type: "string" },
  provider: { type: "string" },
};

function scopeQuery(values) {
  const query = {};
  if (values.workspace) query.workspace_id = values.workspace;
  if (values.provider) query.provider = values.provider;
  return Object.keys(query).length ? query : undefined;
}

export async function filesCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, {
      ...FILE_SCOPE,
      limit: { type: "string" },
      cursor: { type: "string" },
      after: { type: "string" },
      "after-id": { type: "string" },
      "before-id": { type: "string" },
      order: { type: "string" },
    });
    const query = scopeQuery(values) || {};
    if (values.limit !== undefined) query.limit = numberOption(values.limit, "--limit");
    if (values.cursor) query.cursor = values.cursor;
    if (values.after) query.after = values.after;
    if (values["after-id"]) query.after_id = values["after-id"];
    if (values["before-id"]) query.before_id = values["before-id"];
    if (values.order) query.order = values.order;
    const data = await api("GET", "/files", { auth: authFromValues(values), query });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (f) => f.id || "" },
        { label: "filename", value: (f) => f.filename || f.name || "" },
        { label: "bytes", value: (f) => f.size_bytes ?? f.bytes ?? f.size ?? "" },
        { label: "type", value: (f) => f.mime_type || f.purpose || "" },
        { label: "created", value: (f) => f.created_at || "" },
      ]);
      if (data.has_more) {
        outln(data.cursor ? `more: --cursor ${data.cursor}` : `more: --after ${data.last_id}`);
      }
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, FILE_SCOPE);
    if (!positionals[0]) throw new Error("id required");
    const data = await api("GET", `/files/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      query: scopeQuery(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "upload") {
    const { values, positionals } = parseArgs(rest, {
      ...FILE_SCOPE,
      purpose: { type: "string" },
    });
    const path = positionals[0];
    if (!path) throw new Error("path required");
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(path);
    const filename = path.split("/").pop() || "file";
    const form = new FormData();
    form.append("file", new Blob([buf]), filename);
    // --purpose is still accepted but not sent: the multipart body is file only.
    const data = await api("POST", "/files", {
      auth: authFromValues(values),
      body: form,
      query: scopeQuery(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "download") {
    const { values, positionals } = parseArgs(rest, {
      ...FILE_SCOPE,
      out: { type: "string", short: "o" },
    });
    if (!positionals[0]) throw new Error("id required");
    const bytes = await api("GET", `/files/${encodeURIComponent(positionals[0])}/content`, {
      auth: authFromValues(values),
      binary: true,
      query: scopeQuery(values),
    });
    const out = values.out || positionals[0];
    await writeBinaryOutput(bytes, out);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, FILE_SCOPE);
    if (!positionals[0]) throw new Error("id required");
    const data = await api("DELETE", `/files/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      query: scopeQuery(values),
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  throw new Error(`Unknown files subcommand: ${sub}`);
}
