import { expect, test, type Page } from "@playwright/test";

import { api, cellText, openNotebook, twoPeople, typeInLastEditor } from "./helpers";

/** Waits until the sync server has confirmed every edit this page made. */
async function confirmed(page: Page) {
  await expect(page.getByTestId("sync-status")).toHaveText("Live");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-confirmed", "true");
}

/**
 * A switch for the page's network. context.setOffline alone isn't enough:
 * in Chromium it doesn't cut a WebSocket that's already open. So, going
 * offline also (1) refuses every new sync socket the page opens, through a
 * WebSocket route, and (2) fires the window's "offline" event, which the app
 * answers by dropping its socket (the path a real network loss takes in
 * browsers that report it). Going online lifts both and fires "online",
 * which reconnects at once.
 */
async function networkSwitch(page: Page) {
  let offline = false;
  await page.routeWebSocket(
    (url) => url.pathname.startsWith("/notebooks/"),
    (ws) => {
      // 1011: a server-side failure, after which the provider retries.
      if (offline) void ws.close({ code: 1011, reason: "offline (test)" });
      else ws.connectToServer();
    },
  );
  const fire = (name: "offline" | "online") =>
    page.evaluate((event) => window.dispatchEvent(new Event(event)), name);
  return {
    async goOffline() {
      offline = true;
      await page.context().setOffline(true);
      await fire("offline");
    },
    async goOnline() {
      offline = false;
      await page.context().setOffline(false);
      await fire("online");
    },
  };
}

test("an editor keeps working offline while another edits the same cell, and both converge", async ({
  browser,
}) => {
  const { ada, grace, close } = await twoPeople(browser, "editor");
  try {
    const network = await networkSwitch(ada);
    await ada.getByRole("button", { name: "+ Query" }).click();
    await ada.locator(".cm-content").first().click();
    await ada.keyboard.type("select 1");
    await expect.poll(() => cellText(grace)).toBe("select 1");
    await confirmed(ada);

    // Ada loses her connection. She keeps typing in the cell and adds a cell.
    await network.goOffline();
    await expect(ada.getByTestId("sync-status")).toHaveText(/^Offline/);
    await ada.locator(".cm-content").first().click();
    await ada.keyboard.press("End");
    await ada.keyboard.type(" as ada");
    await ada.getByRole("button", { name: "+ Query" }).click();
    await typeInLastEditor(ada, "select 'written offline'");
    await expect(ada.getByTestId("sync-banner")).toHaveText(/^Offline\. Unsynced edits/);

    // Meanwhile Grace edits the same cell, and sees none of Ada's offline work.
    await grace.locator(".cm-content").first().click();
    await grace.keyboard.press("Home");
    await grace.keyboard.type("/* grace */ ");
    await expect.poll(() => cellText(grace)).toBe("/* grace */ select 1");
    await expect(grace.locator(".cm-content")).toHaveCount(1);

    // Ada comes back: the edits merge both ways.
    await network.goOnline();
    await confirmed(ada);
    for (const page of [ada, grace]) await expect(page.locator(".cm-content")).toHaveCount(2);
    await expect.poll(() => cellText(grace)).toBe("/* grace */ select 1 as ada");
    await expect.poll(() => cellText(ada)).toBe("/* grace */ select 1 as ada");
    await expect.poll(() => cellText(grace, 1)).toBe("select 'written offline'");
    expect(await cellText(ada, 1)).toBe("select 'written offline'");

    // The server stored the merged document: a reload shows it.
    await grace.reload();
    await expect(grace.getByTestId("sync-status")).toHaveText("Live");
    await expect.poll(() => cellText(grace)).toBe("/* grace */ select 1 as ada");
    await expect.poll(() => cellText(grace, 1)).toBe("select 'written offline'");
  } finally {
    await close();
  }
});

test("reloading while offline with unsynced edits asks first", async ({ page }) => {
  await api.signIn(page);
  const notebookId = await api.createNotebook(page, `E2E offline reload ${Date.now()}`);
  try {
    const network = await networkSwitch(page);
    await openNotebook(page, notebookId);
    await page.getByRole("button", { name: "+ Query" }).click();
    await typeInLastEditor(page, "select 1");
    await confirmed(page);

    await network.goOffline();
    await expect(page.getByTestId("sync-status")).toHaveText(/^Offline/);
    await page.keyboard.type(" -- offline");
    await expect(page.getByTestId("sync-banner")).toHaveText(/^Offline\. Unsynced edits/);

    // The browser asks before leaving; staying keeps the edits on screen.
    const dialog = page.waitForEvent("dialog");
    // Not page.reload(): it would wait for a navigation that never happens
    // once the dialog is dismissed.
    void page.evaluate(() => location.reload()).catch(() => {});
    const asked = await dialog;
    expect(asked.type()).toBe("beforeunload");
    await asked.dismiss();
    await expect(page.getByTestId("sync-banner")).toHaveText(/^Offline\. Unsynced edits/);
    expect(await cellText(page)).toBe("select 1 -- offline");

    // Back online, the edits reach the server, and a reload no longer asks.
    await network.goOnline();
    await confirmed(page);
    let askedAgain = false;
    page.on("dialog", (again) => {
      askedAgain = true;
      void again.accept();
    });
    await page.reload();
    await expect(page.getByTestId("sync-status")).toHaveText("Live");
    expect(askedAgain).toBe(false);
    await expect.poll(() => cellText(page)).toBe("select 1 -- offline");
  } finally {
    await api.deleteNotebook(page, notebookId);
  }
});
