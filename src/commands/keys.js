import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, outln, printResult, table } from '../output.js';

const HELP = `Usage: openrouter keys <subcommand> [options]

Manage API keys (requires a provisioning/management key).

Subcommands:
  list                            List API keys
  get <hash>                      Get a single key
  create <name> [options]         Create a key
  update <hash> [options]         Update a key
  delete <hash>                   Delete a key

create options:
  --limit <usd>          Spending limit
  --limit-reset <p>      daily | weekly | monthly
  --expires-at <iso>     ISO 8601 UTC expiry
  --workspace <uuid>     Workspace id
  --include-byok         Include BYOK in limit

update options:
  --name <name>
  --limit <usd>
  --limit-reset <p>
  --include-byok / --no-include-byok
  --disabled / --enabled
`;

export async function keysCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  if (sub === 'list') {
    const { values } = parseArgs(rest, {
      offset: { type: 'string' },
      'include-disabled': { type: 'boolean' }
    });
    const query = {};
    if (values.offset) query.offset = values.offset;
    if (values['include-disabled']) query.include_disabled = 'true';
    const data = await api('GET', '/keys', {
      auth: authFromValues(values),
      requiresManagement: true,
      query
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: 'name', value: (k) => k.name || '' },
        { label: 'hash', value: (k) => k.hash || k.id || '' },
        { label: 'usage', value: (k) => k.usage ?? '' },
        { label: 'limit', value: (k) => k.limit ?? '' },
        { label: 'disabled', value: (k) => (k.disabled ? 'yes' : '') }
      ]);
    });
    return 0;
  }

  if (sub === 'get') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('hash required');
    const data = await api('GET', `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'create') {
    const { values, positionals } = parseArgs(rest, {
      limit: { type: 'string' },
      'limit-reset': { type: 'string' },
      'expires-at': { type: 'string' },
      workspace: { type: 'string' },
      'include-byok': { type: 'boolean' }
    });
    const name = positionals[0];
    if (!name) throw new Error('name required');
    const body = { name };
    if (values.limit) body.limit = Number(values.limit);
    if (values['limit-reset']) body.limit_reset = values['limit-reset'];
    if (values['expires-at']) body.expires_at = values['expires-at'];
    if (values.workspace) body.workspace_id = values.workspace;
    if (values['include-byok']) body.include_byok_in_limit = true;
    const data = await api('POST', '/keys', {
      auth: authFromValues(values),
      requiresManagement: true,
      body
    });
    printResult(data, () => {
      const k = data.key || (data.data && data.data.key);
      const meta = data.data || data;
      outln(c.bold('key (save this — shown only once):'));
      outln('  ' + (k || '(see JSON)'));
      outln(c.dim(JSON.stringify(meta, null, 2)));
    });
    return 0;
  }

  if (sub === 'update') {
    const { values, positionals } = parseArgs(rest, {
      name: { type: 'string' },
      limit: { type: 'string' },
      'limit-reset': { type: 'string' },
      'include-byok': { type: 'boolean' },
      'no-include-byok': { type: 'boolean' },
      disabled: { type: 'boolean' },
      enabled: { type: 'boolean' }
    });
    if (!positionals[0]) throw new Error('hash required');
    const body = {};
    if (values.name) body.name = values.name;
    if (values.limit) body.limit = Number(values.limit);
    if (values['limit-reset']) body.limit_reset = values['limit-reset'];
    if (values['include-byok']) body.include_byok_in_limit = true;
    if (values['no-include-byok']) body.include_byok_in_limit = false;
    if (values.disabled) body.disabled = true;
    if (values.enabled) body.disabled = false;
    const data = await api('PATCH', `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true,
      body
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'delete') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('hash required');
    const data = await api('DELETE', `/keys/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
      requiresManagement: true
    });
    printResult(data, () => outln('deleted'));
    return 0;
  }

  throw new Error(`Unknown keys subcommand: ${sub}`);
}
