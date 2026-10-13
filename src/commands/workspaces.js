import {
  parseArgs,
  authFromValues,
  numberOption,
  PAGINATION_OPTIONS,
  paginationQuery,
} from "../args.js";
import { api, APIError } from "../api.js";
import { c, outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter workspaces <subcommand> [options]

Manage workspaces (requires a management key).

Subcommands:
  list [--offset <n>] [--limit <n>]     List workspaces
  get <id|slug>                         Get one
  create <name> [options]               Create
  update <id|slug> [options]            Update
  delete <id|slug>                      Delete
  members <id|slug> [--offset --limit]  List members (org accounts; the default
                                        workspace lists every org member)
  add-members <id|slug> <userId>...     Bulk add members
  remove-members <id|slug> <userId>...  Bulk remove members
  budgets list <id|slug>                List spending budgets (also: budgets <id|slug>)
  budgets get <id|slug> <interval>      Get one budget
  budgets set <id|slug> <interval> --limit <usd> [--include-byok|--no-include-byok]
                                        Create or update a budget
  budgets delete <id|slug> <interval>   Remove a budget

  <interval> is daily | weekly | monthly | lifetime. Limits must strictly
  decrease as the interval narrows: lifetime > monthly > weekly > daily.
  --include-byok counts BYOK spend; it is workspace-wide (applies to every
  interval), and omitting it leaves the current setting unchanged.

create / update options:
  --name <name>                    (update only)
  --slug <slug>                    Required by the API on create; derived from
                                   the name when omitted
  --description <text>
  --default-text-model <id>
  --default-image-model <id>
  --default-provider-sort <s>      price | throughput | latency | exacto
  --disable-tools <csv>            Server tools requests may not call, e.g.
                                   web_search,web_fetch,image_generation (the
                                   openrouter: prefix is optional; "" clears)
  --broadcast / --no-broadcast     Observability broadcast
  --io-logging / --no-io-logging   Private input/output logging
  --io-logging-rate <0-1>          I/O logging sampling rate (0.0001-1)
  --io-logging-keys <csv>          Only log these API key ids ("" clears)
  --data-discount-logging / --no-data-discount-logging
`;

const INTERVALS = ["daily", "weekly", "monthly", "lifetime"];

const COMMON = {
  slug: { type: "string" },
  description: { type: "string" },
  "default-text-model": { type: "string" },
  "default-image-model": { type: "string" },
  "default-provider-sort": { type: "string" },
  "disable-tools": { type: "string" },
  broadcast: { type: "boolean" },
  "no-broadcast": { type: "boolean" },
  "io-logging": { type: "boolean" },
  "no-io-logging": { type: "boolean" },
  "io-logging-rate": { type: "string" },
  "io-logging-keys": { type: "string" },
  "data-discount-logging": { type: "boolean" },
  "no-data-discount-logging": { type: "boolean" },
};

function csv(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Paired --x / --no-x flags: undefined when neither is passed.
function toggle(values, flag) {
  if (values[flag] && values[`no-${flag}`]) {
    throw new Error(`Pass only one of --${flag} or --no-${flag}.`);
  }
  if (values[flag]) return true;
  if (values[`no-${flag}`]) return false;
  return undefined;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildBody(values) {
  const body = {};
  if (values.slug !== undefined) body.slug = values.slug;
  if (values.description !== undefined) body.description = values.description;
  if (values["default-text-model"] !== undefined)
    body.default_text_model = values["default-text-model"];
  if (values["default-image-model"] !== undefined)
    body.default_image_model = values["default-image-model"];
  if (values["default-provider-sort"] !== undefined)
    body.default_provider_sort = values["default-provider-sort"];
  if (values["disable-tools"] !== undefined) {
    body.disabled_server_tools = csv(values["disable-tools"]).map((t) =>
      t.includes(":") ? t : `openrouter:${t}`,
    );
  }
  const broadcast = toggle(values, "broadcast");
  if (broadcast !== undefined) body.is_observability_broadcast_enabled = broadcast;
  const ioLogging = toggle(values, "io-logging");
  if (ioLogging !== undefined) body.is_observability_io_logging_enabled = ioLogging;
  if (values["io-logging-rate"] !== undefined) {
    const rate = numberOption(values["io-logging-rate"], "--io-logging-rate");
    if (rate <= 0 || rate > 1) throw new Error("--io-logging-rate must be between 0.0001 and 1");
    body.io_logging_sampling_rate = rate;
  }
  if (values["io-logging-keys"] !== undefined) {
    body.io_logging_api_key_ids = csv(values["io-logging-keys"]).map((id) =>
      numberOption(id, "--io-logging-keys"),
    );
  }
  const discount = toggle(values, "data-discount-logging");
  if (discount !== undefined) body.is_data_discount_logging_enabled = discount;
  return body;
}

function intervalArg(value) {
  if (!value) throw new Error(`interval required: ${INTERVALS.join(" | ")}`);
  if (!INTERVALS.includes(value)) {
    throw new Error(`Unknown interval "${value}". Expected: ${INTERVALS.join(" | ")}`);
  }
  return value;
}

function budgetRows(rows) {
  table(rows, [
    { label: "interval", value: (b) => b.reset_interval ?? "lifetime" },
    { label: "limit_usd", value: (b) => b.limit_usd ?? "" },
    { label: "id", value: (b) => b.id || "" },
    { label: "updated_at", value: (b) => b.updated_at || "" },
  ]);
}

async function budgetsCommand(argv) {
  // `budgets <ref>` is shorthand for `budgets list <ref>`.
  const actions = ["list", "get", "set", "delete"];
  const action = actions.includes(argv[0]) ? argv[0] : "list";
  const rest = action === argv[0] ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs(rest, {
    limit: { type: "string" },
    "include-byok": { type: "boolean" },
    "no-include-byok": { type: "boolean" },
  });
  const ref = positionals[0];
  if (!ref) throw new Error(`Usage: workspaces budgets ${action} <id|slug>`);
  const base = `/workspaces/${encodeURIComponent(ref)}/budgets`;
  const opts = { auth: authFromValues(values), requiresManagement: true };

  if (action === "list") {
    const data = await api("GET", base, opts);
    printResult(data, () => {
      const rows = data.data || [];
      if (!rows.length) outln(c.dim("(no budgets)"));
      else budgetRows(rows);
      outln(c.dim(`include_byok_in_budgets: ${data.include_byok_in_budgets ?? "-"}`));
    });
    return 0;
  }

  const interval = intervalArg(positionals[1]);
  const path = `${base}/${interval}`;

  if (action === "get") {
    const data = await api("GET", path, opts);
    printResult(data, () => {
      budgetRows([data.data || {}]);
      outln(c.dim(`include_byok_in_budgets: ${data.include_byok_in_budgets ?? "-"}`));
    });
    return 0;
  }

  if (action === "set") {
    if (values.limit === undefined) throw new Error("--limit <usd> required");
    const limit = numberOption(values.limit, "--limit");
    if (limit <= 0) throw new Error("--limit must be greater than 0");
    const body = { limit_usd: limit };
    const byok = toggle(values, "include-byok");
    if (byok !== undefined) body.include_byok_in_budgets = byok;
    let data;
    try {
      data = await api("PUT", path, { ...opts, body });
    } catch (err) {
      // The usual 400 is the ordering rule; say which rule it is.
      if (err instanceof APIError && err.status === 400) {
        err.message +=
          "\nBudget limits must strictly decrease: lifetime > monthly > weekly > daily." +
          ` Check with: openrouter workspaces budgets list ${ref}`;
      }
      throw err;
    }
    printResult(data, () => {
      budgetRows([data.data || {}]);
      outln(c.dim(`include_byok_in_budgets: ${data.include_byok_in_budgets ?? "-"}`));
    });
    return 0;
  }

  const data = await api("DELETE", path, opts);
  printResult(data, () => outln("deleted"));
  return 0;
}

export async function workspacesCommand(argv) {
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

  if (sub === "budgets" || sub === "budget") return budgetsCommand(rest);

  if (sub === "members") {
    const { values, positionals } = parseArgs(rest, PAGINATION_OPTIONS);
    if (!positionals[0]) throw new Error("id|slug required");
    const data = await api("GET", `/workspaces/${encodeURIComponent(positionals[0])}/members`, {
      auth: authFromValues(values),
      requiresManagement: true,
      query: paginationQuery(values),
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "user_id", value: (m) => m.user_id || "" },
        { label: "role", value: (m) => m.role || "" },
        { label: "added", value: (m) => m.created_at || "" },
      ]);
      if (data.total_count != null && data.total_count > rows.length) {
        outln(c.dim(`${rows.length} of ${data.total_count} (use --offset / --limit)`));
      }
    });
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, PAGINATION_OPTIONS);
    const query = paginationQuery(values);
    const data = await api("GET", "/workspaces", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "slug", value: (w) => w.slug || "" },
        { label: "name", value: (w) => w.name || "" },
        { label: "id", value: (w) => w.id || "" },
        { label: "created", value: (w) => (w.created_at || "").slice(0, 10) },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id|slug required");
    const data = await api("GET", `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, COMMON);
    const name = positionals[0];
    if (!name) throw new Error("name required");
    const body = { name, ...buildBody(values) };
    if (!body.slug) body.slug = slugify(name);
    if (!body.slug) throw new Error("--slug required (could not derive one from the name)");
    const data = await api("POST", "/workspaces", {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "update") {
    const { values, positionals } = parseArgs(rest, { ...COMMON, name: { type: "string" } });
    if (!positionals[0]) throw new Error("id|slug required");
    const body = buildBody(values);
    if (values.name) body.name = values.name;
    const data = await api("PATCH", `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id|slug required");
    const data = await api("DELETE", `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  if (sub === "add-members" || sub === "remove-members") {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error("Usage: <id|slug> <userId>...");
    const id = positionals[0];
    const userIds = positionals.slice(1);
    const path =
      sub === "add-members"
        ? `/workspaces/${encodeURIComponent(id)}/members/add`
        : `/workspaces/${encodeURIComponent(id)}/members/remove`;
    const data = await api("POST", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      body: { user_ids: userIds },
    });
    printResult(data);
    return 0;
  }

  throw new Error(`Unknown workspaces subcommand: ${sub}`);
}
