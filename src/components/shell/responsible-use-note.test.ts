import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESPONSIBLE_USE_DOC, ResponsibleUseNote } from "./responsible-use-note";

describe("ResponsibleUseNote", () => {
  it("renders the launch warning with the doc path", () => {
    const html = renderToStaticMarkup(createElement(ResponsibleUseNote, { kind: "launch" }));
    expect(html).toContain('data-testid="responsible-use-note"');
    expect(html).toContain("CAN-SPAM");
    expect(html).toContain(RESPONSIBLE_USE_DOC);
  });
  it("renders the LinkedIn warning", () => {
    const html = renderToStaticMarkup(createElement(ResponsibleUseNote, { kind: "linkedin" }));
    expect(html).toMatch(/restrict or ban/);
    expect(html).toContain(RESPONSIBLE_USE_DOC);
  });
});
