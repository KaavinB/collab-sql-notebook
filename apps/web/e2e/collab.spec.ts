import { expect, test } from "@playwright/test";

import { cellText, twoPeople } from "./helpers";

test("two editors type in the same cell at once and end up with the same text", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await expect(grace.locator(".cm-content")).toHaveCount(1); // the new cell arrived

    // Both type into the one cell at the same time.
    await ada.locator(".cm-content").first().click();
    await grace.locator(".cm-content").first().click();
    await Promise.all([
      ada.keyboard.type("select 1 as ada", { delay: 15 }),
      grace.keyboard.type(" -- grace", { delay: 15 }),
    ]);

    // Converged: identical, and nothing either typed was lost.
    await expect.poll(async () => (await cellText(ada)) === (await cellText(grace))).toBe(true);
    const merged = await cellText(ada);
    expect(merged.replace(/[^a-z1]/g, "").length).toBe("select1asada".length + "grace".length);

    // Each sees the other: in the presence list, and as a named cursor in the cell.
    for (const page of [ada, grace]) {
      await expect(
        page.getByRole("list", { name: "People in this notebook" }).locator("li"),
      ).toHaveCount(2);
    }
    await expect(ada.locator(".cm-ySelectionCaret")).toHaveCount(1);
    await expect(ada.locator(".cm-ySelectionInfo")).toHaveText(/^Grace/);
  } finally {
    await close();
  }
});

test("a run anyone starts is shown to everyone, and survives a reload", async ({ browser }) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.locator(".cm-content").first().click();
    await ada.keyboard.type("select count(*) as trips from trips");
    await expect.poll(() => cellText(grace)).toBe("select count(*) as trips from trips");

    // Both press Run at the same moment: one execution, one result for both.
    await Promise.all([
      ada.getByRole("button", { name: "Run" }).click(),
      grace.getByRole("button", { name: "Run" }).click(),
    ]);
    for (const page of [ada, grace]) {
      await expect(page.getByTestId("result-summary")).toContainText("1 row");
    }

    // The document (and the result it points at) is stored by the sync server.
    await grace.reload();
    await expect(grace.getByTestId("sync-status")).toHaveText("Live");
    await expect.poll(() => cellText(grace)).toBe("select count(*) as trips from trips");
    await expect(grace.getByTestId("result-summary")).toContainText("1 row");
  } finally {
    await close();
  }
});

test("a run one person starts shows as running for everyone, then its outcome", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.locator(".cm-content").first().click();
    // Long enough to watch: a cross join that runs until the query timeout.
    await ada.keyboard.type("select sum(a.passenger_count) from trips a, trips b");
    await expect.poll(() => cellText(grace)).toContain("trips b");
    await ada.getByRole("button", { name: "Run" }).click();

    // Grace never pressed Run: she learns of it through the API's NOTIFY,
    // the sync server and the shared document.
    await expect(grace.getByText(/^Running… \(started by Ada/)).toBeVisible();
    await expect(grace.getByRole("button", { name: "Running…" })).toBeDisabled();
    await expect(grace.getByText(/took longer than/)).toBeVisible({ timeout: 30_000 });
    await expect(grace.getByRole("button", { name: "Run" })).toBeEnabled();
  } finally {
    await close();
  }
});

test("a viewer sees edits live but can't change anything", async ({ browser }) => {
  const { ada, grace, close } = await twoPeople(browser, "viewer");
  try {
    await expect(grace.getByTestId("view-only")).toBeVisible();
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.locator(".cm-content").first().click();
    await ada.keyboard.type("select 42");
    await expect.poll(() => cellText(grace)).toBe("select 42");

    // The viewer's editor isn't editable, and there's nothing to press.
    await expect(grace.locator(".cm-content").first()).toHaveAttribute("contenteditable", "false");
    await expect(grace.getByRole("button", { name: "Run" })).toHaveCount(0);
    await expect(grace.getByRole("button", { name: "+ Query" })).toHaveCount(0);
  } finally {
    await close();
  }
});

test("removing a member closes their live connection", async ({ browser }) => {
  const { ada, grace, notebookId, close } = await twoPeople(browser, "editor");
  try {
    const members = await ada.request.get(
      `${process.env.E2E_API_URL}/notebooks/${notebookId}/members`,
    );
    const graceMember = ((await members.json()) as { user_id: string; role: string }[]).find(
      (member) => member.role === "editor",
    )!;
    await ada.request.delete(
      `${process.env.E2E_API_URL}/notebooks/${notebookId}/members/${graceMember.user_id}`,
      { headers: { Origin: process.env.E2E_WEB_URL! } },
    );
    await expect(grace.getByTestId("sync-banner")).toHaveText(
      "You no longer have access to this notebook.",
    );
    await expect(grace.getByRole("button", { name: "+ Query" })).toHaveCount(0);
  } finally {
    await close();
  }
});
