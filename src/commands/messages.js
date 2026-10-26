import {
  parseArgs,
  authFromValues,
  numberOption,
  readStdinIfPiped,
  shouldStream,
  loadJson,
  REQUEST_FIELD_OPTIONS,
  REQUEST_FIELD_HELP,
  applyRequestFields,
} from "../args.js";
import { api, assertNoStreamError, sseStream } from "../api.js";
import { c, info, isJsonMode, out, outln, printJSON } from "../output.js";
import {
  SHARED_OPTIONS,
  SERVER_TOOL_HELP,
  CACHE_HELP,
  ALIGNMENT_HELP,
  applyToolExtras,
  applyCache,
  addAlignmentPlugin,
  printAlignment,
  withAlignmentErrors,
} from "./chat.js";

const HELP = `Usage: openrouter messages [prompt...] [options]

Anthropic-compatible /messages endpoint.

Options:
  -m, --model <id>         Model id (required)
      --models <csv>       Fallback models (comma-separated)
  -s, --system <text>      System prompt
      --max-tokens <n>     (default: 1024)
      --temperature <n>
      --top-p <n>
      --top-k <n>
      --stop <text>        Stop sequence (repeatable via comma)
      --thinking <mode>    adaptive | disabled | between_tools | <budget tokens>
      --thinking-budget <n>  Extended thinking with a token budget
                           (same as --thinking <n>)
      --thinking-display <d>  summarized | omitted | updates (adaptive/budget)
      --effort <e>         low | medium | high | xhigh | max (output_config.effort)
      --speed <s>          fast | standard (fast = premium pricing)
      --tool <json|@file>  Anthropic-shaped tool definition (repeatable).
                           Add "defer_loading": true to load a tool on demand
      --tool-choice <v>    auto | any | none | <tool name>
${SERVER_TOOL_HELP}      --provider <json|@file>  Provider routing (order, only, sort, ...;
                           options: per-provider passthrough keyed by slug)
      --plugins <json|@file>   Plugins array (ids: auto-router, moderation, web,
                           web-fetch, file-parser, response-healing,
                           context-compression, pareto-router, fusion,
                           switchyard-router, jev-router, alignment)
${ALIGNMENT_HELP}      --metadata <json|@file>  e.g. {"user_id":"..."}
${CACHE_HELP}${REQUEST_FIELD_HELP}      --extra <json|@file> Extra fields merged into the request body (last)
      --stream             Stream tokens
      --no-stream
      --raw                Print full JSON response
      --body <json|@file>  Provide a fully-formed body (overrides flags)
`;

const HELP_RESPONSES = `Usage: openrouter responses [prompt...] [options]

OpenAI-compatible /responses endpoint.

Options:
  -m, --model <id>         Model id (required)
  -s, --instructions <t>   System / instructions
      --max-tokens <n>     Sent as max_output_tokens
      --max-tool-calls <n>
      --temperature <n>
      --top-p <n>
      --seed <n>
      --stop <text>        Stop sequence (repeatable via comma, max 4)
      --reasoning <effort> none|minimal|low|medium|high|xhigh|max
      --truncation <t>     auto | disabled
      --models <csv>       Fallback models
      --provider <json|@file>  Provider routing (order, only, sort, ...;
                           options: per-provider passthrough keyed by slug)
      --plugins <json|@file>   Plugins array (ids: auto-router, moderation, web,
                           web-fetch, file-parser, response-healing,
                           context-compression, pareto-router, fusion,
                           switchyard-router, jev-router, alignment)
${ALIGNMENT_HELP}      --metadata <json|@file>  String key/value pairs (max 16)
      --parallel-tools     Enable parallel tool calls
      --tool <json|@file>  Tool definition (repeatable). Function tools can
                           carry "defer_loading": true
      --tool-choice <v>    auto | none | required | <tool name>
${SERVER_TOOL_HELP}      --include <csv>      Extra output fields to include
      --store              Persist the response server-side
      --previous-response-id <id>  Continue a stored response
      --background         Run as a background response
      --prompt-cache-key <k>   Provider prompt-cache key
      --safety-identifier <id> Stable per-end-user id for abuse isolation
${CACHE_HELP}${REQUEST_FIELD_HELP}      --extra <json|@file> Extra fields merged into the request body (last)
      --stream             Stream tokens (default when TTY)
      --no-stream          Disable streaming
      --raw                Print full JSON response
      --body <json|@file>  Provide a fully-formed body (overrides flags)
`;

async function resolvePrompt(values, positionals) {
  if (!values.model) throw new Error("--model is required");
  let prompt = positionals.join(" ").trim();
  const piped = await readStdinIfPiped();
  if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
  if (!prompt) throw new Error("No prompt.");
  return prompt;
}

function applyNumeric(body, values, map) {
  for (const [flag, field] of Object.entries(map)) {
    const n = numberOption(values[flag], `--${flag}`);
    if (n !== undefined) body[field] = n;
  }
}

const csv = (v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// --plugins plus the alignment plugin from --rule/--alignment-*.
async function buildPlugins(values) {
  const plugins = values.plugins ? await loadJson(values.plugins, "--plugins") : [];
  const list = addAlignmentPlugin(Array.isArray(plugins) ? plugins : [plugins], values);
  return list.length ? list : undefined;
}

const THINKING_MODES = ["adaptive", "disabled", "between_tools"];

function buildThinking(values) {
  const mode = values.thinking;
  const display = values["thinking-display"];
  let budget = numberOption(values["thinking-budget"], "--thinking-budget");
  if (mode !== undefined && !THINKING_MODES.includes(mode)) {
    if (!Number.isFinite(Number(mode)) || !mode.trim()) {
      throw new Error(`--thinking must be ${THINKING_MODES.join(" | ")} or a token budget`);
    }
    budget = Number(mode);
  }
  let thinking;
  if (budget !== undefined) thinking = { type: "enabled", budget_tokens: budget };
  else if (mode) thinking = { type: mode };
  if (display) {
    if (!thinking || (thinking.type !== "enabled" && thinking.type !== "adaptive")) {
      throw new Error("--thinking-display needs --thinking adaptive or a budget");
    }
    thinking.display = display;
  }
  return thinking;
}

// Short lines for output items that carry no text, so pretty mode shows
// what happened instead of dumping JSON or printing nothing.
function itemNote(item) {
  if (!item || !item.type) return null;
  if (item.type.endsWith("armor_blocked")) {
    const why = item.reason || item.message || item.category || item.error || "";
    return `[armor blocked]${why ? ` ${typeof why === "string" ? why : JSON.stringify(why)}` : ""}`;
  }
  if (item.type === "openrouter:tool_search") {
    if (item.error) return `[tool search] failed: ${item.error}`;
    const ids = (item.matches || []).map((m) => m.tool_id).join(", ");
    return `[tool search]${item.query ? ` "${item.query}"` : ""} -> ${ids || "no matches"}`;
  }
  if (item.type === "tool_search_call") {
    return `[tool search call] ${typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {})}`;
  }
  return null;
}

export async function messagesCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    system: { type: "string", short: "s" },
    "max-tokens": { type: "string" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    "top-k": { type: "string" },
    stop: { type: "string" },
    thinking: { type: "string" },
    "thinking-budget": { type: "string" },
    "thinking-display": { type: "string" },
    effort: { type: "string" },
    speed: { type: "string" },
    models: { type: "string" },
    provider: { type: "string" },
    plugins: { type: "string" },
    metadata: { type: "string" },
    extra: { type: "string" },
    tool: { type: "string", multiple: true },
    "tool-choice": { type: "string" },
    stream: { type: "boolean" },
    "no-stream": { type: "boolean" },
    raw: { type: "boolean" },
    body: { type: "string" },
    ...SHARED_OPTIONS,
    ...REQUEST_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let body = await loadJson(values.body, "--body");
  if (!body) {
    const prompt = await resolvePrompt(values, positionals);
    body = {
      model: values.model,
      max_tokens: numberOption(values["max-tokens"], "--max-tokens") ?? 1024,
      messages: [{ role: "user", content: prompt }],
    };
    if (values.system) body.system = values.system;
    applyNumeric(body, values, {
      temperature: "temperature",
      "top-p": "top_p",
      "top-k": "top_k",
    });
    if (values.stop) body.stop_sequences = values.stop.split(",");
    const thinking = buildThinking(values);
    if (thinking) body.thinking = thinking;
    if (values.effort) body.output_config = { effort: values.effort };
    if (values.speed) body.speed = values.speed;
    if (values.models) body.models = csv(values.models);
    if (values.provider) body.provider = await loadJson(values.provider, "--provider");
    const plugins = await buildPlugins(values);
    if (plugins) body.plugins = plugins;
    if (values.metadata) body.metadata = await loadJson(values.metadata, "--metadata");
    if (values.tool && values.tool.length) {
      body.tools = [];
      for (const t of values.tool) body.tools.push(await loadJson(t, "--tool"));
    }
    await applyToolExtras(body, values);
    if (values["tool-choice"]) {
      const v = values["tool-choice"];
      body.tool_choice = ["auto", "any", "none"].includes(v)
        ? { type: v }
        : { type: "tool", name: v };
    }
    applyCache(body, values);
    await applyRequestFields(body, values);
    if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));
  }

  if (shouldStream(values)) {
    body.stream = true;
    const res = await withAlignmentErrors(
      api("POST", "/messages", {
        auth: authFromValues(values),
        body,
        raw: true,
        headers: { Accept: "text/event-stream" },
      }),
    );
    let alignment = null;
    for await (const evt of sseStream(res)) {
      assertNoStreamError(evt);
      if (evt.alignment) alignment = evt.alignment;
      else if (evt.message && evt.message.alignment) alignment = evt.message.alignment;
      if (evt.type === "content_block_start" && evt.content_block) {
        const note = itemNote(evt.content_block);
        if (note) out(`${note}\n`);
      }
      if (evt.type === "content_block_delta" && evt.delta) {
        const d = evt.delta;
        if (d.text) out(d.text);
        // Extended-thinking and streamed tool-call args arrive as their own
        // delta types; without these both were silently dropped.
        else if (d.thinking && process.stdout.isTTY) out(c.dim(d.thinking));
        else if (d.partial_json) out(d.partial_json);
      }
    }
    if (process.stdout.isTTY) out("\n");
    printAlignment(alignment);
    return 0;
  }

  const data = await withAlignmentErrors(
    api("POST", "/messages", {
      auth: authFromValues(values),
      body,
    }),
  );
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    printAlignment(data.alignment);
    const blocks = data.content || [];
    for (const b of blocks) {
      if (b.type === "text") outln(b.text);
      else {
        const note = itemNote(b);
        if (note) outln(note);
      }
    }
  }
  return 0;
}

export async function responsesCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    instructions: { type: "string", short: "s" },
    "max-tokens": { type: "string" },
    "max-tool-calls": { type: "string" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    seed: { type: "string" },
    stop: { type: "string" },
    reasoning: { type: "string" },
    models: { type: "string" },
    plugins: { type: "string" },
    metadata: { type: "string" },
    "parallel-tools": { type: "boolean" },
    tool: { type: "string", multiple: true },
    "tool-choice": { type: "string" },
    include: { type: "string" },
    store: { type: "boolean" },
    "previous-response-id": { type: "string" },
    background: { type: "boolean" },
    verbosity: { type: "string" },
    truncation: { type: "string" },
    "prompt-cache-key": { type: "string" },
    "safety-identifier": { type: "string" },
    extra: { type: "string" },
    stream: { type: "boolean" },
    "no-stream": { type: "boolean" },
    raw: { type: "boolean" },
    body: { type: "string" },
    ...SHARED_OPTIONS,
    ...REQUEST_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP_RESPONSES);
    return 0;
  }

  let body = await loadJson(values.body, "--body");
  if (!body) {
    const prompt = await resolvePrompt(values, positionals);
    body = { model: values.model, input: prompt };
    if (values.instructions) body.instructions = values.instructions;
    applyNumeric(body, values, {
      "max-tokens": "max_output_tokens",
      "max-tool-calls": "max_tool_calls",
      temperature: "temperature",
      "top-p": "top_p",
      seed: "seed",
    });
    if (values.stop) body.stop = values.stop.includes(",") ? values.stop.split(",") : values.stop;
    if (values.reasoning) body.reasoning = { effort: values.reasoning };
    if (values.truncation) body.truncation = values.truncation;
    if (values.models) body.models = csv(values.models);
    if (values.provider) body.provider = await loadJson(values.provider, "--provider");
    const plugins = await buildPlugins(values);
    if (plugins) body.plugins = plugins;
    if (values.metadata) body.metadata = await loadJson(values.metadata, "--metadata");
    if (values["parallel-tools"]) body.parallel_tool_calls = true;
    if (values.tool && values.tool.length) {
      body.tools = [];
      for (const t of values.tool) body.tools.push(await loadJson(t, "--tool"));
    }
    await applyToolExtras(body, values);
    if (values["tool-choice"]) {
      const v = values["tool-choice"];
      if (["auto", "none", "required"].includes(v)) body.tool_choice = v;
      else body.tool_choice = { type: "function", name: v };
    }
    if (values.include) body.include = values.include.split(",").map((s) => s.trim());
    if (values.store) body.store = true;
    if (values["previous-response-id"]) body.previous_response_id = values["previous-response-id"];
    if (values.background) body.background = true;
    if (values["prompt-cache-key"]) body.prompt_cache_key = values["prompt-cache-key"];
    if (values["safety-identifier"]) body.safety_identifier = values["safety-identifier"];
    // Explicit mode caches only marked blocks: mark the prompt, which caches
    // the instructions before it too.
    if (applyCache(body, values, { explicit: true }) && typeof body.input === "string") {
      body.input = [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: body.input,
              prompt_cache_breakpoint: { mode: "explicit" },
            },
          ],
        },
      ];
    }
    await applyRequestFields(body, values);
    if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));
  }

  if (shouldStream(values)) {
    body.stream = true;
    const res = await withAlignmentErrors(
      api("POST", "/responses", {
        auth: authFromValues(values),
        body,
        raw: true,
        headers: { Accept: "text/event-stream" },
      }),
    );
    let alignment = null;
    for await (const evt of sseStream(res)) {
      assertNoStreamError(evt);
      if (evt.response && evt.response.alignment) alignment = evt.response.alignment;
      if (evt.type === "response.output_item.done") {
        const note = itemNote(evt.item);
        if (note) out(`${note}\n`);
      }
      if (evt.type && evt.type.endsWith("output_text.delta") && evt.delta) {
        out(evt.delta);
      } else if (
        evt.type &&
        (evt.type.endsWith("reasoning_summary_text.delta") ||
          evt.type.endsWith("reasoning_text.delta")) &&
        evt.delta &&
        process.stdout.isTTY
      ) {
        out(c.dim(evt.delta));
      }
    }
    if (process.stdout.isTTY) out("\n");
    printAlignment(alignment);
    return 0;
  }

  const data = await withAlignmentErrors(
    api("POST", "/responses", {
      auth: authFromValues(values),
      body,
    }),
  );
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    printAlignment(data.alignment);
    const output = Array.isArray(data.output) ? data.output : [];
    const notes = output.map(itemNote).filter(Boolean);
    for (const note of notes) outln(note);
    const text =
      data.output_text ||
      output
        .flatMap((o) =>
          (Array.isArray(o.content) ? o.content : [])
            .filter((c) => c.type === "output_text")
            .map((c) => c.text),
        )
        .join("\n");
    if (text) outln(text);
    else if (!notes.length) outln(JSON.stringify(data));
  }
  return 0;
}
