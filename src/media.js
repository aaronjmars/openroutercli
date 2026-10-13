// Media inputs: local paths become base64 data URLs; URLs pass through.

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

function extOf(value) {
  const path = value.split(/[?#]/)[0];
  const name = path.split("/").pop() || "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "";
}

// "image" | "audio" | "video" | undefined, from a data: URL mime or the extension.
export function mediaKind(value) {
  const m = /^data:([a-z]+)\//i.exec(value);
  const mime = m ? `${m[1].toLowerCase()}/` : MIME[extOf(value)] || "";
  return mime.split("/")[0] || undefined;
}

// http(s) and data: URLs pass through; a local path becomes a base64 data URL.
export async function mediaUrl(value) {
  if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(value);
  const mime = MIME[extOf(value)] || "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}
