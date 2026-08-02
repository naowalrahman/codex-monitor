/**
 * Probe registry: maps condition `type` strings to probe factories.
 *
 * Built-in types are registered at startup; additional types can be loaded
 * from `$CODEX_MONITOR_HOME/probes/*.mjs` (see loadCustomProbes), which is
 * what makes the monitor system programmable without forking the plugin.
 */
import { readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import type { Probe, ProbeFactory } from "./probes/probe.js";

/**
 * Config home: $CODEX_MONITOR_HOME or ~/.codex-monitor. Holds only the
 * custom probes directory — there is no runtime state on disk.
 */
export function defaultHome(): string {
  return (
    process.env.CODEX_MONITOR_HOME ??
    join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".codex-monitor")
  );
}

export class ProbeRegistry {
  private factories = new Map<string, ProbeFactory>();

  register(type: string, factory: ProbeFactory): void {
    if (this.factories.has(type)) {
      throw new Error(`probe type already registered: ${type}`);
    }
    this.factories.set(type, factory);
  }

  create(condition: { type: string }): Probe {
    const factory = this.factories.get(condition.type);
    if (!factory) throw new Error(`unknown condition type: ${condition.type}`);
    return factory(condition);
  }

  types(): string[] {
    return [...this.factories.keys()];
  }
}

/**
 * Load user-defined probes from a directory. Each module default-exports
 * `{ type: string, create: ProbeFactory }` or an array of them.
 */
export async function loadCustomProbes(
  registry: ProbeRegistry,
  dir: string,
  log: (msg: string) => void,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return; // no custom probes dir — fine
  }
  for (const entry of entries) {
    if (!/\.(mjs|js)$/.test(entry)) continue;
    try {
      const mod = await import(pathToFileURL(join(dir, entry)).href);
      const defs = Array.isArray(mod.default) ? mod.default : [mod.default];
      for (const def of defs) {
        if (!def?.type || typeof def.create !== "function") {
          throw new Error("expected default export { type, create }");
        }
        registry.register(def.type, def.create);
        log(`loaded custom probe '${def.type}' from ${entry}`);
      }
    } catch (err) {
      log(`failed to load custom probe ${entry}: ${(err as Error).message}`);
    }
  }
}
