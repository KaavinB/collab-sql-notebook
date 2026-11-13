/** Tooltips render every column as text, including Vega's special image/title keys. */
export function formatChartTooltip(value: unknown): string {
  const text = (item: unknown) =>
    (typeof item === "string" ? item : (JSON.stringify(item) ?? String(item))).replace(
      /[&<>"']/g,
      (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
    );

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return `<table>${Object.entries(value)
      .map(([key, item]) => `<tr><td class="key">${text(key)}</td><td>${text(item)}</td></tr>`)
      .join("")}</table>`;
  }
  return text(value);
}
