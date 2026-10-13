import { parseArgs, authFromValues, PAGINATION_OPTIONS, paginationQuery } from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter byok <subcommand> [options]

Manage BYOK (bring-your-own-key) provider integrations (requires a provisioning/management key).

Subcommands:
  list [options]                  List integrations
  get <id>                        Get a single integration
  create [options]                Create an integration
  update <id> [options]           Update an integration
  delete <id>                     Delete an integration

list options:
  --workspace <uuid>     Workspace to list (default: the default workspace)
  --provider <slug>      Only this provider (e.g. openai, anthropic, amazon-bedrock)
  --offset <n> / --limit <n>   Pagination (limit max 100)

create / update options:
  --provider <slug>      Provider slug (create only, required)
  --api-key <key>        Provider secret key (required on create; on update it
                         rotates the key in place)
  --workspace <uuid>     Workspace to create it in (create only)
  --name <text>
  --allowed-models <csv>         ("" clears the allowlist)
  --allowed-hashes <csv>         OpenRouter key hashes ("" clears)
  --allowed-users <csv>          ("" clears)
  --disabled / --enabled
  --fallback / --no-fallback     Use only after non-fallback keys (not with --byok-only)
  --required / --no-required     Drop shared endpoints for this key's models
  --byok-only / --no-byok-only   Drop shared endpoints for every model on this
                                 provider, even after your keys fail
  --region <r>           Declared data region: global | europe | us | none
  --zdr <v>              Declared zero data retention: true | false | none
`;

const WRITE_OPTIONS = {
  provider: { type: "string" },
  "api-key": { type: "string" },
  workspace: { type: "string" },
  name: { type: "string" },
  "allowed-models": { type: "string" },
  "allowed-hashes": { type: "string" },
  "allowed-users": { type: "string" },
  disabled: { type: "boolean" },
  enabled: { type: "boolean" },
  fallback: { type: "boolean" },
  "no-fallback": { type: "boolean" },
  required: { type: "boolean" },
  "no-required": { type: "boolean" },
  "byok-only": { type: "boolean" },
  "no-byok-only": { type: "boolean" },
  region: { type: "string" },
  zdr: { type: "string" },
};

const REGIONS = ["global", "europe", "us"];

// "" means null (no restriction), the API's way to clear an allowlist.
function csvOption(value) {
  if (value === "") return null;
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toggle(values, on, off) {
  if (values[on] && values[off]) throw new Error(`Pass only one of --${on} or --${off}.`);
  if (values[on]) return true;
  if (values[off]) return false;
  return undefined;
}

// Fields shared by create and update (both bodies take the same names).
function buildBody(values) {
  const body = {};
  if (values["api-key"]) body.key = values["api-key"];
  if (values.name) body.name = values.name;
  if (values["allowed-models"] !== undefined)
    body.allowed_models = csvOption(values["allowed-models"]);
  if (values["allowed-hashes"] !== undefined)
    body.allowed_api_key_hashes = csvOption(values["allowed-hashes"]);
  if (values["allowed-users"] !== undefined)
    body.allowed_user_ids = csvOption(values["allowed-users"]);
  const pairs = [
    ["disabled", "disabled", "enabled"],
    ["is_fallback", "fallback", "no-fallback"],
    ["is_required", "required", "no-required"],
    ["is_byok_only", "byok-only", "no-byok-only"],
  ];
  for (const [field, on, off] of pairs) {
    const v = toggle(values, on, off);
    if (v !== undefined) body[field] = v;
  }
  if (body.is_fallback && body.is_byok_only) {
    throw new Error("--fallback cannot be combined with --byok-only.");
  }
  if (values.region !== undefined) {
    if (values.region === "none") body.declared_region = null;
    else if (REGIONS.includes(values.region)) body.declared_region = values.region;
    else
      throw new Error(
        `Unknown --region "${values.region}". Expected: ${REGIONS.join(" | ")} | none`,
      );
  }
  if (values.zdr !== undefined) {
    const map = { true: true, false: false, none: null };
    if (!(values.zdr in map)) throw new Error("--zdr must be true, false, or none");
    body.declared_zdr = map[values.zdr];
  }
  return body;
}

export async function byokCommand(argv) {
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
      ...PAGINATION_OPTIONS,
      workspace: { type: "string" },
      provider: { type: "string" },
    });
    const query = paginationQuery(values);
    if (values.workspace) query.workspace_id = values.workspace;
    if (values.provider) query.provider = values.provider;
    const data = await api("GET", "/byok", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (b) => b.id || "" },
        { label: "provider", value: (b) => b.provider || "" },
        { label: "name", value: (b) => b.name || "" },
        { label: "disabled", value: (b) => (b.disabled ? "yes" : "") },
        {
          label: "mode",
          value: (b) =>
            [
              b.is_fallback && "fallback",
              b.is_required && "required",
              b.is_byok_only && "byok-only",
            ]
              .filter(Boolean)
              .join(","),
        },
        { label: "region", value: (b) => b.declared_region ?? "" },
        { label: "zdr", value: (b) => (b.declared_zdr == null ? "" : String(b.declared_zdr)) },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const data = await api("GET", `/byok/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const { values } = parseArgs(rest, WRITE_OPTIONS);
    if (!values.provider) throw new Error("--provider required");
    if (!values["api-key"]) throw new Error("--api-key required");
    const body = { provider: values.provider, ...buildBody(values) };
    if (values.workspace) body.workspace_id = values.workspace;
    const data = await api("POST", "/byok", {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "update") {
    const { values, positionals } = parseArgs(rest, WRITE_OPTIONS);
    if (!positionals[0]) throw new Error("id required");
    // The update body has no provider or workspace_id: a credential cannot
    // change either after creation.
    if (values.provider || values.workspace) {
      throw new Error(
        "--provider and --workspace are create-only; delete and recreate the integration to change them.",
      );
    }
    const body = buildBody(values);
    const data = await api("PATCH", `/byok/${encodeURIComponent(positionals[0])}`, {
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
    const data = await api("DELETE", `/byok/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  throw new Error(`Unknown byok subcommand: ${sub}`);
}
