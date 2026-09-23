import { parseArgs, authFromValues } from "../args.js";
import { api } from "../api.js";
import { printResult } from "../output.js";

const HELP = `Usage: openrouter decisions [options]

Submit a structured Decisions request (alpha). The API is designed for typed
choice, score, and yes/no decisions, such as routing or classification.

Options:
  -m, --model <id>         Decisions model id (required without --body)
      --state <json|text>  State to evaluate (required without --body)
      --questions <json>   Questions object or @questions.json
      --body <json|@file>  Fully-formed request body
      --extra <json>       Extra fields merged into the request
`;

async function loadJson(value, flag) {
  if (value == null) return undefined;
  const text = value.startsWith("@")
    ? await (async () => {
        const { readFile } = await import("node:fs/promises");
        return readFile(value.slice(1), "utf8");
      })()
    : value;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON for ${flag}: ${err.message}`);
  }
}

async function loadState(value) {
  if (value == null) return undefined;
  if (value.startsWith("@")) return loadJson(value, "--state");
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function decisionsCommand(argv) {
  const { values } = parseArgs(argv, {
    model: { type: "string", short: "m" },
    state: { type: "string" },
    questions: { type: "string" },
    body: { type: "string" },
    extra: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  let body = values.body ? await loadJson(values.body, "--body") : null;
  if (!body) {
    if (!values.model) throw new Error("--model is required");
    if (values.state === undefined) throw new Error("--state is required");
    if (!values.questions) throw new Error("--questions is required");
    body = {
      model: values.model,
      state: await loadState(values.state),
      questions: await loadJson(values.questions, "--questions"),
    };
  }
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));
  const data = await api("POST", "/decisions", {
    rootPath: "/api/alpha",
    auth: authFromValues(values),
    body,
  });
  printResult(data);
  return 0;
}
