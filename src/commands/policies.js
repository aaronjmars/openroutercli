import {
  parseArgs,
  authFromValues,
  PAGINATION_OPTIONS,
  paginationQuery,
  loadJson,
} from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

export const POLICIES_HELP = `Usage: openrouter guardrails policies <subcommand> [options]

Typed guardrail policies (requires a management key). Each policy has one type:
budget, model-availability or moderation. Workspace policies need --workspace;
--account works on workspace-wide (account) policies instead. The legacy
\`guardrails\` commands keep working: default policies map to them.

Subcommands:
  list --type <t> --workspace <uuid>      List policies of a type (--offset/--limit)
  list --account                          List workspace-wide policies (all types)
  get <id> --type <t> --workspace <uuid>  Get one (no get for --account policies)
  create <name> --type <t> --config <json|@file> (--workspace <uuid> | --account)
  update <id> --type <t> --name <n> --config <json|@file> (--workspace <uuid> | --account)
                                          PUT: replaces name and config
  delete <id> --type <t> --workspace <uuid>
  delete <id> --account
  assignment key|member <hash|user_id> --type <t> --workspace <uuid>
                                          Which policies of a type apply to it
  assign key|member <hash|user_id> <policy_id> --type <t> --workspace <uuid> [--unassign]
                                          Reads the current assignment first and sends
                                          it as expected_assignment (409 if it changed).
                                          --unassign of the last explicit policy also opts
                                          the subject out of the workspace default; assign
                                          the default policy id again to undo that

Types (--type): budget | model-availability | moderation (assignment also takes rate-limit)

Config (--config) is the policy's config object, for example:
  budget              {"limit_usd":10,"reset_interval":"daily","include_byok_in_budgets":false}
  model-availability  {"allowed_providers":["anthropic"],"enforce_zdr":true}
  moderation          {"content_filter_builtins":[{"slug":"email","action":"redact"}]}

create / update options:
  --default                 is_workspace_default (with --account: is_default)
  --members <csv>           member_ids
  --keys <csv>              api_key_hashes
  --opt-out-members <csv>   opted_out_member_ids
  --opt-out-keys <csv>      opted_out_api_key_hashes
  --workspaces <csv>        workspace_ids (--account only)
  --opt-out-workspaces <csv> opted_out_workspace_ids (--account only)
  --extra <json|@file>      Extra body fields, merged last (e.g. floor_reassignment)
`;

const TYPES = {
  budget: "budget",
  "model-availability": "model_availability",
  moderation: "moderation",
};
const ASSIGNMENT_TYPES = { ...TYPES, "rate-limit": "rate_limit" };

const OPTIONS = {
  ...PAGINATION_OPTIONS,
  type: { type: "string" },
  workspace: { type: "string" },
  account: { type: "boolean" },
  name: { type: "string" },
  config: { type: "string" },
  default: { type: "boolean" },
  members: { type: "string" },
  keys: { type: "string" },
  "opt-out-members": { type: "string" },
  "opt-out-keys": { type: "string" },
  workspaces: { type: "string" },
  "opt-out-workspaces": { type: "string" },
  extra: { type: "string" },
  unassign: { type: "boolean" },
};

function csv(v) {
  if (v == null) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function policyType(values, types = TYPES) {
  const t = values.type;
  if (!t) throw new Error(`--type required: ${Object.keys(types).join(" | ")}`);
  const slug = types[t] || (Object.values(types).includes(t) ? t : undefined);
  if (!slug) throw new Error(`Unknown --type "${t}". Expected: ${Object.keys(types).join(", ")}`);
  return slug;
}

// URL segment for a policy type: model_availability -> model-availability
const segment = (slug) => slug.replace(/_/g, "-");

function workspaceId(values) {
  if (!values.workspace) throw new Error("--workspace <uuid> required");
  return values.workspace;
}

async function jsonObject(value, flag) {
  const parsed = await loadJson(value, flag);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object`);
  }
  return parsed;
}

async function buildBody(values, { name, includeType }) {
  const config = await jsonObject(values.config, "--config");
  if (!config) throw new Error("--config <json|@file> required");
  if (!name) throw new Error("name required");
  const body = { name, config };
  if (values.account) {
    body.policy_type = policyType(values);
    if (values.default) body.is_default = true;
    if (values.workspaces !== undefined) body.workspace_ids = csv(values.workspaces);
    if (values["opt-out-workspaces"] !== undefined)
      body.opted_out_workspace_ids = csv(values["opt-out-workspaces"]);
  } else {
    if (includeType) body.policy_type = policyType(values);
    body.workspace_id = workspaceId(values);
    if (values.default) body.is_workspace_default = true;
  }
  const lists = [
    ["member_ids", "members"],
    ["api_key_hashes", "keys"],
    ["opted_out_member_ids", "opt-out-members"],
    ["opted_out_api_key_hashes", "opt-out-keys"],
  ];
  for (const [field, flag] of lists) {
    if (values[flag] === undefined) continue;
    if (values.account) throw new Error(`--${flag} works only on workspace policies`);
    body[field] = csv(values[flag]);
  }
  const extra = await jsonObject(values.extra, "--extra");
  if (extra) Object.assign(body, extra);
  return body;
}

function basePath(values) {
  if (values.account) return "/guardrails/policies/account";
  return `/guardrails/policies/${segment(policyType(values))}`;
}

function assignmentPath(kind, id) {
  if (kind === "key") return `/guardrails/policies/assignments/api-keys/${encodeURIComponent(id)}`;
  if (kind === "member")
    return `/guardrails/policies/assignments/members/${encodeURIComponent(id)}`;
  throw new Error('First argument must be "key" or "member"');
}

export async function policiesCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(POLICIES_HELP);
    return sub ? 0 : 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(POLICIES_HELP);
    return 0;
  }

  const { values, positionals } = parseArgs(rest, OPTIONS);
  const opts = { auth: authFromValues(values), requiresManagement: true };

  if (sub === "list") {
    const query = paginationQuery(values);
    if (!values.account) query.workspace_id = workspaceId(values);
    const data = await api("GET", basePath(values), { ...opts, query });
    printResult(data, () => {
      table(data.data || [], [
        { label: "id", value: (p) => p.id },
        { label: "name", value: (p) => p.name },
        { label: "type", value: (p) => p.policy_type },
        {
          label: "default",
          value: (p) => (p.is_default || p.is_workspace_default ? "yes" : ""),
        },
        {
          label: values.account ? "workspaces" : "members/keys",
          value: (p) =>
            values.account
              ? (p.workspace_count ?? "")
              : `${p.member_count ?? 0}/${p.api_key_count ?? 0}`,
        },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    if (values.account) throw new Error("The API has no get for --account policies; use list");
    if (!positionals[0]) throw new Error("id required");
    const data = await api("GET", `${basePath(values)}/${encodeURIComponent(positionals[0])}`, {
      ...opts,
      query: { workspace_id: workspaceId(values) },
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const body = await buildBody(values, { name: positionals[0], includeType: true });
    const data = await api("POST", basePath(values), { ...opts, body });
    printResult(data);
    return 0;
  }

  if (sub === "update") {
    if (!positionals[0]) throw new Error("id required");
    if (!values.name) throw new Error("--name required (PUT replaces name and config)");
    const body = await buildBody(values, { name: values.name, includeType: false });
    const data = await api("PUT", `${basePath(values)}/${encodeURIComponent(positionals[0])}`, {
      ...opts,
      body,
    });
    printResult(data);
    return 0;
  }

  if (sub === "delete") {
    if (!positionals[0]) throw new Error("id required");
    const query = values.account ? undefined : { workspace_id: workspaceId(values) };
    const data = await api("DELETE", `${basePath(values)}/${encodeURIComponent(positionals[0])}`, {
      ...opts,
      query,
    });
    printResult(data, () => outln("deleted"));
    return 0;
  }

  if (sub === "assignment" || sub === "assign") {
    const [kind, id, policyId] = positionals;
    if (!kind || !id) throw new Error(`Usage: ${sub} key|member <hash|user_id>`);
    const path = assignmentPath(kind, id);
    const query = {
      workspace_id: workspaceId(values),
      policy_type: policyType(values, ASSIGNMENT_TYPES),
    };
    const current = await api("GET", path, { ...opts, query });
    if (sub === "assignment") {
      printResult(current);
      return 0;
    }
    if (!policyId) throw new Error("Usage: assign key|member <hash|user_id> <policy_id>");
    const data = await api("PUT", path, {
      ...opts,
      body: {
        ...query,
        policy_id: policyId,
        assigned: !values.unassign,
        expected_assignment: current.data,
      },
    });
    printResult(data, () => outln(values.unassign ? "unassigned" : "assigned"));
    return 0;
  }

  throw new Error(`Unknown guardrails policies subcommand: ${sub}`);
}
