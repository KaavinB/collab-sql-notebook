// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionGate, useSession } from "@/components/auth/SessionGate";
import { appendCell } from "@/lib/notebook/doc";
import { openConnection, resetConnections } from "@/lib/notebook/connections";
import { fakeProviders } from "@/test/fakeSync";
import { ApiError, type ApiClient } from "@/lib/api";
import { deferred, fakeApi, NOTEBOOK, USER } from "@/test/fakeApi";

vi.mock("next/navigation", () => ({ usePathname: () => "/notebooks/abc" }));

afterEach(() => {
  cleanup();
  resetConnections();
  window.history.replaceState(null, "", "/");
});

const signedOut = () => Promise.reject(new ApiError(401, "unauthenticated", "Please sign in."));

function Who() {
  return <p>Hello {useSession().user.name}</p>;
}

describe("SessionGate", () => {
  it("shows its children with the signed-in user", async () => {
    render(
      <SessionGate api={fakeApi()}>
        <Who />
      </SessionGate>,
    );
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
    expect(screen.getByTestId("signed-in-as").textContent).toBe("Ada");
  });

  it("shows the sign-in page, with links back to this page, when signed out", async () => {
    const api = fakeApi({
      me: vi.fn<ApiClient["me"]>(signedOut),
      providers: vi.fn<ApiClient["providers"]>(async () => ({
        providers: ["github", "google"],
        dev_login: false,
      })),
    });
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    const github = await screen.findByRole("link", { name: "Continue with GitHub" });
    expect(github.getAttribute("href")).toBe(
      "http://api.test/auth/github/login?next=%2Fnotebooks%2Fabc",
    );
    expect(screen.getByRole("link", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.queryByLabelText("Dev user name")).toBeNull();
    expect(screen.queryByText(/Hello/)).toBeNull();
  });

  it("signs in by name with dev login, once, then shows the children", async () => {
    const login = deferred<typeof USER>();
    const devLogin = vi.fn<ApiClient["devLogin"]>(() => login.promise);
    const api = fakeApi({ me: vi.fn<ApiClient["me"]>(signedOut), devLogin });
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    fireEvent.change(await screen.findByLabelText("Dev user name"), {
      target: { value: " Ada " },
    });
    const button = screen.getByRole("button", { name: "Sign in" });
    fireEvent.click(button);
    fireEvent.click(button);
    await act(async () => login.resolve(USER));
    expect(devLogin).toHaveBeenCalledTimes(1);
    expect(devLogin).toHaveBeenCalledWith("Ada");
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
  });

  it("explains a failed sign-in the API redirected back with", async () => {
    window.history.replaceState(null, "", "/?signin_error=expired");
    render(
      <SessionGate api={fakeApi({ me: vi.fn<ApiClient["me"]>(signedOut) })}>
        <Who />
      </SessionGate>,
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/took too long/);
  });

  it("ignores an unknown sign-in error code", async () => {
    window.history.replaceState(null, "", "/?signin_error=<script>");
    render(
      <SessionGate api={fakeApi({ me: vi.fn<ApiClient["me"]>(signedOut) })}>
        <Who />
      </SessionGate>,
    );
    await screen.findByLabelText("Dev user name");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says when no sign-in method is configured", async () => {
    const api = fakeApi({
      me: vi.fn<ApiClient["me"]>(signedOut),
      providers: vi.fn<ApiClient["providers"]>(async () => ({ providers: [], dev_login: false })),
    });
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    expect(await screen.findByText(/No sign-in method is configured/)).toBeTruthy();
  });

  it("signs out", async () => {
    const api = fakeApi();
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(screen.queryByText("Hello Ada")).toBeNull());
    expect(api.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByLabelText("Dev user name")).toBeTruthy();
  });

  it("stays signed in, with a message, when signing out fails", async () => {
    const logout = vi
      .fn<ApiClient["logout"]>()
      .mockRejectedValueOnce(new ApiError(0, "network", "Could not reach the server."))
      .mockResolvedValueOnce(undefined);
    render(
      <SessionGate api={fakeApi({ logout })}>
        <Who />
      </SessionGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the server.");
    expect(screen.getByText("Hello Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" })); // retry works
    expect(await screen.findByLabelText("Dev user name")).toBeTruthy();
  });

  it("asks before signing out while offline edits haven't reached the server", async () => {
    const providers = fakeProviders();
    const sync = openConnection(fakeApi(), NOTEBOOK.id, providers.factory);
    await act(async () => {});
    providers.latest().serve();
    providers.latest().drop();
    appendCell(sync.doc, "sql");
    const api = fakeApi();
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/haven.t reached the server/);
    expect(api.logout).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Hello Ada")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(await screen.findByRole("button", { name: "Sign out anyway" }));
    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1));
  });

  it("shows a non-auth failure as an error, not as signed out", async () => {
    const api = fakeApi({
      me: vi.fn<ApiClient["me"]>(() =>
        Promise.reject(new ApiError(0, "network", "Could not reach the server.")),
      ),
    });
    render(
      <SessionGate api={api}>
        <Who />
      </SessionGate>,
    );
    expect((await screen.findByRole("alert")).textContent).toBe("Could not reach the server.");
  });
});
