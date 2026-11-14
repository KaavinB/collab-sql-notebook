/**
 * Where and how a run happened, recorded with every result so a number is
 * never separated from the machine, code and parameters that produced it.
 *
 * Left out on purpose: the hostname and user name (results are meant to be
 * published), and anything from .env.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";

export interface Machine {
  cpuModel: string;
  /** Logical CPUs the OS reports. */
  logicalCpus: number;
  /** What Node would use for parallel work (respects cgroup/affinity limits). */
  availableParallelism: number;
  memoryBytes: number;
  os: string;
  osRelease: string;
  arch: string;
  node: string;
  /** 1, 5 and 15 minute load averages when the run started (0s on Windows). */
  loadAverageAtStart: number[];
}

export interface GitState {
  commit: string | null;
  /** Uncommitted changes to tracked files, or untracked files, when the run started. */
  dirty: boolean | null;
  /** How many paths `git status --porcelain` listed. */
  changedPaths: number | null;
}

export function machine(): Machine {
  const cpus = os.cpus();
  return {
    cpuModel: cpus[0]?.model.trim() ?? "unknown",
    logicalCpus: cpus.length,
    availableParallelism: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    os: os.type(),
    osRelease: os.release(),
    arch: os.arch(),
    node: process.version,
    loadAverageAtStart: os.loadavg().map((value) => Math.round(value * 100) / 100),
  };
}

export function gitState(repoRoot: string): GitState {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  try {
    const commit = git("rev-parse", "HEAD").trim();
    const status = git("status", "--porcelain").split("\n").filter(Boolean);
    return { commit, dirty: status.length > 0, changedPaths: status.length };
  } catch {
    return { commit: null, dirty: null, changedPaths: null };
  }
}

/** A run ID that sorts by time: load-20261113T101500Z-a588d71. */
export function runId(kind: string, startedAt: Date, commit: string | null): string {
  const stamp = startedAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `${kind}-${stamp}-${commit ? commit.slice(0, 7) : "nogit"}`;
}
