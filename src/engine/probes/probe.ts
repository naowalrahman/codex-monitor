/**
 * The probe abstraction.
 *
 * A probe is the runtime evaluator for one condition. It comes in two shapes,
 * and may be both at once:
 *
 *  - Event-driven: implements `start(host)` and pushes outcomes via
 *    `host.emit(...)` whenever the underlying source changes (fs.watch, etc.).
 *  - Probed: implements `check()`; the engine schedules calls with adaptive
 *    backoff and applies the outcome.
 *
 * Either way, evaluation happens entirely inside the plugin process. The
 * model only ever creates monitors and blocks on them.
 */
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

/** Truncate probe evidence so tool results and status output stay small. */
export function clip(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}

export function compileRegex(pattern: string): RegExp {
  return new RegExp(pattern, "m");
}
