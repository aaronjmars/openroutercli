import {
  parseArgs,
  authFromValues,
  numberOption,
  readStdinIfPiped,
  shouldStream,
} from "../args.js";
import { api, assertNoStreamError, sseStream } from "../api.js";
import { c, isJsonMode, out, outln, printJSON } from "../output.js";

const HELP = `Usage: openrouter messages [prompt...] [options]

Anthropic-compatible /messages endpoint.

Options:
  -m, --model <id>         Model id (required)
  -s, --system <text>      System prompt
      --max-tokens <n>     (default: 1024)
      --temperature <n>
      --top-p <n>
      --top-k <n>
      --stop <text>        Stop sequence (repeatable via comma)
      --thinking-budget <n>  Enable extended thinking with a token budget
      --tool <json|@file>  Anthropic-shaped tool definition (repeatable)
      --tool-choice <v>    auto | any | <tool name>
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
      --temperature <n>
      --top-p <n>
      --seed <n>
      --reasoning <effort> none|minimal|low|medium|high|xhigh|max
      --tool <json|@file>  Tool definition (repeatable)
      --tool-choice <v>    auto | none | required | <tool name>
      --include <csv>      Extra output fields to include
      --store              Persist the response server-side
      --previous-response-id <id>  Continue a stored response
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

async function loadBody(value) {
  if (!value) return null;
  if (value.startsWith("@")) {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(value.slice(1), "utf8"));
  }
  return JSON.parse(value);
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
    "thinking-budget": { type: "string" },
    tool: { type: "string", multiple: true },
    "tool-choice": { type: "string" },
    stream: { type: "boolean" },
    "no-stream": { type: "boolean" },
    raw: { type: "boolean" },
    body: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let body = await loadBody(values.body);
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
    const budget = numberOption(values["thinking-budget"], "--thinking-budget");
    if (budget !== undefined) body.thinking = { type: "enabled", budget_tokens: budget };
    if (values.tool && values.tool.length) {
      body.tools = [];
      for (const t of values.tool) body.tools.push(await loadBody(t));
    }
    if (values["tool-choice"]) {
      const v = values["tool-choice"];
      body.tool_choice = v === "auto" || v === "any" ? { type: v } : { type: "tool", name: v };
    }
  }

  if (shouldStream(values)) {
    body.stream = true;
    const res = await api("POST", "/messages", {
      auth: authFromValues(values),
      body,
      raw: true,
      headers: { Accept: "text/event-stream" },
    });
    for await (const evt of sseStream(res)) {
      assertNoStreamError(evt);
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
    return 0;
  }

  const data = await api("POST", "/messages", {
    auth: authFromValues(values),
    body,
  });
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    const blocks = data.content || [];
    for (const b of blocks) if (b.type === "text") outln(b.text);
  }
  return 0;
}

export async function responsesCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    instructions: { type: "string", short: "s" },
    "max-tokens": { type: "string" },
    temperature: { type: "string" },
    "top-p": { type: "string" },
    seed: { type: "string" },
    reasoning: { type: "string" },
    tool: { type: "string", multiple: true },
    "tool-choice": { type: "string" },
    include: { type: "string" },
    store: { type: "boolean" },
    "previous-response-id": { type: "string" },
    stream: { type: "boolean" },
    "no-stream": { type: "boolean" },
    raw: { type: "boolean" },
    body: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP_RESPONSES);
    return 0;
  }

  let body = await loadBody(values.body);
  if (!body) {
    const prompt = await resolvePrompt(values, positionals);
    body = { model: values.model, input: prompt };
    if (values.instructions) body.instructions = values.instructions;
    applyNumeric(body, values, {
      "max-tokens": "max_output_tokens",
      temperature: "temperature",
      "top-p": "top_p",
      seed: "seed",
    });
    if (values.reasoning) body.reasoning = { effort: values.reasoning };
    if (values.tool && values.tool.length) {
      body.tools = [];
      for (const t of values.tool) body.tools.push(await loadBody(t));
    }
    if (values["tool-choice"]) {
      const v = values["tool-choice"];
      if (["auto", "none", "required"].includes(v)) body.tool_choice = v;
      else body.tool_choice = { type: "function", name: v };
    }
    if (values.include) body.include = values.include.split(",").map((s) => s.trim());
    if (values.store) body.store = true;
    if (values["previous-response-id"]) body.previous_response_id = values["previous-response-id"];
  }

  if (shouldStream(values)) {
    body.stream = true;
    const res = await api("POST", "/responses", {
      auth: authFromValues(values),
      body,
      raw: true,
      headers: { Accept: "text/event-stream" },
    });
    for await (const evt of sseStream(res)) {
      assertNoStreamError(evt);
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
    return 0;
  }

  const data = await api("POST", "/responses", {
    auth: authFromValues(values),
    body,
  });
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    const text =
      data.output_text ||
      (data.output &&
        data.output
          .flatMap?.((o) =>
            (o.content || []).filter((c) => c.type === "output_text").map((c) => c.text),
          )
          .join("\n"));
    outln(text || JSON.stringify(data));
  }
  return 0;
}
