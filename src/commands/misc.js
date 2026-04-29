import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, outln, printResult, table } from '../output.js';

export async function orgMembersCommand(argv) {
  const { values } = parseArgs(argv, {
    offset: { type: 'string' },
    limit: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(
      'Usage: openrouter org members [--offset N] [--limit N]\n\nList organization members. Requires a management key.\n'
    );
    return 0;
  }
  const query = {};
  if (values.offset) query.offset = values.offset;
  if (values.limit) query.limit = values.limit;
  const data = await api('GET', '/organization/members', {
    auth: authFromValues(values),
    requiresManagement: true,
    query
  });
  printResult(data, () => {
    const rows = data.data || [];
    table(rows, [
      { label: 'user_id', value: (m) => m.user_id || m.id || '' },
      { label: 'email', value: (m) => m.email || '' },
      { label: 'role', value: (m) => m.role || '' },
      { label: 'name', value: (m) => m.name || '' }
    ]);
  });
  return 0;
}

export async function orgCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'members') return orgMembersCommand(rest);
  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(
      'Usage: openrouter org <subcommand>\n\nSubcommands:\n  members   List organization members (management key)\n'
    );
    return sub ? 0 : 1;
  }
  throw new Error(`Unknown org subcommand: ${sub}`);
}

export async function zdrCommand(argv) {
  const { values } = parseArgs(argv, {});
  if (values.help) {
    process.stdout.write(
      'Usage: openrouter zdr\n\nPreview the impact of Zero Data Retention on the available endpoints.\n'
    );
    return 0;
  }
  const data = await api('GET', '/endpoints/zdr', {
    auth: authFromValues(values)
  });
  printResult(data, () => outln(JSON.stringify(data, null, 2)));
  return 0;
}

export async function authCodeCommand(argv) {
  const { values } = parseArgs(argv, {
    'callback-url': { type: 'string' },
    'code-challenge': { type: 'string' },
    'code-challenge-method': { type: 'string' },
    'expires-at': { type: 'string' },
    'key-label': { type: 'string' },
    limit: { type: 'string' },
    'usage-limit-type': { type: 'string' }
  });
  if (values.help || !values['callback-url']) {
    process.stdout.write(
      'Usage: openrouter auth-code --callback-url <url> [options]\n\n' +
        'Mint a PKCE authorization code so a user can claim a key for your app.\n' +
        'Requires a management key.\n\n' +
        'Options:\n' +
        '  --callback-url <url>           HTTPS URL on port 443 or 3000 (required)\n' +
        '  --code-challenge <s>           PKCE challenge\n' +
        '  --code-challenge-method <m>    S256 | plain\n' +
        '  --expires-at <iso>             Optional ISO 8601 UTC expiry\n' +
        '  --key-label <text>             Custom label for the resulting key\n' +
        '  --limit <usd>                  Credit limit\n' +
        '  --usage-limit-type <p>         daily | weekly | monthly\n'
    );
    return values.help ? 0 : 1;
  }
  const body = { callback_url: values['callback-url'] };
  if (values['code-challenge']) body.code_challenge = values['code-challenge'];
  if (values['code-challenge-method']) body.code_challenge_method = values['code-challenge-method'];
  if (values['expires-at']) body.expires_at = values['expires-at'];
  if (values['key-label']) body.key_label = values['key-label'];
  if (values.limit) body.limit = Number(values.limit);
  if (values['usage-limit-type']) body.usage_limit_type = values['usage-limit-type'];
  const data = await api('POST', '/auth/keys/code', {
    auth: authFromValues(values),
    requiresManagement: true,
    body
  });
  printResult(data, () => outln(JSON.stringify(data, null, 2)));
  return 0;
}
