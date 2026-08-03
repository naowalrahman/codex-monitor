/**
 * Bundled custom probe: `process`, satisfied when a PID exits.
 *
 * Install: copy this file into `$(codex-monitor home)/probes/` and restart
 * Codex. Condition shape:
 *
 *   { "type": "process", "pid": 41527 }
 *
 * Uses signal 0 to test existence, so it works for processes the plugin did
 * not spawn. For the same reason it cannot observe the exit code of a
 * non-child. Pair with a `log` or `command` monitor when the outcome matters,
 * not just the exit. Note the EPERM edge case below: "not allowed to signal
 * it" still means "it exists".
 */
export default {
  type: "process",
  create: (cond) => {
    if (!Number.isInteger(cond.pid) || cond.pid <= 0) {
      throw new Error("process condition requires a positive integer 'pid'");
    }
    return {
      defaultPoll: { interval_seconds: 1, max_interval_seconds: 10, backoff_factor: 1.3 },
      async check() {
        try {
          process.kill(cond.pid, 0);
          return { status: "pending", detail: `pid ${cond.pid} is running` };
        } catch (err) {
          if (err.code === "EPERM") {
            return { status: "pending", detail: `pid ${cond.pid} is running (EPERM)` };
          }
          return { status: "satisfied", detail: `pid ${cond.pid} has exited` };
        }
      },
    };
  },
};
