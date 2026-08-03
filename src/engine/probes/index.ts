import { ProbeRegistry } from "../registry.js";
import { createCommandProbe } from "./command.js";
import { createFileProbe } from "./file.js";
import { createLogProbe } from "./log.js";

/**
 * The core deliberately ships only three condition types:
 *
 *  - `command`: the universal sampling adapter, for anything with a CLI.
 *  - `file` / `log`: conditions that are stateful across evaluations or
 *    event-driven, which a stateless sampled command cannot express.
 *
 * Everything else (HTTP readiness, PID exit, TCP ports, queue depths) is
 * either a `command` condition or a custom probe. See examples/probes/.
 */
export function builtinRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry();
  registry.register("command", createCommandProbe);
  registry.register("file", createFileProbe);
  registry.register("log", createLogProbe);
  return registry;
}
