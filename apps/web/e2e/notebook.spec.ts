import { expect, test, type Page } from "@playwright/test";

// Set by playwright.config.ts, which starts the API on its own port.
const API = process.env.E2E_API_URL!;

async function typeInLastEditor(page: Page, text: string) {
  const editor = page.locator(".cm-content").last();
  await editor.click();
  await page.keyboard.type(text);
}

test("create a notebook, run SQL, write markdown, and find it all after a reload", async ({
  page,
  request,
}) => {
  const title = `E2E ${Date.now()}`;
  await page.goto("/");
  await page.getByLabel("New notebook title").fill(title);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page).toHaveURL(/\/notebooks\/[0-9a-f-]{36}$/);
  const notebookId = page.url().split("/").pop()!;

  try {
    await expect(page.getByLabel("Notebook title")).toHaveValue(title);

    // Rename the notebook (saved on Enter/blur).
    const renamed = `${title} (renamed)`;
    await page.getByLabel("Notebook title").fill(renamed);
    await page.getByLabel("Notebook title").press("Enter");

    // A SQL cell against the real taxi data.
    await page.getByRole("button", { name: "+ SQL" }).click();
    await typeInLastEditor(page, "select count(*) as trips from trips where payment_type = 2");
    await page.getByRole("button", { name: "Run" }).click();
    const sqlCell = page.locator("section", { hasText: "sql" }).first();
    await expect(sqlCell.getByRole("columnheader", { name: /trips/ })).toBeVisible();
    await expect(sqlCell.getByTestId("result-summary")).toContainText("1 row");

    // A rejected statement is stored and shown as an error.
    await page.getByRole("button", { name: "+ SQL" }).click();
    await typeInLastEditor(page, "drop table trips");
    await page.keyboard.press("ControlOrMeta+Enter");
    await expect(page.getByText("Not allowed: Only SELECT queries are allowed.")).toBeVisible();

    // A markdown cell, rendered after editing.
    await page.getByRole("button", { name: "+ Markdown" }).click();
    await typeInLastEditor(page, "# Payment types\n\nCash trips only.");
    await page.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("heading", { name: "Payment types" })).toBeVisible();

    // Reorder: move the markdown cell to the top.
    const markdownCell = page.locator("section[aria-label^='markdown cell']");
    await markdownCell.getByRole("button", { name: "Move cell up" }).click();
    await markdownCell.getByRole("button", { name: "Move cell up" }).click();
    await expect(page.locator("section").first()).toHaveAttribute("aria-label", /^markdown cell 1/);

    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });

    // Everything survives a reload: text, order, and the stored results.
    await page.reload();
    await expect(page.locator("section").first()).toHaveAttribute("aria-label", /^markdown cell 1/);
    await expect(page.getByRole("heading", { name: "Payment types" })).toBeVisible();
    await expect(
      page.getByText("select count(*) as trips from trips where payment_type = 2"),
    ).toBeVisible();
    await expect(page.getByTestId("result-summary").first()).toContainText("1 row");
    await expect(page.getByText("Not allowed: Only SELECT queries are allowed.")).toBeVisible();

    await expect(page.getByLabel("Notebook title")).toHaveValue(renamed);

    // Delete a cell (two clicks), and the deletion is saved too.
    const lastSql = page.locator("section[aria-label^='sql cell 3']");
    await lastSql.getByRole("button", { name: "Delete cell" }).click();
    await lastSql.getByRole("button", { name: "Confirm delete cell" }).click();
    await expect(page.locator("section")).toHaveCount(2);
    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
    await page.reload();
    await expect(page.locator("section")).toHaveCount(2);

    // Delete the notebook from the list.
    await page.getByRole("link", { name: "← Notebooks" }).click();
    const row = page.getByRole("listitem").filter({ hasText: renamed });
    await row.getByRole("button", { name: `Delete ${renamed}` }).click();
    await row.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("link", { name: renamed })).toHaveCount(0);
    expect((await request.get(`${API}/notebooks/${notebookId}`)).status()).toBe(404);
  } finally {
    await request.delete(`${API}/notebooks/${notebookId}`);
  }
});

test("an unknown notebook shows an error with a way back", async ({ page }) => {
  await page.goto("/notebooks/00000000-0000-4000-8000-000000000000");
  // Next.js adds its own (empty) role="alert" route announcer, so match the text.
  await expect(page.getByRole("alert").filter({ hasText: "Notebook not found." })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to notebooks" })).toBeVisible();
});

test("chart a SQL cell's result, and the chart survives a reload", async ({ page, request }) => {
  const created = await request.post(`${API}/notebooks`, {
    data: { title: `E2E chart ${Date.now()}` },
  });
  const notebookId = (await created.json()).id as string;
  try {
    await page.goto(`/notebooks/${notebookId}`);
    await page.getByRole("button", { name: "+ SQL" }).click();
    await typeInLastEditor(
      page,
      "select payment_type, count(*) as trips from trips group by all order by payment_type",
    );
    await page.getByRole("button", { name: "Run" }).click();
    const summary = page.getByTestId("result-summary");
    await expect(summary).toContainText("rows");
    const rows = Number((await summary.textContent())!.match(/^(\d+) rows/)![1]);

    await page.getByRole("button", { name: "+ Chart" }).click();
    await expect(page.getByTestId("chart-hint")).toHaveText("Choose a SQL cell to chart.");
    await page.getByLabel("Chart data").selectOption({ index: 1 });
    await page.getByLabel("Chart x").selectOption("payment_type");
    await page.getByLabel("Chart y").selectOption("trips");
    const bars = page.getByTestId("chart").locator(".mark-rect path");
    await expect(bars).toHaveCount(rows);

    await expect(page.getByTestId("save-status")).toHaveText("Saved", { timeout: 10_000 });
    await page.reload();
    await expect(page.getByLabel("Chart x")).toHaveValue("payment_type");
    await expect(page.getByTestId("chart").locator(".mark-rect path")).toHaveCount(rows);
  } finally {
    await request.delete(`${API}/notebooks/${notebookId}`);
  }
});

test("a bar chart over daily timestamps draws visible bars", async ({ page, request }) => {
  const created = await request.post(`${API}/notebooks`, {
    data: { title: `E2E daily ${Date.now()}` },
  });
  const notebookId = (await created.json()).id as string;
  try {
    await page.goto(`/notebooks/${notebookId}`);
    await page.getByRole("button", { name: "+ SQL" }).click();
    // date_trunc returns TIMESTAMP: the most common time chart.
    await typeInLastEditor(
      page,
      "select date_trunc('day', pickup_at) as day, count(*) as trips from trips where pickup_at < '2024-02-01' group by all order by day",
    );
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("result-summary")).toContainText("31 rows");
    await page.getByRole("button", { name: "+ Chart" }).click();
    await page.getByLabel("Chart data").selectOption({ index: 1 });
    await page.getByLabel("Chart x").selectOption("day");
    await page.getByLabel("Chart y").selectOption("trips");
    const bars = page.getByTestId("chart").locator(".mark-rect path");
    await expect(bars).toHaveCount(31);
    const widths = await bars.evaluateAll((paths) =>
      paths.map((path) => (path as SVGGraphicsElement).getBBox().width),
    );
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1);
  } finally {
    await request.delete(`${API}/notebooks/${notebookId}`);
  }
});

test("chart tooltips show image URLs as text without requesting them", async ({
  page,
  request,
}) => {
  const created = await request.post(`${API}/notebooks`, {
    data: { title: `E2E tooltip ${Date.now()}` },
  });
  expect(created.status()).toBe(201);
  const notebookId = (await created.json()).id as string;
  const url = "https://tracker.example/pixel.png";
  const trackerRequests: string[] = [];
  // Intercept the host so a regression can never send a real tracking request.
  await page.route("https://tracker.example/**", async (route) => {
    trackerRequests.push(route.request().url());
    await route.abort();
  });
  try {
    await page.goto(`/notebooks/${notebookId}`);
    await page.getByRole("button", { name: "+ SQL" }).click();
    await typeInLastEditor(page, `select '${url}' as image, 10 as title`);
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.getByTestId("result-summary")).toContainText("1 row");
    await page.getByRole("button", { name: "+ Chart" }).click();
    await page.getByLabel("Chart data").selectOption({ index: 1 });
    await page.getByLabel("Chart x").selectOption("image");
    await page.getByLabel("Chart y").selectOption("title");
    const bar = page.getByTestId("chart").locator(".mark-rect path");
    await expect(bar).toHaveCount(1);
    await bar.hover();
    const tooltip = page.locator("#vg-tooltip-element");
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText(url);
    await expect(tooltip.locator("img, iframe, script")).toHaveCount(0);
    expect(trackerRequests).toEqual([]);
  } finally {
    await request.delete(`${API}/notebooks/${notebookId}`);
  }
});
