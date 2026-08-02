/**
 * `file` probe — event-driven filesystem conditions.
 *
 * Uses fs.watch on the parent directory for low-latency wakeups, backed by a
 * coarse stat timer because fs.watch is best-effort on some platforms
 * (network mounts, editors doing atomic renames). All of that machinery is
 * internal; the monitor just settles when the condition holds.
 */
import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileCondition, ProbeOutcome } from "../types.js";
import type { Probe, ProbeHost } from "./probe.js";

const SAFETY_POLL_MS = 1000;

interface Sig {
  exists: boolean;
  size: number;
  mtimeMs: number;
}

async function signature(path: string): Promise<Sig> {
  try {
    const s = await stat(path);
    return { exists: true, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

export function createFileProbe(condition: unknown): Probe {
  const cond = condition as FileCondition;
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stableTimer: ReturnType<typeof setTimeout> | undefined;
  let baseline: Sig | undefined;
  let last: Sig | undefined;
  let evaluating = false;

  const evaluate = async (host: ProbeHost) => {
    if (evaluating) return;
    evaluating = true;
    try {
      const sig = await signature(cond.path);
      const changedSinceLast =
        last !== undefined &&
        (sig.exists !== last.exists || sig.size !== last.size || sig.mtimeMs !== last.mtimeMs);
      last = sig;

      const outcome = ((): ProbeOutcome | undefined => {
        switch (cond.event) {
          case "exists":
            return sig.exists ? { status: "satisfied", detail: `${cond.path} exists (${sig.size} bytes)` } : undefined;
          case "deleted":
            return !sig.exists ? { status: "satisfied", detail: `${cond.path} is gone` } : undefined;
          case "changed": {
            if (!baseline) return undefined;
            const changed =
              sig.exists !== baseline.exists ||
              sig.size !== baseline.size ||
              sig.mtimeMs !== baseline.mtimeMs;
            return changed
              ? { status: "satisfied", detail: `${cond.path} changed (size ${baseline.size} -> ${sig.size})` }
              : undefined;
          }
          case "stable": {
            if (!sig.exists) {
              if (stableTimer) clearTimeout(stableTimer);
              stableTimer = undefined;
              return undefined;
            }
            if (changedSinceLast || !stableTimer) {
              if (stableTimer) clearTimeout(stableTimer);
              stableTimer = setTimeout(() => {
                host.emit({
                  status: "satisfied",
                  detail: `${cond.path} unchanged for ${cond.stable_seconds}s (${sig.size} bytes)`,
                });
              }, cond.stable_seconds * 1000);
            }
            return undefined;
          }
        }
      })();

      if (outcome) host.emit(outcome);
      else host.emit({ status: "pending", detail: sig.exists ? `exists, ${sig.size} bytes` : "missing" });
    } finally {
      evaluating = false;
    }
  };

  return {
    async start(host: ProbeHost) {
      baseline = await signature(cond.path);
      last = baseline;
      try {
        watcher = watch(dirname(cond.path), () => void evaluate(host));
      } catch {
        // Parent dir may not exist yet; the safety timer still covers us.
      }
      timer = setInterval(() => void evaluate(host), SAFETY_POLL_MS);
      void evaluate(host);
    },
    stop() {
      watcher?.close();
      if (timer) clearInterval(timer);
      if (stableTimer) clearTimeout(stableTimer);
    },
  };
}
