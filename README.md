# codex-monitor

**Claude Code-style monitors for Codex: pause the agent until an arbitrary condition becomes true.**

Agents watching long-running work (cluster jobs, builds, deploys, training runs) usually degenerate into `sleep 30 && squeue ...` loops that burn tokens, spam the transcript, and wake the model dozens of times to learn nothing. [openai/codex#13733](https://github.com/openai/codex/issues/13733) tracks the problem. `codex-monitor` replaces the loop with three steps:

1. Create a monitor for a condition.
2. Block on it.
3. Wake up exactly once.

- **Command-agnostic.** Conditions are declarative: a shell command plus output predicates, a log regex, a file event, plus any probe type you install. Nothing is hardcoded for Slurm, Docker, or Kubernetes, yet all of them work out of the box.
- **Event-driven.** File and log conditions use filesystem notifications; probed conditions use adaptive backoff with jitter. Evaluation happens entirely inside the plugin process. The model never writes a polling loop.
- **Blocking by design.** `monitor_wait` is one MCP tool call that does not return until the condition settles. That is the pause.
- **Session-scoped by design.** Monitors live and die with the Codex session that created them.
- **Concurrent and composable.** Run any number of monitors; wait for `all` or `any` of a set.
- **Programmable.** Drop a `.mjs` file in `~/.config/codex-monitor/probes/` to add a condition type. No fork required.

## Install

```bash
npm install -g @naowalrahman/codex-monitor
```

The package is scoped, but the binary it installs is plain `codex-monitor`.

Then register it in `~/.codex/config.toml`:

```toml
[mcp_servers.monitor]
command = "codex-monitor"
# monitor_wait blocks on purpose. Give the tool call room to block.
tool_timeout_sec = 86400
startup_timeout_sec = 20
```

(Or skip the global install and use `command = "npx"`, `args = ["-y", "@naowalrahman/codex-monitor"]`.)

Finally, teach the agent to reach for monitors by adding this to your `AGENTS.md`:

```markdown
## Waiting for long-running work

Never wait for long-running work (jobs, builds, deploys, servers, downloads)
by sleeping and re-checking in a loop. Instead use the `monitor` MCP tools:
create a monitor describing the completion/failure condition, then call
`monitor_wait`, which blocks until the condition settles and returns evidence.
Prefer `log`/`file` conditions when output is written to disk (they are
event-driven), and `command` conditions with `success_when`/`failure_when`
predicates for anything with a CLI (squeue, docker, kubectl, gh run).
```

## The model, in 30 seconds

A **monitor** is a condition plus an evaluation policy plus a lifecycle:

```
        ┌────────────────────────── settles once ──────────────────────────┐
active ─┤  satisfied   the condition became true                           │
        │  failed      a failure predicate matched (job crashed, etc.)     │
        │  timeout     the monitor's own deadline passed                   │
        │  cancelled   monitor_cancel                                      │
        └──────────────────────────────────────────────────────────────────┘
```

The agent sees five tools:

| Tool             | Behavior                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `monitor_create` | Register a condition; returns a monitor id immediately.                                                                      |
| `monitor_wait`   | **Blocks** until the listed monitors settle (`mode: all\|any`). A `wait_timeout` returns control; the monitors keep running. |
| `monitor_run`    | `create` + `wait` in one call, for the common case.                                                                          |
| `monitor_status` | Non-blocking snapshot (for a quick look, not for polling).                                                                   |
| `monitor_cancel` | Settle an active monitor as `cancelled`.                                                                                     |

## Condition types

The core ships three, and the split is deliberate:

- **`command`** is the universal sampling adapter: run a program, apply predicates to the result, forget. Anything with a CLI is monitorable this way, which is what makes the system command-agnostic.
- **`file`** and **`log`** exist because sampling cannot express them. They hold state across evaluations (a log tail tracks a byte offset so it only matches newly appended content; "unchanged for 10s" spans multiple observations) and they are event-driven (fs.watch wakes them in milliseconds, not on the next poll boundary). In a command-only world that state would live in the model's context, which is what this plugin exists to prevent.
- Everything else, including HTTP readiness, PID exit, TCP ports, and queue depths, is stateless sampling. Write it as a `command` condition or a [custom probe](#custom-probes). Ready-made `http`, `process`, and `tcp` probes ship in [examples/probes](examples/probes).

### `command`: the universal adapter

Runs a shell command per evaluation (with backoff, inside the plugin) and applies declarative predicates to its exit code and combined output. This is how you monitor anything with a CLI:

```jsonc
// Slurm job, distinguishing success from failure
{
  "name": "slurm job 812345",
  "condition": {
    "type": "command",
    "command": "sacct -j 812345 -n -o State | head -1",
    "success_when": { "output_matches": "COMPLETED" },
    "failure_when": { "output_matches": "FAILED|CANCELLED|TIMEOUT|OUT_OF_ME" },
  },
  "poll": { "interval_seconds": 15, "max_interval_seconds": 120 },
  "timeout_seconds": 43200,
}
```

```jsonc
// Docker container becomes healthy
{
  "type": "command",
  "command": "docker inspect -f '{{.State.Health.Status}}' api",
  "success_when": { "output_matches": "healthy" },
  "failure_when": { "output_matches": "unhealthy" },
}
```

```jsonc
// Kubernetes rollout finished
{
  "type": "command",
  "command": "kubectl rollout status deploy/web --timeout=1s",
  "success_when": { "exit_code": 0 },
}
```

```jsonc
// GitHub Actions run finished
{
  "type": "command",
  "command": "gh run view 123456789 --json status,conclusion -q '.status + \" \" + .conclusion'",
  "success_when": { "output_matches": "completed success" },
  "failure_when": {
    "output_matches": "completed (failure|cancelled|timed_out)",
  },
}
```

Predicates: `exit_code` (int or list), `output_matches`, `output_not_matches` (regexes). All present fields must hold, and `failure_when` is checked before `success_when`.

### `log`: event-driven regex tail

Tails a file by byte offset (cheap on huge logs, survives rotation and truncation) and settles when appended content matches:

```jsonc
{
  "type": "log",
  "path": "/data/run7/train.log",
  "pattern": "epoch 100/100 .* val_loss",
  "failure_pattern": "Traceback|CUDA out of memory",
}
```

### `file`: filesystem events

`exists` (appears), `deleted` (gone), `changed` (mtime or size moved after the monitor started), `stable` (unchanged for `stable_seconds`, which is how you catch "download finished"):

```jsonc
{
  "type": "file",
  "path": "/results/model.safetensors",
  "event": "stable",
  "stable_seconds": 10,
}
```

## Lifetime and scope

A monitor belongs to the session that created it. Codex spawns one `codex-monitor` server per session; monitors are held in that process's memory, and when the session ends the server exits and every monitor dies with it. This is deliberate. It keeps the mental model exact (what you see in `monitor_status` is exactly what exists), it makes unlimited concurrent sessions safe by construction, and it leaves nothing on disk. If a job outlives your session, recreate the monitor in the next one; the underlying job is the durable thing, not the watcher. The only thing in the config directory is your custom probes.

## Custom probes

Drop a module in `~/.config/codex-monitor/probes/`. To install the ready-made ones:

```bash
mkdir -p "$(codex-monitor home)/probes" && cp examples/probes/http.mjs "$(codex-monitor home)/probes/"
```

The config directory resolves in this order: `$CODEX_MONITOR_HOME`, then `%APPDATA%\codex-monitor` on Windows, then `$XDG_CONFIG_HOME/codex-monitor`, then `~/.config/codex-monitor`. Run `codex-monitor home` to print what it resolved to.

Custom condition types pass schema validation with their fields untouched, since the probe factory owns validation and defaults, and they become creatable through the same MCP tools immediately. A complete probe:

```js
// ~/.config/codex-monitor/probes/tcp.mjs
export default {
  type: "tcp",
  create: (cond) => ({
    defaultPoll: { interval_seconds: 1, max_interval_seconds: 15 },
    async check() {
      const net = await import("node:net");
      return new Promise((resolve) => {
        const sock = net.connect({
          host: cond.host,
          port: cond.port,
          timeout: 2000,
        });
        sock.on("connect", () => {
          sock.destroy();
          resolve({
            status: "satisfied",
            detail: `${cond.host}:${cond.port} accepting connections`,
          });
        });
        sock.on("error", () =>
          resolve({ status: "pending", detail: "connection refused" }),
        );
        sock.on("timeout", () => {
          sock.destroy();
          resolve({ status: "pending", detail: "connect timeout" });
        });
      });
    },
  }),
};
```

A probe implements `check()` (which the engine schedules with backoff) and/or `start(host)`/`stop()` (event-driven, pushing outcomes via `host.emit`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [examples/probes](examples/probes).

## CLI

```bash
codex-monitor         # start the MCP server on stdio (what Codex runs)
codex-monitor home    # print the config directory (custom probes: <home>/probes)
```

## Why blocking tool calls (and the timeout caveat)

MCP has no "call the model back later" primitive, so the only way to genuinely pause an agent mid-task is a tool call that does not return. `monitor_wait` embraces that. It emits MCP progress notifications every 15s while blocked, and you should set `tool_timeout_sec` generously for this server (see Install). If a wait does get cut off, by a client timeout or by `wait_timeout_seconds`, nothing is lost: the monitor is still running, or already settled with the result held in `monitor_status`, and one more `monitor_wait` on the same id resumes the pause. That retry is a resume, not a poll loop.

## Limitations and roadmap

- Monitors do not outlive their session, by design (see Lifetime and scope). If you need watchers that keep evaluating with no session open, that is a job for a real scheduler.
- Composite conditions are covered by `monitor_wait(mode=any|all)` over multiple monitors. Inline boolean condition algebra is future work.
- Desktop notifications and webhooks on settle are future work.

## Development

```bash
npm install
npm run build
npm test
```

MIT licensed. Contributions welcome. New built-in probe types should be generic: no tool-specific integrations, since that is what `command` and custom probes are for.
