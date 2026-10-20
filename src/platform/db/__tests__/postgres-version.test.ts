import { describe, expect, it } from "vitest";
import {
  MIN_POSTGRES_MAJOR,
  UnsupportedPostgresError,
  assertPostgresSupported,
  checkVersion,
  describeVersion,
  majorOf,
  parseServerVersionNum,
  verifyPostgresVersion,
} from "../postgres-version";

describe("parseServerVersionNum", () => {
  it.each([
    ["160004", 160004],
    ["169999", 169999],
    ["170000", 170000],
    ["170002", 170002],
    [" 180001 ", 180001],
    [170004, 170004],
  ])("reads %s", (raw, expected) => {
    expect(parseServerVersionNum(raw)).toBe(expected);
  });

  it.each(["", "abc", "17.4", "17", "-170000", "1700000", null, undefined, "17 0000"])("rejects %s", (raw) => {
    expect(parseServerVersionNum(raw as never)).toBeNull();
  });
});

describe("checkVersion", () => {
  it("sets the minimum at 17", () => {
    expect(MIN_POSTGRES_MAJOR).toBe(17);
  });

  it.each(["170000", "170002", "180000"])("accepts %s", (raw) => {
    expect(() => checkVersion(raw)).not.toThrow();
  });

  it.each(["90624", "140012", "150004", "160004", "169999"])("refuses %s with the detected and required versions", (raw) => {
    expect(() => checkVersion(raw)).toThrow(UnsupportedPostgresError);
    expect(() => checkVersion(raw)).toThrow(/PostgreSQL 17 or newer/);
    expect(() => checkVersion(raw)).toThrow(new RegExp(`version ${describeVersion(Number(raw)).replace(".", "\\.")}`));
  });

  it("passes an unreadable value, because the server answered", () => {
    expect(() => checkVersion("garbage")).not.toThrow();
    expect(() => checkVersion(undefined)).not.toThrow();
  });

  it("points at the docs", () => {
    expect(() => checkVersion("160000")).toThrow(/docs\/database\.md/);
  });

  it("takes the minimum as an argument", () => {
    expect(() => checkVersion("170000", 18)).toThrow(/PostgreSQL 18 or newer/);
    expect(majorOf(160004)).toBe(16);
    expect(describeVersion(140012)).toBe("14.12");
  });
});

describe("assertPostgresSupported", () => {
  const fake = (version: string) => (async () => [{ server_version_num: version }]) as never;

  it("fails for Postgres 16 with the documented message", async () => {
    await expect(assertPostgresSupported(fake("160004"))).rejects.toThrow(/PostgreSQL 17 or newer, but this database reports version 16\.4/);
  });

  it("passes for 17 and 18", async () => {
    await expect(assertPostgresSupported(fake("170000"))).resolves.toBeUndefined();
    await expect(assertPostgresSupported(fake("170002"))).resolves.toBeUndefined();
    await expect(assertPostgresSupported(fake("180000"))).resolves.toBeUndefined();
  });
});

describe("verifyPostgresVersion", () => {
  it("ignores a connection failure", async () => {
    await expect(verifyPostgresVersion("postgres://nobody:none@127.0.0.1:1/none", false)).resolves.toBeUndefined();
  });
});
