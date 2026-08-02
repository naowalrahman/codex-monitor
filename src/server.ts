/**
 * MCP server: the agent-facing surface of the monitor engine.
 *
 * Design notes:
 *  - `monitor_wait` is a *blocking* tool call. That is the whole point:
 *    "pause the agent until a condition becomes true" maps to one tool call
 *    that does not return until the condition settles. While blocked, we
 *    send MCP progress notifications (when the client supplies a progress
 *    token) so clients that honor progress do not time the call out.
 *  - Tool results are JSON in a text block, easy for the model to read.
 *  - All schemas come from engine/types.ts, so the tool contract and the
 *    engine contract are the same object.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MonitorEngine, type WaitMode } from "./engine/engine.js";
import { builtinRegistry } from "./engine/probes/index.js";
import { defaultHome, loadCustomProbes } from "./engine/registry.js";
import { MonitorSpecSchema, toSnapshot, type MonitorRecord } from "./engine/types.js";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const HEARTBEAT_MS = 15_000;

const log = (msg: string) => console.error(`[codex-monitor] ${msg}`);

function jsonResult(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function creationView(record: MonitorRecord) {
  return {
    monitor: toSnapshot(record),
    hint:
      record.state === "active"
        ? "Monitor is running in the background. Call monitor_wait with this id to pause until it settles. Do NOT poll with sleep loops."
        : "Monitor already settled on its first evaluation.",
  };
}

export async function runServer(home = defaultHome()): Promise<void> {
  const registry = builtinRegistry();
  await loadCustomProbes(registry, join(home, "probes"), log);

  const engine = new MonitorEngine(registry, log);

  const server = new McpServer({ name: "codex-monitor", version: VERSION });

  server.registerTool(
    "monitor_create",
    {
      title: "Create monitor",
      description:
        "Create a background monitor that watches for a condition (command output predicates, " +
        "log pattern, file event, or any installed custom probe type) and settles when it " +
        "becomes true. Evaluation " +
        "happens inside the plugin — never write your own sleep/poll loop. Returns a monitor id; " +
        "pass it to monitor_wait to pause until the condition holds. Use this for anything " +
        "long-running: cluster jobs, builds, deploys, downloads, servers coming up.",
      inputSchema: MonitorSpecSchema.shape,
    },
    async (args) => {
      const spec = MonitorSpecSchema.parse(args);
      return jsonResult(creationView(engine.create(spec)));
    },
  );

  server.registerTool(
    "monitor_wait",
    {
      title: "Wait for monitors",
      description:
        "Block until the given monitor(s) settle (satisfied, failed, timeout, or cancelled). " +
        "mode 'all' waits for every listed monitor; 'any' returns as soon as one settles. " +
        "If wait_timeout_seconds elapses first, returns outcome 'wait_timeout' — the monitors " +
        "keep running and you can call monitor_wait again with the same ids.",
      inputSchema: {
        ids: z.array(z.string()).nonempty().describe("Monitor ids returned by monitor_create."),
        mode: z.enum(["all", "any"]).default("all"),
        wait_timeout_seconds: z
          .number()
          .positive()
          .max(86400)
          .default(1800)
          .describe("Give up waiting (not the monitors) after this long."),
      },
    },
    async (args, extra) => {
      const mode = (args.mode ?? "all") as WaitMode;
      const timeoutMs = (args.wait_timeout_seconds ?? 1800) * 1000;

      // Keep long waits alive for clients that honor progress notifications.
      const progressToken = extra._meta?.progressToken;
      let beats = 0;
      const heartbeat = progressToken
        ? setInterval(() => {
            beats += 1;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: beats,
                  message: `still waiting on ${args.ids.join(", ")}`,
                },
              })
              .catch(() => {});
          }, HEARTBEAT_MS)
        : undefined;

      try {
        const result = await engine.waitFor(args.ids, mode, { timeoutMs, signal: extra.signal });
        return jsonResult(result);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
  );

  server.registerTool(
    "monitor_run",
    {
      title: "Create monitor and wait",
      description:
        "Convenience: monitor_create + monitor_wait in one blocking call. Creates the monitor " +
        "and pauses until it settles (or wait_timeout_seconds elapses, in which case the monitor " +
        "keeps running and you can monitor_wait on the returned id later).",
      inputSchema: {
        ...MonitorSpecSchema.shape,
        wait_timeout_seconds: z.number().positive().max(86400).default(1800),
      },
    },
    async (args, extra) => {
      const { wait_timeout_seconds, ...specArgs } = args;
      const spec = MonitorSpecSchema.parse(specArgs);
      const record = engine.create(spec);

      const progressToken = extra._meta?.progressToken;
      let beats = 0;
      const heartbeat = progressToken
        ? setInterval(() => {
            beats += 1;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { progressToken, progress: beats, message: `waiting on ${record.id}` },
              })
              .catch(() => {});
          }, HEARTBEAT_MS)
        : undefined;

      try {
        const result = await engine.waitFor([record.id], "all", {
          timeoutMs: (wait_timeout_seconds ?? 1800) * 1000,
          signal: extra.signal,
        });
        return jsonResult(result);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
    },
  );

  server.registerTool(
    "monitor_status",
    {
      title: "Monitor status",
      description:
        "Snapshot of monitors without blocking. Omit ids for all monitors. Use for a quick " +
        "look; use monitor_wait (not repeated status calls) to wait for completion.",
      inputSchema: {
        ids: z.array(z.string()).optional(),
      },
    },
    async (args) => {
      const records = args.ids
        ? args.ids.map((id) => {
            const r = engine.get(id);
            if (!r) throw new Error(`unknown monitor id: ${id}`);
            return r;
          })
        : engine.list();
      return jsonResult({ monitors: records.map(toSnapshot) });
    },
  );

  server.registerTool(
    "monitor_cancel",
    {
      title: "Cancel monitor",
      description: "Stop an active monitor. Settled monitors are left untouched.",
      inputSchema: {
        id: z.string(),
        reason: z.string().optional(),
      },
    },
    async (args) => {
      const record = engine.cancel(args.id, args.reason ?? "cancelled by request");
      return jsonResult({ monitor: toSnapshot(record) });
    },
  );

  const shutdown = () => {
    engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (probe types: ${registry.types().join(", ")})`);
}
