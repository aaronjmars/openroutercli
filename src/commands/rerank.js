import { stdin } from 'node:process';
import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, outln, printResult } from '../output.js';

const HELP = `Usage: openrouter rerank --model <id> --query <q> [doc...] [options]

Rerank documents against a query.

Options:
  -m, --model <id>      Reranking model (required)
      --query <text>    Query string (required)
  -d, --doc <text>      Document (repeatable). Or pass docs as positionals.
      --docs-file <p>   Read docs from file (one per line). - for stdin.
      --top-n <n>       Return only the top N
      --provider <json>
`;

async function readDocsFromStdin() {
  let data = '';
  for await (const chunk of stdin) data += chunk;
  return data.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

export async function rerankCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: 'string', short: 'm' },
    query: { type: 'string' },
    doc: { type: 'string', short: 'd', multiple: true },
    'docs-file': { type: 'string' },
    'top-n': { type: 'string' },
    provider: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error('--model is required');
  if (!values.query) throw new Error('--query is required');

  let docs = [...(values.doc || []), ...positionals];
  if (values['docs-file']) {
    if (values['docs-file'] === '-') docs = docs.concat(await readDocsFromStdin());
    else {
      const { readFile } = await import('node:fs/promises');
      const text = await readFile(values['docs-file'], 'utf8');
      docs = docs.concat(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    }
  }
  if (!docs.length) throw new Error('No documents. Pass via positionals, --doc, or --docs-file.');

  const body = {
    model: values.model,
    query: values.query,
    documents: docs
  };
  if (values['top-n']) body.top_n = Number(values['top-n']);
  if (values.provider) body.provider = JSON.parse(values.provider);

  const data = await api('POST', '/rerank', {
    auth: authFromValues(values),
    body
  });
  printResult(data, () => {
    const results = data.results || data.data || [];
    for (const r of results) {
      const idx = r.index;
      const score = r.relevance_score ?? r.score;
      const text = (r.document && r.document.text) || docs[idx] || '';
      outln(`${c.bold(score?.toFixed?.(4) ?? score)}  ${c.dim(`#${idx}`)}  ${text.slice(0, 120)}`);
    }
  });
  return 0;
}
