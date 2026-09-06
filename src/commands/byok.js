import { parseArgs, authFromValues } from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter byok <subcommand> [options]

Manage BYOK (bring-your-own-key) provider integrations (requires a provisioning/management key).

Subcommands:
  list                            List integrations
  get <id>                        Get a single integration
  create [options]                Create an integration
  update <id> [options]           Update an integration
  delete <id>                     Delete an integration

create options:
  --provider <slug>      Provider slug (required)
  --api-key <key>        Provider secret key (required)
  --name <text>
  --allowed-models <csv>
  --allowed-hashes <csv>
  --allowed-users <csv>
  --disabled / --enabled
  --fallback / --no-fallback

update options:
  --provider <slug>
  --api-key <key>
  --name <text>
  --allowed-models <csv>
  --allowed-hashes <csv>
  --allowed-users <csv>
  --disabled / --enabled
  --fallback / --no-fallback
`;

const WRITE_OPTIONS = {
  provider: { type: "string" },
  "api-key": { type: "string" },
  name: { type: "string" },
  "allowed-models": { type: "string" },
  "allowed-hashes": { type: "string" },
  "allowed-users": { type: "string" },
  disabled: { type: "boolean" },
  enabled: { type: "boolean" },
  fallback: { type: "boolean" },
  "no-fallback": { type: "boolean" },
};

function csvOption(value) {
  return value.split(",").map((s) => s.trim());
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
    const { values } = parseArgs(rest, {});
    const data = await api("GET", "/byok", {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (b) => b.id || "" },
        { label: "provider", value: (b) => b.provider || "" },
        { label: "name", value: (b) => b.name || "" },
        { label: "disabled", value: (b) => (b.disabled ? "yes" : "") },
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
    const body = { provider: values.provider, key: values["api-key"] };
    if (values.name) body.name = values.name;
    if (values["allowed-models"]) body.allowed_models = csvOption(values["allowed-models"]);
    if (values["allowed-hashes"]) body.allowed_api_key_hashes = csvOption(values["allowed-hashes"]);
    if (values["allowed-users"]) body.allowed_user_ids = csvOption(values["allowed-users"]);
    if (values.disabled) body.disabled = true;
    if (values.enabled) body.disabled = false;
    if (values.fallback) body.is_fallback = true;
    if (values["no-fallback"]) body.is_fallback = false;
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
    const body = {};
    if (values.provider) body.provider = values.provider;
    if (values["api-key"]) body.key = values["api-key"];
    if (values.name) body.name = values.name;
    if (values["allowed-models"]) body.allowed_models = csvOption(values["allowed-models"]);
    if (values["allowed-hashes"]) body.allowed_api_key_hashes = csvOption(values["allowed-hashes"]);
    if (values["allowed-users"]) body.allowed_user_ids = csvOption(values["allowed-users"]);
    if (values.disabled) body.disabled = true;
    if (values.enabled) body.disabled = false;
    if (values.fallback) body.is_fallback = true;
    if (values["no-fallback"]) body.is_fallback = false;
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
