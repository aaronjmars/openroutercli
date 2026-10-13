import {
  parseArgs,
  authFromValues,
  numberOption,
  loadJson,
  applyRequestFields,
  MEDIA_FIELD_OPTIONS,
  MEDIA_FIELD_HELP,
} from "../args.js";
import { api } from "../api.js";
import { mediaUrl } from "../media.js";
import {
  isJsonMode,
  outln,
  pricePerMillion,
  printResult,
  table,
  writeBinaryOutput,
} from "../output.js";

const HELP = `Usage: openrouter image <subcommand> [options]

Subcommands:
  create [prompt...]              Generate image(s) (default)
  models                          List image-generation models
  endpoints <author>/<slug>       List provider variants for a model

create options:
  -m, --model <id>       Image model id (required)
  -p, --prompt <text>    Prompt (or pass as positional)
      --n <count>        Number of images to generate (1-10, upper bound)
      --resolution <r>   Tier: 512 | 768 | 1K | 1.5K | 2K | 4K
      --size <s>         Tier ("2K") or exact pixels ("2048x2048"); exact pixels
                         win, a clashing --resolution/--aspect is a 400
      --aspect <ratio>   auto | 1:1 | 2:3 | 3:2 | 3:4 | 4:3 | 4:5 | 5:4 | 5:7 | 7:5 |
                         9:16 | 16:9 | 9:21 | 21:9 | 1:2 | 2:1 | 1:4 | 4:1 | 1:8 |
                         8:1 | 5:2 | 2.35:1 | 9:19.5 | 19.5:9 | 9:20 | 20:9
      --image <url|path> Reference image for image-to-image (repeatable, max 16);
                         local files are sent as data URLs
      --quality <q>      auto | low | medium | high | xhigh | max
      --format <fmt>     png | jpeg | webp | svg
      --compression <n>  0-100, webp/jpeg only
      --background <b>   auto | transparent | opaque
      --seed <n>
      --provider <json|@file>
      --extra <json|@file> Extra fields merged into the body (last)
${MEDIA_FIELD_HELP}  -o, --out <file>       Output file (prefix when generating multiple)
`;

const KNOWN_SUBCOMMANDS = new Set(["create", "generate", "models", "endpoints"]);

export async function imageCommand(argv) {
  const sub = argv[0] && KNOWN_SUBCOMMANDS.has(argv[0]) ? argv[0] : null;
  const rest = sub ? argv.slice(1) : argv;

  if (argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "models") {
    const { values } = parseArgs(rest, {});
    const data = await api("GET", "/images/models", {
      auth: authFromValues(values),
      requireAuth: false,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (m) => m.id },
        { label: "context", value: (m) => m.context_length ?? "" },
        { label: "$/M", value: (m) => pricePerMillion((m.pricing || {}).prompt) },
        { label: "name", value: (m) => m.name || "" },
      ]);
    });
    return 0;
  }

  if (sub === "endpoints") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("Expected <author>/<slug>");
    const target = positionals[0];
    const slash = target.indexOf("/");
    if (slash === -1) throw new Error("Expected <author>/<slug>");
    const author = target.slice(0, slash);
    const slug = target.slice(slash + 1);
    const data = await api("GET", `/images/models/${author}/${slug}/endpoints`, {
      auth: authFromValues(values),
      requireAuth: false,
    });
    const eps = (data.data && data.data.endpoints) || data.endpoints || [];
    printResult(data, () => {
      table(eps, [
        { label: "provider", value: (e) => e.provider_name || e.name || "" },
        {
          label: "in/out $/M",
          value: (e) => {
            const p = e.pricing || {};
            return `${pricePerMillion(p.prompt)}/${pricePerMillion(p.completion)}`;
          },
        },
        { label: "quant", value: (e) => e.quantization || "" },
      ]);
    });
    return 0;
  }

  // default (no subcommand) or create/generate: POST /images
  const { values, positionals } = parseArgs(rest, {
    model: { type: "string", short: "m" },
    prompt: { type: "string", short: "p" },
    n: { type: "string" },
    resolution: { type: "string" },
    size: { type: "string" },
    aspect: { type: "string" },
    image: { type: "string", multiple: true },
    quality: { type: "string" },
    format: { type: "string" },
    compression: { type: "string" },
    background: { type: "string" },
    seed: { type: "string" },
    provider: { type: "string" },
    extra: { type: "string" },
    out: { type: "string", short: "o" },
    ...MEDIA_FIELD_OPTIONS,
  });
  if (!values.model) throw new Error("--model is required");
  const prompt = values.prompt || positionals.join(" ").trim();
  if (!prompt) throw new Error("Prompt is required");

  const body = { model: values.model, prompt };
  if (values.n) body.n = numberOption(values.n, "--n");
  if (values.resolution) body.resolution = values.resolution;
  if (values.size) body.size = values.size;
  if (values.aspect) body.aspect_ratio = values.aspect;
  if (values.image?.length) {
    if (values.image.length > 16) throw new Error("--image accepts at most 16 references");
    body.input_references = [];
    for (const img of values.image) {
      body.input_references.push({ type: "image_url", image_url: { url: await mediaUrl(img) } });
    }
  }
  if (values.quality) body.quality = values.quality;
  if (values.format) body.output_format = values.format;
  if (values.compression)
    body.output_compression = numberOption(values.compression, "--compression");
  if (values.background) body.background = values.background;
  if (values.seed) body.seed = numberOption(values.seed, "--seed");
  if (values.provider) body.provider = await loadJson(values.provider, "--provider");
  await applyRequestFields(body, values);
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

  const data = await api("POST", "/images", { auth: authFromValues(values), body });

  if (isJsonMode()) {
    printResult(data);
    return 0;
  }

  const images = data.data || [];
  const ext = values.format || "png";
  const single = images.length === 1;
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (img.b64_json) {
      const bytes = Buffer.from(img.b64_json, "base64");
      let out;
      if (values.out) out = single ? values.out : `${values.out}-${i}.${ext}`;
      else out = `image-${i}.${ext}`;
      await writeBinaryOutput(bytes, out);
    } else if (img.url) {
      outln(img.url);
    }
  }
  return 0;
}
