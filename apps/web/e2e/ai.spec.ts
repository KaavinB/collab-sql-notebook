import { expect, test } from "@playwright/test";

import { cellText, twoPeople } from "./helpers";

/**
 * The AI assistant as a collaborator, through the real API, sync server and
 * browser. The API runs the deterministic fake model (AI_FAKE_MODEL, see
 * playwright.config.ts), which answers every question with this query.
 */
const FAKE_SQL = "SELECT count(*) AS trip_count FROM trips";

test("the AI's suggestion and presence reach everyone, and one person accepts it", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await expect(grace.locator(".cm-content")).toHaveCount(1);

    // "fake-slow" makes the fake take a moment, so the thinking state shows.
    await ada.getByLabel("Ask AI").fill("fake-slow how many trips are there?");
    await ada.getByRole("button", { name: "Ask AI" }).click();

    // Grace didn't ask, but sees the AI at work: its status, presence and cursor
    // (the fake takes 4 s, so these have that long to show up).
    await expect(grace.getByText(/^AI assistant is thinking….*asked by Ada/)).toBeVisible();
    await expect(grace.getByLabel(/^AI assistant/)).toBeVisible();
    await expect(grace.locator(".cm-ySelectionInfo", { hasText: "AI assistant" })).toHaveCount(1);

    // The suggestion arrives for both, with its SQL, as a suggestion only.
    for (const page of [ada, grace]) {
      await expect(page.getByTestId("ai-sql")).toHaveText(FAKE_SQL, { timeout: 10_000 });
    }
    expect(await cellText(ada)).toBe(""); // nothing applied yet

    // Grace accepts: the SQL becomes her edit, and the card goes away for everyone.
    await grace.getByRole("button", { name: "Accept", exact: true }).click();
    for (const page of [ada, grace]) {
      await expect.poll(() => cellText(page)).toBe(FAKE_SQL);
      await expect(page.getByRole("region", { name: "AI suggestion" })).toHaveCount(0);
    }
    // The AI leaves once it has nothing pending.
    await expect(grace.getByLabel(/^AI assistant/)).toHaveCount(0);

    // The accepted query runs like any other.
    await ada.getByRole("button", { name: "Run" }).click();
    await expect(grace.getByTestId("result-summary")).toContainText("1 row");
  } finally {
    await close();
  }
});

test("Fix with AI suggests a corrected query for a failed run, and rejecting leaves the cell alone", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.locator(".cm-content").first().click();
    await ada.keyboard.type("select no_such_column from trips");
    await ada.getByRole("button", { name: "Run" }).click();
    await expect(ada.getByText(/no_such_column/).last()).toBeVisible();

    await ada.getByRole("button", { name: "Fix with AI" }).click();
    for (const page of [ada, grace]) {
      await expect(page.getByTestId("ai-base-sql")).toHaveText("select no_such_column from trips");
      await expect(page.getByTestId("ai-sql")).toHaveText(FAKE_SQL);
    }
    await grace.getByRole("button", { name: "Reject" }).click();
    for (const page of [ada, grace]) {
      await expect(page.getByRole("region", { name: "AI suggestion" })).toHaveCount(0);
      expect(await cellText(page)).toBe("select no_such_column from trips");
    }
  } finally {
    await close();
  }
});

test("a viewer sees the AI's suggestion but can't ask it or decide", async ({ browser }) => {
  const { ada, grace, close } = await twoPeople(browser, "viewer");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.getByLabel("Ask AI").fill("how many trips are there?");
    await ada.getByRole("button", { name: "Ask AI" }).click();
    await expect(grace.getByTestId("ai-sql")).toHaveText(FAKE_SQL);
    await expect(grace.getByLabel("Ask AI")).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "Reject" })).toHaveCount(0);
  } finally {
    await close();
  }
});
