import { parseArgs, authFromValues, loadJson } from "../args.js";
import { api } from "../api.js";
import { mediaUrl } from "../media.js";
import { printResult } from "../output.js";

const HELP = `Usage: openrouter systemone [options]
       openrouter decisions [options]       (same command)

Submit a System One (Decisions) request: state plus typed questions (choice,
score, yes/no), answered by a System One model such as typesafe/jev-latest.
Used for routing, classification and other structured decisions.

Options:
  -m, --model <id>         Model id, e.g. jev-latest (required without --body)
      --state <json|text>  State to evaluate (required without --body)
      --questions <json>   Questions object or @questions.json
      --image <url|path>   Add an image to the state (repeatable). Local files
                           are sent as data URLs. For multimodal models.
      --body <json|@file>  Fully-formed request body
      --extra <json>       Extra fields merged into the request
      --alpha              Use the older /api/alpha/decisions route

Example:
  openrouter systemone -m jev-latest --state "Refund request for order 123" \\
    --questions '{"route":{"type":"choice","options":["billing","support"]}}'
`;

async function imagePart(value) {
  return { type: "image_url", image_url: { url: await mediaUrl(value) } };
}

// State becomes an array of parts: a text state turns into a text part, an
// object stays one element, an array keeps its items; images go last.
export function withImages(state, parts) {
  if (!parts.length) return state;
  let base;
  if (state === undefined || state === null || state === "") base = [];
  else if (Array.isArray(state)) base = state;
  else if (typeof state === "string") base = [{ type: "text", text: state }];
  else base = [state];
  return [...base, ...parts];
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
    image: { type: "string", multiple: true },
    body: { type: "string" },
    extra: { type: "string" },
    alpha: { type: "boolean" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const images = values.image || [];
  let body = values.body ? await loadJson(values.body, "--body") : null;
  if (!body) {
    if (!values.model) throw new Error("--model is required");
    if (values.state === undefined && !images.length) throw new Error("--state is required");
    if (!values.questions) throw new Error("--questions is required");
    body = {
      model: values.model,
      state: await loadState(values.state),
      questions: await loadJson(values.questions, "--questions"),
    };
  }
  if (images.length) {
    const parts = await Promise.all(images.map(imagePart));
    body.state = withImages(body.state, parts);
  }
  if (values.extra) Object.assign(body, await loadJson(values.extra, "--extra"));
  const data = values.alpha
    ? await api("POST", "/decisions", {
        rootPath: "/api/alpha",
        auth: authFromValues(values),
        body,
      })
    : await api("POST", "/systemone", { auth: authFromValues(values), body });
  printResult(data);
  return 0;
}

export const systemoneCommand = decisionsCommand;
