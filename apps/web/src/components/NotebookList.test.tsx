// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookList } from "@/components/NotebookList";
import { ApiError, type ApiClient, type Notebook } from "@/lib/api";
import { deferred, fakeApi, NOTEBOOK } from "@/test/fakeApi";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

let api: ReturnType<typeof fakeApi>;
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, createApiClient: () => api };
});

beforeEach(() => push.mockReset());
afterEach(cleanup);

describe("NotebookList", () => {
  it("creates one notebook even if Create is pressed twice", async () => {
    const created = deferred<Notebook>();
    const createNotebook = vi.fn<ApiClient["createNotebook"]>(() => created.promise);
    api = fakeApi({ createNotebook });
    render(<NotebookList />);
    fireEvent.change(screen.getByLabelText("New notebook title"), { target: { value: "Tips" } });
    const create = screen.getByRole("button", { name: "Create" });
    fireEvent.click(create);
    fireEvent.click(create);
    fireEvent.submit(create.closest("form")!);
    await act(async () => created.resolve(NOTEBOOK));
    expect(createNotebook).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(`/notebooks/${NOTEBOOK.id}`);
  });

  it("lets you try again after a failed create", async () => {
    const createNotebook = vi
      .fn<ApiClient["createNotebook"]>()
      .mockRejectedValueOnce(new ApiError(503, "unavailable", "The database is not configured."))
      .mockResolvedValueOnce(NOTEBOOK);
    api = fakeApi({ createNotebook });
    render(<NotebookList />);
    fireEvent.change(screen.getByLabelText("New notebook title"), { target: { value: "Tips" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The database is not configured.");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("deletes after confirmation, and clears an earlier error", async () => {
    const deleteNotebook = vi
      .fn<ApiClient["deleteNotebook"]>()
      .mockRejectedValueOnce(new ApiError(0, "network", "Could not reach the server."))
      .mockResolvedValueOnce(undefined);
    api = fakeApi({ deleteNotebook });
    render(<NotebookList />);
    const deleteButton = await screen.findByRole("button", { name: `Delete ${NOTEBOOK.title}` });

    fireEvent.click(deleteButton);
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the server.");
    expect(screen.getByRole("link", { name: NOTEBOOK.title })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Delete ${NOTEBOOK.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.queryByRole("link", { name: NOTEBOOK.title })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(deleteNotebook).toHaveBeenCalledTimes(2);
  });

  it("does nothing until the delete is confirmed", async () => {
    api = fakeApi();
    render(<NotebookList />);
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${NOTEBOOK.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.deleteNotebook).not.toHaveBeenCalled();
  });
});
