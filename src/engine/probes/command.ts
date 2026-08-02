/**
 * `command` probe — the universal escape hatch.
 *
 * Runs an arbitrary shell command per evaluation and applies declarative
 * predicates to its exit code and output. This is what makes the monitor
 * system command-agnostic: `squeue`, `docker inspect`, `kubectl get`,
 * `gh run view` — anything with a CLI can be monitored without the plugin
 * knowing about it.
 */
import { spawn } from "node:child_process";
import type { CommandCondition, OutputPredicate, ProbeOutcome } from "../types.js";
import { clip, compileRegex, type Probe } from "./probe.js";

const MAX_OUTPUT = 64 * 1024;

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

function runShell(cond: CommandCondition): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd" : "/bin/sh", [isWin ? "/c" : "-c", cond.command], {
      cwd: cond.cwd,
      env: { ...process.env, ...cond.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);

    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, cond.run_timeout_seconds * 1000);

    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: null, output: `spawn error: ${err.message}`, timedOut: false });
    });
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, output, timedOut });
    });
  });
}

export function predicateMatches(p: OutputPredicate, code: number | null, output: string): boolean {
  if (p.exit_code !== undefined) {
    const codes = Array.isArray(p.exit_code) ? p.exit_code : [p.exit_code];
    if (code === null || !codes.includes(code)) return false;
  }
  if (p.output_matches !== undefined && !compileRegex(p.output_matches).test(output)) return false;
  if (p.output_not_matches !== undefined && compileRegex(p.output_not_matches).test(output)) {
    return false;
  }
  return true;
}

export function createCommandProbe(condition: unknown): Probe {
  const cond = condition as CommandCondition;
  return {
    async check(): Promise<ProbeOutcome> {
      const run = await runShell(cond);
      if (run.timedOut) {
        return { status: "pending", detail: `probe command timed out after ${cond.run_timeout_seconds}s` };
      }
      const evidence = `exit ${run.code}${run.output ? `: ${clip(run.output)}` : ""}`;
      if (cond.failure_when && predicateMatches(cond.failure_when, run.code, run.output)) {
        return { status: "failed", detail: evidence };
      }
      if (predicateMatches(cond.success_when, run.code, run.output)) {
        return { status: "satisfied", detail: evidence };
      }
      return { status: "pending", detail: evidence };
    },
  };
}
