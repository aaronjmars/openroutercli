import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, outln, printResult } from '../output.js';

export async function generationCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    content: { type: 'boolean' }
  });
  if (values.help || !positionals[0]) {
    process.stdout.write(
      'Usage: openrouter generation <id> [--content]\n\nFetch metadata for a generation. With --content, fetch the input/output content.\n'
    );
    return values.help ? 0 : 1;
  }
  const id = positionals[0];
  const path = values.content ? '/generation/content' : '/generation';
  const data = await api('GET', path, {
    auth: authFromValues(values),
    query: { id }
  });
  printResult(data, () => {
    const d = data.data || data;
    outln(c.bold(`generation ${id}`));
    for (const [k, v] of Object.entries(d)) {
      const display = typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '...' : v;
      outln(`  ${k}: ${typeof display === 'object' ? JSON.stringify(display) : display}`);
    }
  });
  return 0;
}
