import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OutboundPauseBanner } from "./outbound-pause-banner";

describe("OutboundPauseBanner", () => {
  it("renders the text with a status role while paused", () => {
    const html = renderToStaticMarkup(createElement(OutboundPauseBanner, { banner: { paused: true, text: "PAUSE_OUTBOUND is set." } }));
    expect(html).toContain('role="status"');
    expect(html).toContain("Sending is paused.");
    expect(html).toContain("PAUSE_OUTBOUND is set.");
  });

  it("links an organization pause to the place that resumes it", () => {
    const html = renderToStaticMarkup(createElement(OutboundPauseBanner, { banner: { paused: true, text: "Ada paused sending.", href: "/settings/organization#sending" } }));
    expect(html).toContain("Ada paused sending.");
    expect(html).toContain('href="/settings/organization#sending"');
  });

  it("renders nothing while sending runs", () => {
    expect(renderToStaticMarkup(createElement(OutboundPauseBanner, { banner: { paused: false, text: null } }))).toBe("");
  });
});
