import { ProbeRegistry } from "../registry.js";
import { createCommandProbe } from "./command.js";
import { createFileProbe } from "./file.js";
import { createLogProbe } from "./log.js";

export function builtinRegistry(): ProbeRegistry {
  const registry = new ProbeRegistry();
  registry.register("command", createCommandProbe);
  registry.register("file", createFileProbe);
  registry.register("log", createLogProbe);
  return registry;
}
