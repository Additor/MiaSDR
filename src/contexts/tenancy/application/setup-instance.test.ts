import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { setupInstance, type InstanceSetupStore, type NewInstance } from "./setup-instance";

function fakeStore() {
  const created: NewInstance[] = [];
  const store: InstanceSetupStore = {
    hasAnyUser: async () => false,
    createInitialAdmin: async (instance) => {
      created.push(instance);
      return { userId: "u", organizationId: "o" };
    },
  };
  return { store, created };
}

const valid = { name: "Ada", email: "Ada@Example.com", password: "long-enough-1", organizationName: "Acme" };

async function run(overrides: Record<string, unknown>) {
  const { store, created } = fakeStore();
  const result = await setupInstance({ store, hashPassword: async (p) => `hash:${p}` }, { ...valid, ...overrides }).then(
    () => null,
    (error: unknown) => error,
  );
  return { error: result, created };
}

describe("setupInstance validation", () => {
  it("stores the canonical time zone", async () => {
    const { error, created } = await run({ timeZone: "europe/berlin" });
    expect(error).toBeNull();
    expect(created[0]?.timeZone).toBe("Europe/Berlin");
    expect(created[0]?.email).toBe("ada@example.com");
  });

  it.each(["", "  "])("treats time zone %j as no preference", async (timeZone) => {
    const { error, created } = await run({ timeZone });
    expect(error).toBeNull();
    expect(created[0]?.timeZone).toBeUndefined();
  });

  it("accepts a missing time zone", async () => {
    const { error, created } = await run({});
    expect(error).toBeNull();
    expect(created[0]?.timeZone).toBeUndefined();
  });

  it.each(["Mars/Olympus", "x".repeat(65)])("rejects time zone %j with a message and stores nothing", async (timeZone) => {
    const { error, created } = await run({ timeZone });
    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues[0]?.message).toMatch(/Time zone/);
    expect(created).toHaveLength(0);
  });

  it.each([
    [{ name: "  " }, "Enter your name."],
    [{ email: "nope" }, "Enter a valid email address."],
    [{ password: "short" }, "Password needs at least 8 characters."],
    [{ organizationName: "" }, "Enter an organization name."],
  ])("names the failing field for %j", async (overrides, message) => {
    const { error } = await run(overrides);
    expect((error as ZodError).issues[0]?.message).toBe(message);
  });
});
