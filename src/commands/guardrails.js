import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, outln, printResult, table } from '../output.js';

const HELP = `Usage: openrouter guardrails <subcommand> [options]

Manage guardrails (requires a management key).

Subcommands:
  list                                List guardrails
  get <id>                            Get one
  create <name> [options]             Create
  update <id> [options]               Update
  delete <id>                         Delete
  assignments [--keys|--members]      List all assignments
  assign-key <id> <hash>...           Assign API keys to a guardrail
  unassign-key <id> <hash>...         Unassign API keys
  assign-member <id> <user>...        Assign org members
  unassign-member <id> <user>...      Unassign members
  key-assignments <id>                List key assignments for a guardrail
  member-assignments <id>             List member assignments for a guardrail

create / update options:
  --description <text>
  --limit-usd <n>
  --reset-interval <p>      daily | weekly | monthly | null
  --enforce-zdr / --no-zdr
  --allowed-models <csv>
  --ignored-models <csv>
  --allowed-providers <csv>
  --ignored-providers <csv>
  --workspace <uuid>        (create only)
`;

function csv(v) {
  if (v == null) return undefined;
  if (v === '') return null;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function buildBody(values) {
  const body = {};
  if (values.description !== undefined) body.description = values.description;
  if (values['limit-usd'] !== undefined) body.limit_usd = Number(values['limit-usd']);
  if (values['reset-interval'] !== undefined) {
    body.reset_interval = values['reset-interval'] === 'null' ? null : values['reset-interval'];
  }
  if (values['enforce-zdr']) body.enforce_zdr = true;
  if (values['no-zdr']) body.enforce_zdr = false;
  if (values['allowed-models'] !== undefined) body.allowed_models = csv(values['allowed-models']);
  if (values['ignored-models'] !== undefined) body.ignored_models = csv(values['ignored-models']);
  if (values['allowed-providers'] !== undefined) body.allowed_providers = csv(values['allowed-providers']);
  if (values['ignored-providers'] !== undefined) body.ignored_providers = csv(values['ignored-providers']);
  return body;
}

const COMMON_FIELDS = {
  description: { type: 'string' },
  'limit-usd': { type: 'string' },
  'reset-interval': { type: 'string' },
  'enforce-zdr': { type: 'boolean' },
  'no-zdr': { type: 'boolean' },
  'allowed-models': { type: 'string' },
  'ignored-models': { type: 'string' },
  'allowed-providers': { type: 'string' },
  'ignored-providers': { type: 'string' }
};

export async function guardrailsCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  const auth = (v) => authFromValues(v);

  if (sub === 'list') {
    const { values } = parseArgs(rest, {
      offset: { type: 'string' },
      limit: { type: 'string' }
    });
    const query = {};
    if (values.offset) query.offset = values.offset;
    if (values.limit) query.limit = values.limit;
    const data = await api('GET', '/guardrails', {
      auth: auth(values),
      requiresManagement: true,
      query
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: 'id', value: (g) => g.id },
        { label: 'name', value: (g) => g.name },
        { label: 'limit_usd', value: (g) => g.limit_usd ?? '' },
        { label: 'reset', value: (g) => g.reset_interval ?? '' },
        { label: 'zdr', value: (g) => (g.enforce_zdr ? 'yes' : '') }
      ]);
    });
    return 0;
  }

  if (sub === 'get') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('id required');
    const data = await api('GET', `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'create') {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      workspace: { type: 'string' }
    });
    const name = positionals[0];
    if (!name) throw new Error('name required');
    const body = { name, ...buildBody(values) };
    if (values.workspace) body.workspace_id = values.workspace;
    const data = await api('POST', '/guardrails', {
      auth: auth(values),
      requiresManagement: true,
      body
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'update') {
    const { values, positionals } = parseArgs(rest, {
      ...COMMON_FIELDS,
      name: { type: 'string' }
    });
    if (!positionals[0]) throw new Error('id required');
    const body = buildBody(values);
    if (values.name) body.name = values.name;
    const data = await api('PATCH', `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true,
      body
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'delete') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('id required');
    const data = await api('DELETE', `/guardrails/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data, () => outln('deleted'));
    return 0;
  }

  if (sub === 'assignments') {
    const { values } = parseArgs(rest, {
      keys: { type: 'boolean' },
      members: { type: 'boolean' }
    });
    const path = values.members ? '/guardrails/assignments/members' : '/guardrails/assignments/keys';
    const data = await api('GET', path, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'key-assignments' || sub === 'member-assignments') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('id required');
    const path =
      sub === 'key-assignments'
        ? `/guardrails/${encodeURIComponent(positionals[0])}/assignments/keys`
        : `/guardrails/${encodeURIComponent(positionals[0])}/assignments/members`;
    const data = await api('GET', path, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'assign-key' || sub === 'unassign-key') {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error('Usage: <id> <hash>...');
    const id = positionals[0];
    const hashes = positionals.slice(1);
    const path = sub === 'assign-key'
      ? `/guardrails/${encodeURIComponent(id)}/assignments/keys`
      : `/guardrails/${encodeURIComponent(id)}/assignments/keys/remove`;
    const data = await api('POST', path, {
      auth: auth(values),
      requiresManagement: true,
      body: { key_hashes: hashes }
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  if (sub === 'assign-member' || sub === 'unassign-member') {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error('Usage: <id> <user_id>...');
    const id = positionals[0];
    const userIds = positionals.slice(1);
    const path = sub === 'assign-member'
      ? `/guardrails/${encodeURIComponent(id)}/assignments/members`
      : `/guardrails/${encodeURIComponent(id)}/assignments/members/remove`;
    const data = await api('POST', path, {
      auth: auth(values),
      requiresManagement: true,
      body: { user_ids: userIds }
    });
    printResult(data, () => outln(JSON.stringify(data, null, 2)));
    return 0;
  }

  throw new Error(`Unknown guardrails subcommand: ${sub}`);
}
