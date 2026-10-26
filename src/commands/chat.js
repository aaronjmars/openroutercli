import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  parseArgs,
  authFromValues,
  numberOption,
  shouldStream,
  loadJson,
  REQUEST_FIELD_OPTIONS,
  REQUEST_FIELD_HELP,
  applyRequestFields,
} from "../args.js";
import { api, assertNoStreamError, sseStream } from "../api.js";
import { c, info, isJsonMode, out, outln, printJSON } from "../output.js";

const DEFAULT_MODEL = "openrouter/auto";
const ERROR_FINISH_REASONS = ["error", "content_filter"];

// ---- Shared by chat, messages and responses (messages.js imports these) ----

export const SHARED_OPTIONS = {
  "server-tool": { type: "string", multiple: true },
  "defer-loading": { type: "boolean" },
  "deferred-tools": { type: "string" },
  cache: { type: "boolean" },
  "cache-ttl": { type: "string" },
  rule: { type: "string", multiple: true },
  "alignment-mode": { type: "string" },
  "alignment-threshold": { type: "string" },
};

export const SERVER_TOOL_HELP = `      --server-tool <name>[=<json|@file>]  OpenRouter server tool (repeatable),
                           sent as {"type":"openrouter:<name>","parameters":{..}}.
                           e.g. web_search, web_fetch, datetime, tool_search,
                           image_generation, fusion, advisor, subagent, bash
      --defer-loading      Mark every --tool as defer_loading (pair with
                           --server-tool tool_search or --deferred-tools)
      --deferred-tools <json|@file>  Router-level deferred tools, e.g.
                           {"protocol":"v1","profile":"portable","validation":
                           "runtime","search":{"type":"bm25","max_results":5}}
                           (search.type: regex | bm25 | custom)
`;

export const CACHE_HELP = `      --cache              Automatic prompt caching (top-level cache_control)
      --cache-ttl <ttl>    5m | 1h (implies --cache). chat/responses also take
                           30m | 12h: OpenAI explicit prompt_cache_options
                           (GPT-5.6+; 12h writes bill higher)
`;

export const ALIGNMENT_HELP = `      --rule <text>        Alignment plugin rule (repeatable, max 128, <=200 chars,
                           one line each). Merged into --plugins
      --alignment-mode <m> enforce (withhold + retry, then error) | audit
      --alignment-threshold <p>  Probability that counts as broken (default 0.7)
`;

// "web_search" | "openrouter:web_search" | "web_search={...}" | "web_search=@f.json"
export async function serverTool(spec) {
  const eq = spec.indexOf("=");
  const name = (eq === -1 ? spec : spec.slice(0, eq)).trim();
  if (!name) throw new Error(`Invalid --server-tool: "${spec}"`);
  const tool = { type: name.includes(":") ? name : `openrouter:${name}` };
  if (eq !== -1) tool.parameters = await loadJson(spec.slice(eq + 1), "--server-tool");
  return tool;
}

// Server tools, defer_loading and router-level deferred_tools. Call after
// body.tools holds the --tool definitions.
export async function applyToolExtras(body, values) {
  if (values["defer-loading"]) {
    if (!body.tools || !body.tools.length) throw new Error("--defer-loading needs --tool");
    body.tools = body.tools.map((t) =>
      !t.type || t.type === "function" || t.type === "custom" || t.input_schema
        ? { ...t, defer_loading: true }
        : t,
    );
  }
  for (const spec of values["server-tool"] || []) {
    (body.tools ||= []).push(await serverTool(spec));
  }
  if (values["deferred-tools"]) {
    body.deferred_tools = await loadJson(values["deferred-tools"], "--deferred-tools");
  }
}

const EXPLICIT_CACHE_TTLS = ["30m", "12h"];

// 5m | 1h: top-level cache_control (Anthropic style). 30m | 12h: OpenAI
// explicit prompt_cache_options, which only caches blocks marked with
// prompt_cache_breakpoint, so the caller must mark one. Returns true for the
// explicit form. `explicit` = the endpoint accepts it (chat, responses).
export function applyCache(body, values, { explicit = false } = {}) {
  if (!values.cache && !values["cache-ttl"]) return false;
  const ttl = values["cache-ttl"];
  if (EXPLICIT_CACHE_TTLS.includes(ttl)) {
    if (!explicit) throw new Error("--cache-ttl 30m|12h works with chat and responses only");
    body.prompt_cache_options = { mode: "explicit", ttl };
    return true;
  }
  if (ttl && ttl !== "5m" && ttl !== "1h") {
    throw new Error(`--cache-ttl must be ${explicit ? "5m, 1h, 30m or 12h" : "5m or 1h"}`);
  }
  body.cache_control = { type: "ephemeral", ...(ttl ? { ttl } : {}) };
  return false;
}

// Adds the alignment plugin from --rule/--alignment-*. An alignment entry
// already in --plugins is extended, since only one is allowed per request.
export function addAlignmentPlugin(list, values) {
  const rules = values.rule || [];
  const mode = values["alignment-mode"];
  const threshold = numberOption(values["alignment-threshold"], "--alignment-threshold");
  if (!rules.length && !mode && threshold === undefined) return list;
  for (const r of rules) {
    if (!r.trim() || r.length > 200 || /[\r\n]/.test(r)) {
      throw new Error(`--rule must be one line of 1-200 chars: ${JSON.stringify(r.slice(0, 40))}`);
    }
  }
  if (mode && mode !== "enforce" && mode !== "audit") {
    throw new Error("--alignment-mode must be enforce or audit");
  }
  let entry = list.find((p) => p && p.id === "alignment");
  if (!entry) {
    entry = { id: "alignment", rules: [] };
    list.push(entry);
  }
  entry.rules = [...(entry.rules || []), ...rules];
  if (!entry.rules.length) throw new Error("--alignment-mode/--alignment-threshold need --rule");
  if (mode) entry.mode = mode;
  if (threshold !== undefined) entry.threshold = threshold;
  return list;
}

function alignmentSummary(alignment) {
  const calls = (alignment && alignment.calls) || [];
  return calls
    .map((call) => {
      let s = `call ${call.call} ${call.outcome}`;
      if (Array.isArray(call.rules)) {
        const broken = call.rules
          .map((r, i) => (r.broken ? i + 1 : 0))
          .filter(Boolean)
          .join(",");
        const maxP = Math.max(...call.rules.map((r) => r.probability || 0));
        s += broken ? ` (broke rule ${broken}, max p=${maxP})` : ` (max p=${maxP})`;
      }
      if (call.reason) s += ` (${call.reason})`;
      return s;
    })
    .join("; ");
}

// One stderr line for a response's alignment result (pretty mode only).
export function printAlignment(alignment) {
  if (alignment && alignment.calls) info(`alignment: ${alignmentSummary(alignment)}`);
}

// An enforce-mode block arrives as an API error carrying
// error.metadata.alignment; say so before the error itself is printed.
export async function withAlignmentErrors(promise) {
  try {
    return await promise;
  } catch (err) {
    const alignment = err && err.body && err.body.error && err.body.error.metadata?.alignment;
    if (alignment && !isJsonMode()) {
      process.stderr.write(`alignment: blocked - ${alignmentSummary(alignment)}\n`);
      const rej = alignment.rejected;
      const text = rej && !Array.isArray(rej) ? rej.content : undefined;
      if (text) process.stderr.write(`alignment: withheld reply: ${text}\n`);
    }
    throw err;
  }
}

const HELP = `Usage: openrouter chat [prompt...] [options]

Send a chat completion. With no prompt and a TTY, starts an interactive REPL.
With no prompt and stdin piped, reads the prompt from stdin.

Options:
  -m, --model <id>         Model id (default: ${DEFAULT_MODEL})
      --models <csv>       Fallback list (comma-separated)
  -s, --system <text>      System message
      --stream             Stream tokens (default when TTY)
      --no-stream          Disable streaming
      --temperature <n>
      --top-p <n>
      --top-k <n>
      --max-tokens <n>     (deprecated upstream; prefer --max-completion-tokens)
      --max-completion-tokens <n>
      --seed <n>
      --stop <text>        Stop sequence (repeatable via comma)
      --frequency-penalty <n>   -2.0 to 2.0
      --presence-penalty <n>    -2.0 to 2.0
      --repetition-penalty <n>  0.0 to 2.0
      --min-p <n>               0.0 to 1.0
      --top-a <n>               0.0 to 1.0
      --logprobs                Return log probabilities
      --top-logprobs <n>        Return top-N logprobs per token (0-20)
      --logit-bias <json|@file> Token bias map
      --json-output        Ask the model for JSON (response_format=json_object)
      --schema <file|json> JSON schema for structured output
      --tool <file|json>   Tool definition (repeatable). JSON object or @file.json.
                           A bare {name, parameters} is wrapped as a function;
                           server tools ({"type":"openrouter:..."}) pass through.
                           Add "defer_loading": true to load a tool on demand
      --tool-choice <v>    auto | none | required | <tool name>
      --no-parallel-tools  Disable parallel tool calls
${SERVER_TOOL_HELP}      --reasoning <effort> none|minimal|low|medium|high|xhigh|max
      --reasoning-max-tokens <n>  Reasoning token budget (Anthropic-style)
      --reasoning-exclude  Reason internally but omit reasoning from the output
      --provider <json|@file>  Provider routing (order, only, sort, ...;
                           options: per-provider passthrough keyed by slug)
      --modalities <csv>   Output modalities: text,image,audio
      --image-config <json|@file>  Image output options, e.g. {"aspect_ratio":"16:9"}
      --prediction <text|@file>    Predicted output (prediction.content) to cut latency
      --prompt-cache-key <k>       Provider prompt-cache key
      --metadata <json|@file>      String key/value pairs (max 16)
${CACHE_HELP}      --cache-system       Mark the system prompt as a cache breakpoint
      --cache-user         Mark the user prompt as a cache breakpoint

Plugins (ids: auto-router, moderation, web, web-fetch, file-parser,
response-healing, context-compression, pareto-router, fusion, switchyard-router,
jev-router, alignment; anything not covered below goes in --plugins):
      --web                Web-search plugin (id: web; deprecated upstream, the
                           newer path is --server-tool web_search)
      --web-max-results <n>       Max web results
      --web-search-prompt <text>  Custom web-search prompt
      --web-engine <e>     native | exa | firecrawl | parallel | perplexity
      --web-domains <csv>  Only search these domains (include_domains)
      --web-exclude <csv>  Never search these domains (exclude_domains)
      --web-fetch          Web-fetch plugin (id: web-fetch)
      --pdf-engine <e>     PDF parser engine: mistral-ocr | pdf-text | native
      --response-healing   Repair malformed JSON output (id: response-healing)
${ALIGNMENT_HELP}      --plugins <json|@file>      Full plugins array (merged with the flags above)

Input / output:
      --image <url|path>   Attach an image (repeatable). URL or local file
      --file <path>        Attach a file/PDF (repeatable). Local path
${REQUEST_FIELD_HELP}      --extra <json|@file> Extra fields merged into the request body
      --body <json|@file>  Fully-formed body (overrides all other flags; one-shot)
      --raw                Print full JSON response (non-streaming; the REPL
                           always streams, so it is ignored there)
      --usage              Print usage info to stderr after completion
      --interactive, -i    Force interactive REPL (needs a terminal).
                           --image applies to the opening turn only.
  -h, --help
`;

async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = "";
  for await (const chunk of stdin) data += chunk;
  return data.trimEnd() || null;
}

// loadJson plus chat's older convenience: a bare value that names a file is
// read as JSON before falling back to inline JSON.
async function loadJsonOrFile(value, flag) {
  if (value.startsWith("@") || value.startsWith("{") || value.startsWith("[")) {
    return loadJson(value, flag);
  }
  let text;
  try {
    const { readFile } = await import("node:fs/promises");
    text = await readFile(value, "utf8");
  } catch {
    return loadJson(value, flag);
  }
  return loadJson(text, flag);
}

const FILE_MIME = {
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
};

async function fileToContent(value) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(value);
  const ext = (value.split(".").pop() || "").toLowerCase();
  const mime = FILE_MIME[ext] || "application/octet-stream";
  const filename = value.split("/").pop() || value;
  return {
    type: "file",
    file: { filename, file_data: `data:${mime};base64,${buf.toString("base64")}` },
  };
}

async function imageToContent(value) {
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) {
    return { type: "image_url", image_url: { url: value } };
  }
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(value);
  const ext = (value.split(".").pop() || "").toLowerCase();
  const mime =
    ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/jpeg";
  return {
    type: "image_url",
    image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
  };
}

const NUMERIC_SAMPLING = {
  temperature: "temperature",
  "top-p": "top_p",
  "top-k": "top_k",
  "max-tokens": "max_tokens",
  "max-completion-tokens": "max_completion_tokens",
  seed: "seed",
  "frequency-penalty": "frequency_penalty",
  "presence-penalty": "presence_penalty",
  "repetition-penalty": "repetition_penalty",
  "min-p": "min_p",
  "top-a": "top_a",
  "top-logprobs": "top_logprobs",
};

function applySamplingOptions(body, values) {
  if (values.models) body.models = values.models.split(",").map((s) => s.trim());
  for (const [flag, field] of Object.entries(NUMERIC_SAMPLING)) {
    const n = numberOption(values[flag], `--${flag}`);
    if (n !== undefined) body[field] = n;
  }
  if (values.stop) body.stop = values.stop.split(",");
  if (values.logprobs) body.logprobs = true;

  const reasoning = {};
  if (values.reasoning) reasoning.effort = values.reasoning;
  const rmax = numberOption(values["reasoning-max-tokens"], "--reasoning-max-tokens");
  if (rmax !== undefined) reasoning.max_tokens = rmax;
  if (values["reasoning-exclude"]) reasoning.exclude = true;
  if (Object.keys(reasoning).length) body.reasoning = reasoning;
}

const csv = (v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

async function buildPlugins(values) {
  const plugins = values.plugins ? await loadJsonOrFile(values.plugins, "--plugins") : [];
  const list = Array.isArray(plugins) ? plugins : [plugins];
  const webFlags = ["web-max-results", "web-search-prompt", "web-engine", "web-domains"];
  if (values.web || values["web-exclude"] || webFlags.some((f) => values[f])) {
    const web = { id: "web" };
    const n = numberOption(values["web-max-results"], "--web-max-results");
    if (n !== undefined) web.max_results = n;
    if (values["web-search-prompt"]) web.search_prompt = values["web-search-prompt"];
    if (values["web-engine"]) web.engine = values["web-engine"];
    if (values["web-domains"]) web.include_domains = csv(values["web-domains"]);
    if (values["web-exclude"]) web.exclude_domains = csv(values["web-exclude"]);
    list.push(web);
  }
  if (values["web-fetch"]) list.push({ id: "web-fetch" });
  if (values["pdf-engine"]) {
    list.push({ id: "file-parser", pdf: { engine: values["pdf-engine"] } });
  }
  if (values["response-healing"]) list.push({ id: "response-healing" });
  return addAlignmentPlugin(list, values);
}

// Wrap a string into a single text content part so a cache breakpoint can be
// attached; content already in part form gets it on its last part. Explicit
// mode uses prompt_cache_breakpoint, which only text parts accept.
function markCache(content, explicit) {
  const mark = explicit
    ? { prompt_cache_breakpoint: { mode: "explicit" } }
    : { cache_control: { type: "ephemeral" } };
  if (typeof content === "string") return [{ type: "text", text: content, ...mark }];
  if (Array.isArray(content) && content.length) {
    const parts = content.map((p) => ({ ...p }));
    const i = explicit ? parts.findLastIndex((p) => p.type === "text") : parts.length - 1;
    if (i !== -1) Object.assign(parts[i], mark);
    return parts;
  }
  return content;
}

async function buildUserContent(values, prompt, withImages) {
  const images = withImages ? values.image || [] : [];
  const files = withImages ? values.file || [] : [];
  if (images.length === 0 && files.length === 0) return prompt;
  const parts = [];
  if (prompt) parts.push({ type: "text", text: prompt });
  for (const img of images) parts.push(await imageToContent(img));
  for (const f of files) parts.push(await fileToContent(f));
  return parts;
}

// Options that apply to the request whichever turn it is, so an interactive
// session is configured the same way a one-shot run is.
async function applyRequestOptions(body, values) {
  applySamplingOptions(body, values);

  if (values["json-output"]) body.response_format = { type: "json_object" };
  if (values.schema) {
    const schema = await loadJsonOrFile(values.schema, "--schema");
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema, strict: true },
    };
  }
  if (values.tool && values.tool.length) {
    body.tools = [];
    for (const t of values.tool) {
      const def = await loadJsonOrFile(t, "--tool");
      // Accept {type:"function", function}, a server tool such as
      // {type:"openrouter:web_search"} (passed through as is), or a bare
      // {name, parameters, ...} function definition.
      if (def.type && (def.function || def.type !== "function")) body.tools.push(def);
      else body.tools.push({ type: "function", function: def });
    }
  }
  await applyToolExtras(body, values);
  if (values["tool-choice"]) {
    const v = values["tool-choice"];
    if (["auto", "none", "required"].includes(v)) body.tool_choice = v;
    else body.tool_choice = { type: "function", function: { name: v } };
  }
  if (values["no-parallel-tools"]) body.parallel_tool_calls = false;
  if (values["logit-bias"])
    body.logit_bias = await loadJsonOrFile(values["logit-bias"], "--logit-bias");
  if (values.provider) body.provider = await loadJsonOrFile(values.provider, "--provider");
  if (values.modalities) body.modalities = csv(values.modalities);
  if (values["image-config"]) {
    body.image_config = await loadJsonOrFile(values["image-config"], "--image-config");
  }
  if (values.prediction) {
    const v = values.prediction;
    const content = v.startsWith("@")
      ? await (await import("node:fs/promises")).readFile(v.slice(1), "utf8")
      : v;
    body.prediction = { type: "content", content };
  }
  if (values["prompt-cache-key"]) body.prompt_cache_key = values["prompt-cache-key"];
  if (values.metadata) body.metadata = await loadJsonOrFile(values.metadata, "--metadata");
  const explicit = applyCache(body, values, { explicit: true });
  await applyRequestFields(body, values);

  const plugins = await buildPlugins(values);
  if (plugins.length) body.plugins = plugins;

  // Cache breakpoints are attached to message content, so this must run after
  // the messages are assembled. Explicit mode caches nothing unmarked, so with
  // no --cache-system/--cache-user it marks the system prompt, else the prompt.
  const sys = body.messages.find((m) => m.role === "system");
  const markSystem = values["cache-system"] || (explicit && !values["cache-user"] && sys);
  const markUser = values["cache-user"] || (explicit && !values["cache-system"] && !sys);
  if (markSystem && sys) sys.content = markCache(sys.content, explicit);
  if (markUser) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (body.messages[i].role === "user") {
        body.messages[i].content = markCache(body.messages[i].content, explicit);
        break;
      }
    }
  }

  if (values.extra) Object.assign(body, await loadJsonOrFile(values.extra, "--extra"));
}

async function buildBody(values, prompt) {
  // --body is a full escape hatch: send it verbatim (still honors --extra).
  if (values.body) {
    const body = await loadJsonOrFile(values.body, "--body");
    if (values.extra) Object.assign(body, await loadJsonOrFile(values.extra, "--extra"));
    return body;
  }
  const messages = [];
  if (values.system) messages.push({ role: "system", content: values.system });
  messages.push({
    role: "user",
    content: await buildUserContent(values, prompt, true),
  });
  const body = { model: values.model || DEFAULT_MODEL, messages };
  await applyRequestOptions(body, values);
  return body;
}

function printUsage(model, usage) {
  info(
    `model=${model || ""} prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} total=${usage.total_tokens}`,
  );
}

async function streamResponse(body, auth) {
  const res = await withAlignmentErrors(
    api("POST", "/chat/completions", {
      auth,
      body: { ...body, stream: true },
      raw: true,
      headers: { Accept: "text/event-stream" },
    }),
  );
  let usage = null;
  let alignment = null;
  let images = 0;
  let model = null;
  let finishReason = null;
  let text = "";
  for await (const evt of sseStream(res)) {
    assertNoStreamError(evt);
    if (evt.usage) usage = evt.usage;
    if (evt.model) model = evt.model;
    if (evt.alignment) alignment = evt.alignment;
    const choice = evt.choices && evt.choices[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message;
    if (!delta) continue;
    if (typeof delta.content === "string") {
      out(delta.content);
      text += delta.content;
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (part.type === "text" && part.text) {
          out(part.text);
          text += part.text;
        }
      }
    }
    if (delta.reasoning) {
      if (process.stdout.isTTY) out(c.dim(delta.reasoning));
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        if (tc.function && tc.function.arguments) out(tc.function.arguments);
      }
    }
    if (Array.isArray(delta.images)) images += delta.images.length;
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (process.stdout.isTTY) out("\n");
  if (images) info(imagesNote(images));
  printAlignment(alignment);
  return { usage, model, finishReason, text };
}

const imagesNote = (n) => `[${n} image(s) returned as data URLs; use --json to get them]`;

export async function chatCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    models: { type: "string" },
    system: { type: "string", short: "s" },
    stream: { type: "boolean" },
    "no-stream": { type: "boolean" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    "top-k": { type: "string" },
    "max-tokens": { type: "string" },
    "max-completion-tokens": { type: "string" },
    seed: { type: "string" },
    stop: { type: "string" },
    "frequency-penalty": { type: "string" },
    "presence-penalty": { type: "string" },
    "repetition-penalty": { type: "string" },
    "min-p": { type: "string" },
    "top-a": { type: "string" },
    logprobs: { type: "boolean" },
    "top-logprobs": { type: "string" },
    "logit-bias": { type: "string" },
    "json-output": { type: "boolean" },
    schema: { type: "string" },
    tool: { type: "string", multiple: true },
    "tool-choice": { type: "string" },
    "no-parallel-tools": { type: "boolean" },
    reasoning: { type: "string" },
    "reasoning-max-tokens": { type: "string" },
    "reasoning-exclude": { type: "boolean" },
    provider: { type: "string" },
    web: { type: "boolean" },
    "web-max-results": { type: "string" },
    "web-search-prompt": { type: "string" },
    "web-engine": { type: "string" },
    "web-domains": { type: "string" },
    "web-exclude": { type: "string" },
    "web-fetch": { type: "boolean" },
    "pdf-engine": { type: "string" },
    "response-healing": { type: "boolean" },
    plugins: { type: "string" },
    modalities: { type: "string" },
    "image-config": { type: "string" },
    prediction: { type: "string" },
    "prompt-cache-key": { type: "string" },
    metadata: { type: "string" },
    image: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    "cache-system": { type: "boolean" },
    "cache-user": { type: "boolean" },
    extra: { type: "string" },
    body: { type: "string" },
    raw: { type: "boolean" },
    usage: { type: "boolean" },
    interactive: { type: "boolean", short: "i" },
    ...SHARED_OPTIONS,
    ...REQUEST_FIELD_OPTIONS,
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const auth = authFromValues(values);

  // Must precede readStdinIfPiped: that call drains stdin, which would leave
  // the REPL's readline with an exhausted stream and no way to report why.
  if (values.interactive && !stdin.isTTY) {
    throw new Error(
      "--interactive needs a terminal on stdin. To send piped input as a " +
        'single prompt, drop -i: echo "hi" | openrouter chat',
    );
  }

  const piped = await readStdinIfPiped();
  let prompt = positionals.join(" ").trim();
  if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;

  const wantsInteractive =
    values.interactive || (!prompt && !values.body && stdin.isTTY && stdout.isTTY);

  if (wantsInteractive) {
    return repl(values, auth);
  }

  // --body carries its own messages, so it needs no prompt.
  if (!prompt && !values.body) {
    throw new Error("No prompt. Pass text, pipe via stdin, or use --interactive.");
  }

  const body = await buildBody(values, prompt);

  if (!shouldStream(values)) {
    const data = await withAlignmentErrors(api("POST", "/chat/completions", { auth, body }));
    if (isJsonMode() || values.raw) {
      printJSON(data);
    } else {
      const choice = data.choices && data.choices[0];
      const msg = choice && choice.message;
      const images = msg && Array.isArray(msg.images) ? msg.images.length : 0;
      if (images) info(imagesNote(images));
      printAlignment(data.alignment);
      if (msg && typeof msg.content === "string") {
        if (msg.content || !images) outln(msg.content);
      } else if (msg && Array.isArray(msg.content)) {
        for (const part of msg.content) if (part.type === "text") outln(part.text);
      } else if (choice && choice.finish_reason === "length") {
        process.stderr.write(
          "warning: no output, hit max_tokens (reasoning models may spend the budget thinking)\n",
        );
      } else outln(JSON.stringify(data));
      if (values.usage && data.usage) printUsage(data.model, data.usage);
    }
    const finish = data.choices && data.choices[0] && data.choices[0].finish_reason;
    if (ERROR_FINISH_REASONS.includes(finish)) {
      process.stderr.write(`error: generation stopped (${finish})\n`);
      return 2;
    }
    return 0;
  }

  const meta = await streamResponse(body, auth);
  if (values.usage && meta.usage) printUsage(meta.model, meta.usage);
  if (ERROR_FINISH_REASONS.includes(meta.finishReason)) {
    process.stderr.write(`error: generation stopped (${meta.finishReason})\n`);
    return 2;
  }
  return 0;
}

async function repl(values, auth) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history = [];
  if (values.system) history.push({ role: "system", content: values.system });
  outln(c.dim("OpenRouter chat. /exit to quit, /reset to clear history, /model <id> to switch."));
  let model = values.model || DEFAULT_MODEL;
  outln(c.dim(`model: ${model}`));
  let firstTurn = true;
  try {
    while (true) {
      let line;
      try {
        line = await rl.question(c.cyan("› "));
      } catch {
        return 0;
      }
      if (line == null) return 0;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "/exit" || trimmed === "/quit") return 0;
      if (trimmed === "/reset") {
        history.length = 0;
        if (values.system) history.push({ role: "system", content: values.system });
        firstTurn = true;
        outln(c.dim("(history cleared)"));
        continue;
      }
      if (trimmed.startsWith("/model ")) {
        model = trimmed.slice(7).trim();
        outln(c.dim(`model: ${model}`));
        continue;
      }
      // --image attaches to the opening turn only; resending it every turn
      // would re-upload the same attachment.
      history.push({
        role: "user",
        content: await buildUserContent(values, trimmed, firstTurn),
      });
      const body = { model, messages: history };
      await applyRequestOptions(body, values);
      try {
        const meta = await streamResponse(body, auth);
        history.push({ role: "assistant", content: meta.text });
        firstTurn = false;
        if (values.usage && meta.usage) printUsage(meta.model, meta.usage);
        if (ERROR_FINISH_REASONS.includes(meta.finishReason)) {
          outln(c.red(`generation stopped (${meta.finishReason})`));
        }
      } catch (err) {
        outln(c.red(err.message));
        // Drop the orphaned user message so the next turn doesn't send a
        // [..., user, user] sequence the API will reject.
        history.pop();
      }
    }
  } finally {
    rl.close();
  }
}

export const completeCommand = chatCommand;
