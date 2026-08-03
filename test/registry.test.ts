import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultHome } from "../src/engine/registry.js";

const VARS = ["CODEX_MONITOR_HOME", "XDG_CONFIG_HOME", "APPDATA"] as const;
const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
const realPlatform = process.platform;

/** process.platform is a getter, so tests swap it rather than assign it. */
function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

afterEach(() => {
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  setPlatform(realPlatform);
});

describe("defaultHome", () => {
  it("prefers $CODEX_MONITOR_HOME over everything else", () => {
    process.env.CODEX_MONITOR_HOME = "/opt/monitor-cfg";
    process.env.XDG_CONFIG_HOME = "/xdg";
    process.env.APPDATA = "C:\\Users\\x\\AppData\\Roaming";
    expect(defaultHome()).toBe("/opt/monitor-cfg");
  });

  it("uses %APPDATA% on Windows", () => {
    delete process.env.CODEX_MONITOR_HOME;
    setPlatform("win32");
    process.env.APPDATA = join("C:", "Users", "x", "AppData", "Roaming");
    expect(defaultHome()).toBe(join(process.env.APPDATA, "codex-monitor"));
  });

  it("uses $XDG_CONFIG_HOME when it is absolute", () => {
    delete process.env.CODEX_MONITOR_HOME;
    setPlatform("linux");
    process.env.XDG_CONFIG_HOME = "/home/x/elsewhere";
    expect(defaultHome()).toBe(join("/home/x/elsewhere", "codex-monitor"));
  });

  it("falls back to ~/.config for a relative $XDG_CONFIG_HOME", () => {
    delete process.env.CODEX_MONITOR_HOME;
    setPlatform("linux");
    process.env.XDG_CONFIG_HOME = "relative/config";
    expect(defaultHome()).toBe(join(homedir(), ".config", "codex-monitor"));
  });

  it("defaults to ~/.config/codex-monitor", () => {
    delete process.env.CODEX_MONITOR_HOME;
    delete process.env.XDG_CONFIG_HOME;
    setPlatform("linux");
    expect(defaultHome()).toBe(join(homedir(), ".config", "codex-monitor"));
  });
});
