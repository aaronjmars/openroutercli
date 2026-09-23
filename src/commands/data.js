import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
import { outln, printResult, table } from "../output.js";

async function loadJson(value, flag) {
  if (value == null) return undefined;
  const text = value.startsWith("@")
    ? await (async () => {
        const { readFile } = await import("node:fs/promises");
        return readFile(value.slice(1), "utf8");
      })()
    : value;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON for ${flag}: ${err.message}`);
  }
}

function add(query, key, value) {
  if (value !== undefined) query[key] = value;
}

function addNumber(query, key, value, flag) {
  if (value !== undefined) query[key] = numberOption(value, flag);
}

const BENCHMARK_HELP = `Usage: openrouter benchmarks [options]

List OpenRouter's unified benchmark data. Supports Artificial Analysis, Design
Arena, OpenRouter evaluations, and search benchmarks.

Options:
  --source <name>             artificial-analysis | design-arena
  --task-type <type>          coding | intelligence | agentic | search
  --benchmark-type <type>     Exact OpenRouter benchmark (e.g. search_widesearch)
  --include-run-config        Include published search benchmark run config
  --search-engine <name>      Filter search benchmarks by engine
  --search-surface <name>     server-tool | openai | anthropic
  --arena <name>              models | builders | agents
  --category <name>           Design Arena category
  --max-results <n>
`;

export async function benchmarksCommand(argv) {
  const { values } = parseArgs(argv, {
    source: { type: "string" },
    "task-type": { type: "string" },
    "benchmark-type": { type: "string" },
    "include-run-config": { type: "boolean" },
    "search-engine": { type: "string" },
    "search-surface": { type: "string" },
    arena: { type: "string" },
    category: { type: "string" },
    "max-results": { type: "string" },
  });
  if (values.help) {
    process.stdout.write(BENCHMARK_HELP);
    return 0;
  }
  const query = {};
  add(query, "source", values.source);
  add(query, "task_type", values["task-type"]);
  add(query, "benchmark_type", values["benchmark-type"]);
  if (values["include-run-config"]) query.include_run_config = "true";
  add(query, "search_engine", values["search-engine"]);
  add(query, "search_surface", values["search-surface"]);
  add(query, "arena", values.arena);
  add(query, "category", values.category);
  addNumber(query, "max_results", values["max-results"], "--max-results");
  const data = await api("GET", "/benchmarks", {
    auth: authFromValues(values),
    query,
  });
  printResult(data, () => {
    const rows = data.data || [];
    table(rows, [
      { label: "model", value: (r) => r.display_name || r.model_permaslug || r.model || "" },
      { label: "source", value: (r) => r.source || "" },
      {
        label: "score",
        value: (r) =>
          r.primary_score ??
          r.intelligence_index ??
          r.coding_index ??
          r.agentic_index ??
          r.elo ??
          "",
      },
      { label: "benchmark", value: (r) => r.benchmark_type || r.category || "" },
    ]);
  });
  return 0;
}

const CLASSIFICATIONS_HELP = `Usage: openrouter classifications [options]

Show task-classification market share over the trailing window.

Options:
  --window <window>  Currently only 7d (default: 7d)
`;

export async function classificationsCommand(argv) {
  const { values } = parseArgs(argv, { window: { type: "string" } });
  if (values.help) {
    process.stdout.write(CLASSIFICATIONS_HELP);
    return 0;
  }
  const query = {};
  add(query, "window", values.window);
  const data = await api("GET", "/classifications/task", {
    auth: authFromValues(values),
    query,
  });
  printResult(data, () => {
    const rows = data.data?.classifications || [];
    table(rows, [
      { label: "tag", value: (r) => r.tag || "" },
      { label: "category", value: (r) => r.display_name || "" },
      { label: "macro", value: (r) => r.macro_category || "" },
      { label: "usage", value: (r) => r.usage_share ?? "" },
      { label: "tokens", value: (r) => r.token_share ?? "" },
    ]);
  });
  return 0;
}

const DATASETS_HELP = `Usage: openrouter datasets <subcommand> [options]

Public OpenRouter usage datasets.

Subcommands:
  apps [options]          Top public apps by token usage
  daily [options]         Daily/weekly/monthly model rankings
  session-cost [options] Cost per session by harness and model

apps options:
  --category <name> --subcategory <name> --sort popular|trending
  --start-date <date> --end-date <date> --limit <n> --offset <n>

daily options:
  --start-date <date> --end-date <date> --period day|week|month
  --modality <name> --context-bucket <bucket> --category <name>
  --language-type natural|programming

session-cost options:
  --app-slug <slug> --model <id> --turn-range <range> --limit <n> --offset <n>
`;

function printDataset(data, columns) {
  printResult(data, () => table(data.data || [], columns));
}

export async function datasetsCommand(argv) {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "apps";
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (!argv.length || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(DATASETS_HELP);
    return argv.length ? 0 : 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(DATASETS_HELP);
    return 0;
  }

  if (sub === "apps" || sub === "app-rankings") {
    const { values } = parseArgs(rest, {
      category: { type: "string" },
      subcategory: { type: "string" },
      sort: { type: "string" },
      "start-date": { type: "string" },
      "end-date": { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    });
    const query = {};
    add(query, "category", values.category);
    add(query, "subcategory", values.subcategory);
    add(query, "sort", values.sort);
    add(query, "start_date", values["start-date"]);
    add(query, "end_date", values["end-date"]);
    addNumber(query, "limit", values.limit, "--limit");
    addNumber(query, "offset", values.offset, "--offset");
    const data = await api("GET", "/datasets/app-rankings", {
      auth: authFromValues(values),
      query,
    });
    printDataset(data, [
      { label: "rank", value: (r) => r.rank ?? "" },
      { label: "app", value: (r) => r.app_name || r.app_slug || "" },
      { label: "requests", value: (r) => r.total_requests ?? "" },
      { label: "tokens", value: (r) => r.total_tokens ?? "" },
    ]);
    return 0;
  }

  if (sub === "daily" || sub === "rankings" || sub === "rankings-daily") {
    const { values } = parseArgs(rest, {
      "start-date": { type: "string" },
      "end-date": { type: "string" },
      period: { type: "string" },
      modality: { type: "string" },
      "context-bucket": { type: "string" },
      category: { type: "string" },
      "language-type": { type: "string" },
    });
    const query = {};
    add(query, "start_date", values["start-date"]);
    add(query, "end_date", values["end-date"]);
    add(query, "period", values.period);
    add(query, "modality", values.modality);
    add(query, "context_bucket", values["context-bucket"]);
    add(query, "category", values.category);
    add(query, "language_type", values["language-type"]);
    const data = await api("GET", "/datasets/rankings-daily", {
      auth: authFromValues(values),
      query,
    });
    printDataset(data, [
      { label: "date", value: (r) => r.date || "" },
      { label: "model", value: (r) => r.model_permaslug || r.model || "" },
      { label: "tokens", value: (r) => r.total_tokens ?? "" },
    ]);
    return 0;
  }

  if (sub === "session-cost" || sub === "sessions") {
    const { values } = parseArgs(rest, {
      "app-slug": { type: "string" },
      model: { type: "string" },
      "turn-range": { type: "string" },
      limit: { type: "string" },
      offset: { type: "string" },
    });
    const query = {};
    add(query, "app_slug", values["app-slug"]);
    add(query, "model", values.model);
    add(query, "turn_range", values["turn-range"]);
    addNumber(query, "limit", values.limit, "--limit");
    addNumber(query, "offset", values.offset, "--offset");
    const data = await api("GET", "/datasets/session-cost", {
      auth: authFromValues(values),
      query,
    });
    printDataset(data, [
      { label: "app", value: (r) => r.app_name || r.app_slug || "" },
      { label: "model", value: (r) => r.model_permaslug || r.model || "" },
      { label: "turns", value: (r) => r.turn_range || r.turns || "" },
      {
        label: "median $/session",
        value: (r) => r.median_session_cost_usd ?? r.cost ?? r.total_cost ?? "",
      },
    ]);
    return 0;
  }

  throw new Error(`Unknown datasets subcommand: ${sub}`);
}

const ANALYTICS_HELP = `Usage: openrouter analytics <subcommand> [options]

Management-key analytics. Use the meta subcommand to discover valid metrics,
dimensions, operators, and granularities before querying.

Subcommands:
  meta                    List available analytics fields
  query [options]         Run an analytics query

query options:
  --metrics <name>        Required; repeat or pass comma-separated values
  --dimensions <name>     Repeat or pass comma-separated values
  --filter <json>         Filter object; repeatable or use @file.json
  --granularity <name> --group-limit <n> --limit <n>
  --start <iso> --end <iso>
  --order-by <json> --classifier-dimensions <json>
  --classifier-filters <json> --body <json|@file>
`;

function splitValues(values) {
  return (values || []).flatMap((v) =>
    v
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

export async function analyticsCommand(argv) {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "meta";
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  if (!argv.length || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(ANALYTICS_HELP);
    return argv.length ? 0 : 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(ANALYTICS_HELP);
    return 0;
  }

  if (sub === "meta") {
    const { values } = parseArgs(rest, {});
    const data = await api("GET", "/analytics/meta", {
      auth: authFromValues(values),
      requiresManagement: true,
    });
    printResult(data);
    return 0;
  }

  if (sub === "query") {
    const { values } = parseArgs(rest, {
      metrics: { type: "string", multiple: true },
      dimensions: { type: "string", multiple: true },
      filter: { type: "string", multiple: true },
      granularity: { type: "string" },
      "group-limit": { type: "string" },
      limit: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      "order-by": { type: "string" },
      "classifier-dimensions": { type: "string" },
      "classifier-filters": { type: "string" },
      body: { type: "string" },
    });
    let body = values.body ? await loadJson(values.body, "--body") : {};
    if (!values.body) {
      const metrics = splitValues(values.metrics);
      if (!metrics.length) throw new Error("--metrics is required");
      body.metrics = metrics;
      const dimensions = splitValues(values.dimensions);
      if (dimensions.length) body.dimensions = dimensions;
      if (values.filter)
        body.filters = await Promise.all(values.filter.map((v) => loadJson(v, "--filter")));
      if (values.granularity) body.granularity = values.granularity;
      addNumber(body, "group_limit", values["group-limit"], "--group-limit");
      addNumber(body, "limit", values.limit, "--limit");
      if (values.start || values.end) {
        body.time_range = {};
        add(body.time_range, "start", values.start);
        add(body.time_range, "end", values.end);
      }
      if (values["order-by"]) body.order_by = await loadJson(values["order-by"], "--order-by");
      if (values["classifier-dimensions"])
        body.classifier_dimensions = await loadJson(
          values["classifier-dimensions"],
          "--classifier-dimensions",
        );
      if (values["classifier-filters"])
        body.classifier_filters = await loadJson(
          values["classifier-filters"],
          "--classifier-filters",
        );
    }
    if (!Array.isArray(body.metrics) || body.metrics.length === 0)
      throw new Error("Analytics body must include a non-empty metrics array.");
    const data = await api("POST", "/analytics/query", {
      auth: authFromValues(values),
      requiresManagement: true,
      body,
    });
    printResult(data, () => {
      const result = data.data || {};
      const rows = result.data || [];
      if (!rows.length) {
        outln("(no rows)");
        return;
      }
      const columns = Object.keys(rows[0]).map((key) => ({ label: key, value: (row) => row[key] }));
      table(rows, columns);
    });
    return 0;
  }

  throw new Error(`Unknown analytics subcommand: ${sub}`);
}
