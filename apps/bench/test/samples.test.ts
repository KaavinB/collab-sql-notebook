import { describe, expect, it } from "vitest";

import {
  encodeStamp,
  parseStamps,
  phaseOf,
  ReceiptColumns,
  tally,
  type TypingWindow,
} from "../src/samples.ts";

describe("stamps", () => {
  it("round-trip through the text they're typed as", () => {
    const stamp = { sender: 12, seq: 345, sentAtUs: 677_425_101_806_916 };
    expect(encodeStamp(stamp)).toBe("12:345:677425101806916;");
    expect(parseStamps(encodeStamp(stamp))).toEqual([stamp]);
  });

  it("parses every stamp in an insert that merged several edits", () => {
    const text =
      encodeStamp({ sender: 1, seq: 0, sentAtUs: 10 }) +
      encodeStamp({ sender: 1, seq: 1, sentAtUs: 20 });
    expect(parseStamps(text)).toEqual([
      { sender: 1, seq: 0, sentAtUs: 10 },
      { sender: 1, seq: 1, sentAtUs: 20 },
    ]);
  });

  it("finds nothing in ordinary typing", () => {
    expect(parseStamps("select 1 as x; -- 12:30")).toEqual([]);
  });

  it("refuses values that wouldn't parse back", () => {
    expect(() => encodeStamp({ sender: -1, seq: 0, sentAtUs: 0 })).toThrow(RangeError);
    expect(() => encodeStamp({ sender: 0, seq: 1.5, sentAtUs: 0 })).toThrow(RangeError);
    expect(() => encodeStamp({ sender: 1_000_000, seq: 0, sentAtUs: 0 })).toThrow(RangeError);
  });
});

describe("ReceiptColumns", () => {
  it("grows past its initial capacity and survives a postMessage round trip", () => {
    const columns = new ReceiptColumns(2);
    for (let i = 0; i < 5; i++) columns.push(i, i * 10, 7, i * 100, i * 100 + 5);
    expect(columns.length).toBe(5);
    const { message, transfer } = columns.toMessage();
    expect(message.sender).toHaveLength(5);
    expect(transfer).toHaveLength(5);
    const copy = ReceiptColumns.fromMessage(structuredClone(message));
    expect(Array.from(copy.seq.subarray(0, copy.length))).toEqual([0, 10, 20, 30, 40]);
    expect(copy.receivedAtUs[4]).toBe(405);
    // toMessage copies, so the original keeps working after a transfer.
    columns.push(9, 9, 9, 9, 9);
    expect(columns.length).toBe(6);
  });

  it("appends another set of receipts", () => {
    const a = new ReceiptColumns(1);
    a.push(1, 0, 2, 10, 11);
    const b = new ReceiptColumns(1);
    b.push(3, 0, 4, 20, 21);
    a.append(b);
    expect(a.length).toBe(2);
    expect(a.sender[1]).toBe(3);
  });
});

const window: TypingWindow = { typingStartUs: 1_000, measureStartUs: 2_000, measureEndUs: 5_000 };

describe("phaseOf", () => {
  it("decides by send time, with half-open windows", () => {
    expect(phaseOf(999, window)).toBe("outside");
    expect(phaseOf(1_000, window)).toBe("warmup");
    expect(phaseOf(1_999, window)).toBe("warmup");
    expect(phaseOf(2_000, window)).toBe("measured");
    expect(phaseOf(4_999, window)).toBe("measured");
    expect(phaseOf(5_000, window)).toBe("outside");
  });
});

describe("tally", () => {
  // Three clients; 0 and 1 observe. Each sent one warm-up and two measured edits.
  const sends = new Map<number, number[]>([
    [0, [1_500, 2_500, 3_500]],
    [1, [1_600, 2_600, 3_600]],
    [2, [1_700, 2_700, 3_700]],
  ]);

  /** Every delivery each observer should get, `latencyUs` after sending. */
  function allDeliveries(latencyUs = 1_000): ReceiptColumns {
    const receipts = new ReceiptColumns();
    for (const receiver of [0, 1]) {
      for (const [sender, times] of sends) {
        if (sender === receiver) continue;
        times.forEach((t, seq) => receipts.push(sender, seq, receiver, t, t + latencyUs));
      }
    }
    return receipts;
  }

  it("counts expected deliveries per observer, excluding its own edits", () => {
    const result = tally(allDeliveries(), sends, [0, 1], window);
    // Measured sends: 6. Observer 0 expects 4 (not its own 2), observer 1 the same.
    expect(result.measuredSends).toBe(6);
    expect(result.warmupSends).toBe(3);
    expect(result.expected).toBe(8);
    expect(result.missing).toBe(0);
    expect(result.measuredMs).toHaveLength(8);
    expect([...result.measuredMs].every((ms) => ms === 1)).toBe(true);
    // Warm-up deliveries: each observer got the other two clients' warm-up edit.
    expect(result.warmup).toBe(4);
  });

  it("counts deliveries that never arrived as missing", () => {
    const receipts = new ReceiptColumns();
    receipts.push(2, 1, 0, 2_700, 2_800); // one of observer 0's four
    const result = tally(receipts, sends, [0, 1], window);
    expect(result.expected).toBe(8);
    expect(result.measuredMs).toHaveLength(1);
    expect(result.missing).toBe(7);
  });

  it("counts a repeated delivery once and reports it", () => {
    const receipts = allDeliveries();
    receipts.push(2, 1, 0, 2_700, 9_999);
    const result = tally(receipts, sends, [0, 1], window);
    expect(result.duplicates).toBe(1);
    expect(result.measuredMs).toHaveLength(8);
    expect(Math.max(...result.measuredMs)).toBe(1);
  });

  it("excludes receipts that match no logged send, or come from a non-observer", () => {
    const receipts = new ReceiptColumns();
    receipts.push(2, 9, 0, 2_700, 2_800); // seq never sent
    receipts.push(2, 1, 0, 2_701, 2_800); // stamp disagrees with the log
    receipts.push(7, 0, 0, 2_700, 2_800); // unknown sender
    receipts.push(0, 1, 2, 2_500, 2_600); // receiver 2 doesn't observe
    receipts.push(0, 1, 0, 2_500, 2_600); // its own edit
    const result = tally(receipts, sends, [0, 1], window);
    expect(result.unknown).toBe(5);
    expect(result.measuredMs).toHaveLength(0);
    expect(result.missing).toBe(8);
  });

  it("puts edits sent outside the typing window aside", () => {
    const outsideSends = new Map<number, number[]>([
      [0, [2_500]],
      [1, [5_500]],
    ]);
    const receipts = new ReceiptColumns();
    receipts.push(1, 0, 0, 5_500, 5_600);
    const result = tally(receipts, outsideSends, [0], window);
    expect(result.outside).toBe(1);
    expect(result.expected).toBe(0);
    expect(result.measuredMs).toHaveLength(0);
  });
});
