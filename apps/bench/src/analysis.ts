/**
 * From one typing window's fleet results to the numbers both benchmarks
 * report, and the raw records they write. Shared so the load test and the
 * browser benchmark's load clients are judged the same way.
 */
import { nowUs } from "./clock.ts";
import type { FleetResults } from "./fleet.ts";
import { assessGenerator, type Deliveries, type GeneratorHealth, type Traffic } from "./report.ts";
import type { JsonlWriter } from "./results.ts";
import { phaseOf, tally, type TypingWindow } from "./samples.ts";
import { summarize, type Summary } from "./stats.ts";

export interface FleetAnalysis {
  latencyMs: Summary;
  deliveries: Deliveries;
  sends: { measured: number; warmup: number };
  traffic: Traffic;
  generator: GeneratorHealth;
}

export function analyzeFleet(
  results: FleetResults,
  window: TypingWindow,
  options: { generatorCpuPercent: number | null; targetRatePerClient: number },
): FleetAnalysis {
  const t = tally(results.receipts, results.sends, results.observers, window);
  const seconds = (window.measureEndUs - window.measureStartUs) / 1e6;
  const tr = results.traffic;
  return {
    latencyMs: summarize(t.measuredMs, t.missing),
    deliveries: {
      expected: t.expected,
      measured: t.measuredMs.length,
      missing: t.missing,
      warmupExcluded: t.warmup,
      duplicates: t.duplicates,
      unknown: t.unknown,
      outside: t.outside,
    },
    sends: { measured: t.measuredSends, warmup: t.warmupSends },
    traffic: {
      inboundMessagesPerSecond: tr.sentMessages / seconds,
      outboundMessagesPerSecond: tr.receivedMessages / seconds,
      inboundBytesPerSecond: tr.sentBytes / seconds,
      outboundBytesPerSecond: tr.receivedBytes / seconds,
      meanInboundMessageBytes: tr.sentMessages ? tr.sentBytes / tr.sentMessages : null,
      meanOutboundMessageBytes: tr.receivedMessages ? tr.receivedBytes / tr.receivedMessages : null,
    },
    generator: assessGenerator({
      cpuPercentOfOneCore: options.generatorCpuPercent,
      observerLoopP99Ms: results.observerLoopDelay.map((d) => d.p99Ms),
      busyLoopP99Ms: results.busyLoopDelay.map((d) => d.p99Ms),
      sendLagMs: results.sendLagUs.map((us) => us / 1000),
      targetRatePerClient: options.targetRatePerClient,
      measuredSends: t.measuredSends,
      clients: results.sends.size,
      measuredSeconds: seconds,
    }),
  };
}

/**
 * Writes everything needed to recompute a window's statistics from
 * samples.jsonl alone: the window, which clients observed, every send (so
 * expected and missing deliveries can be recounted) and every receipt.
 */
export async function writeFleetRecords(
  writer: JsonlWriter,
  tag: Record<string, unknown>,
  results: FleetResults,
  window: TypingWindow,
): Promise<void> {
  await writer.write({ ...tag, kind: "window", ...window, observers: results.observers });
  for (const [sender, times] of results.sends) {
    for (let seq = 0; seq < times.length; seq++) {
      const sentAtUs = times[seq]!;
      await writer.write({
        ...tag,
        kind: "send",
        sender,
        seq,
        sentAtUs,
        phase: phaseOf(sentAtUs, window),
      });
    }
  }
  const r = results.receipts;
  for (let i = 0; i < r.length; i++) {
    await writer.write({
      ...tag,
      kind: "receipt",
      sender: r.sender[i],
      seq: r.seq[i],
      receiver: r.receiver[i],
      sentAtUs: r.sentAtUs[i],
      receivedAtUs: r.receivedAtUs[i],
      latencyMs: (r.receivedAtUs[i]! - r.sentAtUs[i]!) / 1000,
      phase: phaseOf(r.sentAtUs[i]!, window),
    });
  }
}

/**
 * Starts measuring this process's CPU (every thread, so every load client);
 * the returned function stops and gives the % of one core since the start.
 */
export function startCpuMeter(): () => number {
  const start = process.cpuUsage();
  const startUs = nowUs();
  return () => {
    const used = process.cpuUsage(start);
    return (100 * (used.user + used.system)) / Math.max(1, nowUs() - startUs);
  };
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
