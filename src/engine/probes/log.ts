/**
 * `log` probe — tail a file and fire on a regex.
 *
 * Tracks a byte offset and only ever reads appended data, so it is cheap on
 * large logs. Handles files that do not exist yet and files that get
 * truncated/rotated (offset resets). A sliding window of recent content is
 * kept so patterns spanning a chunk boundary still match.
 */
import { createReadStream, watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { LogCondition } from "../types.js";
import { clip, compileRegex, type Probe, type ProbeHost } from "./probe.js";

const SAFETY_POLL_MS = 1000;
const WINDOW = 64 * 1024;

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
  let timer: ReturnType<typeof setInterval> | undefined;
  let offset = -1; // -1 = not initialized yet
  let window = "";
  let scanning = false;
  let settled = false;

  const scan = async (host: ProbeHost) => {
    if (scanning || settled) return;
    scanning = true;
    try {
      let size: number;
      try {
        size = (await stat(cond.path)).size;
      } catch {
        host.emit({ status: "pending", detail: "log file does not exist yet" });
        return;
      }

      if (offset === -1) offset = cond.from === "end" ? size : 0;
      if (size < offset) {
        // Truncated or rotated: start over from the beginning of the new file.
        offset = 0;
        window = "";
      }
      if (size === offset) return;

      const chunk = await readRange(cond.path, offset, size);
      offset = size;
      window = (window + chunk).slice(-WINDOW);

      const fail = failureRe?.exec(window);
      if (fail) {
        settled = true;
        host.emit({ status: "failed", detail: `matched failure_pattern: ${clip(fail[0], 200)}` });
        return;
      }
      const hit = successRe.exec(window);
      if (hit) {
        settled = true;
        host.emit({ status: "satisfied", detail: `matched pattern: ${clip(hit[0], 200)}` });
        return;
      }
      // Keep only the tail that could still participate in a future match.
      host.emit({ status: "pending", detail: `tailing at byte ${offset}` });
    } catch (err) {
      host.emit({ status: "pending", detail: `read error: ${(err as Error).message}` });
    } finally {
      scanning = false;
    }
  };

  return {
    start(host: ProbeHost) {
      try {
        watcher = watch(dirname(cond.path), () => void scan(host));
      } catch {
        // Parent dir missing; safety timer covers creation later.
      }
      timer = setInterval(() => void scan(host), SAFETY_POLL_MS);
      void scan(host);
    },
    stop() {
      watcher?.close();
      if (timer) clearInterval(timer);
    },
  };
}
