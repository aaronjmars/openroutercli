import { stdin } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { printJSON, out } from '../output.js';

const HELP = `Usage: openrouter request <METHOD> <path> [options]

Make a raw authenticated request to the OpenRouter API.

Examples:
  openrouter request GET /credits
  openrouter request POST /chat/completions --body @body.json
  openrouter request GET /models --query category=programming

Options:
  --body <json|@file>     JSON body. @file reads from disk. - reads stdin.
  --query <k=v>           Query parameter (repeatable)
  --header <k:v>          Extra request header (repeatable)
  --binary <out|->        Treat response as binary; write to file or stdout
  --raw                   Print raw text response (no JSON parsing)
`;

async function readStdin() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data;
}

async function loadBody(value) {
  if (value === '-') return JSON.parse(await readStdin());
  if (value.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    return JSON.parse(await readFile(value.slice(1), 'utf8'));
  }
  return JSON.parse(value);
}

export async function requestCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    body: { type: 'string' },
    query: { type: 'string', multiple: true },
    header: { type: 'string', multiple: true },
    binary: { type: 'string' },
    raw: { type: 'boolean' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length < 2) {
    process.stdout.write(HELP);
    return 1;
  }
  const method = positionals[0];
  const path = positionals[1];

  const query = {};
  for (const q of values.query || []) {
    const i = q.indexOf('=');
    if (i === -1) throw new Error(`bad --query (need k=v): ${q}`);
    query[q.slice(0, i)] = q.slice(i + 1);
  }
  const headers = {};
  for (const h of values.header || []) {
    const i = h.indexOf(':');
    if (i === -1) throw new Error(`bad --header (need k:v): ${h}`);
    headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
  }

  const opts = {
    auth: authFromValues(values),
    headers,
    query: Object.keys(query).length ? query : undefined
  };
  if (values.body !== undefined) opts.body = await loadBody(values.body);

  if (values.binary) {
    opts.binary = true;
    const bytes = await api(method, path, opts);
    if (values.binary === '-') process.stdout.write(Buffer.from(bytes));
    else {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(values.binary, Buffer.from(bytes));
    }
    return 0;
  }

  if (values.raw) {
    opts.raw = true;
    const res = await api(method, path, opts);
    process.stdout.write(await res.text());
    return res.ok ? 0 : 2;
  }

  const data = await api(method, path, opts);
  if (data == null) return 0;
  if (typeof data === 'string') out(data);
  else printJSON(data);
  return 0;
}
