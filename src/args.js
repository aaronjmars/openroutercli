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

// parseArgs yields strings; a bare Number() turns a typo into NaN, which
// JSON.stringify serializes as null -- an API request that silently means
// something else. Fail on the CLI instead.
export function numberOption(value, flag) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(n)) {
    throw new Error(`Invalid number for ${flag}: "${value}"`);
  }
  return n;
}

export const PAGINATION_OPTIONS = {
  offset: { type: 'string' },
  limit: { type: 'string' }
};

export function paginationQuery(values) {
  const query = {};
  if (values.offset) query.offset = values.offset;
  if (values.limit) query.limit = values.limit;
  return query;
}

export function authFromValues(values) {
  const out = {};
  if (values.key) out.key = values.key;
  if (values['base-url']) out.baseUrl = values['base-url'];
  if (values.referer) out.referer = values.referer;
  if (values.title) out.title = values.title;
  return out;
}
