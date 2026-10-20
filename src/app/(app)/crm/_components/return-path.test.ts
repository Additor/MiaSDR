import { describe, expect, it } from "vitest";
import { contactReturnPath, dealReturnPath } from "./return-path";

const ID = "0b5c3f2e-4d1a-4c2b-9e8f-1a2b3c4d5e6f";

describe("dealReturnPath", () => {
  it("labels each allowed origin", () => {
    expect(dealReturnPath("/crm/pipeline")).toEqual({ path: "/crm/pipeline", label: "Pipeline" });
    expect(dealReturnPath("/crm/contacts")).toEqual({ path: "/crm/contacts", label: "Contacts" });
    expect(dealReturnPath(`/crm/contacts/${ID}`)).toEqual({ path: `/crm/contacts/${ID}`, label: "Contact" });
    expect(dealReturnPath("/crm/companies")).toEqual({ path: "/crm/companies", label: "Companies" });
    expect(dealReturnPath(`/crm/companies/${ID}`)).toEqual({ path: `/crm/companies/${ID}`, label: "Company" });
    expect(dealReturnPath(`/inbox/${ID}`)).toEqual({ path: `/inbox/${ID}`, label: "Inbox" });
  });

  it("keeps the query of a list and drops it from a single page", () => {
    expect(dealReturnPath("/crm/contacts?q=ada&page=2").path).toBe("/crm/contacts?q=ada&page=2");
    expect(dealReturnPath("/crm/pipeline?owner=me").path).toBe("/crm/pipeline?owner=me");
    expect(dealReturnPath("/crm/contacts?").path).toBe("/crm/contacts");
    expect(dealReturnPath(`/crm/contacts/${ID}?from=/crm/contacts`).path).toBe(`/crm/contacts/${ID}`);
  });

  it("falls back to Pipeline for anything off the list", () => {
    const fallback = { path: "/crm/pipeline", label: "Pipeline" };
    for (const from of [
      null,
      undefined,
      "",
      "//evil.example",
      "//evil.example/crm/pipeline",
      "https://evil.example/crm/pipeline",
      "crm/pipeline",
      "/\\evil.example",
      "/crm/pipeline\\..",
      "/crm/pipeline\n",
      "/crm/pipeline#top",
      "/crm/pipeline/extra",
      "/crm/contacts/not-a-uuid",
      `/crm/contacts/${ID}/edit`,
      `/crm/deals/${ID}`,
      `/leads/${ID}`,
      "/inbox",
      "/settings",
    ]) {
      expect(dealReturnPath(from), String(from)).toEqual(fallback);
    }
  });

  it("accepts an upper-case uuid", () => {
    expect(dealReturnPath(`/crm/contacts/${ID.toUpperCase()}`).label).toBe("Contact");
  });
});

describe("contactReturnPath", () => {
  it("allows the Contacts list with its query and a company page", () => {
    expect(contactReturnPath("/crm/contacts")).toBe("/crm/contacts");
    expect(contactReturnPath("/crm/contacts?q=ada&sort=name")).toBe("/crm/contacts?q=ada&sort=name");
    expect(contactReturnPath(`/crm/companies/${ID}`)).toBe(`/crm/companies/${ID}`);
  });

  it("falls back to Contacts for other pages and unsafe paths", () => {
    for (const from of [null, "", "//evil.example", "/crm/pipeline", "/crm/companies", `/crm/contacts/${ID}`, `/inbox/${ID}`, "/crm/companies/x"]) {
      expect(contactReturnPath(from), String(from)).toBe("/crm/contacts");
    }
  });
});
