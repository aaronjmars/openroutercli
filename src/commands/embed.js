import {
  parseArgs,
  authFromValues,
  numberOption,
  readStdinIfPiped,
  loadJson,
  applyRequestFields,
  MEDIA_FIELD_HELP,
  MEDIA_FIELD_OPTIONS,
} from "../args.js";
import { api } from "../api.js";
import { mediaUrl } from "../media.js";
import { outln, pricePerMillion, printResult, table } from "../output.js";

const HELP = `Usage: openrouter embed [text...] [options]
       openrouter embed models

Generate embeddings, or list embedding models.

Options:
  -m, --model <id>      Embedding model id (required for inference)
  -i, --input <text>    Input string (repeatable)
      --image <url|path> Image to embed (repeatable, multimodal models); each is
                        its own input. Local files are sent as data URLs.
      --input-type <t>  e.g. search_query | search_document
      --dimensions <n>
      --encoding <fmt>  float | base64
      --provider <json|@file> Provider routing as JSON
      --extra <json|@file>    Extra fields merged into the body (last)
${MEDIA_FIELD_HELP}`;

export async function embedCommand(argv) {
  if (argv[0] === "models") {
    const { values } = parseArgs(argv.slice(1), {});
    if (values.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const data = await api("GET", "/embeddings/models", {
      auth: authFromValues(values),
      requireAuth: false,
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "id", value: (m) => m.id },
        { label: "context", value: (m) => m.context_length ?? "" },
        {
          label: "$/M tokens",
          value: (m) => pricePerMillion((m.pricing || {}).prompt),
        },
        { label: "name", value: (m) => m.name || "" },
      ]);
    });
    return 0;
  }

  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    input: { type: "string", short: "i", multiple: true },
    "input-type": { type: "string" },
    dimensions: { type: "string" },
    image: { type: "string", multiple: true },
    encoding: { type: "string" },
    provider: { type: "string" },
    extra: { type: "string" },
    ...MEDIA_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error("--model is required");

  const inputs = [...(values.input || []), ...positionals];
  const piped = await readStdinIfPiped();
  if (piped) inputs.push(piped);
  const images = values.image || [];
  if (!inputs.length && !images.length)
    throw new Error("No input. Pass text, use --input or --image, or pipe stdin.");

  let input = inputs.length === 1 ? inputs[0] : inputs;
  if (images.length) {
    // Multimodal form: one { content: [part] } item per text or image.
    input = inputs.map((text) => ({ content: [{ type: "text", text }] }));
    for (const img of images) {
      input.push({ content: [{ type: "image_url", image_url: { url: await mediaUrl(img) } }] });
    }
  }
  const body = { model: values.model, input };
  if (values["input-type"]) body.input_type = values["input-type"];
  if (values.dimensions) body.dimensions = numberOption(values.dimensions, "--dimensions");
  if (values.encoding) body.encoding_format = values.encoding;
  if (values.provider) body.provider = await loadJson(values.provider, "--provider");
  await applyRequestFields(body, values);
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

  const data = await api("POST", "/embeddings", {
    auth: authFromValues(values),
    body,
  });
  printResult(data, () => {
    const arr = data.data || [];
    for (const e of arr) {
      const v = e.embedding;
      if (Array.isArray(v))
        outln(
          `[${v.length}d] ${v
            .slice(0, 4)
            .map((x) => x.toFixed(5))
            .join(", ")}, ...`,
        );
      else outln(String(v).slice(0, 80) + "...");
    }
  });
  return 0;
}
