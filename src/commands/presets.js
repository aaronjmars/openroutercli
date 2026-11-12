import {
  parseArgs,
  authFromValues,
  loadJson,
  PAGINATION_OPTIONS,
  paginationQuery,
} from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter presets <subcommand> [options]

View, create, archive and restore server-saved config presets.

Subcommands:
  list [--offset N] [--limit N]   List presets (default)
  get <slug>                      Get a single preset
  versions <slug> [--offset N] [--limit N]
                                  List versions for a preset
  version <slug> <version>        Get a specific preset version
  create <slug> --body <json|@file> [--api chat|messages|responses]
                                  Create a preset from an inference request body.
                                  An existing slug gets a new version.
  delete <slug>                   Archive a preset: it stops resolving for
                                  inference and is hidden from get and list.
                                  Versions are kept and the slug stays taken.
  restore <slug>                  Re-activate an archived preset (no new version;
                                  the designated version is unchanged)

create, delete and restore need a read-write management key (inference keys
are rejected). A disabled preset returns 409 on delete and restore.

Options (every subcommand):
      --workspace <uuid>    Workspace to act in (default: the key's workspace
                            for a key limited to one, else the account default)

create options:
      --body <json|@file>   A normal request body for that API. Only preset fields
                            (model, provider, sampling params, ...) are kept;
                            messages, input and stream are ignored.
      --api <a>             chat (default) | messages | responses

Examples:
  openrouter presets create fast-cheap --body '{"model":"openai/gpt-5-nano","temperature":0.2,"provider":{"sort":"price"}}'
  openrouter presets delete fast-cheap && openrouter presets restore fast-cheap
`;

const PRESET_APIS = {
  chat: "chat/completions",
  "chat-completions": "chat/completions",
  messages: "messages",
  responses: "responses",
};

// The inference schemas require messages even though preset creation ignores
// them, so a config-only body gets a placeholder.
export function buildPresetBody(apiName, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("--body must be a JSON object");
  }
  const out = { ...body };
  if (apiName !== "responses" && !out.messages) {
    out.messages = [{ role: "user", content: "." }];
  }
  return out;
}

const WORKSPACE_OPTION = { workspace: { type: "string" } };

function workspaceQuery(values, query = {}) {
  if (values.workspace) query.workspace_id = values.workspace;
  return Object.keys(query).length ? query : undefined;
}

export async function presetsCommand(argv) {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (!argv.length || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return argv[0] ? 0 : 1;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, WORKSPACE_OPTION);
    if (!positionals[0]) throw new Error("slug required");
    const data = await api("GET", `/presets/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      query: workspaceQuery(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "delete" || sub === "restore") {
    const { values, positionals } = parseArgs(rest, WORKSPACE_OPTION);
    const slug = positionals[0];
    if (!slug) throw new Error("slug required");
    const path =
      sub === "delete"
        ? `/presets/${encodeURIComponent(slug)}`
        : `/presets/${encodeURIComponent(slug)}/restore`;
    const data = await api(sub === "delete" ? "DELETE" : "POST", path, {
      auth: authFromValues(values),
      requiresManagement: true,
      query: workspaceQuery(values),
    });
    printResult(data, () => {
      const p = data && (data.data || data);
      outln(`${sub === "delete" ? "archived" : "restored"} preset ${(p && p.slug) || slug}`);
    });
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      body: { type: "string" },
      api: { type: "string" },
      ...WORKSPACE_OPTION,
    });
    const slug = positionals[0];
    if (!slug) throw new Error("slug required");
    if (!values.body) throw new Error("--body is required");
    const apiName = values.api || "chat";
    const route = PRESET_APIS[apiName];
    if (!route) throw new Error(`Unknown --api: ${apiName} (use chat, messages or responses)`);
    const body = buildPresetBody(apiName, await loadJson(values.body, "--body"));
    const data = await api("POST", `/presets/${encodeURIComponent(slug)}/${route}`, {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
      query: workspaceQuery(values),
    });
    printResult(data, () => {
      const p = data && (data.data || data);
      const dv = (p && p.designated_version) || {};
      const version = dv.version ?? dv.version_number ?? dv.id;
      outln(
        `saved preset ${(p && p.slug) || slug}${version != null ? ` (version ${version})` : ""}`,
      );
    });
    return 0;
  }

  if (sub === "versions") {
    const { values, positionals } = parseArgs(rest, { ...PAGINATION_OPTIONS, ...WORKSPACE_OPTION });
    if (!positionals[0]) throw new Error("slug required");
    const data = await api("GET", `/presets/${encodeURIComponent(positionals[0])}/versions`, {
      auth: authFromValues(values),
      query: workspaceQuery(values, paginationQuery(values)),
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "version", value: (v) => v.version ?? "" },
        { label: "created", value: (v) => v.created ?? "" },
      ]);
    });
    return 0;
  }

  if (sub === "version") {
    const { values, positionals } = parseArgs(rest, WORKSPACE_OPTION);
    if (!positionals[0]) throw new Error("slug required");
    if (!positionals[1]) throw new Error("version required");
    const data = await api(
      "GET",
      `/presets/${encodeURIComponent(positionals[0])}/versions/${encodeURIComponent(positionals[1])}`,
      { auth: authFromValues(values), query: workspaceQuery(values) },
    );
    printResult(data);
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, { ...PAGINATION_OPTIONS, ...WORKSPACE_OPTION });
    const data = await api("GET", "/presets", {
      auth: authFromValues(values),
      query: workspaceQuery(values, paginationQuery(values)),
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "slug", value: (p) => p.slug || p.id || "" },
        { label: "name", value: (p) => p.name || "" },
        { label: "model", value: (p) => p.model || "" },
        {
          label: "description",
          value: (p) => {
            const d = p.description || "";
            return d.length > 60 ? d.slice(0, 57) + "..." : d;
          },
        },
      ]);
    });
    return 0;
  }

  throw new Error(`Unknown presets subcommand: ${sub}`);
}
