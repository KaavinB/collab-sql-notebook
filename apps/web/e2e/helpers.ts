import { expect, type Browser, type Page } from "@playwright/test";

// Set by playwright.config.ts, which starts the API on its own port.
export const API = process.env.E2E_API_URL!;
export const WEB = process.env.E2E_WEB_URL!;

/**
 * API calls made with the page's own request context, which shares the
 * browser's cookies: signing in here signs the page in too. State-changing
 * calls carry the web app's Origin, as the browser's would.
 */
export const api = {
  async signIn(page: Page, name = "E2E User") {
    const response = await page.request.post(`${API}/auth/dev-login`, {
      data: { name },
      headers: { Origin: WEB },
    });
    expect(response.ok()).toBe(true);
  },
  async createNotebook(page: Page, title: string): Promise<string> {
    const response = await page.request.post(`${API}/notebooks`, {
      data: { title },
      headers: { Origin: WEB },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).id as string;
  },
  async deleteNotebook(page: Page, id: string) {
    await page.request.delete(`${API}/notebooks/${id}`, { headers: { Origin: WEB } });
  },
  async shareLink(page: Page, notebookId: string, role: "editor" | "viewer"): Promise<string> {
    const response = await page.request.post(`${API}/notebooks/${notebookId}/share-links`, {
      data: { role },
      headers: { Origin: WEB },
    });
    expect(response.status()).toBe(201);
    return (await response.json()).token as string;
  },
};

export async function typeInLastEditor(page: Page, text: string) {
  const editor = page.locator(".cm-content").last();
  await editor.click();
  await page.keyboard.type(text);
}

/** Opens a notebook page and waits for the live document. */
export async function openNotebook(page: Page, notebookId: string) {
  await page.goto(`/notebooks/${notebookId}`);
  await expect(page.getByTestId("sync-status")).toHaveText("Live");
}

/**
 * The text of the page's first cell editor, as the document has it:
 * collaborators' cursors are drawn inline (a caret plus a name label), and an
 * empty editor shows a placeholder; neither is part of the text.
 */
export function cellText(page: Page, index = 0): Promise<string> {
  return page
    .locator(".cm-content")
    .nth(index)
    .evaluate((content) =>
      [...content.querySelectorAll(".cm-line")]
        .map((line) => {
          const copy = line.cloneNode(true) as Element;
          // Collaborators' carets and an empty editor's placeholder aren't text.
          copy
            .querySelectorAll(".cm-ySelectionCaret, .cm-placeholder")
            .forEach((node) => node.remove());
          return copy.textContent ?? "";
        })
        .join("\n"),
    );
}

/**
 * Two people, each in their own browser context (separate cookies, separate
 * tabs), on the same notebook through the real API and sync server.
 */
export async function twoPeople(browser: Browser, role: "editor" | "viewer") {
  const ada = await (await browser.newContext()).newPage();
  const grace = await (await browser.newContext()).newPage();
  await api.signIn(ada, `Ada ${Date.now()}`);
  await api.signIn(grace, `Grace ${Date.now()}`);
  const notebookId = await api.createNotebook(ada, `E2E collab ${Date.now()}`);
  const token = await api.shareLink(ada, notebookId, role);
  // Grace joins through the share link, which opens the notebook.
  await grace.goto(`/share/${token}`);
  await expect(grace).toHaveURL(new RegExp(`/notebooks/${notebookId}$`));
  await expect(grace.getByTestId("sync-status")).toHaveText("Live");
  await openNotebook(ada, notebookId);
  const close = async () => {
    await api.deleteNotebook(ada, notebookId);
    await ada.context().close();
    await grace.context().close();
  };
  return { ada, grace, notebookId, close };
}
