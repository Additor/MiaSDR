import { describe, expect, it } from "vitest";
import { CAMPAIGN_FIELDS } from "@/contexts/grid/domain/campaign-rows";
import { guessFields } from "./push-guess";
import type { GridColumn } from "./types";

const col = (key: string, name: string, type: GridColumn["type"] = "text"): GridColumn => ({ id: key, tableId: "t", key, name, type, config: {}, dependsOn: [], position: 1, autoRun: false });

describe("guessFields", () => {
  it("maps columns by their visible name", () => {
    const g = guessFields(CAMPAIGN_FIELDS, [col("c1", "Email", "email"), col("c2", "First name"), col("c3", "Last name"), col("c4", "Company")]);
    expect(g).toMatchObject({ email: "c1", firstName: "c2", lastName: "c3", companyName: "c4", fullName: null });
  });

  it("does not read an Email column as the full name when it kept the starter key", () => {
    // An import renames the starter column "New Column" to "Email" and leaves its key as "name".
    const g = guessFields(CAMPAIGN_FIELDS, [col("name", "Email", "email"), col("first_name", "First name")]);
    expect(g.email).toBe("name");
    expect(g.fullName).toBeNull();
  });

  it("gives one column to one field", () => {
    const g = guessFields(CAMPAIGN_FIELDS, [col("a", "Name", "email")]);
    expect(g.email).toBe("a");
    expect(g.fullName).toBeNull();
  });

  it("finds an email-typed column under any name", () => {
    expect(guessFields(["email"], [col("x", "Contact", "email")]).email).toBe("x");
  });

  it("maps Email to the address a verification checked, else to a found work email, over the imported column", () => {
    const imported = col("email", "email", "email");
    const find = { ...col("find", "Find work email", "enrichment"), config: { actionKey: "find-work-email" } };
    const work = { ...col("work", "Work email", "integration_output"), config: { sourceColumnKey: "find", outputKey: "email" } };
    expect(guessFields(["email"], [imported, find, work]).email).toBe("work");
    expect(guessFields(["email"], [imported, find]).email).toBe("find");
    const verify = { ...col("check", "Verify email", "enrichment"), config: { actionKey: "verify-email", inputs: { email: "email" } } };
    expect(guessFields(["email"], [imported, find, work, verify]).email).toBe("email");
  });
});
