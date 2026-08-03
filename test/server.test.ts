import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import type { MonitorEngine } from "../src/engine/engine.js";

/**
 * Tool schemas are re-sent to the model on every request, so the whole surface
 * is budgeted. This is a ceiling, not a target: raising it is a deliberate
 * decision, and the failure message is the point.
 */
const SURFACE_BUDGET_CHARS = 6500;

let dir: string;
let client: Client;
let engine: MonitorEngine;

const call = async (name: string, args: Record<string, unknown>) => {
  const res = await client.callTool({ name, arguments: args });
  const [block] = res.content as { type: string; text: string }[];
  return { text: block.text, json: JSON.parse(block.text) };
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "codex-monitor-server-"));
  const built = await createServer(join(dir, "home"));
  engine = built.engine;
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([client.connect(clientSide), built.server.connect(serverSide)]);
});

afterEach(async () => {
  await client.close();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("tool surface", () => {
  it("exposes exactly the four tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "monitor_cancel",
      "monitor_create",
      "monitor_status",
      "monitor_wait",
    ]);
  });

  it("stays within the context budget", async () => {
    const { tools } = await client.listTools();
    const chars = JSON.stringify(tools).length;
    expect(chars, `tool surface grew to ${chars} chars`).toBeLessThanOrEqual(SURFACE_BUDGET_CHARS);
  });

  it("never repeats the condition schema across tools", async () => {
    const { tools } = await client.listTools();
    const withCondition = tools.filter((t) => "condition" in (t.inputSchema.properties ?? {}));
    expect(withCondition.map((t) => t.name)).toEqual(["monitor_create"]);
  });
});

describe("result payloads", () => {
  it("returns compact JSON", async () => {
    const { text } = await call("monitor_status", {});
    expect(text).not.toMatch(/\n\s+/);
  });

  it("uses one monitors-array shape for every tool", async () => {
    const created = await call("monitor_create", {
      condition: { type: "file", path: join(dir, "absent"), event: "exists" },
    });
    const status = await call("monitor_status", {});
    const cancelled = await call("monitor_cancel", { id: created.json.monitors[0].id });
    for (const payload of [created.json, status.json, cancelled.json]) {
      expect(Array.isArray(payload.monitors)).toBe(true);
    }
    expect(cancelled.json.monitors[0].state).toBe("cancelled");
  });
});

describe("monitor_create", () => {
  it("returns immediately with a handoff hint when wait_timeout_seconds is omitted", async () => {
    const { json } = await call("monitor_create", {
      condition: { type: "file", path: join(dir, "absent"), event: "exists" },
    });
    expect(json.monitors[0].state).toBe("active");
    expect(json.hint).toMatch(/monitor_wait/);
  });

  it("blocks until the monitor settles when wait_timeout_seconds is set", async () => {
    const target = join(dir, "output.bin");
    setTimeout(() => writeFileSync(target, "data"), 100);
    const { json } = await call("monitor_create", {
      condition: { type: "file", path: target, event: "exists" },
      wait_timeout_seconds: 5,
    });
    expect(json.outcome).toBe("settled");
    expect(json.monitors[0].state).toBe("satisfied");
    expect(json.hint).toBeUndefined();
  });

  it("hands back a resumable id when the wait times out first", async () => {
    const { json } = await call("monitor_create", {
      condition: { type: "file", path: join(dir, "never"), event: "exists" },
      wait_timeout_seconds: 0.2,
    });
    expect(json.outcome).toBe("wait_timeout");
    expect(json.monitors[0].state).toBe("active");
    expect(json.hint).toMatch(/monitor_wait/);

    const id = json.monitors[0].id;
    writeFileSync(join(dir, "never"), "here");
    const resumed = await call("monitor_wait", { ids: [id], wait_timeout_seconds: 5 });
    expect(resumed.json.outcome).toBe("settled");
    expect(resumed.json.monitors[0].state).toBe("satisfied");
  });

  it("rejects a malformed condition", async () => {
    const res = await client.callTool({
      name: "monitor_create",
      arguments: { condition: { type: "command", command: "true" } },
    });
    expect(res.isError).toBe(true);
  });
});
