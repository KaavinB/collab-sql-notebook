// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SessionGate } from "@/components/auth/SessionGate";
import { AcceptShareLink } from "@/components/sharing/AcceptShareLink";
import { ApiError, type AcceptedShareLink, type ApiClient } from "@/lib/api";
import { deferred, fakeApi, NOTEBOOK, SHARE_TOKEN, USER } from "@/test/fakeApi";

const replace = vi.fn();
let pathname = `/share/${SHARE_TOKEN}`;
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => pathname,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

beforeEach(() => {
  replace.mockReset();
  pathname = `/share/${SHARE_TOKEN}`;
});
afterEach(cleanup);

function renderPage(api: ReturnType<typeof fakeApi>, token = SHARE_TOKEN) {
  return render(
    <StrictMode>
      <SessionGate api={api}>
        <AcceptShareLink token={token} />
      </SessionGate>
    </StrictMode>,
  );
}

describe("AcceptShareLink", () => {
  it("accepts the link once, then opens the notebook in place of this page", async () => {
    const accepted = deferred<AcceptedShareLink>();
    const acceptShareLink = vi.fn<ApiClient["acceptShareLink"]>(() => accepted.promise);
    renderPage(fakeApi({ acceptShareLink }));
    expect(await screen.findByText("Opening the shared notebook…")).toBeTruthy();
    await act(async () => accepted.resolve({ notebook_id: NOTEBOOK.id, role: "viewer" }));
    // StrictMode runs the effect twice; the link is still accepted once.
    expect(acceptShareLink).toHaveBeenCalledTimes(1);
    expect(acceptShareLink).toHaveBeenCalledWith(SHARE_TOKEN);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith(`/notebooks/${NOTEBOOK.id}`);
  });

  it("shows why a link doesn't work, with a way home", async () => {
    const api = fakeApi({
      acceptShareLink: vi.fn(async () => {
        throw new ApiError(
          404,
          "not_found",
          "This share link doesn't work. It may have been revoked.",
        );
      }),
    });
    renderPage(api);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This share link doesn't work. It may have been revoked.",
    );
    expect(screen.getByRole("link", { name: "Go to your notebooks" }).getAttribute("href")).toBe(
      "/",
    );
    expect(replace).not.toHaveBeenCalled();
  });

  it("doesn't send something that can't be a token", async () => {
    const api = fakeApi();
    renderPage(api, "not a token!");
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This share link doesn't work. It may have been revoked.",
    );
    expect(api.acceptShareLink).not.toHaveBeenCalled();
  });

  it("asks a signed-out visitor to sign in first, then accepts", async () => {
    const api = fakeApi({
      me: vi.fn<ApiClient["me"]>(() =>
        Promise.reject(new ApiError(401, "unauthenticated", "Please sign in.")),
      ),
      providers: vi.fn<ApiClient["providers"]>(async () => ({
        providers: ["github"],
        dev_login: true,
      })),
    });
    renderPage(api);
    // A provider sign-in comes back to this very page.
    await screen.findByRole("link", { name: "Continue with GitHub" });
    expect(api.signInUrl).toHaveBeenCalledWith("github", `/share/${SHARE_TOKEN}`);
    expect(api.acceptShareLink).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Dev user name"), { target: { value: USER.name } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(`/notebooks/${NOTEBOOK.id}`));
    expect(api.acceptShareLink).toHaveBeenCalledTimes(1);
  });
});
