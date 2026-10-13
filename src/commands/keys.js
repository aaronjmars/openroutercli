import { parseArgs, authFromValues, numberOption, loadJson } from "../args.js";
import { api } from "../api.js";
import { c, outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter keys <subcommand> [options]

Manage API keys (requires a provisioning/management key).

Subcommands:
  list [options]                  List API keys
  get <hash>                      Get a single key
  create <name> [options]         Create a key
  update <hash> [options]         Update a key
  delete <hash>                   Delete a key

list options:
  --offset <n>           Pagination offset
  --include-disabled     Include disabled keys
  --include-expired      Include expired keys (hidden by default)
  --workspace <uuid>     Keys in this workspace (default: the default workspace)

create options:
  --limit <usd>          Spending limit
  --limit-reset <p>      daily | weekly | monthly
  --expires-at <iso>     ISO 8601 UTC expiry with seconds (2027-12-31T23:59:59Z)
  --workspace <uuid>     Workspace id
  --include-byok         Include BYOK in limit
  --disabled             Create the key already disabled (not in the API spec;
                         check with keys get)
  --creator <user_id>    Org member who owns the key (organization keys)
  --external-user <id>   Partner end-user id to attribute the key to
  --external-api-key <k> Partner-supplied key (32+ chars) tied to that user;
                         needs --external-user
  --extra <json|@file>   Extra body fields, merged last

update options:
  --name <name>
  --limit <usd>
  --limit-reset <p>
  --workspace <uuid>     Move the key to this workspace
  --include-byok / --no-include-byok
  --disabled / --enabled
  --extra <json|@file>   Extra body fields, merged last

  The expiry is set at create time only; the API cannot change it later.
`;

// --extra merges arbitrary fields last, for API fields without a flag.
async function mergeExtra(body, values) {
  const extra = await loadJson(values.extra, "--extra");
  if (extra === undefined) return body;
  if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
    throw new Error("--extra must be a JSON object");
  }
  return { ...body, ...extra };
}

export async function keysCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, {
      offset: { type: "string" },
      "include-disabled": { type: "boolean" },
      "include-expired": { type: "boolean" },
      workspace: { type: "string" },
    });
    const query = {};
    if (values.offset) query.offset = values.offset;
    if (values["include-disabled"]) query.include_disabled = "true";
    if (values["include-expired"]) query.include_expired = "true";
    if (values.workspace) query.workspace_id = values.workspace;
    const data = await api("GET", "/keys", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "name", value: (k) => k.name || "" },
        { label: "hash", value: (k) => k.hash || k.id || "" },
        { label: "usage", value: (k) => k.usage ?? "" },
        { label: "limit", value: (k) => k.limit ?? "" },
        { label: "disabled", value: (k) => (k.disabled ? "yes" : "") },
        { label: "expires", value: (k) => k.expires_at || "" },
        { label: "last used", value: (k) => k.last_used_at || "" },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("hash required");
    const data = await api("GET", `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      limit: { type: "string" },
      "limit-reset": { type: "string" },
      "expires-at": { type: "string" },
      workspace: { type: "string" },
      "include-byok": { type: "boolean" },
      disabled: { type: "boolean" },
      creator: { type: "string" },
      "external-user": { type: "string" },
      "external-api-key": { type: "string" },
      extra: { type: "string" },
    });
    const name = positionals[0];
    if (!name) throw new Error("name required");
    if (values["external-api-key"] && !values["external-user"]) {
      throw new Error("--external-api-key needs --external-user");
    }
    const body = { name };
    if (values.limit) body.limit = numberOption(values.limit, "--limit");
    if (values["limit-reset"]) body.limit_reset = values["limit-reset"];
    if (values["expires-at"]) body.expires_at = values["expires-at"];
    if (values.workspace) body.workspace_id = values.workspace;
    if (values["include-byok"]) body.include_byok_in_limit = true;
    if (values.disabled) body.disabled = true;
    if (values.creator) body.creator_user_id = values.creator;
    if (values["external-user"]) {
      body.external = { user: values["external-user"] };
      if (values["external-api-key"]) body.external.api_key = values["external-api-key"];
    }
    const data = await api("POST", "/keys", {
      auth: authFromValues(values),
      requiresManagement: true,
      body: await mergeExtra(body, values),
    });
    printResult(data, () => {
      const k = data.key || (data.data && data.data.key);
      const meta = data.data || data;
      outln(c.bold("key (save this - shown only once):"));
      outln("  " + (k || "(see JSON)"));
      outln(c.dim(JSON.stringify(meta, null, 2)));
    });
    return 0;
  }

  if (sub === "update") {
    const { values, positionals } = parseArgs(rest, {
      name: { type: "string" },
      limit: { type: "string" },
      "limit-reset": { type: "string" },
      "expires-at": { type: "string" },
      workspace: { type: "string" },
      "include-byok": { type: "boolean" },
      "no-include-byok": { type: "boolean" },
      disabled: { type: "boolean" },
      enabled: { type: "boolean" },
      extra: { type: "string" },
    });
    if (!positionals[0]) throw new Error("hash required");
    // PATCH /keys/{hash} has no expires_at: the API drops it (or answers
    // "No update fields provided" when it is the only field).
    if (values["expires-at"]) {
      throw new Error(
        "--expires-at can only be set when creating a key; the API cannot change it later.",
      );
    }
    const body = {};
    if (values.name) body.name = values.name;
    if (values.limit) body.limit = numberOption(values.limit, "--limit");
    if (values["limit-reset"]) body.limit_reset = values["limit-reset"];
    if (values.workspace) body.workspace_id = values.workspace;
    if (values["include-byok"]) body.include_byok_in_limit = true;
    if (values["no-include-byok"]) body.include_byok_in_limit = false;
    if (values.disabled) body.disabled = true;
    if (values.enabled) body.disabled = false;
    const data = await api("PATCH", `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
      body: await mergeExtra(body, values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("hash required");
    const data = await api("DELETE", `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  throw new Error(`Unknown keys subcommand: ${sub}`);
}
