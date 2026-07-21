import { stdin } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { outln, pricePerMillion, printResult, table } from '../output.js';

const HELP = `Usage: openrouter embed [text...] [options]
       openrouter embed models

Generate embeddings, or list embedding models.

Options:
  -m, --model <id>      Embedding model id (required for inference)
  -i, --input <text>    Input string (repeatable)
      --input-type <t>  e.g. query | document
      --dimensions <n>
      --encoding <fmt>  float | base64
      --provider <json> Provider routing as JSON
`;

async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim() || null;
}

export async function embedCommand(argv) {
  if (argv[0] === 'models') {
    const { values } = parseArgs(argv.slice(1), {});
    const data = await api('GET', '/embeddings/models', {
      auth: authFromValues(values),
      requireAuth: false
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: 'id', value: (m) => m.id },
        { label: 'context', value: (m) => m.context_length ?? '' },
        {
          label: '$/M tokens',
          value: (m) => pricePerMillion((m.pricing || {}).prompt)
        },
        { label: 'name', value: (m) => m.name || '' }
      ]);
    });
    return 0;
  }

  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    input: { type: 'string', short: 'i', multiple: true },
    'input-type': { type: 'string' },
    dimensions: { type: 'string' },
    encoding: { type: 'string' },
    provider: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error('--model is required');

  const inputs = [...(values.input || []), ...positionals];
  const piped = await readStdinIfPiped();
  if (piped) inputs.push(piped);
  if (!inputs.length) throw new Error('No input. Pass text, use --input, or pipe stdin.');

  const body = {
    model: values.model,
    input: inputs.length === 1 ? inputs[0] : inputs
  };
  if (values['input-type']) body.input_type = values['input-type'];
  if (values.dimensions) body.dimensions = Number(values.dimensions);
  if (values.encoding) body.encoding_format = values.encoding;
  if (values.provider) body.provider = JSON.parse(values.provider);

  const data = await api('POST', '/embeddings', {
    auth: authFromValues(values),
    body
  });
  printResult(data, () => {
    const arr = data.data || [];
    for (const e of arr) {
      const v = e.embedding;
      if (Array.isArray(v))
        outln(`[${v.length}d] ${v.slice(0, 4).map((x) => x.toFixed(5)).join(', ')}, ...`);
      else outln(String(v).slice(0, 80) + '...');
    }
  });
  return 0;
}
