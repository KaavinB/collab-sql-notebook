/**
 * Loaded into the sync server's process with `node --import` when the load
 * benchmark starts the server itself. It does nothing until the benchmark
 * asks over the IPC channel, then answers with the process's cumulative CPU
 * time and resident memory, read by Node itself (the same numbers on macOS
 * and Linux, at microsecond resolution, unlike `ps`).
 *
 * It touches nothing in the server; asking costs one small message.
 */

export interface ProbeReading {
  type: "bench-probe";
  /** Cumulative CPU time of the whole process, µs. */
  userUs: number;
  systemUs: number;
  rssBytes: number;
  /** When it was read, on the machine-wide monotonic clock (µs), like the benchmark's own. */
  atUs: number;
}

if (process.send) {
  process.on("message", (message: unknown) => {
    if (typeof message !== "object" || message === null) return;
    if ((message as { type?: unknown }).type !== "bench-probe") return;
    const cpu = process.cpuUsage();
    const reading: ProbeReading = {
      type: "bench-probe",
      userUs: cpu.user,
      systemUs: cpu.system,
      rssBytes: process.memoryUsage.rss(),
      atUs: Number(process.hrtime.bigint() / 1000n),
    };
    process.send?.(reading);
  });
  // Don't let the channel keep the process alive: the server decides when to
  // exit. (After adding the listener, which refs the channel again.)
  process.channel?.unref();
}
