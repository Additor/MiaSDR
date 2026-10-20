import { describe, expect, it, vi } from "vitest";
import { appUrlSchema, flag, flagSchema } from "./env";

describe("APP_URL", () => {
  it.each([
    ["https://sdr.example.com", "https://sdr.example.com"],
    ["https://sdr.example.com/", "https://sdr.example.com"],
    ["https://sdr.example.com///", "https://sdr.example.com"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["HTTPS://SDR.Example.com:443/", "https://sdr.example.com"],
  ])("normalizes %s to its origin", (input, origin) => {
    expect(appUrlSchema.parse(input)).toBe(origin);
  });

  it.each(["https://example.com/app", "https://example.com/app/", "https://example.com/?x=1", "https://example.com/#top", "https://user:pw@example.com"])(
    "rejects %s",
    (input) => {
      const result = appUrlSchema.safeParse(input);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain("origin");
    },
  );

  it("rejects a value that is not a URL", () => {
    expect(appUrlSchema.safeParse("sdr.example.com").success).toBe(false);
  });
});

describe("flag", () => {
  it.each(["1", "true", "TRUE", "Yes", " on ", "yEs"])("reads %j as true", (value) => {
    expect(flag(value, false)).toBe(true);
  });

  it.each(["0", "false", "FALSE", "No", " off ", "oFf"])("reads %j as false", (value) => {
    expect(flag(value, true)).toBe(false);
  });

  it.each([undefined, "", "   "])("returns the default for %j", (value) => {
    expect(flag(value, true)).toBe(true);
    expect(flag(value, false)).toBe(false);
  });

  it.each(["maybe", "2", "enabled", "fasle"])("throws for %j", (value) => {
    expect(() => flag(value, true)).toThrow(/not a boolean/);
  });

  it("names the variable when one is given", () => {
    expect(() => flag("fasle", true, "EMBEDDED_SCHEDULER")).toThrow(/^EMBEDDED_SCHEDULER: "fasle" is not a boolean\. Use one of /);
    expect(flag("off", true, "EMBEDDED_SCHEDULER")).toBe(false);
  });

  it("flagSchema turns a bad value into an issue that names the word", () => {
    expect(flagSchema(true).parse("off")).toBe(false);
    expect(flagSchema(true).parse(undefined)).toBe(true);
    const result = flagSchema(true).safeParse("maybe");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("maybe");
  });
});

describe("env()", () => {
  const base = {
    DATABASE_URL: "postgres://x",
    APP_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "x".repeat(40),
    INTEGRATION_CREDENTIALS_KEY: "x".repeat(40),
    UNSUBSCRIBE_SECRET: "x".repeat(40),
  };

  async function load(extra: Record<string, string>) {
    vi.resetModules();
    const saved = { ...process.env };
    Object.assign(process.env, base, extra);
    try {
      const { env } = await import("./env");
      return env();
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  it("rejects a bad EMBEDDED_SCHEDULER and names the variable", async () => {
    await expect(load({ EMBEDDED_SCHEDULER: "fasle" })).rejects.toThrow(/EMBEDDED_SCHEDULER: "fasle" is not a boolean/);
  });

  it.each([
    [" KR", "KR"],
    ["kr", "KR"],
    ["Kr ", "KR"],
    ["ZZ", "ZZ"],
  ])("accepts DEFAULT_PHONE_COUNTRY %j as %s", async (value, expected) => {
    expect((await load({ DEFAULT_PHONE_COUNTRY: value })).DEFAULT_PHONE_COUNTRY).toBe(expected);
  });

  it("treats an empty DEFAULT_PHONE_COUNTRY (compose passes one when unset) as unset", async () => {
    expect((await load({ DEFAULT_PHONE_COUNTRY: "" })).DEFAULT_PHONE_COUNTRY).toBeUndefined();
  });

  it.each(["KOR", "K", "1R"])("rejects DEFAULT_PHONE_COUNTRY %j", async (value) => {
    await expect(load({ DEFAULT_PHONE_COUNTRY: value })).rejects.toThrow(/DEFAULT_PHONE_COUNTRY/);
  });
});
