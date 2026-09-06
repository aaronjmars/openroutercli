import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { parseArgs, authFromValues, numberOption, shouldStream } from "../args.js";
import { api, assertNoStreamError, sseStream } from "../api.js";
import { c, info, isJsonMode, out, outln, printJSON } from "../output.js";

const DEFAULT_MODEL = "openrouter/auto";
const ERROR_FINISH_REASONS = ["error", "content_filter"];

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
      --max-tokens <n>
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
      --tool <file|json>   Tool definition (repeatable). JSON object or @file.json
      --tool-choice <v>    auto | none | required | <tool name>
      --no-parallel-tools  Disable parallel tool calls
      --reasoning <effort> none|minimal|low|medium|high|xhigh|max
      --reasoning-max-tokens <n>  Reasoning token budget (Anthropic-style)
      --reasoning-exclude  Reason internally but omit reasoning from the output
      --provider <json>    Provider routing options as JSON
      --web                Enable the web-search plugin (id: web)
      --web-max-results <n>       Max web results
      --web-search-prompt <text>  Custom web-search prompt
      --pdf-engine <e>     PDF parser engine: mistral-ocr | pdf-text | native
      --plugins <json|@file>      Full plugins array (merged with --web/--pdf-engine)
      --image <url|path>   Attach an image (repeatable). URL or local file
      --file <path>        Attach a file/PDF (repeatable). Local path
      --cache-system       Mark the system prompt as a cache breakpoint
      --cache-user         Mark the user prompt as a cache breakpoint
      --extra <json|@file> Extra fields merged into the request body
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

async function loadJsonOrFile(value) {
  if (value.startsWith("@")) {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(value.slice(1), "utf8");
    return JSON.parse(text);
  }
  if (value.startsWith("{") || value.startsWith("[")) return JSON.parse(value);
  // Bare value: try it as a file path first, then as inline JSON.
  try {
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(value, "utf8");
    return JSON.parse(text);
  } catch {
    return JSON.parse(value);
  }
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

async function buildPlugins(values) {
  const plugins = values.plugins ? await loadJsonOrFile(values.plugins) : [];
  const list = Array.isArray(plugins) ? plugins : [plugins];
  if (values.web || values["web-max-results"] || values["web-search-prompt"]) {
    const web = { id: "web" };
    const n = numberOption(values["web-max-results"], "--web-max-results");
    if (n !== undefined) web.max_results = n;
    if (values["web-search-prompt"]) web.search_prompt = values["web-search-prompt"];
    list.push(web);
  }
  if (values["pdf-engine"]) {
    list.push({ id: "file-parser", pdf: { engine: values["pdf-engine"] } });
  }
  return list;
}

// Wrap a string into a single text content part so a cache_control breakpoint
// can be attached; content already in part form is returned untouched.
function markCache(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  }
  if (Array.isArray(content) && content.length) {
    const parts = content.map((p) => ({ ...p }));
    parts[parts.length - 1].cache_control = { type: "ephemeral" };
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
    const schema = await loadJsonOrFile(values.schema);
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "response", schema, strict: true },
    };
  }
  if (values.tool && values.tool.length) {
    body.tools = [];
    for (const t of values.tool) {
      const def = await loadJsonOrFile(t);
      // Accept either {type, function} or a bare {name, parameters, ...}
      if (def.type && def.function) body.tools.push(def);
      else body.tools.push({ type: "function", function: def });
    }
  }
  if (values["tool-choice"]) {
    const v = values["tool-choice"];
    if (["auto", "none", "required"].includes(v)) body.tool_choice = v;
    else body.tool_choice = { type: "function", function: { name: v } };
  }
  if (values["no-parallel-tools"]) body.parallel_tool_calls = false;
  if (values["logit-bias"]) body.logit_bias = await loadJsonOrFile(values["logit-bias"]);
  if (values.provider) body.provider = await loadJsonOrFile(values.provider);

  const plugins = await buildPlugins(values);
  if (plugins.length) body.plugins = plugins;

  // cache_control breakpoints are attached to message content, so this must
  // run after the messages are assembled.
  if (values["cache-system"]) {
    const sys = body.messages.find((m) => m.role === "system");
    if (sys) sys.content = markCache(sys.content);
  }
  if (values["cache-user"]) {
    for (let i = body.messages.length - 1; i >= 0; i--) {
      if (body.messages[i].role === "user") {
        body.messages[i].content = markCache(body.messages[i].content);
        break;
      }
    }
  }

  if (values.extra) Object.assign(body, await loadJsonOrFile(values.extra));
}

async function buildBody(values, prompt) {
  // --body is a full escape hatch: send it verbatim (still honors --extra).
  if (values.body) {
    const body = await loadJsonOrFile(values.body);
    if (values.extra) Object.assign(body, await loadJsonOrFile(values.extra));
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
  const res = await api("POST", "/chat/completions", {
    auth,
    body: { ...body, stream: true },
    raw: true,
    headers: { Accept: "text/event-stream" },
  });
  let usage = null;
  let model = null;
  let finishReason = null;
  let text = "";
  for await (const evt of sseStream(res)) {
    assertNoStreamError(evt);
    if (evt.usage) usage = evt.usage;
    if (evt.model) model = evt.model;
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
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (process.stdout.isTTY) out("\n");
  return { usage, model, finishReason, text };
}

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
    "pdf-engine": { type: "string" },
    plugins: { type: "string" },
    image: { type: "string", multiple: true },
    file: { type: "string", multiple: true },
    "cache-system": { type: "boolean" },
    "cache-user": { type: "boolean" },
    extra: { type: "string" },
    body: { type: "string" },
    raw: { type: "boolean" },
    usage: { type: "boolean" },
    interactive: { type: "boolean", short: "i" },
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

  const wantsInteractive = values.interactive || (!prompt && stdin.isTTY && stdout.isTTY);

  if (wantsInteractive) {
    return repl(values, auth);
  }

  if (!prompt) {
    throw new Error("No prompt. Pass text, pipe via stdin, or use --interactive.");
  }

  const body = await buildBody(values, prompt);

  if (!shouldStream(values)) {
    const data = await api("POST", "/chat/completions", { auth, body });
    if (isJsonMode() || values.raw) {
      printJSON(data);
    } else {
      const choice = data.choices && data.choices[0];
      const msg = choice && choice.message;
      if (msg && typeof msg.content === "string") outln(msg.content);
      else if (msg && Array.isArray(msg.content)) {
        for (const part of msg.content) if (part.type === "text") outln(part.text);
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
