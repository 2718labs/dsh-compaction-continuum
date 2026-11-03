/**
 * Session-log reader for the offline benchmark.
 *
 * DeepSeek Harness writes append-only JSONL session logs; the packaged desktop
 * app stores them zstd-compressed as a sequence of independently flushed
 * frames. This reader accepts either a plain `.jsonl` file or a multi-frame
 * `.jsonl.zstd` file and returns parsed events.
 *
 * No dependency is used. zstd decoding needs a Node build that ships
 * `zlib.zstdDecompressSync` (Node >= 22.15, or the Node bundled with the
 * Harness); plain `.jsonl` works on any Node >= 20.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const SESSION_FILE = /session.*\.jsonl(\.zstd)?$/u;

/** Decompress a buffer of concatenated zstd frames. */
export function decompressZstdFrames(buffer) {
  const decompress = zlib.zstdDecompressSync;
  if (typeof decompress !== "function") {
    throw new Error(
      "this Node.js build has no zstd support (zlib.zstdDecompressSync is missing); use Node >= 22.15 or the Node bundled with DeepSeek Harness, or pass an already-decompressed .jsonl file",
    );
  }
  const cuts = [0];
  for (let at = buffer.indexOf(ZSTD_MAGIC, 1); at >= 0; at = buffer.indexOf(ZSTD_MAGIC, at + 1)) cuts.push(at);
  cuts.push(buffer.length);

  const parts = [];
  let index = 0;
  while (index < cuts.length - 1) {
    let end = index + 1;
    let decoded = false;
    while (end < cuts.length) {
      try {
        parts.push(decompress(buffer.subarray(cuts[index], cuts[end])));
        decoded = true;
        break;
      } catch {
        end += 1;
      }
    }
    if (!decoded) throw new Error(`undecodable zstd frame at byte offset ${cuts[index]}`);
    index = end;
  }
  return Buffer.concat(parts);
}

/** Parse one session log file into events, tolerating a torn final line. */
export function readSessionFile(filePath) {
  const raw = fs.readFileSync(filePath);
  const compressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC);
  const text = (compressed ? decompressZstdFrames(raw) : raw).toString("utf8");
  const events = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      skipped += 1;
    }
  }
  return { events, compressed, skipped };
}

/** Stable, non-reversible short label so reports never need raw session ids. */
export function sessionLabel(filePath) {
  // Real logs are named `session.v4.jsonl(.zstd)` inside a session directory;
  // exported/replayed copies carry the identity in the file name instead.
  const standard = /^session(\.v\d+)?\.jsonl(\.zstd)?$/u.test(path.basename(filePath));
  const identity = standard ? path.basename(path.dirname(filePath)) : path.basename(filePath);
  const hash = createHash("sha256").update(identity).digest("hex");
  return `s-${hash.slice(0, 8)}`;
}

/** Recursively collect session logs under a root (or accept a single file). */
export function findSessionFiles(root) {
  const stats = fs.statSync(root);
  if (stats.isFile()) return [root];
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SESSION_FILE.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/** Default session-log root for the current user. */
export function defaultSessionRoot() {
  const home = process.env.USERPROFILE ?? process.env.HOME;
  return home === undefined ? "." : path.join(home, ".dsh", "sessions");
}
