/** What both benchmark entry points share: run setup, provenance and error handling. */
import { UsageError } from "./args.ts";
import { gitState, machine, runId } from "./provenance.ts";
import type { Provenance } from "./report.ts";
import { resultsDir } from "./results.ts";
import { REPO_ROOT, stopAllServers, type Stack } from "./stack.ts";

export const PERCENTILE_METHOD =
  "nearest rank (the p-th percentile is the sample at rank ceil(p/100 × n) in sorted order; " +
  "no interpolation), computed by the script from the raw records in samples.jsonl, which " +
  "hold every send as well as every receipt, so missing deliveries can be recounted from it.";

export function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

export interface RunContext {
  runId: string;
  dir: string;
  startedAt: Date;
  machine: ReturnType<typeof machine>;
  git: ReturnType<typeof gitState>;
}

/** Records the machine and code before anything runs (the load average must predate the run). */
export function startRun(kind: "load" | "latency"): RunContext {
  const startedAt = new Date();
  const git = gitState(REPO_ROOT);
  const id = runId(kind, startedAt, git.commit);
  return { runId: id, dir: resultsDir(id), startedAt, machine: machine(), git };
}

export function provenance(
  kind: "load" | "latency",
  run: RunContext,
  label: string | null,
  stack: Stack | null,
  clock: string,
): Provenance {
  return {
    kind,
    runId: run.runId,
    label,
    startedAt: run.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    machine: run.machine,
    git: run.git,
    stack: stack
      ? { attached: stack.attached, database: stack.databaseName, started: true }
      : { attached: false, database: null, started: false },
    percentileMethod: PERCENTILE_METHOD,
    clock,
  };
}

/**
 * Runs a benchmark's main function: usage errors print the usage text, other
 * errors their message, and Ctrl-C stops the servers this run started.
 */
export function runMain(usage: string, main: (argv: string[]) => Promise<void>): void {
  main(process.argv.slice(2)).then(
    () => process.exit(0),
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${error.message}\n\n${usage}\n`);
        process.exit(2);
      }
      process.stderr.write(`benchmark failed: ${error instanceof Error ? error.stack : error}\n`);
      process.exit(1);
    },
  );
}

/**
 * On Ctrl-C or SIGTERM, stops every server this run started (also those
 * started while the stack was still coming up) before exiting, so nothing is
 * left on the bench ports.
 */
export function stopOnSignal(): void {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) process.exit(130);
    stopping = true;
    say(`\n${signal}: stopping the servers this run started…`);
    void stopAllServers().finally(() => process.exit(130));
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
