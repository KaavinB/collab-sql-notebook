// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MarkdownPreview } from "@/components/notebook/MarkdownPreview";

afterEach(cleanup);

describe("MarkdownPreview", () => {
  it("renders headings, lists and links", () => {
    render(<MarkdownPreview source={"# Title\n\n- one\n- two\n\n[docs](https://duckdb.org)"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "docs" }).getAttribute("href")).toBe(
      "https://duckdb.org",
    );
  });

  it("never injects raw HTML from a collaborator", () => {
    const { container } = render(
      <MarkdownPreview
        source={'<script>window.pwned = 1</script>\n\n<img src=x onerror="alert(1)">'}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops javascript: links", () => {
    render(<MarkdownPreview source={"[click](javascript:alert(1))"} />);
    const href = screen.getByText("click").closest("a")?.getAttribute("href") ?? "";
    expect(href).not.toMatch(/^javascript:/i);
  });

  it("never loads images (a URL would reveal every viewer's IP), but keeps the alt text", () => {
    const { container } = render(
      <MarkdownPreview source={"![chart of trips](https://tracker.example/pixel.png)"} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("[image: chart of trips]")).toBeTruthy();
  });

  it("opens links in a new tab without giving the target page access to this one", () => {
    render(<MarkdownPreview source={"[docs](https://duckdb.org)"} />);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("shows a placeholder for an empty cell", () => {
    render(<MarkdownPreview source="   " />);
    expect(screen.getByText("Empty text cell")).toBeTruthy();
  });
});
