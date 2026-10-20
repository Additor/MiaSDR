import { describe, expect, it } from "vitest";
import { deleteRowsReport, deleteRowsTitle } from "./delete-rows";

describe("deleteRowsTitle", () => {
  it("uses the singular for one row", () => {
    expect(deleteRowsTitle(1, "Leads")).toBe('Delete 1 row from "Leads"?');
  });

  it("uses the plural and thousands separators otherwise", () => {
    expect(deleteRowsTitle(2, "Leads")).toBe('Delete 2 rows from "Leads"?');
    expect(deleteRowsTitle(12000, "Leads")).toBe('Delete 12,000 rows from "Leads"?');
  });
});

describe("deleteRowsReport", () => {
  it("reports success when every batch worked", () => {
    expect(deleteRowsReport(3, 0, null)).toEqual({ kind: "success", message: "Deleted 3 rows." });
    expect(deleteRowsReport(1, 0, null)).toEqual({ kind: "success", message: "Deleted 1 row." });
  });

  it("says so when the rows were already gone", () => {
    expect(deleteRowsReport(0, 0, null)).toEqual({ kind: "success", message: "Those rows were already deleted." });
  });

  it("reports a failure with the recovery when nothing was deleted", () => {
    expect(deleteRowsReport(0, 10, "Could not reach the server.")).toEqual({ kind: "failed", message: "Could not delete 10 rows. Could not reach the server. Try again." });
  });

  it("counts deleted and failed rows on a partial failure", () => {
    expect(deleteRowsReport(5000, 7000, "Server error")).toEqual({
      kind: "partial",
      message: "Deleted 5,000 rows, but 7,000 rows could not be deleted. Server error. They stay selected, so you can try again.",
    });
    expect(deleteRowsReport(5000, 1, "Server error").message).toContain("but 1 row could not");
  });

  it("falls back to a generic problem when the error is empty", () => {
    expect(deleteRowsReport(0, 1, " ").message).toBe("Could not delete 1 row. The server did not respond. Try again.");
  });

  it("never reports a success when an error came back", () => {
    expect(deleteRowsReport(5000, 1000, "boom").kind).not.toBe("success");
  });
});
