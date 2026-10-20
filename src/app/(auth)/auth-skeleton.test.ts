import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AuthCardSkeleton } from "./auth-skeleton";

describe("AuthCardSkeleton", () => {
  it("renders the marker and one placeholder per field, so the server HTML shows a card before hydration", () => {
    const html = renderToStaticMarkup(createElement(AuthCardSkeleton, { fields: 3 }));
    expect(html).toContain('data-skeleton="auth-card"');
    // title, description, three labels, three inputs, one button
    expect(html.match(/data-slot="skeleton"/g)).toHaveLength(9);
  });
});
