import { expect, test } from "@playwright/test";

import { api, cellText, openNotebook, twoPeople, typeInLastEditor } from "./helpers";

/**
 * The journeys of someone who has never written SQL: the guided example, a
 * question in plain English answered and run, a failed query explained and
 * fixed, a one-click chart and CSV, the data guide, and sharing. The API runs
 * the deterministic fake model (see playwright.config.ts), which answers every
 * question with this query.
 */
const FAKE_SQL = "SELECT count(*) AS trip_count FROM trips";

test("the guided example fills itself in, runs, and draws its chart, once", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Dev user name").fill(`Newcomer ${Date.now()}`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Start with an example" }).click();
  await expect(page).toHaveURL(/\/notebooks\/[0-9a-f-]{36}$/);
  const notebookId = page.url().split("/").pop()!;
  try {
    await expect(
      page.getByRole("heading", { name: "Welcome to your first notebook" }),
    ).toBeVisible();
    // The query ran by itself: one row per payment method, as words.
    const summary = page.getByTestId("result-summary");
    await expect(summary).toContainText("rows");
    const rows = Number((await summary.textContent())!.match(/^(\d+) rows/)![1]);
    await expect(page.getByRole("cell", { name: "Credit card" })).toBeVisible();
    // The chart draws that result: one bar per row.
    await expect(page.getByTestId("chart").locator(".mark-rect path")).toHaveCount(rows);

    // Reloading shows the same tour; it isn't added a second time.
    await expect(page.getByTestId("sync-status")).toHaveText("Live");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Welcome to your first notebook" })).toHaveCount(
      1,
    );
    await expect(page.locator("section[data-cell-id]")).toHaveCount(6);
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});

test("a question in plain English becomes an answer: ask, accept and run", async ({ page }) => {
  await api.signIn(page);
  const notebookId = await api.createNotebook(page, `E2E ask ${Date.now()}`);
  try {
    await openNotebook(page, notebookId);
    // An empty notebook asks for a question instead of showing a blank page.
    await page.getByLabel("Your question").fill("How many trips are there?");
    await page.getByLabel("Your question").press("Enter");
    await expect(page.getByTestId("ai-sql")).toHaveText(FAKE_SQL);
    expect(await cellText(page)).toBe(""); // only a suggestion so far
    await page.getByRole("button", { name: "Accept and run" }).click();
    await expect.poll(() => cellText(page)).toBe(FAKE_SQL);
    await expect(page.getByTestId("result-summary")).toContainText("1 row");
    await expect(page.getByRole("region", { name: "AI suggestion" })).toHaveCount(0);
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});

test("a failed query is explained in plain words, with the details and a fix", async ({ page }) => {
  await api.signIn(page);
  const notebookId = await api.createNotebook(page, `E2E error ${Date.now()}`);
  try {
    await openNotebook(page, notebookId);
    await page.getByRole("button", { name: "+ Query" }).click();
    await typeInLastEditor(page, "select pickup_zone from trips");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    const error = page.getByTestId("run-error");
    await expect(error.getByTestId("run-error-title")).toHaveText(
      "There's no column called “pickup_zone”.",
    );
    await expect(
      error.getByRole("listitem").filter({ hasText: "pickup_location_id" }),
    ).toBeVisible();
    // The database's own message is one click away.
    await expect(error.getByText(/Binder Error/)).toHaveCount(0);
    await error.getByText("Details").click();
    await expect(error.getByText(/Binder Error/)).toBeVisible();

    await error.getByRole("button", { name: "Fix with AI" }).click();
    await expect(page.getByTestId("ai-base-sql")).toHaveText("select pickup_zone from trips");
    await page.getByRole("button", { name: "Accept and run" }).click();
    await expect(page.getByTestId("result-summary")).toContainText("1 row");
    await expect(page.getByTestId("run-error")).toHaveCount(0);
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});

test("a result reads well, charts in one click and downloads as CSV", async ({ page }) => {
  await api.signIn(page);
  const notebookId = await api.createNotebook(page, `E2E result ${Date.now()}`);
  try {
    await openNotebook(page, notebookId);
    await page.getByRole("button", { name: "+ Query" }).click();
    await typeInLastEditor(
      page,
      "select date_trunc('day', pickup_at) as day, count(*) as trips, sum(total_amount) as revenue from trips where pickup_at < '2024-01-08' group by all order by day",
    );
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByTestId("result-summary")).toContainText("7 rows");
    // Dates, grouped numbers and dollars, not raw ISO strings and floats.
    const firstRow = page.getByRole("row").nth(1);
    await expect(firstRow.getByRole("cell").first()).toHaveText("Jan 1, 2024");
    await expect(firstRow.getByRole("cell").nth(1)).toHaveText(/^\d{1,3}(,\d{3})+$/);
    await expect(firstRow.getByRole("cell").nth(2)).toHaveText(/^\$[\d,]+\.\d{2}$/);

    await page.getByRole("button", { name: "Make a chart" }).click();
    await expect(page.locator("section[aria-label^='Chart cell 2']")).toBeVisible();
    await expect(page.getByLabel("Across (x axis)")).toHaveValue("day");
    await expect(page.getByLabel("Up (y axis)")).toHaveValue("trips");
    await expect(page.getByTestId("chart").locator(".mark-line path")).toHaveCount(1);

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});

test("the data guide explains the tables and asks its example questions", async ({ page }) => {
  await api.signIn(page);
  const notebookId = await api.createNotebook(page, `E2E guide ${Date.now()}`);
  try {
    await openNotebook(page, notebookId);
    await page.getByRole("button", { name: "About the data" }).click();
    const guide = page.getByRole("dialog", { name: "About the data" });
    await expect(guide.getByText("payment_type", { exact: true })).toBeVisible();
    await guide.getByRole("button", { name: "Which pickup zones are the busiest?" }).click();
    await expect(guide).toHaveCount(0);
    await expect(page.getByTestId("ai-sql")).toHaveText(FAKE_SQL);
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});

test("sharing: a link with copy feedback, and a viewer who's told what they can do", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "viewer");
  try {
    await ada.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await ada.getByRole("button", { name: "Share" }).click();
    const dialog = ada.getByRole("dialog");
    await expect(dialog.getByText("Anyone with the link can")).toBeVisible();
    await dialog.getByRole("button", { name: "Create link" }).click();
    await dialog.getByRole("button", { name: "Copy link" }).click();
    await expect(dialog.getByRole("status")).toHaveText(/Link copied/);
    await expect(dialog.getByRole("list", { name: "Members" })).toContainText("Can view");
    await ada.keyboard.press("Escape");
    await expect(ada.getByRole("dialog")).toHaveCount(0);

    // The viewer sees an explanation and the AI's suggestions, but no way to act on them.
    await expect(grace.getByTestId("viewer-note")).toBeVisible();
    await ada.getByRole("button", { name: "Ask a question" }).click();
    await ada.getByLabel("Ask AI").fill("how many trips?");
    await ada.getByLabel("Ask AI").press("Enter");
    await expect(grace.getByTestId("ai-sql")).toHaveText(FAKE_SQL);
    await expect(grace.getByRole("button", { name: /Accept/ })).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Make a chart" })).toHaveCount(0);
  } finally {
    await close();
  }
});
