import { parseArgs, authFromValues, numberOption } from '../args.js';
import { api } from '../api.js';
import { c, info, outln, printResult, writeBinaryOutput } from '../output.js';

const HELP = `Usage: openrouter video <subcommand> [options]

Subcommands:
  create [prompt...]              Submit a video generation job
  models                          List video models
  get <jobId>                     Get job status
  download <jobId> [-o file]      Download generated video content
  wait <jobId>                    Poll until the job completes

create options:
  -m, --model <id>     Video model id (required)
  -p, --prompt <text>  Prompt (or pass as positional)
      --duration <s>
      --aspect <ratio> e.g. 16:9
      --provider <json>
      --extra <json>   Extra fields merged into the body
`;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function videoCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const auth = (vals) => authFromValues(vals);

  if (!sub || sub === '-h' || sub === '--help' || sub === 'help') {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  if (sub === 'models') {
    const { values } = parseArgs(rest, {});
    const data = await api('GET', '/videos/models', { auth: auth(values) });
    printResult(data);
    return 0;
  }

  if (sub === 'create') {
    const { values, positionals } = parseArgs(rest, {
      model: { type: 'string', short: 'm' },
      prompt: { type: 'string', short: 'p' },
      duration: { type: 'string' },
      aspect: { type: 'string' },
      provider: { type: 'string' },
      extra: { type: 'string' }
    });
    if (!values.model) throw new Error('--model is required');
    const prompt = values.prompt || positionals.join(' ').trim();
    if (!prompt) throw new Error('Prompt is required');
    const body = { model: values.model, prompt };
    if (values.duration) body.duration = Number(values.duration);
    if (values.aspect) body.aspect_ratio = values.aspect;
    if (values.provider) body.provider = JSON.parse(values.provider);
    if (values.extra) Object.assign(body, JSON.parse(values.extra));

    const data = await api('POST', '/videos', { auth: auth(values), body });
    printResult(data, () => {
      const id = data.id || data.job_id || (data.data && data.data.id);
      outln(`${c.bold('job:')} ${id}`);
      outln(JSON.stringify(data, null, 2));
    });
    return 0;
  }

  if (sub === 'get') {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error('jobId required');
    const data = await api('GET', `/videos/${encodeURIComponent(positionals[0])}`, {
      auth: auth(values)
    });
    printResult(data);
    return 0;
  }

  if (sub === 'wait') {
    const { values, positionals } = parseArgs(rest, {
      interval: { type: 'string' },
      timeout: { type: 'string' }
    });
    if (!positionals[0]) throw new Error('jobId required');
    const interval = (numberOption(values.interval, '--interval') ?? 5) * 1000;
    const timeout = (numberOption(values.timeout, '--timeout') ?? 600) * 1000;
    if (interval <= 0) throw new Error('--interval must be greater than 0');
    if (timeout <= 0) throw new Error('--timeout must be greater than 0');
    const start = Date.now();
    while (true) {
      const data = await api('GET', `/videos/${encodeURIComponent(positionals[0])}`, {
        auth: auth(values)
      });
      const status = data.status || (data.data && data.data.status);
      info(`status: ${status}`);
      if (['succeeded', 'completed', 'failed', 'cancelled', 'error'].includes(status)) {
        printResult(data);
        return ['failed', 'cancelled', 'error'].includes(status) ? 4 : 0;
      }
      if (Date.now() - start > timeout) {
        throw new Error('timeout waiting for job');
      }
      await sleep(interval);
    }
  }

  if (sub === 'download') {
    const { values, positionals } = parseArgs(rest, {
      out: { type: 'string', short: 'o' }
    });
    if (!positionals[0]) throw new Error('jobId required');
    const bytes = await api('GET', `/videos/${encodeURIComponent(positionals[0])}/content`, {
      auth: auth(values),
      binary: true
    });
    const out = values.out || `${positionals[0]}.mp4`;
    await writeBinaryOutput(bytes, out);
    return 0;
  }

  throw new Error(`Unknown video subcommand: ${sub}`);
}
