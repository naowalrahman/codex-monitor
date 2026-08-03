/**
 * MonitorEngine: lifecycle, scheduling, and wait semantics.
 *
 * Responsibilities:
 *  - create/cancel monitors, entirely in memory
 *  - run each monitor's probe: subscribe event-driven probes, schedule
 *    polled probes with adaptive backoff + jitter (all inside this process)
 *  - settle monitors exactly once (satisfied / failed / timeout / cancelled)
 *  - `waitFor()`, a promise that resolves when a set of monitors settles,
 *    which is what backs the blocking `monitor_wait` MCP tool
 *
 * Monitors are deliberately session-scoped: they live and die with the MCP
 * server process, and therefore with the Codex session that spawned it.
 * Nothing persists and nothing is shared across sessions, so closing Codex
 * tears every monitor down. That keeps concurrency trivial (any number of
 * sessions, zero shared state) at the cost of monitors not outliving their
 * session.
 */
import { randomBytes } from "node:crypto";
import type { ProbeRegistry } from "./registry.js";
import type { Probe } from "./probes/probe.js";
import {
  TERMINAL_STATES,
  toSnapshot,
  type MonitorRecord,
  type MonitorSnapshot,
  type MonitorSpec,
  type MonitorState,
  type PollPolicy,
  type ProbeOutcome,
} from "./types.js";

const DEFAULT_POLL: PollPolicy = { interval_seconds: 5, max_interval_seconds: 60, backoff_factor: 1.5 };

interface Runtime {
  probe: Probe;
  poll: PollPolicy;
  checkTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  checking: boolean;
  /** Scheduled checks so far; drives the backoff exponent. */
  checks: number;
}

export type WaitMode = "all" | "any";

export interface WaitResult {
  outcome: "settled" | "wait_timeout" | "aborted";
  monitors: MonitorSnapshot[];
}

/**
 * One pending `waitFor` call. Holds only the fields it needs rather than
 * capturing the surrounding scope, and is indexed per-monitor so settling a
 * monitor costs O(waiters on that monitor) instead of a scan of every waiter.
 */
class Waiter {
  remaining: number;
  constructor(
    readonly targets: string[],
    readonly mode: WaitMode,
    readonly settle: (outcome: WaitResult["outcome"]) => void,
  ) {
    this.remaining = targets.length;
  }

  /** Returns true when this settle completes the wait. */
  satisfiedBy(): boolean {
    this.remaining -= 1;
    return this.mode === "any" || this.remaining <= 0;
  }
}

export class MonitorEngine {
  private records = new Map<string, MonitorRecord>();
  private runtimes = new Map<string, Runtime>();
  private waiters = new Map<string, Set<Waiter>>();

  constructor(
    private registry: ProbeRegistry,
    private log: (msg: string) => void = () => {},
  ) {}

  create(spec: MonitorSpec): MonitorRecord {
    const now = new Date();
    const record: MonitorRecord = {
      id: `mon_${randomBytes(4).toString("hex")}`,
      spec,
      state: "active",
      createdAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + spec.timeout_seconds * 1000).toISOString(),
      attempts: 0,
    };
    this.records.set(record.id, record);
    try {
      this.arm(record); // throws on unknown condition type / bad custom condition
    } catch (err) {
      this.records.delete(record.id);
      throw err;
    }
    return record;
  }

  get(id: string): MonitorRecord | undefined {
    return this.records.get(id);
  }

  /** Look up a monitor, failing with the message the agent should see. */
  getOrThrow(id: string): MonitorRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown monitor id: ${id}`);
    return record;
  }

  /** Monitors in creation order (Map preserves insertion order). */
  list(): MonitorRecord[] {
    return [...this.records.values()];
  }

  cancel(id: string, reason = "cancelled by request"): MonitorRecord {
    const record = this.getOrThrow(id);
    if (record.state === "active") this.settle(id, "cancelled", reason);
    return record;
  }

  /**
   * Resolve when the given monitors settle (mode 'all') or when the first
   * one settles (mode 'any'). Never rejects on timeout: a wait timeout is a
   * normal outcome and the monitors keep running.
   */
  waitFor(
    ids: string[],
    mode: WaitMode,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WaitResult> {
    const snapshots = () => ids.map((id) => toSnapshot(this.getOrThrow(id)));
    // Deduplicated for bookkeeping, so a monitor listed twice is not counted
    // twice. The result still mirrors the caller's list.
    const targets = [...new Set(ids)].map((id) => this.getOrThrow(id).id);

    const settledCount = targets.filter((id) =>
      TERMINAL_STATES.has(this.getOrThrow(id).state),
    ).length;
    const done = mode === "any" ? settledCount > 0 : settledCount === targets.length;
    if (done) return Promise.resolve({ outcome: "settled", monitors: snapshots() });

    return new Promise<WaitResult>((resolve) => {
      const waiter = new Waiter(targets, mode, (outcome) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        this.unregisterWaiter(waiter);
        resolve({ outcome, monitors: snapshots() });
      });
      // Monitors that settled before this call still count toward 'all'.
      waiter.remaining -= settledCount;
      const onAbort = () => waiter.settle("aborted");
      const timer = setTimeout(() => waiter.settle("wait_timeout"), opts.timeoutMs);

      for (const id of targets) {
        if (TERMINAL_STATES.has(this.getOrThrow(id).state)) continue;
        let set = this.waiters.get(id);
        if (!set) this.waiters.set(id, (set = new Set()));
        set.add(waiter);
      }
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    for (const id of [...this.runtimes.keys()]) this.disarm(id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private unregisterWaiter(waiter: Waiter): void {
    for (const id of waiter.targets) {
      const set = this.waiters.get(id);
      if (!set) continue;
      set.delete(waiter);
      if (set.size === 0) this.waiters.delete(id);
    }
  }

  private arm(record: MonitorRecord): void {
    const probe = this.registry.create(record.spec.condition);
    const poll: PollPolicy = {
      ...DEFAULT_POLL,
      ...probe.defaultPoll,
      ...record.spec.poll,
    };
    const rt: Runtime = { probe, poll, checking: false, checks: 0 };
    this.runtimes.set(record.id, rt);

    rt.deadlineTimer = setTimeout(
      () =>
        this.settle(
          record.id,
          "timeout",
          `no resolution within timeout (${record.spec.timeout_seconds}s)`,
        ),
      record.spec.timeout_seconds * 1000,
    );

    if (probe.start) {
      void Promise.resolve(
        probe.start({ emit: (outcome) => this.applyOutcome(record.id, outcome) }),
      ).catch((err) =>
        this.settle(record.id, "failed", `probe failed to start: ${(err as Error).message}`),
      );
    }
    if (probe.check) this.scheduleCheck(record.id, 0);
  }

  private disarm(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.runtimes.delete(id);
    if (rt.checkTimer) clearTimeout(rt.checkTimer);
    if (rt.deadlineTimer) clearTimeout(rt.deadlineTimer);
    try {
      void rt.probe.stop?.();
    } catch (err) {
      this.log(`probe stop error for ${id}: ${(err as Error).message}`);
    }
  }

  private scheduleCheck(id: string, delayMs: number): void {
    const rt = this.runtimes.get(id);
    if (!rt) return; // disarmed: settled, or the engine was closed
    rt.checkTimer = setTimeout(() => void this.runCheck(id), delayMs);
  }

  private async runCheck(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    const record = this.records.get(id);
    if (!rt || !record || record.state !== "active" || rt.checking) return;
    rt.checking = true;
    let outcome: ProbeOutcome;
    try {
      outcome = await rt.probe.check!();
    } catch (err) {
      // Probe errors are inconclusive, not fatal: the world may be mid-change
      // (network blip, ssh hiccup). The monitor's own timeout is the backstop.
      outcome = { status: "pending", detail: `probe error: ${(err as Error).message}` };
    }
    rt.checking = false;
    rt.checks += 1;
    this.applyOutcome(id, outcome);

    const stillActive = this.records.get(id)?.state === "active";
    if (stillActive && this.runtimes.has(id)) {
      const { interval_seconds, max_interval_seconds, backoff_factor } = rt.poll;
      const base = Math.min(
        max_interval_seconds,
        interval_seconds * Math.pow(backoff_factor, rt.checks - 1),
      );
      const jitter = 1 + (Math.random() - 0.5) * 0.2; // ±10%
      this.scheduleCheck(id, base * 1000 * jitter);
    }
  }

  private applyOutcome(id: string, outcome: ProbeOutcome): void {
    const record = this.records.get(id);
    if (!record || record.state !== "active") return;
    record.attempts += 1;
    record.lastResult = { at: new Date().toISOString(), status: outcome.status, detail: outcome.detail };
    if (outcome.status === "satisfied" || outcome.status === "failed") {
      this.settle(id, outcome.status, outcome.detail ?? outcome.status);
    }
  }

  /** Move a monitor to a terminal state exactly once. */
  private settle(id: string, state: Exclude<MonitorState, "active">, resolution: string): void {
    const record = this.records.get(id);
    if (!record || record.state !== "active") return;
    this.disarm(id);
    record.state = state;
    record.resolution = resolution;
    record.resolvedAt = new Date().toISOString();
    this.log(`monitor ${id} (${record.spec.name ?? record.spec.condition.type}) -> ${state}`);

    const waiting = this.waiters.get(id);
    if (!waiting) return;
    this.waiters.delete(id);
    for (const waiter of waiting) {
      if (waiter.satisfiedBy()) waiter.settle("settled");
    }
  }
}
