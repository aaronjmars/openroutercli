import { parseArgs as nodeParseArgs } from 'node:util';

const GLOBAL_OPTIONS = {
  key: { type: 'string', short: 'k' },
  'base-url': { type: 'string' },
  referer: { type: 'string' },
  title: { type: 'string' },
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' }
};

export function parseArgs(argv, options = {}) {
  const merged = { ...GLOBAL_OPTIONS, ...options };
  return nodeParseArgs({
    args: argv,
    options: merged,
    allowPositionals: true,
    strict: true
  });
}

export function authFromValues(values) {
  const out = {};
  if (values.key) out.key = values.key;
  if (values['base-url']) out.baseUrl = values['base-url'];
  if (values.referer) out.referer = values.referer;
  if (values.title) out.title = values.title;
  return out;
}
