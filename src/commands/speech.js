import { writeFile } from 'node:fs/promises';
import { stdin } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { info, outln, printJSON, isJsonMode } from '../output.js';

const HELP = `Usage: openrouter speech [text...] [options]

Generate speech audio from text. Reads text from arguments or stdin.

Options:
  -m, --model <id>     TTS model id (required)
      --voice <name>   Voice id
      --format <fmt>   mp3|wav|opus|flac (depends on provider)
      --speed <n>      Speech speed (e.g. 1.0)
  -o, --out <file>     Output audio file (default: out.mp3, or stdout if -)
      --provider <json>
`;

async function readStdinIfPiped() {
  if (stdin.isTTY) return null;
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.trim() || null;
}

export async function speechCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    voice: { type: 'string' },
    format: { type: 'string' },
    speed: { type: 'string' },
    out: { type: 'string', short: 'o' },
    provider: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error('--model is required');

  let text = positionals.join(' ').trim();
  const piped = await readStdinIfPiped();
  if (piped) text = text ? `${text}\n${piped}` : piped;
  if (!text) throw new Error('No input text.');

  const body = { model: values.model, input: text };
  if (values.voice) body.voice = values.voice;
  if (values.format) body.response_format = values.format;
  if (values.speed) body.speed = Number(values.speed);
  if (values.provider) body.provider = JSON.parse(values.provider);

  const bytes = await api('POST', '/audio/speech', {
    auth: authFromValues(values),
    body,
    binary: true
  });

  const out = values.out || `out.${values.format || 'mp3'}`;
  if (out === '-') {
    process.stdout.write(Buffer.from(bytes));
  } else {
    await writeFile(out, Buffer.from(bytes));
    if (isJsonMode()) printJSON({ saved: out, bytes: bytes.length });
    else info(`Wrote ${bytes.length} bytes to ${out}`);
  }
  return 0;
}
