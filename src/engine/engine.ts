/**
 * MonitorEngine — lifecycle, scheduling, and wait semantics.
 *
 * Responsibilities:
 *  - create/cancel monitors, entirely in memory
 *  - run each monitor's probe: subscribe event-driven probes, schedule
 *    polled probes with adaptive backoff + jitter (all inside this process)
 *  - settle monitors exactly once (satisfied / failed / timeout / cancelled)
 *  - `waitFor()`: a promise that resolves when a set of monitors settles —
 *    this is what backs the blocking `monitor_wait` MCP tool
 *
 * Monitors are deliberately session-scoped: they live and die with the MCP
 * server process (and therefore with the Codex session that spawned it).
 * There is no persistence and no cross-session state — closing Codex tears
 * every monitor down. This keeps concurrency trivial (any number of
 * sessions, zero shared state) at the cost of monitors not outliving their
 * session.
 */
import { EventEmitter } from "node:events";
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
const HISTORY_LIMIT = 50;

interface Runtime {
  probe: Probe;
  poll: PollPolicy;
  checkTimer?: ReturnType<typeof setTimeout>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  checking: boolean;
  consecutiveChecks: number;
}

export type WaitMode = "all" | "any";

export interface WaitResult {
  outcome: "settled" | "wait_timeout" | "aborted";
  monitors: MonitorSnapshot[];
}

export class MonitorEngine extends EventEmitter {
  private records = new Map<string, MonitorRecord>();
  private runtimes = new Map<string, Runtime>();
  private closed = false;

  constructor(
    private registry: ProbeRegistry,
    private log: (msg: string) => void = () => {},
  ) {
    super();
    this.setMaxListeners(100);
  }

  create(spec: MonitorSpec): MonitorRecord {
    const now = new Date();
    const record: MonitorRecord = {
      id: `mon_${randomBytes(4).toString("hex")}`,
      spec,
      state: "active",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + spec.timeout_seconds * 1000).toISOString(),
      attempts: 0,
      history: [],
    };
    this.note(record, `created (${spec.condition.type})`);
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

  list(): MonitorRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  cancel(id: string, reason = "cancelled by request"): MonitorRecord {
    const record = this.mustGet(id);
    if (record.state === "active") this.settle(id, "cancelled", reason);
    return record;
  }

  /**
   * Resolve when the given monitors settle (mode 'all') or when the first
   * one settles (mode 'any'). Never rejects on timeout — a wait timeout is a
   * normal outcome and the monitors keep running.
   */
  waitFor(
    ids: string[],
    mode: WaitMode,
    opts: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<WaitResult> {
    const targets = ids.map((id) => this.mustGet(id).id);
    const snapshots = () => targets.map((id) => toSnapshot(this.mustGet(id)));
    const done = () => {
      const settled = targets.filter((id) => TERMINAL_STATES.has(this.mustGet(id).state));
      return mode === "any" ? settled.length > 0 : settled.length === targets.length;
    };

    if (done()) return Promise.resolve({ outcome: "settled", monitors: snapshots() });

    return new Promise<WaitResult>((resolve) => {
      const finish = (outcome: WaitResult["outcome"]) => {
        this.off("settled", onSettled);
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        resolve({ outcome, monitors: snapshots() });
      };
      const onSettled = (record: MonitorRecord) => {
        if (targets.includes(record.id) && done()) finish("settled");
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("wait_timeout"), opts.timeoutMs);
      this.on("settled", onSettled);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  close(): void {
    this.closed = true;
    for (const id of this.runtimes.keys()) this.disarm(id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private mustGet(id: string): MonitorRecord {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown monitor id: ${id}`);
    return record;
  }

  private arm(record: MonitorRecord): void {
    const probe = this.registry.create(record.spec.condition);
    const poll: PollPolicy = {
      ...DEFAULT_POLL,
      ...probe.defaultPoll,
      ...record.spec.poll,
    };
    const rt: Runtime = { probe, poll, checking: false, consecutiveChecks: 0 };
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
    if (!rt || this.closed) return;
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
    rt.consecutiveChecks += 1;
    this.applyOutcome(id, outcome);

    const stillActive = this.records.get(id)?.state === "active";
    if (stillActive && this.runtimes.has(id)) {
      const { interval_seconds, max_interval_seconds, backoff_factor } = rt.poll;
      const base = Math.min(
        max_interval_seconds,
        interval_seconds * Math.pow(backoff_factor, rt.consecutiveChecks - 1),
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
    record.updatedAt = record.lastResult.at;
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
    record.updatedAt = record.resolvedAt;
    this.note(record, `${state}: ${resolution}`);
    this.emit("settled", record);
    this.log(`monitor ${id} (${record.spec.name ?? record.spec.condition.type}) -> ${state}`);
  }

  private note(record: MonitorRecord, note: string): void {
    record.history.push({ at: new Date().toISOString(), note });
    if (record.history.length > HISTORY_LIMIT) {
      record.history.splice(0, record.history.length - HISTORY_LIMIT);
    }
  }
}
