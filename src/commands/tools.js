import { parseArgs, authFromValues, PAGINATION_OPTIONS, paginationQuery } from "../args.js";
import { api } from "../api.js";
import { c, outln, printResult, table } from "../output.js";

const HELP = `Usage: openrouter tools <subcommand> [options]

Server tools OpenRouter runs for a model (web search, web fetch, shell, ...):
accepted tools[].type spellings, engines with pricing, native support.

Subcommands:
  list [options]      List server tools (default)
  get <name>          One tool by canonical name or alias (web_search -> openrouter:web_search)

list options:
      --offset <n>
      --limit <n>               1-100 (all tools when both are omitted)
      --api-format <f>          responses | chat-completions | anthropic-messages
`;

function engineNames(t) {
  return (t.engines || []).map((e) => e.id || e.name).filter(Boolean);
}

function short(s, n = 60) {
  const v = s || "";
  return v.length > n ? v.slice(0, n - 3) + "..." : v;
}

export async function toolsCommand(argv) {
  if (argv[0] === "help" || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return 0;
  }
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, {
      ...PAGINATION_OPTIONS,
      "api-format": { type: "string" },
    });
    const query = paginationQuery(values);
    if (values["api-format"]) query.api_format = values["api-format"];
    const data = await api("GET", "/tools", { auth: authFromValues(values), query });
    printResult(data, () => {
      table(data.data || [], [
        { label: "id", value: (t) => t.id },
        { label: "name", value: (t) => t.name },
        { label: "status", value: (t) => t.status },
        { label: "engines", value: (t) => engineNames(t).join(",") },
        { label: "summary", value: (t) => short(t.summary) },
      ]);
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("name required");
    // Aliases answer 308 to the canonical URL; fetch follows it.
    const data = await api("GET", `/tools/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
    });
    printResult(data, () => {
      const t = data.data || data;
      outln(`${c.bold(t.id)}  ${t.name || ""}  [${t.status || ""}]`);
      if (t.summary) outln(`  ${t.summary}`);
      if (t.docs_url) outln(`  docs: ${t.docs_url}`);
      if (t.supported_api_formats) outln(`  api formats: ${t.supported_api_formats.join(", ")}`);
      const aliases = (t.aliases || []).map((a) => a.type).filter(Boolean);
      if (aliases.length) outln(`  aliases: ${aliases.join(", ")}`);
      if (t.default_engine) {
        outln(
          `  default engine: ${t.default_engine}${t.fallback_engine ? ` (fallback: ${t.fallback_engine})` : ""}`,
        );
      }
      if (t.native_support && t.native_support.endpoint_count != null) {
        outln(`  native endpoints: ${t.native_support.endpoint_count}`);
      }
      const engines = t.engines || [];
      if (engines.length) {
        outln(c.bold("engines:"));
        table(engines, [
          { label: "id", value: (e) => e.id || "" },
          { label: "name", value: (e) => e.name || "" },
          { label: "executed_by", value: (e) => e.executed_by || "" },
          { label: "byok", value: (e) => e.byok || "" },
          { label: "regions", value: (e) => (e.data_regions || []).join(",") },
        ]);
      }
      outln(c.dim("full detail (schemas, pricing): add --json"));
    });
    return 0;
  }

  throw new Error(`Unknown tools subcommand: ${sub}`);
}
