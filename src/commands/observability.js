import {
  parseArgs,
  authFromValues,
  PAGINATION_OPTIONS,
  paginationQuery,
  numberOption,
  loadJson,
} from "../args.js";
import { api } from "../api.js";
import { c, outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter observability <subcommand> [options]

Manage observability destinations: where OpenRouter forwards traces of your
requests (requires a management key). Alias: obs

Subcommands:
  list [options]                    List destinations
  get <id>                          Get one
  create <name> --type <t> --config <json|@file> [options]
  update <id> [options]             Update (only the fields you pass change)
  delete <id>                       Delete

list options:
      --offset <n>
      --limit <n>                   1-100
      --workspace <id>              Another workspace (default: the key's default)

create / update options:
      --type <t>                    (create only) arize | braintrust | clickhouse |
                                    datadog | grafana | langfuse | langsmith | newrelic |
                                    opik | otel-collector | posthog | ramp | s3 | sentry |
                                    snowflake | weave | webhook
      --config <json|@file>         Provider settings, e.g. langfuse:
                                    {"publicKey":"pk-lf-...","secretKey":"sk-lf-...",
                                    "baseUrl":"https://cloud.langfuse.com"}. Clickhouse and
                                    Snowflake accept "shouldIncludeCacheWriteTokens": true.
                                    For s3, key auth: {"accessKeyId":"...",
                                    "secretAccessKey":"...",...} or IAM role auth:
                                    {"authMode":"iam_role","provider":"aws",
                                    "roleArn":"arn:aws:iam::<acct>:role/<name>",
                                    "region":"<region>","externalId":"<id>"} (GovCloud and
                                    China ARNs rejected; trust policy must require the
                                    external id).
                                    On update, masked values are ignored and unset fields
                                    keep their value.
      --name <name>                 (update only)
      --enabled / --disabled        Turn forwarding on or off
      --privacy-mode / --no-privacy-mode   Send metadata only, no request/response bodies
      --sampling-rate <n>           0.0001-1 (1 = 100%)
      --filter-rules <json|@file>   Structured rules for which events are forwarded
                                    ("null" clears them on update)
      --regions <csv>               global | europe (eu) | us (default: global)
      --api-keys <csv>              Only forward traffic from these API key hashes
                                    ("all" forwards every key on update)
      --broadcast-cost / --no-broadcast-cost              Cost and billing metadata
      --broadcast-cost-allocation / --no-broadcast-cost-allocation
                                    Cost allocation metadata (beta)
      --broadcast-identity / --no-broadcast-identity      Identity metadata
      --broadcast-request-context / --no-broadcast-request-context
                                    Request-context metadata
      --workspace <id>              (create only) Target workspace

Pretty output never shows config values (only their keys); use --json for the
full object (the API masks secrets there too).
`;

const BOOL_PAIRS = [
  ["privacy-mode", "no-privacy-mode", "privacy_mode"],
  ["broadcast-cost", "no-broadcast-cost", "broadcast_generation_cost"],
  [
    "broadcast-cost-allocation",
    "no-broadcast-cost-allocation",
    "broadcast_generation_cost_allocation",
  ],
  ["broadcast-identity", "no-broadcast-identity", "broadcast_generation_identity"],
  [
    "broadcast-request-context",
    "no-broadcast-request-context",
    "broadcast_generation_request_context",
  ],
];

const COMMON_FIELDS = {
  config: { type: "string" },
  enabled: { type: "boolean" },
  disabled: { type: "boolean" },
  "sampling-rate": { type: "string" },
  "filter-rules": { type: "string" },
  regions: { type: "string" },
  "api-keys": { type: "string" },
};
for (const [on, off] of BOOL_PAIRS) {
  COMMON_FIELDS[on] = { type: "boolean" };
  COMMON_FIELDS[off] = { type: "boolean" };
}

function csv(v) {
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function buildBody(values) {
  const body = {};
  if (values.config !== undefined) body.config = await loadJson(values.config, "--config");
  if (values.enabled && values.disabled)
    throw new Error("Pass only one of --enabled or --disabled.");
  if (values.enabled) body.enabled = true;
  if (values.disabled) body.enabled = false;
  for (const [on, off, field] of BOOL_PAIRS) {
    if (values[on] && values[off]) throw new Error(`Pass only one of --${on} or --${off}.`);
    if (values[on]) body[field] = true;
    if (values[off]) body[field] = false;
  }
  if (values["sampling-rate"] !== undefined) {
    const rate = numberOption(values["sampling-rate"], "--sampling-rate");
    if (rate < 0.0001 || rate > 1) throw new Error("--sampling-rate must be between 0.0001 and 1");
    body.sampling_rate = rate;
  }
  if (values["filter-rules"] !== undefined) {
    body.filter_rules =
      values["filter-rules"] === "null"
        ? null
        : await loadJson(values["filter-rules"], "--filter-rules");
  }
  if (values.regions !== undefined) body.regions = csv(values.regions);
  if (values["api-keys"] !== undefined) {
    body.api_key_hashes = values["api-keys"] === "all" ? null : csv(values["api-keys"]);
  }
  return body;
}

function keysOf(obj) {
  return obj && typeof obj === "object" ? Object.keys(obj).join(",") : "";
}

function printDestination(data) {
  printResult(data, () => {
    const d = data.data || data;
    outln(`${c.bold(d.name || "(unnamed)")}  ${d.type || ""}  ${d.id || ""}`);
    outln(`  enabled: ${d.enabled ? "yes" : "no"}`);
    if (d.workspace_id) outln(`  workspace: ${d.workspace_id}`);
    outln(`  config keys: ${keysOf(d.config) || "-"}`);
    if (d.sampling_rate != null) outln(`  sampling_rate: ${d.sampling_rate}`);
    outln(`  privacy_mode: ${d.privacy_mode ? "yes" : "no"}`);
    if (d.regions) outln(`  regions: ${d.regions.join(",")}`);
    outln(`  api keys: ${Array.isArray(d.api_key_hashes) ? d.api_key_hashes.join(",") : "all"}`);
    const broadcast = [
      ["cost", d.broadcast_generation_cost],
      ["cost_allocation", d.broadcast_generation_cost_allocation],
      ["identity", d.broadcast_generation_identity],
      ["request_context", d.broadcast_generation_request_context],
    ]
      .filter(([, v]) => v)
      .map(([k]) => k);
    outln(`  broadcast: ${broadcast.join(",") || "-"}`);
    if (d.filter_rules) outln(`  filter_rules: ${JSON.stringify(d.filter_rules)}`);
    if (d.created_at) outln(`  created: ${d.created_at}`);
    if (d.updated_at) outln(`  updated: ${d.updated_at}`);
  });
}

export async function observabilityCommand(argv) {
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
      ...PAGINATION_OPTIONS,
      workspace: { type: "string" },
    });
    const query = paginationQuery(values);
    if (values.workspace) query.workspace_id = values.workspace;
    const data = await api("GET", "/observability/destinations", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    });
    printResult(data, () => {
      const rows = data.data || [];
      if (!rows.length) {
        outln("no destinations");
        return;
      }
      table(rows, [
        { label: "id", value: (d) => d.id },
        { label: "type", value: (d) => d.type },
        { label: "name", value: (d) => d.name || "" },
        { label: "enabled", value: (d) => (d.enabled ? "yes" : "no") },
        { label: "sampling", value: (d) => d.sampling_rate ?? "" },
        { label: "privacy", value: (d) => (d.privacy_mode ? "yes" : "") },
        { label: "regions", value: (d) => (d.regions || []).join(",") },
        { label: "config_keys", value: (d) => keysOf(d.config) },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const data = await api(
      "GET",
      `/observability/destinations/${encodeURIComponent(positionals[0])}`,
      { auth: authFromValues(values), requiresManagement: true },
    );
    printDestination(data);
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      type: { type: "string" },
      workspace: { type: "string" },
    });
    const name = positionals[0];
    if (!name) throw new Error("name required");
    if (!values.type) throw new Error("--type is required");
    if (values.config === undefined) throw new Error("--config is required");
    const body = { type: values.type, name, ...(await buildBody(values)) };
    if (values.workspace) body.workspace_id = values.workspace;
    const data = await api("POST", "/observability/destinations", {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printDestination(data);
    return 0;
  }

  if (sub === "update") {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      name: { type: "string" },
    });
    if (!positionals[0]) throw new Error("id required");
    const body = await buildBody(values);
    if (values.name !== undefined) body.name = values.name;
    if (!Object.keys(body).length) throw new Error("Nothing to update: pass at least one field.");
    const data = await api(
      "PATCH",
      `/observability/destinations/${encodeURIComponent(positionals[0])}`,
      { auth: authFromValues(values), requiresManagement: true, body },
    );
    printDestination(data);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const data = await api(
      "DELETE",
      `/observability/destinations/${encodeURIComponent(positionals[0])}`,
      { auth: authFromValues(values), requiresManagement: true },
    );
    printResult(data, () => outln("deleted"));
    return 0;
  }

  throw new Error(`Unknown observability subcommand: ${sub}`);
}
