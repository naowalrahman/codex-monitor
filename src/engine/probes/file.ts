/**
 * `file` probe — filesystem conditions.
 *
 * fs.watch on the parent directory supplies low-latency wakeups; the
 * engine's scheduled `check()` is the safety net, because fs.watch is
 * best-effort on some platforms (network mounts, editors doing atomic
 * renames). Both paths run the same `evaluate`, so there is one code path
 * and one scheduler rather than a private poll loop per probe.
 */
import { stat } from "node:fs/promises";
import type { FSWatcher } from "node:fs";
import type { FileCondition, PollPolicy, ProbeOutcome } from "../types.js";
import { coalesce, watchPath, type Probe, type ProbeHost } from "./probe.js";

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

/** The file-identity heuristic, in one place so all events agree on it. */
function differs(a: Sig, b: Sig): boolean {
  return a.exists !== b.exists || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
}

/**
 * `stable` is detected by comparing against the clock rather than by an
 * independent timer, so every event kind is a pure function of the current
 * signature and this probe keeps no timers of its own. Its schedule is
 * derived from `stable_seconds` because, unlike the other events, nothing
 * pushes a notification when a file *stops* changing — the check is the only
 * thing that can observe it.
 */
function pollFor(cond: FileCondition): Partial<PollPolicy> {
  if (cond.event !== "stable") return { interval_seconds: 2, max_interval_seconds: 30 };
  const interval = Math.max(0.2, cond.stable_seconds / 4);
  return { interval_seconds: interval, max_interval_seconds: interval, backoff_factor: 1 };
}

export function createFileProbe(condition: unknown): Probe {
  const cond = condition as FileCondition;
  let watcher: FSWatcher | undefined;
  /** Signature at monitor start; defines what `changed` is relative to. */
  let baseline: Sig | undefined;
  let last: Sig | undefined;
  let lastChangeMs = Date.now();

  const evaluate = coalesce(async (): Promise<ProbeOutcome> => {
    const sig = await signature(cond.path);
    // The first evaluation defines the baseline, so no async setup has to
    // land before the engine's first scheduled check.
    baseline ??= sig;
    if (last && differs(sig, last)) lastChangeMs = Date.now();
    last = sig;

    switch (cond.event) {
      case "exists":
        return sig.exists
          ? { status: "satisfied", detail: `${cond.path} exists (${sig.size} bytes)` }
          : { status: "pending", detail: "missing" };
      case "deleted":
        return sig.exists
          ? { status: "pending", detail: `still present (${sig.size} bytes)` }
          : { status: "satisfied", detail: `${cond.path} is gone` };
      case "changed":
        return differs(sig, baseline)
          ? {
              status: "satisfied",
              detail: `${cond.path} changed (size ${baseline.size} -> ${sig.size})`,
            }
          : { status: "pending", detail: `unchanged (${sig.size} bytes)` };
      case "stable": {
        if (!sig.exists) return { status: "pending", detail: "missing" };
        const stableMs = Date.now() - lastChangeMs;
        return stableMs >= cond.stable_seconds * 1000
          ? {
              status: "satisfied",
              detail: `${cond.path} unchanged for ${cond.stable_seconds}s (${sig.size} bytes)`,
            }
          : { status: "pending", detail: `settling (${Math.round(stableMs / 1000)}s so far)` };
      }
    }
  });

  return {
    defaultPoll: pollFor(cond),
    check: evaluate,
    start(host: ProbeHost) {
      watcher = watchPath(cond.path, () => void evaluate().then((o) => host.emit(o)));
    },
    stop() {
      watcher?.close();
    },
  };
}
