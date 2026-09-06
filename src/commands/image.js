import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
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
      --n <count>        Number of images to generate
      --resolution <r>   e.g. 1024x1024
      --aspect <ratio>   e.g. 16:9
      --quality <q>
      --format <fmt>     png|jpeg|webp
      --background <b>
      --seed <n>
      --provider <json>
      --extra <json>     Extra fields merged into the body
  -o, --out <file>       Output file (prefix when generating multiple)
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
    aspect: { type: "string" },
    quality: { type: "string" },
    format: { type: "string" },
    background: { type: "string" },
    seed: { type: "string" },
    provider: { type: "string" },
    extra: { type: "string" },
    out: { type: "string", short: "o" },
  });
  if (!values.model) throw new Error("--model is required");
  const prompt = values.prompt || positionals.join(" ").trim();
  if (!prompt) throw new Error("Prompt is required");

  const body = { model: values.model, prompt };
  if (values.n) body.n = numberOption(values.n, "--n");
  if (values.resolution) body.resolution = values.resolution;
  if (values.aspect) body.aspect_ratio = values.aspect;
  if (values.quality) body.quality = values.quality;
  if (values.format) body.output_format = values.format;
  if (values.background) body.background = values.background;
  if (values.seed) body.seed = numberOption(values.seed, "--seed");
  if (values.provider) body.provider = JSON.parse(values.provider);
  if (values.extra) Object.assign(body, JSON.parse(values.extra));

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
