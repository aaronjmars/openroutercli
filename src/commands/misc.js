import {
  parseArgs,
  authFromValues,
  numberOption,
  PAGINATION_OPTIONS,
  paginationQuery,
} from "../args.js";
import { api, APIError } from "../api.js";
import { outln, printResult, table } from "../output.js";

// Org-only endpoints answer a personal account with an error (404 or a
// message naming organization accounts). Add a plain hint to it.
async function orgOnly(promise) {
  try {
    return await promise;
  } catch (err) {
    if (
      err instanceof APIError &&
      (err.status === 404 || /organi[sz]ation/i.test(err.message || ""))
    ) {
      err.message +=
        "\nHint: your management key belongs to a personal account. Switch to an" +
        " organization in the OpenRouter dashboard and create the management key there.";
    }
    throw err;
  }
}

async function orgSettingsCommand(argv) {
  const { values } = parseArgs(argv, {
    "filtered-catalog": { type: "string" },
  });
  if (values.help) {
    process.stdout.write(
      "Usage: openrouter org settings [--filtered-catalog true|false]\n\n" +
        "Show organization settings, or change them. Organization accounts only;\n" +
        "requires a management key.\n\n" +
        "Options:\n" +
        "  --filtered-catalog <bool>  When true, GET /models with an org API key returns\n" +
        "                             only the models that key can use (the models user\n" +
        "                             catalog), and the dashboard shows the same list.\n",
    );
    return 0;
  }
  const opts = { auth: authFromValues(values), requiresManagement: true };
  let data;
  if (values["filtered-catalog"] !== undefined) {
    const v = values["filtered-catalog"].toLowerCase();
    if (v !== "true" && v !== "false") throw new Error("--filtered-catalog must be true or false");
    data = await orgOnly(
      api("PATCH", "/organization/settings", {
        ...opts,
        body: { is_filtered_model_catalog_enabled: v === "true" },
      }),
    );
  } else {
    data = await orgOnly(api("GET", "/organization/settings", opts));
  }
  printResult(data, () => {
    const d = data.data || data;
    for (const [k, v] of Object.entries(d)) outln(`${k}: ${v}`);
  });
  return 0;
}

async function orgMembersCommand(argv) {
  const { values } = parseArgs(argv, PAGINATION_OPTIONS);
  if (values.help) {
    process.stdout.write(
      "Usage: openrouter org members [--offset N] [--limit N]\n\nList organization members. Requires a management key.\n",
    );
    return 0;
  }
  const query = paginationQuery(values);
  const data = await orgOnly(
    api("GET", "/organization/members", {
      auth: authFromValues(values),
      requiresManagement: true,
      query,
    }),
  );
  printResult(data, () => {
    const rows = data.data || [];
    table(rows, [
      { label: "user_id", value: (m) => m.user_id || m.id || "" },
      { label: "email", value: (m) => m.email || "" },
      { label: "role", value: (m) => m.role || "" },
      { label: "name", value: (m) => m.name || "" },
    ]);
  });
  return 0;
}

export async function orgCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === "members") return orgMembersCommand(rest);
  if (sub === "settings") return orgSettingsCommand(rest);
  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(
      "Usage: openrouter org <subcommand>\n\n" +
        "Organization accounts only; requires a management key.\n\n" +
        "Subcommands:\n" +
        "  members [--offset N] [--limit N]         List organization members\n" +
        "  settings [--filtered-catalog true|false] Show or change organization settings\n",
    );
    return sub ? 0 : 1;
  }
  throw new Error(`Unknown org subcommand: ${sub}`);
}

export async function zdrCommand(argv) {
  const { values } = parseArgs(argv, {});
  if (values.help) {
    process.stdout.write(
      "Usage: openrouter zdr\n\nPreview the impact of Zero Data Retention on the available endpoints.\n",
    );
    return 0;
  }
  const data = await api("GET", "/endpoints/zdr", {
    auth: authFromValues(values),
  });
  printResult(data);
  return 0;
}

export async function authCodeCommand(argv) {
  const { values } = parseArgs(argv, {
    "callback-url": { type: "string" },
    "code-challenge": { type: "string" },
    "code-challenge-method": { type: "string" },
    "expires-at": { type: "string" },
    "key-label": { type: "string" },
    limit: { type: "string" },
    "usage-limit-type": { type: "string" },
    workspace: { type: "string" },
  });
  if (values.help || !values["callback-url"]) {
    process.stdout.write(
      "Usage: openrouter auth-code --callback-url <url> [options]\n\n" +
        "Mint a PKCE authorization code so a user can claim a key for your app.\n" +
        "Requires a management key.\n\n" +
        "Options:\n" +
        "  --callback-url <url>           https URL, or localhost/127.0.0.1 on any port (required)\n" +
        "  --code-challenge <s>           PKCE challenge\n" +
        "  --code-challenge-method <m>    S256 | plain\n" +
        "  --expires-at <iso>             ISO 8601 UTC expiry with seconds (2027-12-31T23:59:59Z)\n" +
        "  --key-label <text>             Custom label for the resulting key\n" +
        "  --limit <usd>                  Credit limit\n" +
        "  --usage-limit-type <p>         daily | weekly | monthly\n" +
        "  --workspace <uuid>             Workspace the resulting key belongs to\n",
    );
    return values.help ? 0 : 1;
  }
  const body = { callback_url: values["callback-url"] };
  if (values["code-challenge"]) body.code_challenge = values["code-challenge"];
  if (values["code-challenge-method"]) body.code_challenge_method = values["code-challenge-method"];
  if (values["expires-at"]) body.expires_at = values["expires-at"];
  if (values["key-label"]) body.key_label = values["key-label"];
  if (values.limit) body.limit = numberOption(values.limit, "--limit");
  if (values["usage-limit-type"]) body.usage_limit_type = values["usage-limit-type"];
  if (values.workspace) body.workspace_id = values.workspace;
  const data = await api("POST", "/auth/keys/code", {
    auth: authFromValues(values),
    requiresManagement: true,
    body,
  });
  printResult(data);
  return 0;
}
