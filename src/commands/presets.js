import { parseArgs, authFromValues } from "../args.js";
import { api } from "../api.js";
import { printResult, table } from "../output.js";

const HELP = `Usage: openrouter presets <subcommand> [options]

View server-saved config presets (read-only).

Subcommands:
  list                            List presets (default)
  get <slug>                      Get a single preset
  versions <slug>                 List versions for a preset
  version <slug> <version>        Get a specific preset version
`;

export async function presetsCommand(argv) {
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = sub === argv[0] ? argv.slice(1) : argv;

  if (!argv.length || argv[0] === "-h" || argv[0] === "--help" || argv[0] === "help") {
    process.stdout.write(HELP);
    return argv[0] ? 0 : 1;
  }

  if (rest.includes("-h") || rest.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }

  if (sub === "get") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("slug required");
    const data = await api("GET", `/presets/${encodeURIComponent(positionals[0])}`, {
      auth: authFromValues(values),
    });
    printResult(data);
    return 0;
  }

  if (sub === "versions") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("slug required");
    const data = await api("GET", `/presets/${encodeURIComponent(positionals[0])}/versions`, {
      auth: authFromValues(values),
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "version", value: (v) => v.version ?? "" },
        { label: "created", value: (v) => v.created ?? "" },
      ]);
    });
    return 0;
  }

  if (sub === "version") {
    const { values, positionals } = parseArgs(rest, {});
    if (!positionals[0]) throw new Error("slug required");
    if (!positionals[1]) throw new Error("version required");
    const data = await api(
      "GET",
      `/presets/${encodeURIComponent(positionals[0])}/versions/${encodeURIComponent(positionals[1])}`,
      { auth: authFromValues(values) },
    );
    printResult(data);
    return 0;
  }

  if (sub === "list") {
    const { values } = parseArgs(rest, {});
    const data = await api("GET", "/presets", {
      auth: authFromValues(values),
    });
    printResult(data, () => {
      const rows = data.data || [];
      table(rows, [
        { label: "slug", value: (p) => p.slug || p.id || "" },
        { label: "name", value: (p) => p.name || "" },
        { label: "model", value: (p) => p.model || "" },
        {
          label: "description",
          value: (p) => {
            const d = p.description || "";
            return d.length > 60 ? d.slice(0, 57) + "..." : d;
          },
        },
      ]);
    });
    return 0;
  }

  throw new Error(`Unknown presets subcommand: ${sub}`);
}
