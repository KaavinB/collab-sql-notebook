/**
 * The results directory of one run: data/bench-results/<run-id>/ with
 *   samples.jsonl  every raw record, one JSON object per line, enough to
 *                  recompute every statistic in the summary: per typing
 *                  window its bounds and observers ("window"), every edit
 *                  sent ("send") and every receipt ("receipt"), so expected
 *                  and missing deliveries can be recounted; for the browser
 *                  benchmark every keystroke ("keystroke", with appearedMs
 *                  null when it never appeared). Warm-up records are
 *                  included and marked.
 *   summary.json   provenance, parameters and the computed statistics
 *   report.md      the same, for people
 *   *.log          output of the servers this run started
 * data/ is gitignored; results are published by copying numbers out of a
 * report, together with its provenance.
 */
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./stack.ts";

export function resultsDir(runId: string, root = path.join(REPO_ROOT, "data/bench-results")) {
  const dir = path.join(root, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes JSON lines, respecting backpressure so a million samples don't pile up in memory. */
export class JsonlWriter {
  private readonly stream: WriteStream;
  readonly file: string;
  lines = 0;

  constructor(file: string) {
    this.file = file;
    this.stream = createWriteStream(file);
  }

  async write(record: unknown): Promise<void> {
    this.lines++;
    if (!this.stream.write(`${JSON.stringify(record)}\n`)) {
      await new Promise<void>((resolve) => this.stream.once("drain", () => resolve()));
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.stream.once("error", reject);
      this.stream.end(() => resolve());
    });
  }
}

/**
 * JSON can't hold Infinity: JSON.stringify writes null, which would read as
 * "no data" when it means "a delivery never arrived". It's spelled out.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v: unknown) => (v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : v),
    2,
  );
}

export function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${toJson(value)}\n`);
}
