import { stdin } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api, sseStream } from '../api.js';
import { isJsonMode, out, outln, printJSON } from '../output.js';

const HELP = `Usage: openrouter messages [prompt...] [options]

Anthropic-compatible /messages endpoint.

Options:
  -m, --model <id>         Model id (required)
  -s, --system <text>      System prompt
      --max-tokens <n>     (default: 1024)
      --temperature <n>
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
      --reasoning <effort> low | medium | high
      --stream             Stream tokens (default when TTY)
      --no-stream          Disable streaming
      --raw                Print full JSON response
      --body <json|@file>  Provide a fully-formed body (overrides flags)
`;

async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim() || null;
}

async function loadBody(value) {
  if (!value) return null;
  if (value.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(value.slice(1), 'utf8'));
  }
  return JSON.parse(value);
}

export async function messagesCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    system: { type: 'string', short: 's' },
    'max-tokens': { type: 'string' },
    temperature: { type: 'string' },
    stream: { type: 'boolean' },
    'no-stream': { type: 'boolean' },
    raw: { type: 'boolean' },
    body: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  let body = await loadBody(values.body);
  if (!body) {
    if (!values.model) throw new Error('--model is required');
    let prompt = positionals.join(' ').trim();
    const piped = await readStdinIfPiped();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    if (!prompt) throw new Error('No prompt.');
    body = {
      model: values.model,
      max_tokens: Number(values['max-tokens'] || 1024),
      messages: [{ role: 'user', content: prompt }]
    };
    if (values.system) body.system = values.system;
    if (values.temperature) body.temperature = Number(values.temperature);
  }

  const shouldStream =
    values.stream ||
    (!values['no-stream'] && !values.raw && !isJsonMode() && process.stdout.isTTY);

  if (shouldStream) {
    body.stream = true;
    const res = await api('POST', '/messages', {
      auth: authFromValues(values),
      body,
      raw: true,
      headers: { Accept: 'text/event-stream' }
    });
    for await (const evt of sseStream(res)) {
      const t = evt.type;
      if (t === 'content_block_delta' && evt.delta && evt.delta.text) {
        out(evt.delta.text);
      }
    }
    if (process.stdout.isTTY) out('\n');
    return 0;
  }

  const data = await api('POST', '/messages', {
    auth: authFromValues(values),
    body
  });
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    const blocks = data.content || [];
    for (const b of blocks) if (b.type === 'text') outln(b.text);
  }
  return 0;
}

export async function responsesCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    instructions: { type: 'string', short: 's' },
    'max-tokens': { type: 'string' },
    temperature: { type: 'string' },
    'top-p': { type: 'string' },
    seed: { type: 'string' },
    reasoning: { type: 'string' },
    stream: { type: 'boolean' },
    'no-stream': { type: 'boolean' },
    raw: { type: 'boolean' },
    body: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP_RESPONSES);
    return 0;
  }

  let body = await loadBody(values.body);
  if (!body) {
    if (!values.model) throw new Error('--model is required');
    let prompt = positionals.join(' ').trim();
    const piped = await readStdinIfPiped();
    if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    if (!prompt) throw new Error('No prompt.');
    body = { model: values.model, input: prompt };
    if (values.instructions) body.instructions = values.instructions;
    if (values['max-tokens'] != null) body.max_output_tokens = Number(values['max-tokens']);
    if (values.temperature != null) body.temperature = Number(values.temperature);
    if (values['top-p'] != null) body.top_p = Number(values['top-p']);
    if (values.seed != null) body.seed = Number(values.seed);
    if (values.reasoning) body.reasoning = { effort: values.reasoning };
  }

  const shouldStream =
    values.stream ||
    (!values['no-stream'] && !values.raw && !isJsonMode() && process.stdout.isTTY);

  if (shouldStream) {
    body.stream = true;
    const res = await api('POST', '/responses', {
      auth: authFromValues(values),
      body,
      raw: true,
      headers: { Accept: 'text/event-stream' }
    });
    for await (const evt of sseStream(res)) {
      if (evt.type && evt.type.endsWith('output_text.delta') && evt.delta) {
        out(evt.delta);
      }
    }
    if (process.stdout.isTTY) out('\n');
    return 0;
  }

  const data = await api('POST', '/responses', {
    auth: authFromValues(values),
    body
  });
  if (isJsonMode() || values.raw) {
    printJSON(data);
  } else {
    const text =
      data.output_text ||
      (data.output && data.output.flatMap?.((o) =>
        (o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text)
      ).join('\n'));
    outln(text || JSON.stringify(data));
  }
  return 0;
}
