/**
 * MCP server: the agent-facing surface of the monitor engine.
 *
 * Design notes:
 *  - `monitor_wait` is a *blocking* tool call. That is the whole point:
 *    "pause the agent until a condition becomes true" maps to one tool call
 *    that does not return until the condition settles. While blocked, we
 *    send MCP progress notifications (when the client supplies a progress
 *    token) so clients that honor progress do not time the call out.
 *  - Tool results are compact JSON in a text block, and every tool returns
 *    the same `{ monitors, outcome?, hint? }` shape.
 *  - All schemas come from engine/types.ts, so the tool contract and the
 *    engine contract are the same object.
 *  - The tool schemas are injected into the model's context on every request,
 *    so the surface is kept deliberately small. `monitor_create` absorbs the
 *    blocking case via `wait_timeout_seconds` rather than existing twice: a
 *    second tool would have to repeat the whole condition union, which is
 *    ~2.8kB of JSON Schema, because MCP cannot share schemas across tools.
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
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

/**
 * Hints are per-call context cost, so only two survive: the create -> wait
 * handoff, and the moment a wait ends unsettled, which is exactly where a
 * model is tempted to fall back to a sleep loop. Everything else lives in the
 * tool descriptions, which are paid once per session instead.
 */
const CREATED_HINT = "Running in background. Call monitor_wait with this id; never sleep/poll.";
const RESUME_HINT = "Monitors still running. Call monitor_wait again with these ids; never sleep/poll.";

function monitorsView(records: MonitorRecord[], extra?: Record<string, string>) {
  return { ...extra, monitors: records.map(toSnapshot) };
}

function waitView(result: WaitResult) {
  return result.outcome === "wait_timeout" ? { ...result, hint: RESUME_HINT } : result;
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

/**
 * Build the configured server and its engine without binding a transport, so
 * tests can drive the same tool surface the CLI exposes.
 */
export async function createServer(
  home = defaultHome(),
): Promise<{ server: McpServer; engine: MonitorEngine }> {
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
        "true. Evaluation happens inside the plugin, so never write your own sleep/poll loop. " +
        "Set wait_timeout_seconds to block until it settles, which is the usual case; omit it " +
        "to get a monitor id back immediately and pause later with monitor_wait. Use this for " +
        "anything long-running: cluster jobs, builds, deploys, downloads, servers coming up. " +
        `Installed condition types: ${registry.types().join(", ")}.`,
      inputSchema: {
        ...MonitorSpecSchema.shape,
        wait_timeout_seconds: z
          .number()
          .positive()
          .max(86400)
          .optional()
          .describe("Block until the monitor settles, giving up the wait (not the monitor) after this long."),
      },
    },
    async (args, extra) => {
      const { wait_timeout_seconds, ...specArgs } = args;
      const record = engine.create(MonitorSpecSchema.parse(specArgs));
      if (wait_timeout_seconds === undefined) {
        return jsonResult(
          monitorsView([record], record.state === "active" ? { hint: CREATED_HINT } : undefined),
        );
      }
      return jsonResult(
        waitView(
          await waitWithHeartbeat(engine, [record.id], "all", wait_timeout_seconds * 1000, extra),
        ),
      );
    },
  );

  server.registerTool(
    "monitor_wait",
    {
      title: "Wait for monitors",
      description:
        "Block until the given monitor(s) settle (satisfied, failed, timeout, or cancelled). " +
        "mode 'all' waits for every listed monitor; 'any' returns as soon as one settles. " +
        "If wait_timeout_seconds elapses first, returns outcome 'wait_timeout'. Monitors keep " +
        "running whenever a wait ends early, including when the call is interrupted, so call " +
        "monitor_wait again with the same ids to resume.",
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
        waitView(
          await waitWithHeartbeat(
            engine,
            args.ids,
            args.mode,
            args.wait_timeout_seconds * 1000,
            extra,
          ),
        ),
      ),
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
    async (args) =>
      jsonResult(
        monitorsView(args.ids ? args.ids.map((id) => engine.getOrThrow(id)) : engine.list()),
      ),
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
    async (args) => jsonResult(monitorsView([engine.cancel(args.id, args.reason)])),
  );

  log(`probe types: ${registry.types().join(", ")}`);
  return { server, engine };
}

export async function runServer(home = defaultHome()): Promise<void> {
  const { server, engine } = await createServer(home);

  const shutdown = () => {
    engine.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
  log("ready");
}
