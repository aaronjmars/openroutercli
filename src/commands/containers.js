import { parseArgs, authFromValues, numberOption } from "../args.js";
import { api } from "../api.js";
import { printResult, writeBinaryOutput } from "../output.js";

const HELP = `Usage: openrouter containers <subcommand> [options]

Inspect files produced by OpenRouter's hosted shell/batch tools.

Subcommands:
  list <container-id> [--limit <n>] [--after <file-id>]
  get <container-id> <file-id>
  download <container-id> <file-id> [-o file]
  promote <container-id> <file-id>   Promote into workspace Files
`;

function ids(positionals) {
  if (positionals.length < 2) throw new Error("container-id and file-id required");
  return positionals.slice(0, 2).map(encodeURIComponent);
}

export async function containersCommand(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (!sub || sub === "help" || sub === "-h" || sub === "--help") {
    process.stdout.write(HELP);
    return sub ? 0 : 1;
  }
  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "list") {
    const { values, positionals } = parseArgs(rest, {
      limit: { type: "string" },
      after: { type: "string" },
    });
    if (!positionals[0]) throw new Error("container-id required");
    const query = {};
    if (values.limit !== undefined) query.limit = numberOption(values.limit, "--limit");
    if (values.after) query.after = values.after;
    const data = await api("GET", `/containers/${encodeURIComponent(positionals[0])}/files`, {
      auth: authFromValues(values),
      query,
    });
    printResult(data);
    return 0;
  }

  if (sub === "get" || sub === "download" || sub === "promote") {
    const { values, positionals } = parseArgs(rest, {
      out: { type: "string", short: "o" },
    });
    const [containerId, fileId] = ids(positionals);
    const path = `/containers/${containerId}/files/${fileId}`;
    if (sub === "get") {
      const data = await api("GET", path, { auth: authFromValues(values) });
      printResult(data);
      return 0;
    }
    if (sub === "promote") {
      const data = await api("POST", `${path}/promote`, { auth: authFromValues(values) });
      printResult(data);
      return 0;
    }
    const bytes = await api("GET", `${path}/content`, {
      auth: authFromValues(values),
      binary: true,
    });
    await writeBinaryOutput(bytes, values.out || positionals[1]);
    return 0;
  }

  throw new Error(`Unknown containers subcommand: ${sub}`);
}
