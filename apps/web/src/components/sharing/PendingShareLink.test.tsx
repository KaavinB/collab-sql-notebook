// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGate } from "@/components/auth/SessionGate";
import { AcceptShareLink } from "@/components/sharing/AcceptShareLink";
import { PendingShareLink, RememberShareLink } from "@/components/sharing/PendingShareLink";
import { ApiError, type AcceptedShareLink, type ApiClient } from "@/lib/api";
import { pendingShareToken } from "@/lib/pendingShare";
import { deferred, fakeApi, NOTEBOOK, SHARE_TOKEN } from "@/test/fakeApi";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => `/share/${SHARE_TOKEN}`,
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  replace.mockReset();
});

const signedOut = () => Promise.reject(new ApiError(401, "unauthenticated", "Please sign in."));

describe("share links and sign-in", () => {
  it("signs in through /share, never with the token in the URL", async () => {
    const api = fakeApi({
      me: vi.fn<ApiClient["me"]>(signedOut),
      providers: vi.fn<ApiClient["providers"]>(async () => ({
        providers: ["github"],
        dev_login: false,
      })),
    });
    render(
      <>
        <RememberShareLink token={SHARE_TOKEN} />
        <SessionGate api={api} signInNext="/share">
          <AcceptShareLink token={SHARE_TOKEN} />
        </SessionGate>
      </>,
    );
    const link = await screen.findByRole("link", { name: "Continue with GitHub" });
    expect(link.getAttribute("href")).toBe("http://api.test/auth/github/login?next=%2Fshare");
    expect(link.getAttribute("href")).not.toContain(SHARE_TOKEN);
    expect(pendingShareToken()).toBe(SHARE_TOKEN);
  });

  it("finishes joining on /share with the remembered token, then forgets it", async () => {
    sessionStorage.setItem("notebook.pendingShareToken", SHARE_TOKEN);
    const api = fakeApi();
    render(
      <SessionGate api={api} signInNext="/share">
        <PendingShareLink />
      </SessionGate>,
    );
    await act(async () => {});
    expect(api.acceptShareLink).toHaveBeenCalledWith(SHARE_TOKEN);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith(`/notebooks/${NOTEBOOK.id}`));
    expect(pendingShareToken()).toBeNull();
  });

  it("asks to open the link again when nothing was remembered", async () => {
    render(
      <SessionGate api={fakeApi()} signInNext="/share">
        <PendingShareLink />
      </SessionGate>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/Open the share link again/);
  });

  it("never answers a new token with an older token's request", async () => {
    const first = deferred<AcceptedShareLink>();
    const acceptShareLink = vi
      .fn<ApiClient["acceptShareLink"]>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({
        notebook_id: "8f0e5d51-8a0b-4d77-9a8e-0b1d2c3e4f50",
        role: "viewer",
      });
    const api = fakeApi({ acceptShareLink });
    const other = "B".repeat(43);
    const view = render(
      <SessionGate api={api}>
        <AcceptShareLink token={SHARE_TOKEN} />
      </SessionGate>,
    );
    await act(async () => {});
    view.rerender(
      <SessionGate api={api}>
        <AcceptShareLink token={other} />
      </SessionGate>,
    );
    await act(async () => {});
    expect(acceptShareLink).toHaveBeenLastCalledWith(other);
    await vi.waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/notebooks/8f0e5d51-8a0b-4d77-9a8e-0b1d2c3e4f50"),
    );
  });
});
