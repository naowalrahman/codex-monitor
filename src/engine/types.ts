/**
 * Core types and schemas for the monitor engine.
 *
 * A Monitor is: a declarative *condition* + an evaluation policy + a lifecycle.
 * Conditions are validated with zod; the same schemas are exposed as the MCP
 * tool input schemas so the agent-facing contract and the engine contract
 * can never drift apart.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Output predicates (used by the `command` condition)
// ---------------------------------------------------------------------------

/**
 * A declarative predicate over a finished command run. Every field that is
 * present must hold for the predicate to match. `output` is the combined
 * stdout + stderr of the probe command.
 */
export const OutputPredicateSchema = z
  .object({
    exit_code: z
      .union([z.number().int(), z.array(z.number().int()).nonempty()])
      .optional()
      .describe("Exit code (or list of acceptable exit codes) the command must return."),
    output_matches: z
      .string()
      .optional()
      .describe("Regular expression that must match the combined stdout+stderr."),
    output_not_matches: z
      .string()
      .optional()
      .describe("Regular expression that must NOT match the combined stdout+stderr."),
  })
  .refine(
    (p) =>
      p.exit_code !== undefined ||
      p.output_matches !== undefined ||
      p.output_not_matches !== undefined,
    { message: "predicate must set at least one of exit_code, output_matches, output_not_matches" },
  );

export type OutputPredicate = z.infer<typeof OutputPredicateSchema>;

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export const CommandConditionSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1).describe("Shell command to run on every evaluation."),
  cwd: z.string().optional().describe("Working directory for the command."),
  env: z.record(z.string()).optional().describe("Extra environment variables."),
  run_timeout_seconds: z
    .number()
    .positive()
    .max(3600)
    .default(60)
    .describe("Kill a single probe run after this many seconds (counts as 'pending')."),
  success_when: OutputPredicateSchema.describe("Monitor is satisfied when this predicate matches."),
  failure_when: OutputPredicateSchema.optional().describe(
    "Monitor fails permanently when this predicate matches (checked before success_when).",
  ),
});

export const FileConditionSchema = z.object({
  type: z.literal("file"),
  path: z.string().min(1).describe("Absolute path to watch."),
  event: z
    .enum(["exists", "deleted", "changed", "stable"])
    .default("exists")
    .describe(
      "exists: path appears (or already exists). deleted: path disappears (or is already gone). " +
        "changed: mtime/size changes after the monitor starts. " +
        "stable: path exists and has not changed for stable_seconds.",
    ),
  stable_seconds: z
    .number()
    .positive()
    .default(5)
    .describe("For event=stable: how long the file must remain unchanged."),
});

export const LogConditionSchema = z.object({
  type: z.literal("log"),
  path: z.string().min(1).describe("Path of the log file to tail (may not exist yet)."),
  pattern: z.string().min(1).describe("Regex; monitor is satisfied when a new chunk matches."),
  failure_pattern: z
    .string()
    .optional()
    .describe("Regex; monitor fails permanently when a new chunk matches (checked first)."),
  from: z
    .enum(["end", "start"])
    .default("end")
    .describe("Tail from the current end of the file, or scan existing content from the start."),
});

export const BUILTIN_CONDITION_TYPES = ["command", "file", "log"] as const;

export const BuiltinConditionSchema = z.discriminatedUnion("type", [
  CommandConditionSchema,
  FileConditionSchema,
  LogConditionSchema,
]);

/**
 * Conditions for custom probe types (loaded from the probes/ directory).
 * The shape is opaque to the engine — the probe factory owns validation and
 * defaults. Built-in type names are rejected here so a *malformed* built-in
 * condition fails validation loudly instead of sliding through as "custom".
 * Whether the type actually has a registered probe is checked at create time.
 */
export const CustomConditionSchema = z
  .object({ type: z.string().min(1) })
  .passthrough()
  .refine((c) => !(BUILTIN_CONDITION_TYPES as readonly string[]).includes(c.type), {
    message: "not a valid built-in condition",
  });

export const ConditionSchema = z.union([BuiltinConditionSchema, CustomConditionSchema]);

export type CommandCondition = z.infer<typeof CommandConditionSchema>;
export type FileCondition = z.infer<typeof FileConditionSchema>;
export type LogCondition = z.infer<typeof LogConditionSchema>;
export type Condition = z.infer<typeof ConditionSchema>;

// ---------------------------------------------------------------------------
// Evaluation policy
// ---------------------------------------------------------------------------

/**
 * Backoff policy for probed (non-event-driven) conditions. The engine starts
 * at `interval_seconds` and multiplies by `backoff_factor` after every
 * inconclusive check, capped at `max_interval_seconds`. A small jitter is
 * always applied. This lives entirely inside the plugin — the LLM never sees
 * or drives individual checks.
 */
export const PollPolicySchema = z.object({
  interval_seconds: z.number().min(0.05).max(3600).default(5),
  max_interval_seconds: z.number().min(0.05).max(86400).default(60),
  backoff_factor: z.number().min(1).max(10).default(1.5),
});

export type PollPolicy = z.infer<typeof PollPolicySchema>;

export const MonitorSpecSchema = z.object({
  name: z.string().max(120).optional().describe("Human-readable label, e.g. 'slurm job 12345'."),
  condition: ConditionSchema,
  poll: PollPolicySchema.partial()
    .optional()
    .describe(
      "Override the probe schedule. Event-driven conditions (file, log) still react immediately " +
        "via filesystem events; this tunes the periodic safety check behind them.",
    ),
  timeout_seconds: z
    .number()
    .positive()
    .max(30 * 86400)
    .default(86400)
    .describe("Monitor moves to state 'timeout' if unresolved after this long. Default 24h."),
});

export type MonitorSpec = z.infer<typeof MonitorSpecSchema>;

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** `active` is the only non-terminal state. */
export type MonitorState = "active" | "satisfied" | "failed" | "timeout" | "cancelled";

export const TERMINAL_STATES: ReadonlySet<MonitorState> = new Set([
  "satisfied",
  "failed",
  "timeout",
  "cancelled",
]);

/** What a single probe evaluation concluded. */
export interface ProbeOutcome {
  status: "satisfied" | "failed" | "pending";
  /** Short human-readable evidence, e.g. "exit 1: JobState=RUNNING". */
  detail?: string;
}

/** The in-memory record for one monitor (session-scoped). */
export interface MonitorRecord {
  id: string;
  spec: MonitorSpec;
  state: MonitorState;
  createdAt: string;
  /** Absolute deadline for the monitor's own timeout. */
  deadlineAt: string;
  resolvedAt?: string;
  /** Evidence for the terminal state. */
  resolution?: string;
  /** Number of probe evaluations performed. */
  attempts: number;
  lastResult?: { at: string; status: ProbeOutcome["status"]; detail?: string };
}

/** Compact view returned to the agent. */
export interface MonitorSnapshot {
  id: string;
  name?: string;
  state: MonitorState;
  condition_type: string;
  created_at: string;
  resolved_at?: string;
  resolution?: string;
  last_check?: { at: string; status: string; detail?: string };
  attempts: number;
  timeout_at: string;
}

export function toSnapshot(r: MonitorRecord): MonitorSnapshot {
  return {
    id: r.id,
    name: r.spec.name,
    state: r.state,
    condition_type: r.spec.condition.type,
    created_at: r.createdAt,
    resolved_at: r.resolvedAt,
    resolution: r.resolution,
    last_check: r.lastResult
      ? { at: r.lastResult.at, status: r.lastResult.status, detail: r.lastResult.detail }
      : undefined,
    attempts: r.attempts,
    timeout_at: r.deadlineAt,
  };
}
