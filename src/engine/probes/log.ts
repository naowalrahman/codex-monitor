/**
 * `log` probe — tail a file and fire on a regex.
 *
 * Tracks a byte offset and only ever reads appended data, so it stays cheap
 * on large logs. Handles files that do not exist yet and files that get
 * truncated or rotated (the offset resets). fs.watch supplies latency and
 * the engine's scheduled `check()` is the backstop, both running the same
 * `scan`.
 */
import { createReadStream } from "node:fs";
import type { FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import type { LogCondition, ProbeOutcome } from "../types.js";
import { clip, coalesce, compileRegex, watchPath, type Probe, type ProbeHost } from "./probe.js";

/**
 * How much of the previous scan to re-examine, so a pattern spanning a chunk
 * boundary still matches. Bounded and small: retaining a large window would
 * mean re-running both regexes over the same already-rejected bytes on every
 * append, which is quadratic on a busy log.
 */
const OVERLAP = 4 * 1024;
/** Cap bytes consumed per scan; the remainder is picked up by the next one. */
const MAX_READ = 1024 * 1024;

function readRange(path: string, start: number, end: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const stream = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
    stream.on("data", (chunk) => (data += chunk));
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

export function createLogProbe(condition: unknown): Probe {
  const cond = condition as LogCondition;
  const successRe = compileRegex(cond.pattern);
  const failureRe = cond.failure_pattern ? compileRegex(cond.failure_pattern) : undefined;

  let watcher: FSWatcher | undefined;
  let offset = -1; // -1 = not initialized yet
  let overlap = "";

  const scan = coalesce(async (): Promise<ProbeOutcome> => {
    let size: number;
    try {
      size = (await stat(cond.path)).size;
    } catch {
      return { status: "pending", detail: "log file does not exist yet" };
    }

    // The first scan sets the starting offset, so no async setup has to land
    // before the engine's first scheduled check.
    if (offset === -1) offset = cond.from === "end" ? size : 0;
    if (size < offset) {
      // Truncated or rotated: start over from the beginning of the new file.
      offset = 0;
      overlap = "";
    }
    if (size === offset) return { status: "pending", detail: `tailing at byte ${offset}` };

    const end = Math.min(size, offset + MAX_READ);
    let text: string;
    try {
      text = await readRange(cond.path, offset, end);
    } catch (err) {
      return { status: "pending", detail: `read error: ${(err as Error).message}` };
    }
    offset = end;

    // Only the new bytes plus a bounded overlap are examined, so each byte is
    // scanned at most twice no matter how the appends are chunked.
    const scanned = overlap + text;
    overlap = scanned.slice(-OVERLAP);

    const fail = failureRe?.exec(scanned);
    if (fail) return { status: "failed", detail: `matched failure_pattern: ${clip(fail[0], 200)}` };
    const hit = successRe.exec(scanned);
    if (hit) return { status: "satisfied", detail: `matched pattern: ${clip(hit[0], 200)}` };
    return { status: "pending", detail: `tailing at byte ${offset}` };
  });

  return {
    defaultPoll: { interval_seconds: 2, max_interval_seconds: 30 },
    check: scan,
    start(host: ProbeHost) {
      watcher = watchPath(cond.path, () => void scan().then((o) => host.emit(o)));
    },
    stop() {
      watcher?.close();
    },
  };
}
