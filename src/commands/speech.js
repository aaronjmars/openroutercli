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
import { mediaKind, mediaUrl } from "../media.js";
import { info, writeBinaryOutput } from "../output.js";

const HELP = `Usage: openrouter speech [text...] [options]

Generate speech audio from text. Reads text from arguments or stdin.

Options:
  -m, --model <id>     TTS model id (required)
      --voice <name>   Voice id (provider-specific)
      --instructions <text>  Tone, pacing or emotion (OpenAI gpt-4o-mini-tts, Gemini TTS)
      --turns <json|@file>   Multi-speaker input instead of text (Gemini TTS):
                       [{"text":"Hi Jane.","voice":"Kore","instructions":"whispering"}, ...]
      --ref <url|path> Voice-cloning reference (repeatable, up to 3 audio clips),
                       or one image (.png/.jpg/.webp) for voice design.
                       Local files are sent as data URLs.
      --ref-text <t>   Transcript of a --ref clip (repeatable, in --ref order)
      --format <fmt>   mp3 | pcm (default: mp3; pcm is raw 16-bit audio)
      --speed <n>      Speech speed (e.g. 1.0)
  -o, --out <file>     Output audio file (default: out.mp3 / out.pcm, or stdout if -)
      --provider <json|@file>  Routing and provider options, e.g.
                       '{"zdr":true,"options":{"elevenlabs":{"stability":0.5}}}'
      --extra <json|@file>     Extra fields merged into the body (last)
${MEDIA_FIELD_HELP}`;

async function referenceParts(refs, texts) {
  if (texts.length > refs.length) throw new Error("More --ref-text values than --ref clips");
  const parts = [];
  for (const [i, ref] of refs.entries()) {
    const isUrl = /^https?:\/\//i.test(ref);
    if (mediaKind(ref) === "image") {
      parts.push({ type: "image_url", image_url: { url: await mediaUrl(ref) } });
    } else {
      const input_audio = isUrl ? { url: ref } : { data: await mediaUrl(ref) };
      parts.push({ type: "input_audio", input_audio });
    }
    if (texts[i]) parts.push({ type: "text", text: texts[i] });
  }
  return parts;
}

export async function speechCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    voice: { type: "string" },
    instructions: { type: "string" },
    turns: { type: "string" },
    ref: { type: "string", multiple: true },
    "ref-text": { type: "string", multiple: true },
    format: { type: "string" },
    speed: { type: "string" },
    out: { type: "string", short: "o" },
    provider: { type: "string" },
    extra: { type: "string" },
    ...MEDIA_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error("--model is required");

  let input;
  if (values.turns) {
    if (positionals.length) throw new Error("Pass text or --turns, not both");
    input = await loadJson(values.turns, "--turns");
    if (!Array.isArray(input) || !input.length) {
      throw new Error("--turns must be a non-empty JSON array of {text, voice?, instructions?}");
    }
  } else {
    let text = positionals.join(" ").trim();
    const piped = await readStdinIfPiped();
    if (piped) text = text ? `${text}\n${piped}` : piped;
    if (!text) throw new Error("No input text.");
    input = text;
  }

  // The API defaults to raw PCM; ask for mp3 so the default out.mp3 plays.
  const format = values.format || "mp3";
  const body = { model: values.model, input, response_format: format };
  if (values.voice) body.voice = values.voice;
  if (values.instructions) body.instructions = values.instructions;
  if (values["ref-text"]?.length && !values.ref?.length) {
    throw new Error("--ref-text needs a --ref clip");
  }
  if (values.ref?.length) {
    body.input_references = await referenceParts(values.ref, values["ref-text"] || []);
  }
  if (values.speed) body.speed = numberOption(values.speed, "--speed");
  if (values.provider) body.provider = await loadJson(values.provider, "--provider");
  await applyRequestFields(body, values);
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

  const bytes = await api("POST", "/audio/speech", {
    auth: authFromValues(values),
    body,
    binary: true,
  });

  const outFormat = body.response_format;
  const out = values.out || `out.${outFormat}`;
  if (outFormat === "pcm" && /\.mp3$/i.test(out)) {
    info(`warning: ${out} holds raw PCM audio, not mp3 (use --format mp3 or a .pcm name)`);
  }
  await writeBinaryOutput(bytes, out);
  return 0;
}
