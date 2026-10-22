import { afterEach, describe, expect, it } from "vitest";
import { getOutboundPauseBanner } from "@/contexts/outreach/application/outbound-pause";
import { isOutboundPauseUnreadable, isOutboundPaused } from "./outbound-pause";

const original = process.env.PAUSE_OUTBOUND;
afterEach(() => {
  if (original === undefined) delete process.env.PAUSE_OUTBOUND;
  else process.env.PAUSE_OUTBOUND = original;
});

describe("isOutboundPaused", () => {
  it("is off when unset or empty", () => {
    delete process.env.PAUSE_OUTBOUND;
    expect(isOutboundPaused()).toBe(false);
    process.env.PAUSE_OUTBOUND = "";
    expect(isOutboundPaused()).toBe(false);
  });

  it.each(["true", "1", "YES", "on"])("is on for %s", (value) => {
    process.env.PAUSE_OUTBOUND = value;
    expect(isOutboundPaused()).toBe(true);
  });

  it.each(["false", "0", "no", "off"])("is off for %s", (value) => {
    process.env.PAUSE_OUTBOUND = value;
    expect(isOutboundPaused()).toBe(false);
  });

  it("reads the environment on every call", () => {
    process.env.PAUSE_OUTBOUND = "true";
    expect(isOutboundPaused()).toBe(true);
    process.env.PAUSE_OUTBOUND = "false";
    expect(isOutboundPaused()).toBe(false);
  });

  it("accepts a typo in env() and reads it as paused", async () => {
    process.env.PAUSE_OUTBOUND = "ture";
    Object.assign(process.env, {
      DATABASE_URL: "postgres://x",
      APP_URL: "http://localhost:3000",
      BETTER_AUTH_SECRET: "x".repeat(40),
      INTEGRATION_CREDENTIALS_KEY: "x".repeat(40),
      UNSUBSCRIBE_SECRET: "x".repeat(40),
    });
    const { env } = await import("./env");
    expect(env().PAUSE_OUTBOUND).toBe("ture");
    expect(isOutboundPaused()).toBe(true);
    expect(isOutboundPauseUnreadable()).toBe(true);
  });

  it("does not flag a readable value as unreadable", () => {
    process.env.PAUSE_OUTBOUND = "off";
    expect(isOutboundPauseUnreadable()).toBe(false);
    delete process.env.PAUSE_OUTBOUND;
    expect(isOutboundPauseUnreadable()).toBe(false);
  });

  it("fails closed on a value it cannot read", () => {
    process.env.PAUSE_OUTBOUND = "maybe";
    expect(isOutboundPaused()).toBe(true);
  });
});

describe("outbound pause banner read model", () => {
  it("carries text while paused", () => {
    process.env.PAUSE_OUTBOUND = "true";
    const banner = getOutboundPauseBanner();
    expect(banner.paused).toBe(true);
    expect(banner.text).toBe("Campaign emails and LinkedIn actions wait until the pause ends. Replies you approve still send. The server administrator ends the pause, see docs/operations.md.");
  });

  it("is empty while sending runs", () => {
    delete process.env.PAUSE_OUTBOUND;
    expect(getOutboundPauseBanner()).toEqual({ paused: false, text: null });
  });

  it("names who paused the organization and links to the switch; PAUSE_OUTBOUND wins", () => {
    delete process.env.PAUSE_OUTBOUND;
    const pause = { at: "2026-10-22T01:00:00.000Z", byName: "Ada" };
    expect(getOutboundPauseBanner(pause)).toEqual({
      paused: true,
      text: "Ada paused campaign emails and LinkedIn actions for this organization. Replies you approve still send.",
      href: "/settings/organization#sending",
    });
    process.env.PAUSE_OUTBOUND = "true";
    expect(getOutboundPauseBanner(pause).href).toBeUndefined();
  });

  it("reports an unreadable value as paused", () => {
    process.env.PAUSE_OUTBOUND = "maybe";
    expect(getOutboundPauseBanner().paused).toBe(true);
  });
});
