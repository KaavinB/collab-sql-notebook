"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";

import { cellsMap, orderedCells, type CellView } from "@/lib/notebook/doc";

/**
 * The notebook's cells in display order, re-rendering when cells are added,
 * removed, moved or re-pointed at a new run. Typing inside a cell changes
 * only its Y.Text, which the cell's own editor handles, so it doesn't
 * re-render the whole list.
 */
export function useCells(doc: Y.Doc): CellView[] {
  // The cached list, tagged with the doc it came from, so swapping in a
  // different doc never shows the previous doc's cells.
  const snapshot = useRef<{ doc: Y.Doc; cells: CellView[] } | null>(null);

  const subscribe = useCallback(
    (onChange: () => void) => {
      const cells = cellsMap(doc);
      const handler = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
        if (events.some((event) => !(event.target instanceof Y.Text))) {
          snapshot.current = null;
          onChange();
        }
      };
      cells.observeDeep(handler);
      // The structure may have changed between render and subscribe (in
      // Phase 2, a remote update can land then). Dropping the cache makes
      // React's post-subscribe check read fresh cells.
      snapshot.current = null;
      return () => cells.unobserveDeep(handler);
    },
    [doc],
  );

  const getSnapshot = useCallback(() => {
    if (snapshot.current?.doc !== doc) snapshot.current = { doc, cells: orderedCells(doc) };
    return snapshot.current.cells;
  }, [doc]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
