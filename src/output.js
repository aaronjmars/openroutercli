const isTTY = process.stdout.isTTY;
const noColor =
  process.env.NO_COLOR != null ||
  process.env.OPENROUTER_NO_COLOR != null ||
  !isTTY;

const wrap = (open, close) => (s) =>
  noColor ? String(s) : `\x1b[${open}m${s}\x1b[${close}m`;

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39)
};

let JSON_MODE = false;
let QUIET = false;

export function setJsonMode(v) {
  JSON_MODE = !!v;
}
export function isJsonMode() {
  return JSON_MODE;
}
export function setQuiet(v) {
  QUIET = !!v;
}

export function out(text) {
  process.stdout.write(text);
}

export function outln(text = '') {
  process.stdout.write(text + '\n');
}

export function info(text) {
  if (QUIET || JSON_MODE) return;
  process.stderr.write(c.dim(text) + '\n');
}

export function printJSON(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function printResult(data, formatter) {
  if (JSON_MODE || !formatter) {
    printJSON(data);
  } else {
    formatter(data);
  }
}

export function table(rows, columns) {
  if (rows.length === 0) return;
  const widths = columns.map((col) =>
    Math.max(
      col.label.length,
      ...rows.map((r) => String(col.value(r) ?? '').length)
    )
  );
  const header = columns
    .map((col, i) => c.bold(col.label.padEnd(widths[i])))
    .join('  ');
  outln(header);
  outln(columns.map((_, i) => c.dim('-'.repeat(widths[i]))).join('  '));
  for (const row of rows) {
    outln(
      columns
        .map((col, i) => String(col.value(row) ?? '').padEnd(widths[i]))
        .join('  ')
    );
  }
}
