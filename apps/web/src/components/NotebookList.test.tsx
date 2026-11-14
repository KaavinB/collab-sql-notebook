// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NotebookList } from "@/components/NotebookList";
import { ApiError, type ApiClient, type Notebook } from "@/lib/api";
import { takeExampleMark } from "@/lib/notebook/example";
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

  it("starts the guided example: creates it and marks it to be filled in", async () => {
    api = fakeApi();
    render(<NotebookList />);
    fireEvent.click(screen.getByRole("button", { name: "Start with an example" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/notebooks/${NOTEBOOK.id}`));
    expect(api.createNotebook).toHaveBeenCalledWith("Example: NYC taxi trips");
    expect(takeExampleMark(NOTEBOOK.id)).toBe(true);
  });

  it("creates a blank notebook without asking for a name first", async () => {
    api = fakeApi();
    render(<NotebookList />);
    fireEvent.click(screen.getByRole("button", { name: "New blank notebook" }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(api.createNotebook).toHaveBeenCalledWith("Untitled notebook");
    expect(takeExampleMark(NOTEBOOK.id)).toBe(false);
  });

  it("says when you have no notebooks yet, and how to start", async () => {
    api = fakeApi({ listNotebooks: async () => [] });
    render(<NotebookList />);
    expect((await screen.findByText(/No notebooks yet/)).textContent).toMatch(/example/);
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

  it("labels notebooks shared with you and lets only the owner delete", async () => {
    const shared = (id: string, title: string, role: Notebook["role"]): Notebook => ({
      ...NOTEBOOK,
      id,
      title,
      role,
    });
    api = fakeApi({
      listNotebooks: async () => [
        NOTEBOOK,
        shared("8c7f1f8e-5d22-4b7e-8f3c-1f2e3d4c5b6a", "Team notes", "editor"),
        shared("9d8e2a9f-6e33-4c8f-9a4d-2a3b4c5d6e7f", "Read me", "viewer"),
      ],
    });
    render(<NotebookList />);
    await screen.findByRole("link", { name: "Team notes" });
    expect(screen.getAllByTestId("notebook-role").map((el) => el.textContent)).toEqual([
      "Can edit",
      "Can view",
    ]);
    expect(screen.getByRole("button", { name: `Delete ${NOTEBOOK.title}` })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete Team notes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Read me" })).toBeNull();
  });

  it("does nothing until the delete is confirmed", async () => {
    api = fakeApi();
    render(<NotebookList />);
    fireEvent.click(await screen.findByRole("button", { name: `Delete ${NOTEBOOK.title}` }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.deleteNotebook).not.toHaveBeenCalled();
  });
});
