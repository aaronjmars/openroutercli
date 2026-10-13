import {
  parseArgs,
  authFromValues,
  numberOption,
  loadJson,
  applyRequestFields,
  MEDIA_FIELD_HELP,
  MEDIA_FIELD_OPTIONS,
} from "../args.js";
import { api } from "../api.js";
import { mediaKind, mediaUrl } from "../media.js";
import { c, info, outln, printResult, writeBinaryOutput } from "../output.js";

// Spec statuses: pending | in_progress | completed | failed | cancelled | expired.
const FAILED_STATUSES = ["failed", "cancelled", "expired", "error"];
const TERMINAL_STATUSES = ["succeeded", "completed", ...FAILED_STATUSES];

const HELP = `Usage: openrouter video <subcommand> [options]

Subcommands:
  create [prompt...]              Submit a video generation job
  models                          List video models
  get <jobId>                     Get job status
  download <jobId> [-o file]      Download generated video content
  wait <jobId> [options]          Poll until the job completes

wait options:
      --interval <s>   Seconds between polls (default: 5)
      --timeout <s>    Give up after this many seconds (default: 600)

download options:
  -o, --out <file>     Output file (default: <jobId>.mp4, <jobId>-<n>.mp4 with --index)
      --index <n>      Which output to fetch when the job made several (default: 0)

create options:
  -m, --model <id>     Video model id (required)
  -p, --prompt <text>  Prompt (or pass as positional; optional with frames/refs
                       on models that support image-only input)
      --duration <s>
      --resolution <r> 360p | 480p | 720p | 768p | 1080p | 1K | 2K | 4K
      --size <WxH>     Exact pixels, e.g. 1280x720 (instead of resolution + aspect)
      --aspect <ratio> 16:9 | 9:16 | 1:1 | 4:3 | 3:4 | 3:2 | 2:3 | 21:9 | 9:21
      --seed <n>
      --audio          Generate audio with the video (--no-audio to turn off)
      --first-frame <url|path>  Image to use as the first frame
      --last-frame <url|path>   Image to use as the last frame
      --ref <url|path> Reference asset (repeatable). Type comes from the extension
                       or a prefix: image:<src>, audio:<src>, video:<src>
      --extend <jobId> Edit or extend a completed job (previous_job_id)
      --callback-url <url>  HTTPS webhook called when the job finishes
      --provider <json|@file>
      --extra <json|@file>  Extra fields merged into the body (last)
${MEDIA_FIELD_HELP}`;

const REF_TYPES = { image: "image_url", audio: "audio_url", video: "video_url" };

async function referencePart(value) {
  const m = /^(image|audio|video):(?!\/\/)(.+)$/i.exec(value);
  const src = m ? m[2] : value;
  const kind = m ? m[1].toLowerCase() : mediaKind(src) || "image";
  const type = REF_TYPES[kind];
  return { type, [type]: { url: await mediaUrl(src) } };
}

function printJob(data) {
  const job = data.data && data.data.status ? data.data : data;
  printResult(data, () => {
    outln(`${c.bold("job:")} ${job.id}`);
    outln(`${c.bold("status:")} ${job.status}`);
    if (job.generation_id) outln(`${c.bold("generation:")} ${job.generation_id}`);
    if (job.expires_at != null) {
      const when = new Date(Number(job.expires_at) * 1000);
      const shown = Number.isNaN(when.getTime()) ? job.expires_at : when.toISOString();
      outln(`${c.bold("expires:")} ${shown}`);
    }
    if (job.error) outln(`${c.bold("error:")} ${job.error}`);
    for (const [i, url] of (job.unsigned_urls || []).entries()) {
      outln(`${c.bold(`url[${i}]:`)} ${url}`);
    }
    if (job.usage) outln(`${c.bold("usage:")} ${JSON.stringify(job.usage)}`);
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export async function videoCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);

  if (!sub || sub === "-h" || sub === "--help" || sub === "help") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "models") {
    const { values } = parseArgs(rest, {});
    const data = await api("GET", "/videos/models", {
      auth: authFromValues(values),
      requireAuth: false,
    });
    printResult(data);
    return 0;
  }

  if (sub === "create") {
    const { values, positionals } = parseArgs(rest, {
      model: { type: "string", short: "m" },
      prompt: { type: "string", short: "p" },
      duration: { type: "string" },
      resolution: { type: "string" },
      size: { type: "string" },
      aspect: { type: "string" },
      seed: { type: "string" },
      audio: { type: "boolean" },
      "no-audio": { type: "boolean" },
      "first-frame": { type: "string" },
      "last-frame": { type: "string" },
      ref: { type: "string", multiple: true },
      extend: { type: "string" },
      "callback-url": { type: "string" },
      provider: { type: "string" },
      extra: { type: "string" },
      ...MEDIA_FIELD_OPTIONS,
    });
    if (!values.model) throw new Error("--model is required");
    if (values.audio && values["no-audio"]) throw new Error("Use --audio or --no-audio, not both");
    const prompt = values.prompt || positionals.join(" ").trim();
    const hasMedia = values["first-frame"] || values["last-frame"] || values.ref?.length;
    if (!prompt && !hasMedia && !values.extend && !values.extra) {
      throw new Error("Prompt is required (or pass --first-frame/--ref for image-only models)");
    }
    const body = { model: values.model };
    if (prompt) body.prompt = prompt;
    if (values.duration) body.duration = numberOption(values.duration, "--duration");
    if (values.resolution) body.resolution = values.resolution;
    if (values.size) body.size = values.size;
    if (values.aspect) body.aspect_ratio = values.aspect;
    if (values.seed) body.seed = numberOption(values.seed, "--seed");
    if (values.audio) body.generate_audio = true;
    if (values["no-audio"]) body.generate_audio = false;
    const frames = [];
    for (const [flag, frameType] of [
      ["first-frame", "first_frame"],
      ["last-frame", "last_frame"],
    ]) {
      if (!values[flag]) continue;
      const url = await mediaUrl(values[flag]);
      frames.push({ type: "image_url", image_url: { url }, frame_type: frameType });
    }
    if (frames.length) body.frame_images = frames;
    if (values.ref?.length) {
      body.input_references = [];
      for (const ref of values.ref) body.input_references.push(await referencePart(ref));
    }
    if (values.extend) body.previous_job_id = values.extend;
    if (values["callback-url"]) body.callback_url = values["callback-url"];
    if (values.provider) body.provider = await loadJson(values.provider, "--provider");
    await applyRequestFields(body, values);
    if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

    const data = await api("POST", "/videos", { auth: authFromValues(values), body });
    printResult(data, () => {
      const id = data.id || data.job_id || (data.data && data.data.id);
      outln(`${c.bold("job:")} ${id}`);
      outln(JSON.stringify(data, null, 2));
    });
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("jobId required");
    const data = await api("GET", `/videos/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
    });
    printJob(data);
    return 0;
  }

  if (sub === "wait") {
    const { values, positionals } = parseArgs(rest, {
      interval: { type: "string" },
      timeout: { type: "string" },
    });
    if (!positionals[0]) throw new Error("jobId required");
    const interval = (numberOption(values.interval, "--interval") ?? 5) * 1000;
    const timeout = (numberOption(values.timeout, "--timeout") ?? 600) * 1000;
    if (interval <= 0) throw new Error("--interval must be greater than 0");
    if (timeout <= 0) throw new Error("--timeout must be greater than 0");
    const start = Date.now();
    while (true) {
      const data = await api("GET", `/videos/${encodeURIComponent(positionals[0])}`, {
        auth: authFromValues(values),
      });
      const status = data.status || (data.data && data.data.status);
      info(`status: ${status}`);
      if (TERMINAL_STATUSES.includes(status)) {
        printJob(data);
        return FAILED_STATUSES.includes(status) ? 4 : 0;
      }
      if (Date.now() - start > timeout) {
        throw new Error("timeout waiting for job");
      }
      await sleep(interval);
    }
  }

  if (sub === "download") {
    const { values, positionals } = parseArgs(rest, {
      out: { type: "string", short: "o" },
      index: { type: "string" },
    });
    if (!positionals[0]) throw new Error("jobId required");
    const index = numberOption(values.index, "--index");
    if (index !== undefined && (!Number.isInteger(index) || index < 0)) {
      throw new Error("--index must be a whole number >= 0");
    }
    const bytes = await api("GET", `/videos/${encodeURIComponent(positionals[0])}/content`, {
      auth: authFromValues(values),
      binary: true,
      ...(index !== undefined ? { query: { index: String(index) } } : {}),
    });
    const out = values.out || (index ? `${positionals[0]}-${index}.mp4` : `${positionals[0]}.mp4`);
    await writeBinaryOutput(bytes, out);
    return 0;
  }

  throw new Error(`Unknown video subcommand: ${sub}`);
}
