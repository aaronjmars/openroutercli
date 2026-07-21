import { parseArgs, authFromValues, PAGINATION_OPTIONS, paginationQuery } from '../args.js';
import { api } from '../api.js';
import { outln, printResult, table } from '../output.js';

const HELP = `Usage: openrouter workspaces <subcommand> [options]

Manage workspaces (requires a management key).

Subcommands:
  list                                  List workspaces
  get <id|slug>                         Get one
  create <name> [options]               Create
  update <id|slug> [options]            Update
  delete <id|slug>                      Delete
  add-members <id|slug> <userId>...     Bulk add members
  remove-members <id|slug> <userId>...  Bulk remove members

create / update options:
  --slug <slug>
  --description <text>
  --default-text-model <id>
  --default-image-model <id>
  --default-provider-sort <s>      e.g. price | latency | throughput
`;

const COMMON = {
  slug: { type: 'string' },
  description: { type: 'string' },
  'default-text-model': { type: 'string' },
  'default-image-model': { type: 'string' },
  'default-provider-sort': { type: 'string' }
};

function buildBody(values) {
  const body = {};
  if (values.slug !== undefined) body.slug = values.slug;
  if (values.description !== undefined) body.description = values.description;
  if (values['default-text-model'] !== undefined) body.default_text_model = values['default-text-model'];
  if (values['default-image-model'] !== undefined) body.default_image_model = values['default-image-model'];
  if (values['default-provider-sort'] !== undefined) body.default_provider_sort = values['default-provider-sort'];
  return body;
}

export async function workspacesCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  const auth = (v) => authFromValues(v);

  if (sub === 'list') {
    const { values } = parseArgs(rest, PAGINATION_OPTIONS);
    const query = paginationQuery(values);
    const data = await api('GET', '/workspaces', {
      auth: auth(values),
      requiresManagement: true,
      query
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: 'slug', value: (w) => w.slug || '' },
        { label: 'name', value: (w) => w.name || '' },
        { label: 'id', value: (w) => w.id || '' },
        { label: 'is_default', value: (w) => (w.is_default ? 'yes' : '') }
      ]);
    });
    return 0;
  }

  if (sub === 'get') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('id|slug required');
    const data = await api('GET', `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data);
    return 0;
  }

  if (sub === 'create') {
    const { values, positionals } = parseArgs(rest, COMMON);
    const name = positionals[0];
    if (!name) throw new Error('name required');
    const body = { name, ...buildBody(values) };
    const data = await api('POST', '/workspaces', {
      auth: auth(values),
      requiresManagement: true,
      body
    });
    printResult(data);
    return 0;
  }

  if (sub === 'update') {
    const { values, positionals } = parseArgs(rest, { ...COMMON, name: { type: 'string' } });
    if (!positionals[0]) throw new Error('id|slug required');
    const body = buildBody(values);
    if (values.name) body.name = values.name;
    const data = await api('PATCH', `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true,
      body
    });
    printResult(data);
    return 0;
  }

  if (sub === 'delete') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('id|slug required');
    const data = await api('DELETE', `/workspaces/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values),
      requiresManagement: true
    });
    printResult(data, () => outln('deleted'));
    return 0;
  }

  if (sub === 'add-members' || sub === 'remove-members') {
    const { values, positionals } = parseArgs(rest, {});
    if (positionals.length < 2) throw new Error('Usage: <id|slug> <userId>...');
    const id = positionals[0];
    const userIds = positionals.slice(1);
    const path = sub === 'add-members'
      ? `/workspaces/${encodeURIComponent(id)}/members/add`
      : `/workspaces/${encodeURIComponent(id)}/members/remove`;
    const data = await api('POST', path, {
      auth: auth(values),
      requiresManagement: true,
      body: { user_ids: userIds }
    });
    printResult(data);
    return 0;
  }

  throw new Error(`Unknown workspaces subcommand: ${sub}`);
}
