/**
 * The "Start with an example" notebook: a short guided tour written into a
 * new, empty notebook's shared document by the browser that created it.
 *
 * Creating the notebook (API) and writing its first cells (Yjs, through the
 * sync server) are separate steps, so the home page marks the new notebook
 * and the notebook page seeds it once it's live. The mark lives in this
 * page's memory, not in sessionStorage: the home page moves to the notebook
 * with a client-side navigation, so the mark is still there, while a
 * duplicated tab (which copies sessionStorage) or a reload starts without it
 * and can't seed a second tour. Seeding also only happens into an empty
 * document, so a collaborator who got there first never gets it twice.
 */
import * as Y from "yjs";

import { writeChartConfig } from "@/lib/notebook/chart";
import { chartMap, insertCell, orderedCells } from "@/lib/notebook/doc";

export const EXAMPLE_TITLE = "Example: NYC taxi trips";

const marked = new Set<string>();

/** Marks a just-created notebook to be filled with the tour when it opens. */
export function markExampleNotebook(notebookId: string): void {
  marked.add(notebookId);
}

/** Whether this page should seed the notebook; true at most once per mark. */
export function takeExampleMark(notebookId: string): boolean {
  return marked.delete(notebookId);
}

const INTRO = `# Welcome to your first notebook

This notebook explores **New York City yellow taxi trips** from January to March 2024. It's made of blocks called *cells*:

- **Text cells**, like this one, explain things.
- **Query cells** answer a question about the data. Type your question in plain English and the AI assistant writes the query (in SQL, the language databases understand). You can also write SQL yourself.
- **Chart cells** draw a query's answer.

Anyone you share this notebook with sees the same cells and answers, live.`;

const QUESTION = `## Question: how do riders pay?

The query below counts trips by payment method and works out the average tip. In the raw data, payment methods are numbers (1 is card, 2 is cash); the query turns them into words. Press **Run** to run it again, or edit it and see what changes.`;

export const EXAMPLE_SQL = `-- How do riders pay? Trips and average tip per payment method.
select
  case payment_type
    when 1 then 'Credit card'
    when 2 then 'Cash'
    when 3 then 'No charge'
    when 4 then 'Dispute'
    when 5 then 'Unknown'
    when 6 then 'Voided trip'
    else 'Not recorded'
  end as payment_method,
  count(*) as trips,
  round(avg(tip_amount), 2) as average_tip
from trips
group by all
order by trips desc`;

const CHART_NOTE = `The chart below draws the number of trips from the answer above. In the table, notice the average tip for cash: tips are only recorded when paid by card.`;

const YOUR_TURN = `## Your turn

Click **Ask a question** at the bottom, or open **About the data** at the top to see what's in each table and try an example question.`;

/**
 * Writes the tour into an empty document, in one transaction (collaborators
 * see it arrive at once). Returns the IDs of the query cells to run, or an
 * empty list if the document already had cells.
 */
export function seedExample(doc: Y.Doc): string[] {
  if (orderedCells(doc).length > 0) return [];
  let sqlId = "";
  doc.transact(() => {
    const intro = insertCell(doc, "markdown", null);
    textOf(doc, intro).insert(0, INTRO);
    const question = insertCell(doc, "markdown", intro);
    textOf(doc, question).insert(0, QUESTION);
    sqlId = insertCell(doc, "sql", question);
    textOf(doc, sqlId).insert(0, EXAMPLE_SQL);
    const note = insertCell(doc, "markdown", sqlId);
    textOf(doc, note).insert(0, CHART_NOTE);
    const chart = insertCell(doc, "chart", note);
    writeChartConfig(chartMap(doc, chart)!, {
      source: sqlId,
      mark: "bar",
      x: "payment_method",
      y: "trips",
    });
    const end = insertCell(doc, "markdown", chart);
    textOf(doc, end).insert(0, YOUR_TURN);
  });
  return [sqlId];
}

function textOf(doc: Y.Doc, id: string): Y.Text {
  const text = orderedCells(doc).find((cell) => cell.id === id)?.source;
  if (!text) throw new Error(`no text in cell ${id}`);
  return text;
}
