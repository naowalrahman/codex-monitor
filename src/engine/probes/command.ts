/**
 * `command` probe: the universal escape hatch.
 *
 * Runs an arbitrary shell command per evaluation and applies declarative
 * predicates to its exit code and output. This is what makes the monitor
 * system command-agnostic. `squeue`, `docker inspect`, `kubectl get`,
 * `gh run view`, anything with a CLI can be monitored without the plugin
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

/** A predicate with its regexes compiled once, rather than per evaluation. */
interface CompiledPredicate {
  exitCodes?: number[];
  matches?: RegExp;
  notMatches?: RegExp;
}

function compile(p: OutputPredicate): CompiledPredicate {
  return {
    exitCodes:
      p.exit_code === undefined
        ? undefined
        : Array.isArray(p.exit_code)
          ? p.exit_code
          : [p.exit_code],
    matches: p.output_matches ? compileRegex(p.output_matches) : undefined,
    notMatches: p.output_not_matches ? compileRegex(p.output_not_matches) : undefined,
  };
}

function matches(p: CompiledPredicate, code: number | null, output: string): boolean {
  if (p.exitCodes && (code === null || !p.exitCodes.includes(code))) return false;
  if (p.matches && !p.matches.test(output)) return false;
  if (p.notMatches && p.notMatches.test(output)) return false;
  return true;
}

/** Evaluate a predicate directly. Exported for tests and custom probe authors. */
export function predicateMatches(p: OutputPredicate, code: number | null, output: string): boolean {
  return matches(compile(p), code, output);
}

function runShell(cond: CommandCondition, env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const child = spawn(isWin ? "cmd" : "/bin/sh", [isWin ? "/c" : "-c", cond.command], {
      cwd: cond.cwd,
      env,
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

export function createCommandProbe(condition: unknown): Probe {
  const cond = condition as CommandCondition;
  // Built once per probe: process.env is a native-backed object whose spread
  // costs a getenv per key, and neither input changes over the probe's life.
  const env: NodeJS.ProcessEnv = { ...process.env, ...cond.env };
  const successWhen = compile(cond.success_when);
  const failureWhen = cond.failure_when ? compile(cond.failure_when) : undefined;

  return {
    async check(): Promise<ProbeOutcome> {
      const run = await runShell(cond, env);
      if (run.timedOut) {
        return {
          status: "pending",
          detail: `probe command timed out after ${cond.run_timeout_seconds}s`,
        };
      }
      const evidence = `exit ${run.code}${run.output ? `: ${clip(run.output)}` : ""}`;
      if (failureWhen && matches(failureWhen, run.code, run.output)) {
        return { status: "failed", detail: evidence };
      }
      if (matches(successWhen, run.code, run.output)) {
        return { status: "satisfied", detail: evidence };
      }
      return { status: "pending", detail: evidence };
    },
  };
}
