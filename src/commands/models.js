import { parseArgs, authFromValues } from '../args.js';
import { api } from '../api.js';
import { c, isJsonMode, outln, printResult, table } from '../output.js';

const HELP = `Usage: openrouter models [subcommand] [options]

Subcommands:
  list                       List all models (default)
  show <id>                  Full detail for a single model (pricing breakdown,
                             architecture, supported params, top provider)
  endpoints <author>/<slug>  List endpoints (provider variants) for a model
  count                      Get the total model count

Options for list:
  --category <name>          programming|roleplay|marketing|technology|...
  --supported <param>        Filter by supported parameter (e.g. tools)
  --output-modalities <csv>  text,image,audio,embeddings  (or "all")
  --filter <substr>          Local substring filter on id/name
  --free                     Only :free models
  --sort <field>             id|name|context|prompt|completion (default: as-returned)
`;

function listFormatter(data) {
  const rows = data.data || [];
  table(rows.slice(0, 200), [
    { label: 'id', value: (m) => m.id },
    {
      label: 'context',
      value: (m) => (m.context_length || '').toLocaleString?.() ?? m.context_length
    },
    {
      label: 'in/out $/M',
      value: (m) => {
        const p = m.pricing || {};
        const fmt = (x) => (x == null ? '-' : (Number(x) * 1e6).toFixed(2));
        return `${fmt(p.prompt)}/${fmt(p.completion)}`;
      }
    },
    { label: 'name', value: (m) => m.name || '' }
  ]);
  if (rows.length > 200) outln(c.dim(`... ${rows.length - 200} more (use --json for the full list)`));
}

function fmtPerMillion(x) {
  if (x == null || x === '') return '-';
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return '$' + (n * 1e6).toFixed(n * 1e6 < 0.1 ? 4 : 2) + '/M';
}

function fmtFlat(x) {
  if (x == null || x === '') return '-';
  const n = Number(x);
  if (!Number.isFinite(n)) return String(x);
  return '$' + n.toFixed(n < 0.001 ? 6 : 4);
}

function renderModelDetail(m) {
  outln(c.bold(m.name || m.id));
  outln(c.dim(m.id));
  if (m.canonical_slug && m.canonical_slug !== m.id) outln(c.dim(`canonical: ${m.canonical_slug}`));
  if (m.hugging_face_id) outln(c.dim(`hugging_face: ${m.hugging_face_id}`));
  outln('');
  if (m.description) {
    outln(m.description);
    outln('');
  }

  const a = m.architecture || {};
  outln(c.bold('architecture'));
  outln(`  modality:          ${a.modality ?? '-'}`);
  outln(`  input_modalities:  ${(a.input_modalities || []).join(', ') || '-'}`);
  outln(`  output_modalities: ${(a.output_modalities || []).join(', ') || '-'}`);
  outln(`  tokenizer:         ${a.tokenizer ?? '-'}`);
  outln(`  instruct_type:     ${a.instruct_type ?? '-'}`);
  outln('');

  const tp = m.top_provider || {};
  outln(c.bold('top provider'));
  outln(`  context_length:        ${tp.context_length ?? m.context_length ?? '-'}`);
  outln(`  max_completion_tokens: ${tp.max_completion_tokens ?? '-'}`);
  outln(`  is_moderated:          ${tp.is_moderated ?? '-'}`);
  outln('');

  const p = m.pricing || {};
  outln(c.bold('pricing  ') + c.dim('(per token unless noted)'));
  const priceRows = [
    ['prompt (input)', fmtPerMillion(p.prompt)],
    ['completion (output)', fmtPerMillion(p.completion)],
    ['input cache read', fmtPerMillion(p.input_cache_read)],
    ['input cache write', fmtPerMillion(p.input_cache_write)],
    ['internal reasoning', fmtPerMillion(p.internal_reasoning)],
    ['image input', p.image != null ? fmtFlat(p.image) + ' /image' : '-'],
    ['request', p.request != null ? fmtFlat(p.request) + ' /request' : '-'],
    ['web search', p.web_search != null ? fmtFlat(p.web_search) + ' /search' : '-']
  ];
  for (const [k, v] of priceRows) {
    if (v === '-') continue;
    outln(`  ${k.padEnd(22)} ${v}`);
  }
  outln('');

  outln(c.bold('supported_parameters'));
  outln('  ' + ((m.supported_parameters || []).join(', ') || '-'));
  outln('');

  if (m.default_parameters && Object.keys(m.default_parameters).length) {
    outln(c.bold('default_parameters'));
    for (const [k, v] of Object.entries(m.default_parameters)) {
      if (v == null) continue;
      outln(`  ${k}: ${v}`);
    }
    outln('');
  }

  if (m.knowledge_cutoff) outln(c.dim(`knowledge_cutoff: ${m.knowledge_cutoff}`));
  if (m.expiration_date) outln(c.dim(`expiration_date: ${m.expiration_date}`));
  if (m.created) outln(c.dim(`created: ${new Date(m.created * 1000).toISOString()}`));
  if (m.per_request_limits) outln(c.dim(`per_request_limits: ${JSON.stringify(m.per_request_limits)}`));
}

export async function modelsCommand(argv) {
  // Subcommand: show / endpoints / count / list
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (sub === 'show' || sub === 'info' || sub === 'detail') {
    const { values, positionals } = parseArgs(rest, {});
    if (values.help || positionals.length === 0) {
      process.stdout.write(
        'Usage: openrouter models show <model-id>\n\nShow full details (pricing, architecture, capabilities) for one model.\n'
      );
      return values.help ? 0 : 1;
    }
    const target = positionals[0].toLowerCase();
    const data = await api('GET', '/models', {
      auth: authFromValues(values),
      requireAuth: false
    });
    const rows = data.data || [];
    let m = rows.find((r) => (r.id || '').toLowerCase() === target);
    if (!m) m = rows.find((r) => (r.canonical_slug || '').toLowerCase() === target);
    if (!m) {
      const matches = rows.filter(
        (r) =>
          (r.id || '').toLowerCase().includes(target) ||
          (r.name || '').toLowerCase().includes(target)
      );
      if (matches.length === 1) m = matches[0];
      else if (matches.length > 1) {
        throw new Error(
          `Multiple matches for "${positionals[0]}":\n  ${matches
            .slice(0, 10)
            .map((r) => r.id)
            .join('\n  ')}${matches.length > 10 ? `\n  ...and ${matches.length - 10} more` : ''}`
        );
      }
    }
    if (!m) throw new Error(`No model found matching "${positionals[0]}".`);

    if (isJsonMode()) {
      printResult(m);
      return 0;
    }
    renderModelDetail(m);
    return 0;
  }

  if (sub === 'endpoints') {
    const { values, positionals } = parseArgs(rest, {
      sort: { type: 'string' },
      best: { type: 'boolean' }
    });
    if (values.help || positionals.length === 0) {
      process.stdout.write(
        'Usage: openrouter models endpoints <author>/<slug> [options]\n\n' +
          'List provider endpoints (variants) for a model, with throughput,\n' +
          'latency, uptime, and pricing.\n\n' +
          'Options:\n' +
          '  --sort <field>   throughput | latency | prompt | completion | uptime | context\n' +
          '                   Sort the list before display (best first).\n' +
          '  --best           Show only the top row after sorting.\n'
      );
      return values.help ? 0 : 1;
    }
    const target = positionals[0];
    const slash = target.indexOf('/');
    if (slash === -1) throw new Error('Expected <author>/<slug>');
    const author = target.slice(0, slash);
    const slug = target.slice(slash + 1);
    const data = await api('GET', `/models/${author}/${slug}/endpoints`, {
      auth: authFromValues(values),
      requireAuth: false
    });
    let eps = (data.data && data.data.endpoints) || data.endpoints || [];
    if (values.sort) {
      const key = values.sort;
      const score = (e) => {
        const p = e.pricing || {};
        const t = e.throughput_last_30m || {};
        const l = e.latency_last_30m || {};
        switch (key) {
          case 'throughput': return -(t.p50 ?? -Infinity);
          case 'latency': return l.p50 ?? Infinity;
          case 'prompt': return Number(p.prompt ?? Infinity);
          case 'completion': return Number(p.completion ?? Infinity);
          case 'uptime': return -(e.uptime_last_30m ?? -Infinity);
          case 'context': return -(e.context_length ?? -Infinity);
          default: return 0;
        }
      };
      eps = [...eps].sort((a, b) => {
        const va = score(a), vb = score(b);
        if (Number.isNaN(va)) return 1;
        if (Number.isNaN(vb)) return -1;
        return va - vb;
      });
    }
    if (values.best) eps = eps.slice(0, 1);

    printResult({ ...data, data: { ...(data.data || {}), endpoints: eps } }, () => {
      table(eps, [
        { label: 'provider', value: (e) => e.provider_name || e.name || '' },
        { label: 'context', value: (e) => e.context_length ?? '' },
        { label: 'max_out', value: (e) => e.max_completion_tokens ?? '' },
        {
          label: 'in/out $/M',
          value: (e) => {
            const p = e.pricing || {};
            const fmt = (x) => (x == null ? '-' : (Number(x) * 1e6).toFixed(2));
            return `${fmt(p.prompt)}/${fmt(p.completion)}`;
          }
        },
        {
          label: 'tput p50',
          value: (e) =>
            e.throughput_last_30m?.p50 != null
              ? Number(e.throughput_last_30m.p50).toFixed(0) + ' tok/s'
              : ''
        },
        {
          label: 'lat p50',
          value: (e) =>
            e.latency_last_30m?.p50 != null
              ? Number(e.latency_last_30m.p50).toFixed(0) + ' ms'
              : ''
        },
        {
          label: 'uptime 30m',
          value: (e) =>
            e.uptime_last_30m != null ? Number(e.uptime_last_30m).toFixed(1) + '%' : ''
        },
        { label: 'quant', value: (e) => e.quantization || '' }
      ]);
    });
    return 0;
  }

  if (sub === 'user') {
    const { values } = parseArgs(rest, {
      workspace: { type: 'string' }
    });
    if (values.help) {
      process.stdout.write(
        'Usage: openrouter models user [--workspace <id|slug>]\n\nList models filtered by your workspace provider preferences, privacy, and guardrails.\n'
      );
      return 0;
    }
    const query = {};
    if (values.workspace) query.workspace_id = values.workspace;
    const data = await api('GET', '/models/user', {
      auth: authFromValues(values),
      query
    });
    printResult(data, () => listFormatter(data));
    return 0;
  }

  if (sub === 'count') {
    const { values } = parseArgs(rest, {});
    const data = await api('GET', '/models/count', {
      auth: authFromValues(values),
      requireAuth: false
    });
    printResult(data, () => outln(JSON.stringify(data)));
    return 0;
  }

  // list
  const { values } = parseArgs(rest, {
    category: { type: 'string' },
    supported: { type: 'string' },
    'output-modalities': { type: 'string' },
    filter: { type: 'string' },
    free: { type: 'boolean' },
    sort: { type: 'string' }
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const query = {};
  if (values.category) query.category = values.category;
  if (values.supported) query.supported_parameters = values.supported;
  if (values['output-modalities'])
    query.output_modalities = values['output-modalities'];

  const data = await api('GET', '/models', {
    auth: authFromValues(values),
    query,
    requireAuth: false
  });

  let rows = data.data || [];
  if (values.filter) {
    const f = values.filter.toLowerCase();
    rows = rows.filter(
      (m) =>
        (m.id || '').toLowerCase().includes(f) ||
        (m.name || '').toLowerCase().includes(f)
    );
  }
  if (values.free) rows = rows.filter((m) => (m.id || '').endsWith(':free'));

  if (values.sort) {
    const key = values.sort;
    const get = (m) => {
      switch (key) {
        case 'id': return m.id || '';
        case 'name': return m.name || '';
        case 'context': return -(m.context_length || 0);
        case 'prompt': return Number(m.pricing?.prompt ?? Infinity);
        case 'completion': return Number(m.pricing?.completion ?? Infinity);
        default: return 0;
      }
    };
    rows = [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va < vb) return -1;
      if (va > vb) return 1;
      return 0;
    });
  }

  const filtered = { ...data, data: rows };
  printResult(filtered, () => listFormatter(filtered));
  return 0;
}

export async function providersCommand(argv) {
  const { values } = parseArgs(argv, {});
  if (values.help) {
    process.stdout.write('Usage: openrouter providers\n\nList all providers.\n');
    return 0;
  }
  const data = await api('GET', '/providers', {
    auth: authFromValues(values),
    requireAuth: false
  });
  printResult(data, () => {
    const rows = data.data || [];
    table(rows, [
      { label: 'slug', value: (p) => p.slug || p.id || '' },
      { label: 'name', value: (p) => p.name || '' },
      { label: 'hq', value: (p) => p.headquarters || '' },
      { label: 'datacenters', value: (p) => (p.datacenters || []).join(',') || '' },
      { label: 'privacy', value: (p) => (p.privacy_policy_url ? 'yes' : '') },
      { label: 'tos', value: (p) => (p.terms_of_service_url ? 'yes' : '') },
      { label: 'status', value: (p) => (p.status_page_url ? 'yes' : '') }
    ]);
  });
  return 0;
}
