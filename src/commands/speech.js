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
import { c, info, outln, printResult, table, writeBinaryOutput } from "../output.js";

const HELP = `Usage: openrouter speech [text...] [options]
       openrouter speech models [<author>/<slug>]

Generate speech audio from text. Reads text from arguments or stdin.
\`speech models\` lists text-to-speech models (no key needed); with a model id
it shows that model's voices, formats and providers. To speak text that starts
with the word "models", pipe it on stdin.

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
      --format <fmt>   mp3 | pcm (default: mp3, or pcm for HeyGen Voice and
                       Gemini TTS, which only return pcm; pcm is raw 16-bit audio)
      --speed <n>      Speech speed (e.g. 1.0)
      --delivery <d>   stream (default, audio bytes) | url (store the audio and print
                       JSON with a signed download url, expires_at, media_type; the
                       url is a bearer link valid up to 24h). Falls back to bytes
                       under zero data retention.
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

function speechParams(m) {
  const out = (m.output_modalities || []).find((o) => o.type === "speech") || {};
  return out.supported_parameters || {};
}

function enumValues(p) {
  return p && Array.isArray(p.values) ? p.values : [];
}

async function speechModels(argv) {
  const { values, positionals } = parseArgs(argv, {});
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const auth = authFromValues(values);
  if (!positionals[0]) {
    const data = await api("GET", "/audio/speech/models", { auth, requireAuth: false });
    printResult(data, () => {
      table(data.data || [], [
        { label: "id", value: (m) => m.id },
        { label: "voices", value: (m) => enumValues(speechParams(m).voice).length || "" },
        { label: "formats", value: (m) => enumValues(speechParams(m).response_format).join(",") },
        { label: "providers", value: (m) => (m.endpoints || []).length },
        { label: "name", value: (m) => m.name || "" },
      ]);
    });
    return 0;
  }
  const target = positionals[0];
  const slash = target.indexOf("/");
  if (slash === -1) throw new Error("Expected <author>/<slug>");
  const author = encodeURIComponent(target.slice(0, slash));
  const slug = encodeURIComponent(target.slice(slash + 1));
  const data = await api("GET", `/audio/speech/models/${author}/${slug}`, {
    auth,
    requireAuth: false,
  });
  printResult(data, () => {
    const m = data.data || data;
    const params = speechParams(m);
    outln(`${c.bold("id:")} ${m.id}`);
    if (m.name) outln(`${c.bold("name:")} ${m.name}`);
    if (m.description) outln(`${c.bold("description:")} ${m.description}`);
    for (const [name, p] of Object.entries(params)) {
      const vals = enumValues(p);
      let shown = p.type || "supported";
      if (vals.length) shown = vals.join(", ");
      else if (p.type === "range" && p.min != null && p.max != null) shown = `${p.min} to ${p.max}`;
      outln(`${c.bold(`${name}:`)} ${shown}`);
    }
    const eps = m.endpoints || [];
    if (eps.length) {
      outln(c.bold("providers:"));
      table(eps, [
        { label: "provider", value: (e) => e.provider_name || "" },
        { label: "slug", value: (e) => e.provider_slug || "" },
      ]);
    }
  });
  return 0;
}

export async function speechCommand(argv) {
  if (argv[0] === "models") return speechModels(argv.slice(1));
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    voice: { type: "string" },
    instructions: { type: "string" },
    turns: { type: "string" },
    ref: { type: "string", multiple: true },
    "ref-text": { type: "string", multiple: true },
    format: { type: "string" },
    speed: { type: "string" },
    delivery: { type: "string" },
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

  // The API defaults to raw PCM; ask for mp3 so the default out.mp3 plays,
  // except on HeyGen Voice and Gemini TTS, which return only pcm (400 on mp3).
  const pcmOnly = /^heygen\//.test(values.model) || /^google\/.*-tts\b/.test(values.model);
  const format = values.format || (pcmOnly ? "pcm" : "mp3");
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
  if (values.delivery) {
    if (!["stream", "url"].includes(values.delivery)) {
      throw new Error("--delivery must be stream or url");
    }
    body.output_delivery = values.delivery;
  }
  if (values.provider) body.provider = await loadJson(values.provider, "--provider");
  await applyRequestFields(body, values);
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));

  const res = await api("POST", "/audio/speech", {
    auth: authFromValues(values),
    body,
    raw: true,
  });
  // output_delivery=url answers JSON; stream (and the ZDR fallback) answers audio bytes.
  if ((res.headers.get("content-type") || "").includes("application/json")) {
    printResult(await res.json());
    return 0;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());

  const outFormat = body.response_format;
  const out = values.out || `out.${outFormat}`;
  if (outFormat === "pcm" && /\.mp3$/i.test(out)) {
    info(`warning: ${out} holds raw PCM audio, not mp3 (use --format mp3 or a .pcm name)`);
  }
  await writeBinaryOutput(bytes, out);
  return 0;
}
