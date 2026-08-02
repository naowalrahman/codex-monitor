#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   codex-monitor            start the MCP server on stdio (what Codex runs)
 *   codex-monitor mcp        same, explicit
 *   codex-monitor home       print the config directory (custom probes live in <home>/probes)
 */
import { createRequire } from "node:module";
import { runServer } from "./server.js";
import { defaultHome } from "./engine/registry.js";

const require = createRequire(import.meta.url);
const VERSION: string = require("../package.json").version;

const arg = process.argv[2];
switch (arg) {
  case undefined:
  case "mcp":
    void runServer();
    break;
  case "home":
    console.log(defaultHome());
    break;
  case "--version":
  case "-v":
    console.log(VERSION);
    break;
  default:
    console.log(
      `codex-monitor ${VERSION}\n\nusage:\n  codex-monitor [mcp]   start the MCP server on stdio\n  codex-monitor home    print the config directory (custom probes: <home>/probes)`,
    );
    process.exit(arg === "--help" || arg === "-h" ? 0 : 1);
}
