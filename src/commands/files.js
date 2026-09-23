import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table, writeBinaryOutput } from "../output.js";

const HELP = `Usage: openrouter files <subcommand> [options]

Manage files stored on OpenRouter (backing store for file/PDF inputs).

Subcommands:
  list                       List uploaded files
  get <id>                   Get one file's metadata
  upload <path> [options]    Upload a file (multipart)
  download <id> [-o file]    Download file content
  delete <id>                Delete a file

upload options:
  --purpose <p>    Purpose tag for the file (e.g. assistants, user_data)
  --workspace <id> Workspace UUID (defaults to the key's workspace)
  --provider <slug> Store/read via a BYOK provider
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
    const query = scopeQuery(values);
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
        { label: "bytes", value: (f) => f.bytes ?? f.size ?? "" },
        { label: "purpose", value: (f) => f.purpose || "" },
      ]);
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
    if (values.purpose) form.append("purpose", values.purpose);
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
