import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MonitorEngine } from "../src/engine/engine.js";
import { builtinRegistry } from "../src/engine/probes/index.js";
import { MonitorSpecSchema, type MonitorRecord } from "../src/engine/types.js";

let dir: string;
let engine: MonitorEngine;

const spec = (raw: unknown) => MonitorSpecSchema.parse(raw);

/** Wait for one monitor to settle, with the timeout every case wants. */
const settle = (record: MonitorRecord, timeoutMs = 5000) =>
  engine.waitFor([record.id], "all", { timeoutMs });

/** A monitor whose condition never holds, for testing everything around it. */
const neverSatisfied = (extra: Record<string, unknown> = {}) =>
  spec({
    condition: { type: "command", command: "false", success_when: { exit_code: 0 } },
    ...extra,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "codex-monitor-test-"));
  engine = new MonitorEngine(builtinRegistry());
});

afterEach(() => {
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("command monitor", () => {
  it("settles satisfied when the predicate matches", async () => {
    const record = engine.create(
      spec({
        condition: {
          type: "command",
          command: "echo COMPLETED",
          success_when: { exit_code: 0, output_matches: "COMPLETED" },
        },
      }),
    );
    const result = await settle(record);
    expect(result.outcome).toBe("settled");
    expect(result.monitors[0].state).toBe("satisfied");
    expect(result.monitors[0].resolution).toContain("COMPLETED");
  });

  it("settles failed when failure_when matches first", async () => {
    const record = engine.create(
      spec({
        condition: {
          type: "command",
          command: "echo JobState=FAILED",
          success_when: { output_matches: "JobState=COMPLETED" },
          failure_when: { output_matches: "JobState=FAILED" },
        },
      }),
    );
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("failed");
  });

  it("keeps probing until the condition becomes true", async () => {
    const flag = join(dir, "flag");
    const record = engine.create(
      spec({
        condition: {
          type: "command",
          command: `cat ${flag}`,
          success_when: { exit_code: 0, output_matches: "ready" },
        },
        poll: { interval_seconds: 0.05, max_interval_seconds: 0.1 },
      }),
    );
    setTimeout(() => writeFileSync(flag, "ready\n"), 200);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
    expect(result.monitors[0].attempts).toBeGreaterThan(1);
  });
});

describe("wait semantics", () => {
  it("returns wait_timeout while monitors keep running", async () => {
    const record = engine.create(
      neverSatisfied({ poll: { interval_seconds: 0.05 } }),
    );
    const result = await settle(record, 100);
    expect(result.outcome).toBe("wait_timeout");
    expect(engine.get(record.id)!.state).toBe("active");
  });

  it("mode any resolves on the first settled monitor", async () => {
    const fast = engine.create(
      spec({ condition: { type: "command", command: "true", success_when: { exit_code: 0 } } }),
    );
    const slow = engine.create(
      neverSatisfied({ poll: { interval_seconds: 5 } }),
    );
    const result = await engine.waitFor([fast.id, slow.id], "any", { timeoutMs: 5000 });
    expect(result.outcome).toBe("settled");
    const states = Object.fromEntries(result.monitors.map((m) => [m.id, m.state]));
    expect(states[fast.id]).toBe("satisfied");
    expect(states[slow.id]).toBe("active");
  });

  it("monitor timeout produces state 'timeout'", async () => {
    const record = engine.create(
      neverSatisfied({ poll: { interval_seconds: 0.05 }, timeout_seconds: 0.3 }),
    );
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("timeout");
  });
});

describe("log monitor", () => {
  it("fires when a matching line is appended", async () => {
    const logPath = join(dir, "job.log");
    writeFileSync(logPath, "starting up\n");
    const record = engine.create(
      spec({
        condition: { type: "log", path: logPath, pattern: "epoch \\d+ complete", from: "end" },
      }),
    );
    setTimeout(() => appendFileSync(logPath, "epoch 42 complete\n"), 150);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
    expect(result.monitors[0].resolution).toContain("epoch 42 complete");
  });

  it("from 'end' ignores pre-existing matches", async () => {
    const logPath = join(dir, "stale.log");
    writeFileSync(logPath, "old run: DONE\n");
    const record = engine.create(
      spec({ condition: { type: "log", path: logPath, pattern: "DONE", from: "end" } }),
    );
    const early = await settle(record, 300);
    expect(early.outcome).toBe("wait_timeout");

    appendFileSync(logPath, "new run: DONE\n");
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
  });

  it("failure_pattern settles the monitor as failed", async () => {
    const logPath = join(dir, "job2.log");
    writeFileSync(logPath, "");
    const record = engine.create(
      spec({
        condition: {
          type: "log",
          path: logPath,
          pattern: "DONE",
          failure_pattern: "Traceback",
        },
      }),
    );
    setTimeout(() => appendFileSync(logPath, "Traceback (most recent call last)\n"), 150);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("failed");
  });
});

describe("file monitor", () => {
  it("fires when a file appears", async () => {
    const target = join(dir, "output.bin");
    const record = engine.create(
      spec({ condition: { type: "file", path: target, event: "exists" } }),
    );
    setTimeout(() => writeFileSync(target, "data"), 150);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
  });

  it("fires when a watched file changes", async () => {
    const target = join(dir, "watched.txt");
    writeFileSync(target, "v1");
    const record = engine.create(
      spec({ condition: { type: "file", path: target, event: "changed" } }),
    );
    setTimeout(() => writeFileSync(target, "v2 with more content"), 150);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
  });

  it("event 'stable' waits for writes to stop before settling", async () => {
    const target = join(dir, "download.part");
    writeFileSync(target, "chunk");
    const record = engine.create(
      spec({ condition: { type: "file", path: target, event: "stable", stable_seconds: 0.4 } }),
    );
    // Keep appending past the stability window: it must not settle early.
    const writes = [100, 200, 300].map((at) =>
      setTimeout(() => appendFileSync(target, " more"), at),
    );
    const early = await settle(record, 500);
    expect(early.outcome).toBe("wait_timeout");
    writes.forEach(clearTimeout);

    // Writes have stopped, so it settles once the window elapses.
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
    expect(result.monitors[0].resolution).toContain("unchanged");
  });

  it("event 'deleted' settles when the file disappears", async () => {
    const target = join(dir, "lockfile");
    writeFileSync(target, "held");
    const record = engine.create(
      spec({ condition: { type: "file", path: target, event: "deleted" } }),
    );
    setTimeout(() => rmSync(target), 150);
    const result = await settle(record);
    expect(result.monitors[0].state).toBe("satisfied");
  });
});

describe("custom probes", () => {
  it("accepts custom condition types end to end", async () => {
    const registry = builtinRegistry();
    registry.register("always", () => ({
      check: async () => ({ status: "satisfied" as const, detail: "custom probe ran" }),
    }));
    const custom = new MonitorEngine(registry);
    try {
      const record = custom.create(spec({ condition: { type: "always", anything: "goes" } }));
      const result = await custom.waitFor([record.id], "all", { timeoutMs: 5000 });
      expect(result.monitors[0].state).toBe("satisfied");
      expect(result.monitors[0].resolution).toBe("custom probe ran");
    } finally {
      custom.close();
    }
  });

  it("rejects malformed built-in conditions instead of treating them as custom", () => {
    // 'command' without success_when must fail validation, not slip through
    // the custom-condition passthrough.
    expect(() => spec({ condition: { type: "command", command: "true" } })).toThrow();
  });

  it("rejects unknown condition types at create time", () => {
    expect(() => engine.create(spec({ condition: { type: "no-such-probe" } }))).toThrow(
      /unknown condition type/,
    );
    expect(engine.list()).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("settles an active monitor as cancelled", async () => {
    const record = engine.create(
      neverSatisfied({ poll: { interval_seconds: 5 } }),
    );
    engine.cancel(record.id, "user changed plans");
    expect(engine.get(record.id)!.state).toBe("cancelled");
    const result = await settle(record, 1000);
    expect(result.outcome).toBe("settled");
  });
});
