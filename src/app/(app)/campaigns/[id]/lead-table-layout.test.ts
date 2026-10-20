import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ScrollableTable } from "@/components/ui/scrollable-table";

/** Both campaign lead tables (email and LinkedIn) wrap their rows in ScrollableTable. */
describe("campaign lead tables", () => {
  it("ScrollableTable draws a shadow on each edge that has more to scroll to", () => {
    const html = renderToStaticMarkup(createElement(ScrollableTable, null, "x"));
    expect(html).toContain('data-slot="scrollable-table"');
    // Cover gradients move with the content (local) and the shadows stay on the edges (scroll).
    expect(html).toContain("[background-attachment:local,local,scroll,scroll]");
    expect(html).toContain("[&amp;_[data-slot=table-container]]");
  });
});
