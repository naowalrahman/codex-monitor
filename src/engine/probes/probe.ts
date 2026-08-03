/**
 * The probe abstraction.
 *
 * A probe is the runtime evaluator for one condition. It exposes two
 * capabilities, and may provide either or both:
 *
 *  - `check()`: evaluate once. The engine schedules these with adaptive
 *    backoff, so the poll cadence is uniform, tunable per monitor, and
 *    lives in exactly one place.
 *  - `start(host)`/`stop()`: subscribe to a push source (fs.watch, a socket)
 *    and emit outcomes as they arrive, for low-latency wakeups.
 *
 * The built-in `file` and `log` probes do both: the watcher supplies
 * latency, the engine's scheduled `check()` supplies the safety net for
 * platforms where fs.watch is unreliable. Either way, evaluation happens
 * entirely inside the plugin, and the model only creates monitors and blocks.
 */
import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";
import type { PollPolicy, ProbeOutcome } from "../types.js";

export interface ProbeHost {
  /** Push an outcome. `satisfied`/`failed` settle the monitor; `pending` just updates lastResult. */
  emit(outcome: ProbeOutcome): void;
}

export interface Probe {
  /** Begin event-driven watching. Optional. */
  start?(host: ProbeHost): void | Promise<void>;
  /** Release watchers/timers. Always called when the monitor settles. */
  stop?(): void | Promise<void>;
  /** One evaluation. Optional; if present the engine schedules it with backoff. */
  check?(): Promise<ProbeOutcome>;
  /** Per-probe-type default schedule, overridable by the monitor spec. */
  defaultPoll?: Partial<PollPolicy>;
}

/** Builds a probe from a validated condition object. */
export type ProbeFactory = (condition: unknown) => Probe;

/**
 * Watch a path for changes by watching its parent directory, which also
 * catches creation and atomic-rename replacement. Returns undefined when the
 * parent does not exist yet. Callers rely on their scheduled `check()` as the
 * backstop, so a missing watcher only costs latency, never correctness.
 */
export function watchPath(path: string, onChange: () => void): FSWatcher | undefined {
  try {
    return watch(dirname(path), onChange);
  } catch {
    return undefined;
  }
}

/**
 * Coalesce concurrent evaluations of a probe. A watcher typically fires
 * several times per write, and the engine's scheduled check can land on top
 * of that; sharing one in-flight promise keeps the underlying stat/read work
 * to one pass without dropping the result any caller is waiting on.
 */
export function coalesce<T>(fn: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | undefined;
  return () => {
    if (!inflight) {
      inflight = fn().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  };
}

/** Truncate probe evidence so tool results and status output stay small. */
export function clip(text: string, max = 400): string {
  // Slice before trimming: probe output can be tens of KB and only the tail
  // is kept, so trimming the whole string first would copy it for nothing.
  if (text.length <= max) return text.trim();
  return `...${text.slice(text.length - max).trim()}`;
}

export function compileRegex(pattern: string): RegExp {
  return new RegExp(pattern, "m");
}
