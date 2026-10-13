import { writeFile } from "node:fs/promises";
import { parseArgs, authFromValues, numberOption, loadJson, readStdinIfPiped } from "../args.js";
import { api, APIError } from "../api.js";
import { c, info, isJsonMode, outln, printJSON, printResult, table } from "../output.js";

const HELP = `Usage: openrouter batches <subcommand> [options]

Run many requests asynchronously against one endpoint and model (Batch API).

Subcommands:
  list [options]                  List batches (newest first)
  create [options]                Submit a batch
  get <id>                        Status, request counts and usage
  wait <id> [options]             Poll until the batch reaches a final status
  results <id> [-o out.jsonl]     Write the per-request results as JSONL
  delete <id>                     Delete a finished batch and its stored data

list options:
      --limit <n>               1-100
      --after <id>              Next page: the previous page's last_id
      --status <s>              validating | in_progress | completed | failed |
                                expired | cancelled (repeat or comma-separate)
      --created-after <t>       Unix seconds, YYYY-MM-DD or ISO date-time
      --created-before <t>

create options:
  -m, --model <id>              Model for every request (required)
      --endpoint <e>            chat | responses | messages | embeddings (default: chat)
      --file <path>             JSONL, one request per line: {"custom_id": "...", "body": {...}}
                                (a line without "body" is used as the body itself and
                                gets custom_id req-<n>). Reads stdin when omitted.
      --completion-window <w>   Default: 24h
      --provider <json|@file>   Routing: {"only": [...], "allow_fallbacks": false}
      --only <csv>              Shortcut for provider.only
      --no-fallbacks            Shortcut for provider.allow_fallbacks = false

wait options:
      --interval <s>            Seconds between polls (default: 10)
      --timeout <s>             Give up after this many seconds (default: 86400)

results options:
  -o, --out <path>              Output file (default: stdout)

Statuses: validating, in_progress, finalizing, completed, failed, expired,
cancelling, cancelled. Final ones: completed, failed, expired, cancelled.
There is no cancel endpoint. Results are kept for 30 days.

Examples:
  openrouter batches create -m openai/gpt-5-nano --file reqs.jsonl
  openrouter batches wait batch_abc && openrouter batches results batch_abc -o out.jsonl
`;

const ENDPOINTS = {
  chat: "/v1/chat/completions",
  "chat-completions": "/v1/chat/completions",
  responses: "/v1/responses",
  messages: "/v1/messages",
  embeddings: "/v1/embeddings",
  embed: "/v1/embeddings",
};

const TERMINAL_STATUSES = ["completed", "failed", "expired", "cancelled"];
const FAILED_STATUSES = ["failed", "expired", "cancelled"];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function csv(values) {
  return [values]
    .flat()
    .flatMap((v) => String(v).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveEndpoint(value) {
  const v = value || "chat";
  if (v.startsWith("/")) return v;
  const mapped = ENDPOINTS[v];
  if (!mapped) {
    throw new Error(`Unknown --endpoint: ${v} (use chat, responses, messages or embeddings)`);
  }
  return mapped;
}

function parseRequests(text, source) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error(`No requests found in ${source}`);
  let items;
  if (trimmed.startsWith("[")) {
    try {
      items = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`Invalid JSON in ${source}: ${err.message}`);
    }
  } else {
    items = [];
    const lines = trimmed.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        items.push(JSON.parse(line));
      } catch (err) {
        throw new Error(`Invalid JSON on line ${i + 1} of ${source}: ${err.message}`);
      }
    }
  }
  return items.map((item, i) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`Request ${i + 1} in ${source} is not a JSON object`);
    }
    if (item.body && typeof item.body === "object") {
      return { custom_id: String(item.custom_id ?? `req-${i + 1}`), body: item.body };
    }
    return { custom_id: `req-${i + 1}`, body: item };
  });
}

function fmtTime(t) {
  if (t == null) return "";
  const n = Number(t);
  if (!Number.isFinite(n)) return String(t);
  return new Date(n < 1e12 ? n * 1000 : n).toISOString().replace(".000Z", "Z");
}

function counts(b) {
  const rc = b.request_counts || {};
  return `${rc.completed ?? 0}/${rc.failed ?? 0}/${rc.total ?? 0}`;
}

function printBatch(b) {
  printResult(b, () => {
    outln(`${c.bold("batch:")} ${b.id}`);
    outln(`  status: ${b.status}`);
    outln(`  model: ${b.model}`);
    outln(`  endpoint: ${b.endpoint}`);
    outln(`  requests (completed/failed/total): ${counts(b)}`);
    outln(`  created: ${fmtTime(b.created_at)}`);
    if (b.finalized_at) outln(`  finalized: ${fmtTime(b.finalized_at)}`);
    if (b.usage) {
      const u = b.usage;
      const parts = [];
      if (u.prompt_tokens != null) parts.push(`prompt ${u.prompt_tokens}`);
      if (u.completion_tokens != null) parts.push(`completion ${u.completion_tokens}`);
      if (u.cost != null)
        parts.push(`cost $${Number(u.cost).toFixed(Number(u.cost) < 0.001 ? 7 : 4)}`);
      if (parts.length) outln(`  usage: ${parts.join(", ")}`);
    }
    if (b.error && b.error.message) outln(`  ${c.red("error:")} ${b.error.message}`);
    if (Array.isArray(b.results)) {
      outln(`  results: ${b.results.length} (openrouter batches results ${b.id} -o out.jsonl)`);
    }
  });
}

// 410 and 402 carry a useful meaning the generic API message hides.
async function getBatch(id, values) {
  try {
    return await api("GET", `/batches/${encodeURIComponent(id)}`, {
      auth: authFromValues(values),
    });
  } catch (err) {
    if (err instanceof APIError && err.status === 410) {
      throw new APIError(`batch expired (results retained 30 days): ${id}`, err);
    }
    if (err instanceof APIError && err.status === 402) {
      throw new APIError(
        `${err.message}\nThe batch cost exceeds your balance. Top up credits, then poll again to get the results.`,
        err,
      );
    }
    throw err;
  }
}

export async function batchesCommand(argv) {
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
      limit: { type: "string" },
      after: { type: "string" },
      status: { type: "string", multiple: true },
      "created-after": { type: "string" },
      "created-before": { type: "string" },
    });
    const query = {};
    if (values.limit !== undefined) query.limit = numberOption(values.limit, "--limit");
    if (values.after) query.after = values.after;
    if (values.status) query.status = csv(values.status);
    if (values["created-after"]) query.created_after = values["created-after"];
    if (values["created-before"]) query.created_before = values["created-before"];
    const data = await api("GET", "/batches", { auth: authFromValues(values), query });
    printResult(data, () => {
      const rows = data.data || [];
      if (!rows.length) {
        outln("no batches");
        return;
      }
      table(rows, [
        { label: "id", value: (b) => b.id },
        { label: "status", value: (b) => b.status },
        { label: "model", value: (b) => b.model },
        { label: "endpoint", value: (b) => b.endpoint },
        { label: "done/failed/total", value: counts },
        { label: "created", value: (b) => fmtTime(b.created_at) },
      ]);
      if (data.has_more && data.last_id) info(`more: --after ${data.last_id}`);
    });
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      model: { type: "string", short: "m" },
      endpoint: { type: "string" },
      file: { type: "string" },
      "completion-window": { type: "string" },
      provider: { type: "string" },
      only: { type: "string" },
      "no-fallbacks": { type: "boolean" },
    });
    if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
    if (!values.model) throw new Error("--model is required");
    let text;
    let source;
    if (values.file && values.file !== "-") {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(values.file, "utf8");
      source = values.file;
    } else {
      text = await readStdinIfPiped();
      source = "stdin";
      if (!text) throw new Error("No requests: pass --file reqs.jsonl or pipe JSONL on stdin");
    }
    const requests = parseRequests(text, source);

    let provider = values.provider ? await loadJson(values.provider, "--provider") : undefined;
    if (values.only || values["no-fallbacks"]) provider = { ...(provider || {}) };
    if (values.only) provider.only = csv(values.only);
    if (values["no-fallbacks"]) provider.allow_fallbacks = false;

    // The API rejects bodies where `requests` comes before the other fields,
    // so build the object in this exact key order.
    const body = { endpoint: resolveEndpoint(values.endpoint), model: values.model };
    if (provider) body.provider = provider;
    if (values["completion-window"]) body.completion_window = values["completion-window"];
    body.requests = requests;

    const data = await api("POST", "/batches", { auth: authFromValues(values), body });
    printBatch(data);
    info(`Submitted ${requests.length} request(s). Next: openrouter batches wait ${data.id}`);
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    printBatch(await getBatch(positionals[0], values));
    return 0;
  }

  if (sub === "wait") {
    const { values, positionals } = parseArgs(rest, {
      interval: { type: "string" },
      timeout: { type: "string" },
    });
    if (!positionals[0]) throw new Error("id required");
    const interval = (numberOption(values.interval, "--interval") ?? 10) * 1000;
    const timeout = (numberOption(values.timeout, "--timeout") ?? 86400) * 1000;
    if (interval <= 0) throw new Error("--interval must be greater than 0");
    if (timeout <= 0) throw new Error("--timeout must be greater than 0");
    const start = Date.now();
    let last;
    while (true) {
      const data = await getBatch(positionals[0], values);
      const status = data.status;
      const line = `status: ${status} (${counts(data)} completed/failed/total)`;
      if (line !== last) info(line);
      last = line;
      if (TERMINAL_STATUSES.includes(status)) {
        printBatch(data);
        return FAILED_STATUSES.includes(status) ? 4 : 0;
      }
      if (Date.now() - start > timeout) throw new Error("timeout waiting for batch");
      await sleep(interval);
    }
  }

  if (sub === "results") {
    const { values, positionals } = parseArgs(rest, {
      out: { type: "string", short: "o" },
    });
    if (!positionals[0]) throw new Error("id required");
    const data = await getBatch(positionals[0], values);
    if (!Array.isArray(data.results)) {
      if (!TERMINAL_STATUSES.includes(data.status)) {
        throw new Error(
          `batch is not finished (status: ${data.status}). Run: openrouter batches wait ${positionals[0]}`,
        );
      }
      const why = data.error && data.error.message ? `: ${data.error.message}` : "";
      throw new Error(`batch ${data.status} with no results${why}`);
    }
    const results = data.results;
    const failed = results.filter((r) => r.error).length;
    const out = values.out;
    if (!out || out === "-") {
      if (isJsonMode()) printJSON(results);
      else for (const r of results) outln(JSON.stringify(r));
      return 0;
    }
    const jsonl = results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : "");
    await writeFile(out, jsonl);
    if (isJsonMode()) printJSON({ saved: out, results: results.length, failed });
    else info(`Wrote ${results.length} result(s) to ${out} (${failed} failed)`);
    return 0;
  }

  if (sub === "delete") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("id required");
    const id = positionals[0];
    let data;
    try {
      data = await api("DELETE", `/batches/${encodeURIComponent(id)}`, {
        auth: authFromValues(values),
      });
    } catch (err) {
      if (err instanceof APIError && err.status === 409) {
        throw new APIError(
          `${err.message}\nOnly finished batches can be deleted: run \`openrouter batches wait ${id}\`, then delete again.`,
          err,
        );
      }
      throw err;
    }
    printResult(data, () => {
      const up = data && data.deletion && data.deletion.upstream;
      outln(`deleted ${id}${up ? ` (upstream ${up.provider}: ${up.status})` : ""}`);
    });
    return 0;
  }

  throw new Error(`Unknown batches subcommand: ${sub}`);
}
