import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api, sseStream } from '../api.js';
import { c, info, isJsonMode, out, outln, printJSON } from '../output.js';

const HELP = `Usage: openrouter chat [prompt...] [options]

Send a chat completion. With no prompt and a TTY, starts an interactive REPL.
With no prompt and stdin piped, reads the prompt from stdin.

Options:
  -m, --model <id>         Model id (default: openrouter/auto)
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
      --json-output        Ask the model for JSON (response_format=json_object)
      --schema <file|json> JSON schema for structured output
      --tool <file|json>   Tool definition (repeatable). JSON object or @file.json
      --tool-choice <v>    auto | none | required | <tool name>
      --reasoning <effort> low | medium | high
      --provider <json>    Provider routing options as JSON
      --image <url|path>   Attach an image (repeatable). URL or local file
      --raw                Print full JSON response (non-streaming)
      --usage              Print usage info to stderr after completion
      --interactive, -i    Force interactive REPL
  -h, --help
`;

async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trimEnd() || null;
}

async function loadJsonOrFile(value) {
  if (value.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(value.slice(1), 'utf8');
    return JSON.parse(text);
  }
  if (value.startsWith('{') || value.startsWith('[')) return JSON.parse(value);
  // otherwise treat as a path
  try {
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(value, 'utf8');
    return JSON.parse(text);
  } catch {
    return JSON.parse(value);
  }
}

async function imageToContent(value) {
  if (/^https?:\/\//i.test(value) || value.startsWith('data:')) {
    return { type: 'image_url', image_url: { url: value } };
  }
  const { readFile } = await import('node:fs/promises');
  const buf = await readFile(value);
  const ext = (value.split('.').pop() || '').toLowerCase();
  const mime =
    ext === 'png'
      ? 'image/png'
      : ext === 'webp'
      ? 'image/webp'
      : ext === 'gif'
      ? 'image/gif'
      : 'image/jpeg';
  return {
    type: 'image_url',
    image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
  };
}

function applySamplingOptions(body, values) {
  if (values.models) body.models = values.models.split(',').map((s) => s.trim());
  if (values.temperature != null) body.temperature = Number(values.temperature);
  if (values['top-p'] != null) body.top_p = Number(values['top-p']);
  if (values['top-k'] != null) body.top_k = Number(values['top-k']);
  if (values['max-tokens'] != null) body.max_tokens = Number(values['max-tokens']);
  if (values.seed != null) body.seed = Number(values.seed);
  if (values.stop) body.stop = values.stop.split(',');
  if (values['frequency-penalty'] != null) body.frequency_penalty = Number(values['frequency-penalty']);
  if (values['presence-penalty'] != null) body.presence_penalty = Number(values['presence-penalty']);
  if (values['repetition-penalty'] != null) body.repetition_penalty = Number(values['repetition-penalty']);
  if (values['min-p'] != null) body.min_p = Number(values['min-p']);
  if (values.reasoning) body.reasoning = { effort: values.reasoning };
}

async function buildBody(values, prompt) {
  const messages = [];
  if (values.system) messages.push({ role: 'system', content: values.system });

  let userContent;
  const images = values.image || [];
  if (images.length > 0) {
    const parts = [];
    if (prompt) parts.push({ type: 'text', text: prompt });
    for (const img of images) parts.push(await imageToContent(img));
    userContent = parts;
  } else {
    userContent = prompt;
  }
  messages.push({ role: 'user', content: userContent });

  const body = {
    model: values.model || 'openrouter/auto',
    messages
  };
  applySamplingOptions(body, values);

  if (values['json-output']) body.response_format = { type: 'json_object' };
  if (values.schema) {
    const schema = await loadJsonOrFile(values.schema);
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true }
    };
  }
  if (values.tool && values.tool.length) {
    body.tools = [];
    for (const t of values.tool) {
      const def = await loadJsonOrFile(t);
      // Accept either {type, function} or a bare {name, parameters, ...}
      if (def.type && def.function) body.tools.push(def);
      else body.tools.push({ type: 'function', function: def });
    }
  }
  if (values['tool-choice']) {
    const v = values['tool-choice'];
    if (['auto', 'none', 'required'].includes(v)) body.tool_choice = v;
    else body.tool_choice = { type: 'function', function: { name: v } };
  }
  if (values.provider) body.provider = await loadJsonOrFile(values.provider);
  return body;
}

async function streamResponse(body, auth) {
  const res = await api('POST', '/chat/completions', {
    auth,
    body: { ...body, stream: true },
    raw: true,
    headers: { Accept: 'text/event-stream' }
  });
  let usage = null;
  let model = null;
  let finishReason = null;
  for await (const evt of sseStream(res)) {
    if (evt.usage) usage = evt.usage;
    if (evt.model) model = evt.model;
    const choice = evt.choices && evt.choices[0];
    if (!choice) continue;
    const delta = choice.delta || choice.message;
    if (!delta) continue;
    if (typeof delta.content === 'string') out(delta.content);
    else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (part.type === 'text' && part.text) out(part.text);
      }
    }
    if (delta.reasoning) {
      // reasoning trace; show in dim if TTY
      if (process.stdout.isTTY) out(c.dim(delta.reasoning));
    }
    if (delta.tool_calls) {
      // Print tool calls JSON-compactly
      for (const tc of delta.tool_calls) {
        if (tc.function && tc.function.arguments) out(tc.function.arguments);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }
  if (process.stdout.isTTY) out('\n');
  return { usage, model, finishReason };
}

export async function chatCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    models: { type: 'string' },
    system: { type: 'string', short: 's' },
    stream: { type: 'boolean' },
    'no-stream': { type: 'boolean' },
    temperature: { type: 'string' },
    'top-p': { type: 'string' },
    'top-k': { type: 'string' },
    'max-tokens': { type: 'string' },
    seed: { type: 'string' },
    stop: { type: 'string' },
    'frequency-penalty': { type: 'string' },
    'presence-penalty': { type: 'string' },
    'repetition-penalty': { type: 'string' },
    'min-p': { type: 'string' },
    'json-output': { type: 'boolean' },
    schema: { type: 'string' },
    tool: { type: 'string', multiple: true },
    'tool-choice': { type: 'string' },
    reasoning: { type: 'string' },
    provider: { type: 'string' },
    image: { type: 'string', multiple: true },
    raw: { type: 'boolean' },
    usage: { type: 'boolean' },
    interactive: { type: 'boolean', short: 'i' }
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const auth = authFromValues(values);
  const piped = await readStdinIfPiped();
  let prompt = positionals.join(' ').trim();
  if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;

  const wantsInteractive =
    values.interactive || (!prompt && stdin.isTTY && stdout.isTTY);

  if (wantsInteractive) {
    return repl(values, auth);
  }

  if (!prompt) {
    throw new Error('No prompt. Pass text, pipe via stdin, or use --interactive.');
  }

  const body = await buildBody(values, prompt);

  // Streaming default: TTY and not --raw and not --json globally
  const shouldStream =
    values.stream ||
    (!values['no-stream'] && !values.raw && !isJsonMode() && stdout.isTTY);

  if (!shouldStream) {
    const data = await api('POST', '/chat/completions', { auth, body });
    if (isJsonMode() || values.raw) {
      printJSON(data);
    } else {
      const choice = data.choices && data.choices[0];
      const msg = choice && choice.message;
      if (msg && typeof msg.content === 'string') outln(msg.content);
      else if (msg && Array.isArray(msg.content)) {
        for (const part of msg.content)
          if (part.type === 'text') outln(part.text);
      } else outln(JSON.stringify(data));
      if (values.usage && data.usage) {
        info(
          `model=${data.model || ''} prompt=${data.usage.prompt_tokens} completion=${data.usage.completion_tokens} total=${data.usage.total_tokens}`
        );
      }
    }
    return 0;
  }

  const meta = await streamResponse(body, auth);
  if (values.usage && meta.usage) {
    info(
      `model=${meta.model || ''} prompt=${meta.usage.prompt_tokens} completion=${meta.usage.completion_tokens} total=${meta.usage.total_tokens}`
    );
  }
  return 0;
}

async function repl(values, auth) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history = [];
  if (values.system) history.push({ role: 'system', content: values.system });
  outln(c.dim('OpenRouter chat. /exit to quit, /reset to clear history, /model <id> to switch.'));
  let model = values.model || 'openrouter/auto';
  outln(c.dim(`model: ${model}`));
  try {
    while (true) {
      let line;
      try {
        line = await rl.question(c.cyan('› '));
      } catch {
        return 0;
      }
      if (line == null) return 0;
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === '/exit' || trimmed === '/quit') return 0;
      if (trimmed === '/reset') {
        history.length = 0;
        if (values.system)
          history.push({ role: 'system', content: values.system });
        outln(c.dim('(history cleared)'));
        continue;
      }
      if (trimmed.startsWith('/model ')) {
        model = trimmed.slice(7).trim();
        outln(c.dim(`model: ${model}`));
        continue;
      }
      history.push({ role: 'user', content: trimmed });
      const body = { model, messages: history, stream: true };
      applySamplingOptions(body, values);
      try {
        const res = await api('POST', '/chat/completions', {
          auth,
          body,
          raw: true,
          headers: { Accept: 'text/event-stream' }
        });
        let assistant = '';
        for await (const evt of sseStream(res)) {
          const delta = evt.choices?.[0]?.delta;
          if (delta?.content) {
            out(delta.content);
            assistant += delta.content;
          }
          if (delta?.reasoning && process.stdout.isTTY) out(c.dim(delta.reasoning));
        }
        out('\n');
        history.push({ role: 'assistant', content: assistant });
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

// Alias used by `complete`
export const completeCommand = chatCommand;
