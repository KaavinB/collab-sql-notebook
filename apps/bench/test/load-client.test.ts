import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { emptyTraffic, LoadClient, type ClientSpec } from "../src/load-client.ts";
import { parseStamps, ReceiptColumns } from "../src/samples.ts";

// Never connected: the documents are linked in process below, so these
// tests exercise the edit and receipt code without a server.
const spec = (index: number, extra: Partial<ClientSpec> = {}): ClientSpec => ({
  index,
  notebookId: "00000000-0000-0000-0000-000000000000",
  syncUrl: "ws://127.0.0.1:9",
  ticket: "unused",
  origin: "http://localhost:3200",
  observer: false,
  awareness: true,
  ...extra,
});

const clients: LoadClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
});

function client(s: ClientSpec, receipts = new ReceiptColumns()): LoadClient {
  const c = new LoadClient(s, emptyTraffic(), receipts);
  clients.push(c);
  return c;
}

/** Delivers every update between the two documents, marked as remote, as a provider would. */
function link(a: Y.Doc, b: Y.Doc): void {
  a.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(b, update, "remote");
  });
  b.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin !== "remote") Y.applyUpdate(a, update, "remote");
  });
}

describe("LoadClient", () => {
  it("turns another client's stamped edits into receipts, and ignores its own", () => {
    const sender = client(spec(1));
    const receipts = new ReceiptColumns();
    const observer = client(spec(2, { observer: true }), receipts);
    link(sender.doc, observer.doc);
    sender.createCell();
    observer.createCell();

    sender.sendEdit();
    sender.sendEdit();
    observer.sendEdit(); // its own: never a receipt

    expect(receipts.length).toBe(2);
    expect(Array.from(receipts.sender.subarray(0, 2))).toEqual([1, 1]);
    expect(Array.from(receipts.seq.subarray(0, 2))).toEqual([0, 1]);
    expect(Array.from(receipts.receiver.subarray(0, 2))).toEqual([2, 2]);
    expect(receipts.sentAtUs[0]).toBe(sender.sends[0]);
    expect(receipts.sentAtUs[1]).toBe(sender.sends[1]);
    expect(receipts.receivedAtUs[1]).toBeGreaterThanOrEqual(receipts.sentAtUs[1]!);
  });

  it("records nothing when it isn't an observer", () => {
    const sender = client(spec(1));
    const receipts = new ReceiptColumns();
    const other = client(spec(2), receipts);
    link(sender.doc, other.doc);
    sender.createCell();
    sender.sendEdit();
    expect(receipts.length).toBe(0);
  });

  it("writes a sql cell shaped like the web app's, under its own id", () => {
    const a = client(spec(3));
    const b = client(spec(4, { cellId: "bench-typist" }));
    link(a.doc, b.doc);
    a.createCell();
    b.createCell();
    a.sendEdit();
    const cells = a.doc.getMap<Y.Map<unknown>>("cells");
    expect([...cells.keys()].sort()).toEqual(["bench-typist", "load-3"]);
    const cell = cells.get("load-3")!;
    expect(cell.get("type")).toBe("sql");
    expect(cell.get("lastRunId")).toBeNull();
    // b created its cell after a's existed, so b's sorts after it.
    const order = (id: string) => cells.get(id)!.get("order") as string;
    expect(order("bench-typist") > order("load-3")).toBe(true);
    const text = cell.get("source") as Y.Text;
    expect(parseStamps(text.toString())).toEqual([{ sender: 3, seq: 0, sentAtUs: a.sends[0] }]);
  });

  it("sends its cursor in the exact shape the sync server accepts", () => {
    const a = client(spec(5));
    a.createCell();
    a.sendEdit();
    const cursor = JSON.parse(JSON.stringify(a.provider.awareness.getLocalState()?.cursor));
    for (const position of [cursor.anchor, cursor.head]) {
      expect(Object.keys(position).sort().join(",")).toBe("assoc,item,tname,type");
      expect(position.tname).toBeNull();
    }
  });
});
