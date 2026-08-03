/**
 * Bundled custom probe: `tcp`, satisfied when a host:port accepts connections.
 *
 * Install: copy this file into `$(codex-monitor home)/probes/` and restart
 * Codex. Condition shape:
 *
 *   { "type": "tcp", "host": "localhost", "port": 5432 }
 *
 * The smallest useful example of the probe contract: implement `check()` and
 * the engine schedules it with backoff; return `satisfied`/`failed` to settle
 * the monitor, `pending` to keep waiting.
 */
import net from "node:net";

export default {
  type: "tcp",
  create: (cond) => {
    if (typeof cond.host !== "string" || !Number.isInteger(cond.port)) {
      throw new Error("tcp condition requires 'host' (string) and 'port' (integer)");
    }
    return {
      defaultPoll: { interval_seconds: 1, max_interval_seconds: 15 },
      check: () =>
        new Promise((resolve) => {
          const sock = net.connect({ host: cond.host, port: cond.port, timeout: 2000 });
          sock.on("connect", () => {
            sock.destroy();
            resolve({ status: "satisfied", detail: `${cond.host}:${cond.port} accepting connections` });
          });
          sock.on("error", (err) => resolve({ status: "pending", detail: err.message }));
          sock.on("timeout", () => {
            sock.destroy();
            resolve({ status: "pending", detail: "connect timeout" });
          });
        }),
    };
  },
};
