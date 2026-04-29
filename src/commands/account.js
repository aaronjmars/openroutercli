import { parseArgs, authFromValues } from '../args.js';
import { api, APIError } from '../api.js';
import { resolveAuth } from '../config.js';
import { c, isJsonMode, outln, printJSON, printResult, table } from '../output.js';

async function fetchKey(authOpts, requiresManagement = false) {
  try {
    return await api('GET', '/key', { auth: authOpts, requiresManagement });
  } catch (err) {
    if (err instanceof APIError) return { error: err.message };
    throw err;
  }
}

function renderKey(label, data) {
  outln(c.bold(label));
  if (!data) {
    outln(c.dim('  (not configured)'));
    return;
  }
  if (data.error) {
    outln('  ' + c.red(data.error));
    return;
  }
  const d = data.data || data;
  outln(`  label:              ${d.label ?? ''}`);
  outln(`  is_management_key:  ${d.is_management_key ?? false}`);
  outln(`  is_free_tier:       ${d.is_free_tier}`);
  outln(`  limit:              ${d.limit ?? 'unlimited'}`);
  outln(`  limit_remaining:    ${d.limit_remaining ?? '-'}`);
  outln(`  limit_reset:        ${d.limit_reset ?? '-'}`);
  outln(`  usage (total):      ${d.usage ?? '-'}`);
  if (d.usage_daily != null) outln(`  usage_daily:        ${d.usage_daily}`);
  if (d.usage_weekly != null) outln(`  usage_weekly:       ${d.usage_weekly}`);
  if (d.usage_monthly != null) outln(`  usage_monthly:      ${d.usage_monthly}`);
  if (d.byok_usage != null) outln(`  byok_usage:         ${d.byok_usage}`);
  outln(`  expires_at:         ${d.expires_at ?? '-'}`);
  if (d.rate_limit) {
    outln(`  rate_limit:         ${d.rate_limit.requests ?? '?'} req / ${d.rate_limit.interval ?? '?'}`);
  }
}

export async function whoamiCommand(argv) {
  const { values } = parseArgs(argv, {
    management: { type: 'boolean' }
  });
  if (values.help) {
    process.stdout.write(
      'Usage: openrouter whoami [--management]\n\n' +
        'Show the API key(s) currently configured. By default shows both the user\n' +
        'key and the management key (if set). With --management, shows only the\n' +
        'management key.\n'
    );
    return 0;
  }

  const authOpts = authFromValues(values);
  const resolved = await resolveAuth(authOpts);

  // If --key is supplied, query just that key.
  if (authOpts.key) {
    const data = await fetchKey(authOpts);
    printResult(data, () => renderKey('API key (--key override)', data));
    return 0;
  }

  if (values.management) {
    const data = resolved.hasManagementKey ? await fetchKey(authOpts, true) : null;
    if (isJsonMode()) printJSON({ management: data });
    else renderKey('Management key', data);
    return 0;
  }

  // Both
  const userData = resolved.hasUserKey ? await fetchKey(authOpts, false) : null;
  const mgmtData = resolved.hasManagementKey ? await fetchKey(authOpts, true) : null;

  if (isJsonMode()) {
    printJSON({ user: userData, management: mgmtData });
    return 0;
  }
  renderKey('User key', userData);
  outln('');
  renderKey('Management key', mgmtData);
  return 0;
}

export async function creditsCommand(argv) {
  const { values } = parseArgs(argv, {});
  if (values.help) {
    process.stdout.write('Usage: openrouter credits\n\nShow remaining credits.\n');
    return 0;
  }
  const data = await api('GET', '/credits', { auth: authFromValues(values) });
  printResult(data, () => {
    const d = data.data || data;
    outln(c.bold('Credits'));
    for (const [k, v] of Object.entries(d)) outln(`  ${k}: ${v}`);
  });
  return 0;
}

export async function activityCommand(argv) {
  const { values } = parseArgs(argv, {
    date: { type: 'string' },
    'api-key-hash': { type: 'string' },
    'user-id': { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(
      `Usage: openrouter activity [options]\n\nGet usage activity grouped by endpoint.\n\nOptions:\n  --date <YYYY-MM-DD>     UTC date in last 30 days\n  --api-key-hash <hash>   Filter by API key SHA-256 hash\n  --user-id <id>          Filter by org member user ID\n`
    );
    return 0;
  }
  const query = {};
  if (values.date) query.date = values.date;
  if (values['api-key-hash']) query.api_key_hash = values['api-key-hash'];
  if (values['user-id']) query.user_id = values['user-id'];
  const data = await api('GET', '/activity', {
    auth: authFromValues(values),
    requiresManagement: true,
    query
  });
  printResult(data, () => {
    const rows = data.data || [];
    if (!rows.length) {
      outln(c.dim('(no activity)'));
      return;
    }
    table(rows, [
      { label: 'date', value: (r) => r.date || r.day || '' },
      { label: 'model', value: (r) => r.model || r.model_permaslug || '' },
      { label: 'requests', value: (r) => r.requests ?? r.request_count ?? '' },
      { label: 'tokens', value: (r) => r.tokens ?? r.total_tokens ?? '' },
      { label: 'cost', value: (r) => r.usage ?? r.cost ?? '' }
    ]);
  });
  return 0;
}
