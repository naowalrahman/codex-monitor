# Architecture

`codex-monitor` implements one abstraction — **pause the agent until an arbitrary condition becomes true** — and everything in the design serves it. This document explains the moving parts and, more importantly, the reasoning behind them.

## Why a blocking MCP tool call

MCP has no mechanism for a server to call the model back later. Given that, there are only two ways an agent can wait for the world to change:

1. The model polls: run a check, read the result, sleep, repeat. Every iteration costs tokens, pollutes the transcript, and puts scheduling logic (intervals, backoff, giving up) inside the LLM, where it is unreliable and unauditable.
2. A tool call blocks until the condition settles.

`monitor_wait` is option 2. The model makes one call and is genuinely suspended — no tokens, no turns — until the plugin has evidence. Clients cap tool-call duration, so three things make long blocks safe:

- The server emits `notifications/progress` every 15s while blocked (when the client sends a progress token), for clients that use progress to reset timeouts.
- Users set `tool_timeout_sec` generously for this server in `config.toml`.
- A severed wait loses nothing. Monitors run independently of waiters, and a settled result stays readable in the engine, so re-issuing `monitor_wait` with the same ids *resumes* the pause. This is the recovery path for client timeouts and `wait_timeout_seconds` alike — and it is not a polling loop; it is at most one extra call per interruption.

## Components

```
Codex CLI (MCP client, stdio)
   │
   ▼
server.ts ────────────── tool surface: monitor_create / _wait / _run / _status / _cancel
   │                     schemas shared with the engine (src/engine/types.ts)
   ▼
MonitorEngine ─────────── lifecycle, scheduling, wait semantics   (engine/engine.ts)
               │
               ├── ProbeRegistry ── built-ins: command, file, log (engine/probes/*)
               │                    + custom probes from ~/.codex-monitor/probes/*.mjs
               └── EventEmitter "settled" ──► pending waitFor() promises
```

The engine knows nothing about MCP; the server knows nothing about probes. Both are independently testable (the test suite drives the engine directly), and the engine could be embedded in another host without change.

## The monitor lifecycle

A monitor is `spec` (condition + poll policy + timeout) plus `record` (state, attempts, evidence, history). `active` is the only non-terminal state; `settle()` moves a monitor to `satisfied`, `failed`, `timeout`, or `cancelled` exactly once, tears down its runtime (timers, watchers), and emits `settled` to wake any waiters. Settled records stay readable via `monitor_status` for the rest of the session.

`failed` is a first-class outcome, not an error: distinguishing "the job finished" from "the job crashed" at the *condition* level (`failure_when`, `failure_pattern`) means the agent wakes up already knowing which happened, with evidence attached, instead of waking on a generic change and re-investigating.

## The evaluation model

Probes come in two shapes, and the engine treats them uniformly:

- **Event-driven** (`start`/`stop`): the probe subscribes to a push source — `fs.watch` for `file` and `log` — and emits outcomes when the world changes. A coarse 1s safety timer backs the watcher, because `fs.watch` is best-effort on network mounts and misses atomic-rename writes on some platforms. Latency is milliseconds; steady-state cost is ~zero.
- **Probed** (`check`): the engine schedules evaluations at `interval · factor^n`, capped at `max_interval`, with ±10% jitter (so fifty monitors created together don't thundering-herd a login node). Probe errors — network blips, a `squeue` that fails once — are recorded as `pending`, never as failure; the monitor's own deadline is the backstop for a probe that errors forever.

Either way, evaluation lives entirely in the plugin process. The model's only verbs are *create*, *wait*, *status*, *cancel*.

### Why exactly three built-in condition types

Any condition checkable by running a program and inspecting the result is a `command` condition — one stateless sample per evaluation. That single type is what makes the system command-agnostic: Slurm, Docker, Kubernetes, `gh run`, anything.

`file` and `log` are built in because sampling cannot express them:

- They hold **state across evaluations**. The log probe tracks a byte offset so it matches only *newly appended* content (and survives truncation/rotation); `grep DONE file` as a command condition would fire on stale content from a previous run. `file event=changed` needs a baseline captured at monitor start; `event=stable` needs a debounce timer spanning observations. In a command-only design that state would have to live in the model's context — the exact failure mode this plugin removes.
- They are **event-driven**, reacting in milliseconds rather than on a poll boundary.

Everything else (HTTP, PID exit, TCP, …) is stateless sampling and therefore lives outside the core, as `command` conditions or custom probes (`examples/probes/` ships ready-made ones). This keeps the core's contract crisp: a new built-in type must demonstrate semantics that sampling can't express.

## Lifetime & scope: session-scoped on purpose

Monitors are held entirely in the server process's memory and die with it. Codex spawns one server per session, so a monitor's lifetime is exactly its session's lifetime. This is a deliberate design decision, not a missing feature:

- **Concurrency becomes a non-problem.** Any number of Codex sessions run side by side with zero shared state — no lock files, no state-file ownership races, no risk of two engines evaluating (and side-effecting) the same monitor.
- **The mental model is exact.** `monitor_status` shows everything that exists; when the session ends, nothing lingers to wonder about, leak, or clean up.
- **The durable thing is the job, not the watcher.** A Slurm job, container, or CI run survives your session on its own; a monitor is cheap to recreate from its declarative condition in the next session. Persisting watchers would buy little and cost a shared-state protocol (locks or a daemon) to do safely.

Consequently `~/.codex-monitor/` holds only configuration (the custom probes directory) — no runtime state. If evaluation must continue with no session open at all, that is a job for a real scheduler (cron, systemd), not this plugin.

## Wait semantics

`waitFor(ids, mode, timeout)` resolves when the id set settles (`all`) or when the first member settles (`any`), returning snapshots of every requested monitor with its evidence. Design points:

- A wait timeout is a **normal outcome**, not an error, and it does not disturb the monitors.
- Waiters are pure observers on the `settled` event — any number of waits, over overlapping sets, concurrently.
- `mode: "any"` over several monitors is the composition primitive ("wake me when the job finishes *or* the error log matches"), which is why boolean condition algebra hasn't been needed in the core.
- The MCP request's abort signal cancels the wait (not the monitors).

## Extensibility

A probe factory takes a validated condition object and returns `{ check?, start?, stop?, defaultPoll? }`. Built-ins register in `builtinRegistry()`; user probes are ES modules in `~/.codex-monitor/probes/` default-exporting `{ type, create }`, loaded at startup. Event-driven probes receive a host with `emit`; state that spans evaluations (a log tail's byte offset, a baseline file signature) lives in the probe's closure, which is safe precisely because probes never outlive their process.

Condition validation is deliberately two-tier: built-in condition schemas are closed and strict (a malformed `command` condition fails loudly — it cannot slide through as "custom", because the custom schema rejects built-in type names), while custom conditions pass through with their fields untouched and the probe factory owns validation and defaults. Unknown types are rejected at create time, before the monitor is registered.

## Failure modes, honestly

| Scenario | Behavior |
|---|---|
| Session ends / server killed | Every monitor in that session dies with the process — by design. The underlying job is unaffected; recreate the monitor in the next session if you still care about it. |
| Probe command errors repeatedly | Stays `pending` with the error as evidence; monitor `timeout` is the backstop. |
| Client times the blocked call out | Nothing lost within the session; resume with `monitor_wait` on the same ids. Configure `tool_timeout_sec` to make this rare. |
| Many concurrent sessions | Fully independent server processes with no shared state; nothing to coordinate. |
