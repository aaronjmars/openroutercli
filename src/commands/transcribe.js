import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
import { isJsonMode, outln, printJSON } from "../output.js";

const HELP = `Usage: openrouter transcribe <audio-file> [options]

Transcribe speech to text (POST /audio/transcriptions). The audio file is
uploaded as multipart form data (OpenAI-compatible).

Options:
  -m, --model <id>       Transcription model id (required)
  -f, --file <path>      Audio file (or pass as a positional)
      --language <code>  ISO-639-1 language hint (e.g. en)
      --prompt <text>    Optional prompt to guide the transcription
      --temperature <n>
      --format <fmt>     response_format: json | text | verbose_json | srt | vtt
`;

export async function transcribeCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    file: { type: "string", short: "f" },
    language: { type: "string" },
    prompt: { type: "string" },
    temperature: { type: "string" },
    format: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.model) throw new Error("--model is required");
  const path = values.file || positionals[0];
  if (!path) throw new Error("No audio file. Pass a path or use --file.");

  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  const filename = path.split("/").pop() || "audio";

  const form = new FormData();
  form.append("model", values.model);
  form.append("file", new Blob([buf]), filename);
  if (values.language) form.append("language", values.language);
  if (values.prompt) form.append("prompt", values.prompt);
  if (values.temperature !== undefined && values.temperature !== "")
    form.append("temperature", String(numberOption(values.temperature, "--temperature")));
  if (values.format) form.append("response_format", values.format);

  const data = await api("POST", "/audio/transcriptions", {
    auth: authFromValues(values),
    body: form,
  });

  if (isJsonMode()) {
    printJSON(data);
  } else if (typeof data === "string") {
    outln(data);
  } else {
    outln(data.text ?? JSON.stringify(data));
  }
  return 0;
}
