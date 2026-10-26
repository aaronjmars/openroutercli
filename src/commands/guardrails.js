import {
  parseArgs,
  authFromValues,
  PAGINATION_OPTIONS,
  paginationQuery,
  numberOption,
  loadJson,
} from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter guardrails <subcommand> [options]

Manage guardrails (requires a management key).

Subcommands:
  list [--offset <n>] [--limit <n>] [--workspace <uuid>]
                                      List guardrails (default workspace unless
                                      --workspace is given)
  get <id>                            Get one
  create <name> [options]             Create
  update <id> [options]               Update
  delete <id>                         Delete
  assignments [--keys|--members]      List all assignments (--offset/--limit)
  assign-key <id> <hash>...           Assign API keys to a guardrail
  unassign-key <id> <hash>...         Unassign API keys
  assign-member <id> <user>...        Assign org members
  unassign-member <id> <user>...      Unassign members
  key-assignments <id>                List key assignments for a guardrail
  member-assignments <id>             List member assignments for a guardrail
                                      (both take --offset/--limit)

create / update options:
  --name <name>             (update only)
  --description <text>
  --limit-usd <n>           On create, pass together with --reset-interval
  --reset-interval <p>      daily | weekly | monthly | null
  --enforce-zdr / --no-zdr  ZDR for every provider (deprecated API field)
  --zdr-providers <csv>     Enforce ZDR only for: anthropic,openai,google,xai,other
  --allowed-models <csv>
  --ignored-models <csv>
  --allowed-providers <csv>
  --ignored-providers <csv>
  --regions <csv>           Allowed data regions: global,europe,us ("" clears)
  --content-filters <json|@file>  Custom regex filters, e.g.
                            [{"pattern":"sk-[a-z0-9]{48}","action":"redact","label":"[KEY]"}]
                            action: redact | block | flag. "null" removes them.
  --builtin-filters <spec>  Builtin filters as JSON/@file
                            ([{"slug":"email","action":"redact"}]) or shorthand
                            email:redact,secrets:block. Slugs: email, phone, ssn,
                            credit-card, ip-address, secrets, person-name, address,
                            regex-prompt-injection. "null" removes them.
  --free-publication / --no-free-publication  Allow free endpoints that publish prompts
  --free-training / --no-free-training        Allow free endpoints that train on data
  --paid-training / --no-paid-training        Allow paid endpoints that train on data
  --allow-safety-retention-google / --no-allow-safety-retention-google
                            Allow ZDR requests to google/* to use endpoints that retain for safety
  --allow-safety-retention-other / --no-allow-safety-retention-other
                            Allow ZDR requests to other models to use endpoints that retain for safety
  --include-byok / --no-include-byok   Count BYOK spend toward the budget
  --workspace <uuid>        (create only)
  --extra <json|@file>      Extra body fields, merged last (e.g. enforce_zdr_xai:false)
`;

const ZDR_PROVIDERS = ["anthropic", "openai", "google", "xai", "other"];
const REGIONS = ["global", "europe", "us"];
const MAX_BULK_IDS = 500;

function toggle(values, on, off) {
  if (values[on] && values[off]) throw new Error(`Pass only one of --${on} or --${off}.`);
  if (values[on]) return true;
  if (values[off]) return false;
  return undefined;
}

// JSON array (inline or @file), or the literal "null" to remove the field.
async function jsonArray(value, flag) {
  if (value === undefined) return undefined;
  if (value === "null") return null;
  const parsed = await loadJson(value, flag);
  if (!Array.isArray(parsed)) throw new Error(`${flag} must be a JSON array`);
  return parsed;
}

async function builtinFilters(value) {
  if (value === undefined || value === "null" || /^\s*[[@]/.test(value)) {
    return jsonArray(value, "--builtin-filters");
  }
  return csv(value).map((entry) => {
    const [slug, action] = entry.split(":");
    if (!slug || !action) {
      throw new Error(`--builtin-filters entry "${entry}" must be slug:action (e.g. email:redact)`);
    }
    return { slug, action };
  });
}

function csv(v) {
  if (v == null) return undefined;
  if (v === "") return null;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function buildBody(values) {
  const body = {};
  if (values.description !== undefined) body.description = values.description;
  if (values["limit-usd"] !== undefined)
    body.limit_usd = numberOption(values["limit-usd"], "--limit-usd");
  if (values["reset-interval"] !== undefined) {
    body.reset_interval = values["reset-interval"] === "null" ? null : values["reset-interval"];
  }
  if (values["enforce-zdr"]) body.enforce_zdr = true;
  if (values["no-zdr"]) body.enforce_zdr = false;
  if (values["allowed-models"] !== undefined) body.allowed_models = csv(values["allowed-models"]);
  if (values["ignored-models"] !== undefined) body.ignored_models = csv(values["ignored-models"]);
  if (values["allowed-providers"] !== undefined)
    body.allowed_providers = csv(values["allowed-providers"]);
  if (values["ignored-providers"] !== undefined)
    body.ignored_providers = csv(values["ignored-providers"]);
  if (values["include-byok"]) body.include_byok_in_budgets = true;
  if (values["no-include-byok"]) body.include_byok_in_budgets = false;
  if (values["zdr-providers"] !== undefined) {
    for (const p of csv(values["zdr-providers"]) || []) {
      if (!ZDR_PROVIDERS.includes(p)) {
        throw new Error(
          `Unknown --zdr-providers entry "${p}". Expected: ${ZDR_PROVIDERS.join(", ")}`,
        );
      }
      body[`enforce_zdr_${p}`] = true;
    }
  }
  if (values.regions !== undefined) {
    const regions = csv(values.regions);
    for (const r of regions || []) {
      if (!REGIONS.includes(r)) {
        throw new Error(`Unknown region "${r}". Expected: ${REGIONS.join(", ")}`);
      }
    }
    body.allowed_data_regions = regions;
  }
  const filters = await jsonArray(values["content-filters"], "--content-filters");
  if (filters !== undefined) body.content_filters = filters;
  const builtins = await builtinFilters(values["builtin-filters"]);
  if (builtins !== undefined) body.content_filter_builtins = builtins;
  const toggles = [
    ["enable_free_model_publication", "free-publication"],
    ["enable_free_model_training", "free-training"],
    ["enable_paid_model_training", "paid-training"],
    ["allow_safety_retention_google", "allow-safety-retention-google"],
    ["allow_safety_retention_other", "allow-safety-retention-other"],
  ];
  for (const [field, flag] of toggles) {
    const v = toggle(values, flag, `no-${flag}`);
    if (v !== undefined) body[field] = v;
  }
  const extra = await loadJson(values.extra, "--extra");
  if (extra !== undefined) {
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
      throw new Error("--extra must be a JSON object");
    }
    Object.assign(body, extra);
  }
  return body;
}

const COMMON_FIELDS = {
  description: { type: "string" },
  "limit-usd": { type: "string" },
  "reset-interval": { type: "string" },
  "enforce-zdr": { type: "boolean" },
  "no-zdr": { type: "boolean" },
  "allowed-models": { type: "string" },
  "ignored-models": { type: "string" },
  "allowed-providers": { type: "string" },
  "ignored-providers": { type: "string" },
  "include-byok": { type: "boolean" },
  "no-include-byok": { type: "boolean" },
  "zdr-providers": { type: "string" },
  regions: { type: "string" },
  "content-filters": { type: "string" },
  "builtin-filters": { type: "string" },
  "free-publication": { type: "boolean" },
  "no-free-publication": { type: "boolean" },
  "free-training": { type: "boolean" },
  "no-free-training": { type: "boolean" },
  "paid-training": { type: "boolean" },
  "no-paid-training": { type: "boolean" },
  "allow-safety-retention-google": { type: "boolean" },
  "no-allow-safety-retention-google": { type: "boolean" },
  "allow-safety-retention-other": { type: "boolean" },
  "no-allow-safety-retention-other": { type: "boolean" },
  extra: { type: "string" },
};

export async function guardrailsCommand(argv) {
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
    const { values } = parseArgs(rest, { ...PAGINATION_OPTIONS, workspace: { type: "string" } });
    const query = paginationQuery(values);
    if (values.workspace) query.workspace_id = values.workspace;
    const data = await api("GET", "/guardrails", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (g) => g.id },
        { label: "name", value: (g) => g.name },
        { label: "limit_usd", value: (g) => g.limit_usd ?? "" },
        { label: "reset", value: (g) => g.reset_interval ?? "" },
        {
          label: "zdr",
          value: (g) => {
            if (g.enforce_zdr) return "all";
            return ZDR_PROVIDERS.filter((p) => g[`enforce_zdr_${p}`]).join(",");
          },
        },
        { label: "regions", value: (g) => (g.allowed_data_regions || []).join(",") },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const data = await api("GET", `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      workspace: { type: "string" },
    });
    const name = positionals[0];
    if (!name) throw new Error("name required");
    const body = { name, ...(await buildBody(values)) };
    if (values.workspace) body.workspace_id = values.workspace;
    if ("limit_usd" in body !== "reset_interval" in body) {
      throw new Error("--limit-usd and --reset-interval must be passed together on create.");
    }
    const data = await api("POST", "/guardrails", {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "update") {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      name: { type: "string" },
    });
    if (!positionals[0]) throw new Error("id required");
    const body = await buildBody(values);
    if (values.name) body.name = values.name;
    const data = await api("PATCH", `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const data = await api("DELETE", `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  if (sub === "assignments") {
    const { values } = parseArgs(rest, {
      ...PAGINATION_OPTIONS,
      keys: { type: "boolean" },
      members: { type: "boolean" },
    });
    if (values.keys && values.members) {
      throw new Error("Pass only one of --keys or --members.");
    }
    const path = values.members
      ? "/guardrails/assignments/members"
      : "/guardrails/assignments/keys";
    const data = await api("GET", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      query: paginationQuery(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "key-assignments" || sub === "member-assignments") {
    const { values, positionals } = parseArgs(rest, PAGINATION_OPTIONS);
    if (!positionals[0]) throw new Error("id required");
    const path =
      sub === "key-assignments"
        ? `/guardrails/${encodeURIComponent(positionals[0])}/assignments/keys`
        : `/guardrails/${encodeURIComponent(positionals[0])}/assignments/members`;
    const data = await api("GET", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      query: paginationQuery(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "assign-key" || sub === "unassign-key") {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error("Usage: <id> <hash>...");
    const id = positionals[0];
    const hashes = positionals.slice(1);
    if (hashes.length > MAX_BULK_IDS) {
      throw new Error(
        `Too many key hashes (${hashes.length}); the API takes at most ${MAX_BULK_IDS} per call. Split into batches.`,
      );
    }
    const path =
      sub === "assign-key"
        ? `/guardrails/${encodeURIComponent(id)}/assignments/keys`
        : `/guardrails/${encodeURIComponent(id)}/assignments/keys/remove`;
    const data = await api("POST", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      body: { key_hashes: hashes },
    });
    printResult(data);
    return 0;
  }

  if (sub === "assign-member" || sub === "unassign-member") {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error("Usage: <id> <user_id>...");
    const id = positionals[0];
    const userIds = positionals.slice(1);
    if (userIds.length > MAX_BULK_IDS) {
      throw new Error(
        `Too many user ids (${userIds.length}); the API takes at most ${MAX_BULK_IDS} per call. Split into batches.`,
      );
    }
    const path =
      sub === "assign-member"
        ? `/guardrails/${encodeURIComponent(id)}/assignments/members`
        : `/guardrails/${encodeURIComponent(id)}/assignments/members/remove`;
    const data = await api("POST", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      body: { member_user_ids: userIds },
    });
    printResult(data);
    return 0;
  }

  throw new Error(`Unknown guardrails subcommand: ${sub}`);
}
