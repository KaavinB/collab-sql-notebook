// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SharePanel } from "@/components/sharing/SharePanel";
import { ApiError, type ApiClient, type Member, type Notebook, type ShareLink } from "@/lib/api";
import { fakeApi, NOTEBOOK, SHARE_TOKEN, USER } from "@/test/fakeApi";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  replace.mockReset();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(cleanup);

const ED: Member = { user_id: "8c7f1f8e-5d22-4b7e-8f3c-1f2e3d4c5b6a", name: "Ed", role: "editor" };
const VERA: Member = {
  user_id: "9d8e2a9f-6e33-4c8f-9a4d-2a3b4c5d6e7f",
  name: "Vera",
  role: "viewer",
};
const OWNER: Member = { user_id: USER.id, name: USER.name, role: "owner" };
const LINK: ShareLink = {
  id: "2b1f8a52-8a8e-4f43-9e0e-5d2f7f0c1a11",
  role: "viewer",
  created_at: "2026-11-13T07:00:00Z",
};

function open(api: ReturnType<typeof fakeApi>, notebook: Notebook = NOTEBOOK) {
  render(<SharePanel api={api} notebook={notebook} />);
  const toggle = screen.getByRole("button", {
    name: notebook.role === "owner" ? "Share" : "Members",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
}

describe("SharePanel for the owner", () => {
  it("loads nothing until opened", () => {
    const api = fakeApi();
    render(<SharePanel api={api} notebook={NOTEBOOK} />);
    expect(api.listMembers).not.toHaveBeenCalled();
    expect(api.listShareLinks).not.toHaveBeenCalled();
  });

  it("opens as a dialog that Escape and the close button close", async () => {
    open(fakeApi());
    expect(screen.getByRole("dialog", { name: `Share “${NOTEBOOK.title}”` })).toBeTruthy();
    await screen.findByRole("button", { name: "Create link" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says in words what each kind of link allows", async () => {
    open(fakeApi());
    const role = await screen.findByLabelText<HTMLSelectElement>("Role for the new link");
    expect([...role.options].map((o) => o.textContent)).toEqual(["edit", "view"]);
    expect(screen.getByText(/Viewers see everything live/)).toBeTruthy();
    fireEvent.change(role, { target: { value: "editor" } });
    expect(screen.getByText(/Editors can change cells/)).toBeTruthy();
  });

  it("creates a link and shows its full URL once, with a Copy button", async () => {
    const api = fakeApi({ listMembers: async () => [OWNER] });
    open(api);
    fireEvent.change(await screen.findByLabelText("Role for the new link"), {
      target: { value: "editor" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    const url = `${window.location.origin}/share/${SHARE_TOKEN}`;
    const field = await screen.findByLabelText<HTMLInputElement>("New share link");
    expect(field.value).toBe(url);
    expect(field.readOnly).toBe(true);
    expect(api.createShareLink).toHaveBeenCalledWith(NOTEBOOK.id, "editor");
    expect(screen.getByText(/won.t be shown again/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/^Link copied/);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(url);
    // The new link is listed (without its token) for revoking later.
    const listed = screen.getByRole("list", { name: "Active share links" });
    expect(within(listed).getByText(/^Anyone with this link can edit, created/)).toBeTruthy();
    expect(listed.textContent).not.toContain(SHARE_TOKEN);
  });

  it("says so when copying fails", async () => {
    writeText.mockRejectedValue(new Error("denied"));
    open(fakeApi());
    fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect((await screen.findByRole("status")).textContent).toMatch(/Couldn.t copy/);
  });

  it("lists and revokes links", async () => {
    const api = fakeApi({ listShareLinks: async () => [LINK] });
    open(api);
    const revoke = await screen.findByRole("button", {
      name: /^Revoke link: Anyone with this link can view/,
    });
    fireEvent.click(revoke);
    await waitFor(() => expect(screen.getByText("No active links.")).toBeTruthy());
    expect(api.revokeShareLink).toHaveBeenCalledWith(NOTEBOOK.id, LINK.id);
  });

  it("changes a member's role and removes members, but never the owner", async () => {
    const api = fakeApi({ listMembers: async () => [OWNER, ED, VERA] });
    open(api);
    const role = await screen.findByLabelText<HTMLSelectElement>("Role for Vera");
    expect(role.value).toBe("viewer");
    fireEvent.change(role, { target: { value: "editor" } });
    await waitFor(() => expect(role.value).toBe("editor"));
    expect(api.updateMember).toHaveBeenCalledWith(NOTEBOOK.id, VERA.user_id, "editor");

    fireEvent.click(screen.getByRole("button", { name: "Remove Ed" }));
    await waitFor(() => expect(screen.queryByText("Ed")).toBeNull());
    expect(api.removeMember).toHaveBeenCalledWith(NOTEBOOK.id, ED.user_id);

    expect(screen.queryByLabelText(`Role for ${USER.name}`)).toBeNull();
    expect(screen.queryByRole("button", { name: `Remove ${USER.name}` })).toBeNull();
    expect(screen.getByText(`${USER.name} (you)`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Leave notebook" })).toBeNull();
  });

  it("shows the API's message when a change fails", async () => {
    const api = fakeApi({
      listMembers: async () => [OWNER, ED],
      removeMember: vi.fn<ApiClient["removeMember"]>(async () => {
        throw new ApiError(404, "not_found", "Member not found.");
      }),
    });
    open(api);
    fireEvent.click(await screen.findByRole("button", { name: "Remove Ed" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Member not found.");
    expect(screen.getByText("Ed")).toBeTruthy();
  });
});

describe("SharePanel for other members", () => {
  const shared: Notebook = { ...NOTEBOOK, role: "editor" };
  const me: Member = { user_id: USER.id, name: USER.name, role: "editor" };

  it("shows the members and no link or role controls", async () => {
    const api = fakeApi({
      listMembers: async () => [{ ...OWNER, user_id: ED.user_id, name: "Olive" }, me, VERA],
    });
    open(api, shared);
    await screen.findByText(`${USER.name} (you)`);
    expect(screen.getAllByTestId("member-role").map((el) => el.textContent)).toEqual([
      "Owner",
      "Can edit",
      "Can view",
    ]);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Create link" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
    expect(api.listShareLinks).not.toHaveBeenCalled();
  });

  it("leaves after confirming, then goes home", async () => {
    const api = fakeApi({ listMembers: async () => [me] });
    open(api, shared);
    fireEvent.click(await screen.findByRole("button", { name: "Leave notebook" }));
    expect(api.removeMember).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm leave" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
    expect(api.removeMember).toHaveBeenCalledWith(NOTEBOOK.id, USER.id);
  });
});
