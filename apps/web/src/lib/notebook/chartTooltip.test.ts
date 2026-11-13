// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { formatChartTooltip } from "@/lib/notebook/chartTooltip";

describe("chart tooltips", () => {
  it("keeps image/title column names and values as plain text", () => {
    const tooltip = document.createElement("div");
    tooltip.innerHTML = formatChartTooltip({
      image: "https://tracker.example/pixel.png",
      title: '<img src="https://tracker.example/other.png">',
      '<script>alert("key")</script>': { nested: "<iframe src='https://tracker.example'>" },
    });
    expect(tooltip.querySelectorAll("tr")).toHaveLength(3);
    expect(tooltip.querySelector("img, script, iframe, a")).toBeNull();
    expect(tooltip.textContent).toContain("imagehttps://tracker.example/pixel.png");
    expect(tooltip.textContent).toContain('title<img src="https://tracker.example/other.png">');
    expect(tooltip.textContent).toContain('<script>alert("key")</script>');
  });

  it.each([null, 3, true, ["<img src=x>", 2], '<svg onload="alert(1)">'])(
    "renders scalar and array values safely (%j)",
    (value) => {
      const tooltip = document.createElement("div");
      tooltip.innerHTML = formatChartTooltip(value);
      expect(tooltip.children).toHaveLength(0);
      expect(tooltip.textContent).toBe(typeof value === "string" ? value : JSON.stringify(value));
    },
  );
});
