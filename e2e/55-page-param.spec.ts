import { expect, signInAdmin, test } from "./support/fixtures";

const LISTS = ["/brain", "/inbox", "/crm/contacts", "/crm/companies", "/settings/audit-log", "/settings/inbound-events", "/settings/suppression"];

test("a page value no list can reach opens the list instead of failing it", async ({ page }) => {
  await signInAdmin(page);
  for (const list of LISTS) {
    for (const value of ["Infinity", "1e30", "2.5"]) {
      await page.goto(`${list}?page=${value}`);
      await expect(page.getByRole("heading", { level: 1 }), `${list}?page=${value}`).not.toHaveText("Something went wrong");
      await expect(page.locator("body"), `${list}?page=${value}`).not.toContainText(/couldn.t load|Try again/i);
    }
  }
});
