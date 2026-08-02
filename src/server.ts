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
import { MonitorEngine, type WaitMode, type WaitResult } from "./engine/engine.js";
import { builtinRegistry } from "./engine/probes/index.js";
import { defaultHome, loadCustomProbes } from "./engine/registry.js";
import { MonitorSpecSchema, toSnapshot, type MonitorRecord } from "./engine/types.js";
import { VERSION } from "./version.js";
import { join } from "node:path";

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

/** The subset of the MCP request context the blocking tools need. */
interface RequestExtra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message: string };
  }) => Promise<void>;
}

/**
 * Block on `engine.waitFor`, emitting progress notifications while we do.
 * Clients that honor progress use them to keep a long tool call from timing
 * out, which is what makes an hours-long pause survivable; both blocking
 * tools share this so the keepalive behavior can only be defined once.
 */
async function waitWithHeartbeat(
  engine: MonitorEngine,
  ids: string[],
  mode: WaitMode,
  timeoutMs: number,
  extra: RequestExtra,
): Promise<WaitResult> {
  const progressToken = extra._meta?.progressToken;
  let beats = 0;
  const heartbeat =
    progressToken === undefined
      ? undefined
      : setInterval(() => {
          beats += 1;
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: beats,
                message: `still waiting on ${ids.join(", ")}`,
              },
            })
            .catch(() => {});
        }, HEARTBEAT_MS);

  try {
    return await engine.waitFor(ids, mode, { timeoutMs, signal: extra.signal });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
  }
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
        "Create a background monitor that watches for a condition and settles when it becomes " +
        "true. Evaluation happens inside the plugin — never write your own sleep/poll loop. " +
        "Returns a monitor id; pass it to monitor_wait to pause until the condition holds. Use " +
        "this for anything long-running: cluster jobs, builds, deploys, downloads, servers " +
        `coming up. Installed condition types: ${registry.types().join(", ")}.`,
      inputSchema: MonitorSpecSchema.shape,
    },
    async (args) => jsonResult(creationView(engine.create(MonitorSpecSchema.parse(args)))),
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
    async (args, extra) =>
      jsonResult(
        await waitWithHeartbeat(
          engine,
          args.ids,
          args.mode,
          args.wait_timeout_seconds * 1000,
          extra,
        ),
      ),
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
      const record = engine.create(MonitorSpecSchema.parse(specArgs));
      return jsonResult(
        await waitWithHeartbeat(engine, [record.id], "all", wait_timeout_seconds * 1000, extra),
      );
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
      const records = args.ids ? args.ids.map((id) => engine.getOrThrow(id)) : engine.list();
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
    async (args) => jsonResult({ monitor: toSnapshot(engine.cancel(args.id, args.reason)) }),
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
