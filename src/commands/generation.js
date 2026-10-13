import { parseArgs, authFromValues } from "../args.js";
import { api, APIError } from "../api.js";
import { c, info, outln, printResult } from "../output.js";

const HELP = `Usage: openrouter generation <id> [--content]
       openrouter generation feedback <id> --category <c> [--comment <text>]

Fetch metadata for a generation. With --content, fetch the input/output content.
A generation can take a few seconds to show up; a 404 is retried once.

feedback: report a problem with a generation.
      --category <c>    latency | incoherence | incorrect_response | formatting |
                        billing | api_error | other
      --comment <text>  Optional detail (max 1000 chars)
`;

const ID_RE = /^gen-[0-9A-Za-z-]+$/;
const CATEGORIES = [
  "latency",
  "incoherence",
  "incorrect_response",
  "formatting",
  "billing",
  "api_error",
  "other",
];

function checkId(id) {
  if (!ID_RE.test(id) || id.length > 128) {
    throw new Error(`Invalid generation id: "${id}" (expected gen-..., letters, digits and -)`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function feedbackCommand(argv) {
  const { values, positionals } = parseArgs(argv, {
    category: { type: "string" },
    comment: { type: "string" },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const id = positionals[0];
  if (!id) throw new Error("generation id required");
  checkId(id);
  if (!values.category) throw new Error(`--category is required (${CATEGORIES.join(", ")})`);
  if (!CATEGORIES.includes(values.category)) {
    throw new Error(`Invalid --category: ${values.category} (use ${CATEGORIES.join(", ")})`);
  }
  if (values.comment !== undefined && values.comment.length > 1000) {
    throw new Error("--comment is longer than 1000 characters");
  }
  const body = { generation_id: id, category: values.category };
  if (values.comment !== undefined) body.comment = values.comment;
  const data = await api("POST", "/generation/feedback", {
    auth: authFromValues(values),
    body,
  });
  printResult(data, () => outln(`feedback recorded for ${id}`));
  return 0;
}

export async function generationCommand(argv) {
  if (argv[0] === "feedback") return feedbackCommand(argv.slice(1));
  const { values, positionals } = parseArgs(argv, {
    content: { type: "boolean" },
  });
  if (values.help || !positionals[0]) {
    process.stdout.write(HELP);
    return values.help ? 0 : 1;
  }
  const id = positionals[0];
  checkId(id);
  const path = values.content ? "/generation/content" : "/generation";
  const fetchIt = () => api("GET", path, { auth: authFromValues(values), query: { id } });
  let data;
  try {
    data = await fetchIt();
  } catch (err) {
    // Stats land a moment after the response, so a fresh id can 404 briefly.
    if (!(err instanceof APIError) || err.status !== 404) throw err;
    info("not found yet, retrying in 2s...");
    await sleep(2000);
    data = await fetchIt();
  }
  printResult(data, () => {
    const d = data.data || data;
    outln(c.bold(`generation ${id}`));
    for (const [k, v] of Object.entries(d)) {
      const display = typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "..." : v;
      outln(`  ${k}: ${typeof display === "object" ? JSON.stringify(display) : display}`);
    }
  });
  return 0;
}
