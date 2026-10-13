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
import { isJsonMode, outln, printJSON } from "../output.js";

const HELP = `Usage: openrouter transcribe <audio-file> [options]
       openrouter transcribe --url <https://...> [options]

Transcribe speech to text (POST /audio/transcriptions). The audio file is
uploaded as multipart form data (max 25 MB), or fetched by the provider
from --url.

Options:
  -m, --model <id>       Transcription model id (required)
  -f, --file <path>      Audio file (or pass as a positional)
      --url <src>        Public http(s) audio URL instead of a file (source_url;
                         some providers only)
      --language <code>  ISO-639-1 language hint (e.g. en)
      --temperature <n>
      --format <fmt>     response_format: json | verbose_json (default: json;
                         verbose_json when --diarize or --timestamps is set)
      --timestamps <l>   word,segment (timestamp_granularities, verbose_json only)
      --diarize          Label each word with its speaker (some providers only)
      --keyterms <csv>   Terms or names to bias recognition toward (repeatable)
      --provider <json|@file>  Routing and provider options, e.g.
                         '{"zdr":true,"options":{"elevenlabs":{"tag_audio_events":false}}}'
      --extra <json|@file>     Extra form fields (arrays repeat the field, objects
                         are sent as JSON)
${MEDIA_FIELD_HELP}`;

function csvList(values) {
  return (values || [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
}

function appendField(form, key, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) for (const item of value) appendField(form, key, item);
  else if (typeof value === "object") form.append(key, JSON.stringify(value));
  else form.append(key, String(value));
}

function fmtTime(sec) {
  if (typeof sec !== "number") return "";
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1).padStart(4, "0");
  return `${m}:${s}`;
}

// Group words into speaker turns when segments carry no speaker label.
function speakerTurns(data) {
  const segments = (data.segments || []).filter((s) => s.speaker_label || s.speaker != null);
  if (segments.length) return segments;
  const turns = [];
  for (const w of data.words || []) {
    const who = w.speaker_label ?? w.speaker;
    if (who == null) continue;
    const last = turns[turns.length - 1];
    const text = w.word ?? "";
    if (last && (last.speaker_label ?? last.speaker) === who) {
      last.text += /^[,.!?;:]/.test(text) ? text : ` ${text}`;
      last.end = w.end;
    } else {
      turns.push({ speaker_label: who, start: w.start, end: w.end, text });
    }
  }
  return turns;
}

export async function transcribeCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    file: { type: "string", short: "f" },
    url: { type: "string" },
    language: { type: "string" },
    temperature: { type: "string" },
    format: { type: "string" },
    timestamps: { type: "string", multiple: true },
    diarize: { type: "boolean" },
    keyterms: { type: "string", multiple: true },
    provider: { type: "string" },
    extra: { type: "string" },
    ...MEDIA_FIELD_OPTIONS,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error("--model is required");
  const path = values.file || positionals[0];
  if (!path && !values.url) throw new Error("No audio. Pass a file path, --file, or --url.");
  if (path && values.url) throw new Error("Pass either an audio file or --url, not both.");

  const timestamps = csvList(values.timestamps);
  for (const t of timestamps) {
    if (t !== "word" && t !== "segment") throw new Error(`--timestamps: unknown level "${t}"`);
  }
  let format = values.format;
  if (!format && (values.diarize || timestamps.length)) format = "verbose_json";
  if (values.diarize && format !== "verbose_json") {
    throw new Error("--diarize needs --format verbose_json");
  }

  const form = new FormData();
  form.append("model", values.model);
  if (path) {
    const { readFile } = await import("node:fs/promises");
    const buf = await readFile(path);
    const filename = path.split("/").pop() || "audio";
    form.append("file", new Blob([buf]), filename);
  } else {
    form.append("source_url", values.url);
  }
  if (values.language) form.append("language", values.language);
  if (values.temperature !== undefined && values.temperature !== "")
    form.append("temperature", String(numberOption(values.temperature, "--temperature")));
  if (format) form.append("response_format", format);
  for (const t of timestamps) form.append("timestamp_granularities[]", t);
  if (values.diarize) form.append("diarize", "true");
  for (const term of csvList(values.keyterms)) form.append("keyterms[]", term);
  if (values.provider) {
    form.append("provider", JSON.stringify(await loadJson(values.provider, "--provider")));
  }
  const fields = await applyRequestFields({}, values);
  for (const [k, v] of Object.entries(fields)) appendField(form, k, v);
  if (values.extra) {
    const extra = await loadJson(values.extra, "--extra");
    for (const [k, v] of Object.entries(extra)) {
      form.delete(k);
      appendField(form, k, v);
    }
  }

  const data = await api("POST", "/audio/transcriptions", {
    auth: authFromValues(values),
    body: form,
  });

  if (isJsonMode()) {
    printJSON(data);
  } else if (typeof data === "string") {
    outln(data);
  } else if (values.diarize && speakerTurns(data).length) {
    for (const t of speakerTurns(data)) {
      const who = t.speaker_label ?? t.speaker;
      const span = t.start != null ? `[${fmtTime(t.start)}-${fmtTime(t.end)}] ` : "";
      outln(`${span}${who}: ${String(t.text).trim()}`);
    }
  } else {
    outln(data.text ?? JSON.stringify(data));
  }
  return 0;
}
