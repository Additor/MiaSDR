import { MOBILE_DARK, csvFile, expect, expectNoHorizontalOverflow, importLeads, signInAdmin, test, unique, waitForHydrated } from "./support/fixtures";
import type { Page } from "@playwright/test";

async function openWizard(page: Page) {
  await page.goto("/leads/import");
  const input = page.getByLabel("Choose a CSV or XLSX file");
  await waitForHydrated(input);
  return input;
}

test.describe("lead import wizard", () => {
  test("review counts, back and cancel keep or drop state, and the button carries the numbers", async ({ page }) => {
    const tag = unique("s31").toLowerCase();
    const known = `known-${tag}@s31-labs.test`;
    await signInAdmin(page);
    await importLeads(page.request, [{ email: known, firstName: "Kay", lastName: "Known", title: "Engineer" }]);

    const input = await openWizard(page);
    await input.setInputFiles(
      csvFile(`${tag}.csv`, [
        ["Email", "First Name", "Job Title"],
        [`fresh-${tag}@s31-labs.test`, "Fay", "CTO"],
        [known, "Kay", "VP"],
        ["not-an-email", "Bad", "COO"],
        [`fresh-${tag}@s31-labs.test`, "Fay", "CTO"],
        ["", "Nobody", "CEO"],
      ]),
    );
    await expect(page.getByText("5 rows found.")).toBeVisible();

    // Step 2 offers Back and Cancel, and no import before the review.
    await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", "/leads");
    await expect(page.getByRole("button", { name: /^Import \d/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Review import" }).click();
    const summary = page.getByRole("status").filter({ hasText: "Review before importing" });
    await expect(summary).toBeVisible();
    await expect(summary).toBeFocused();
    await expect(summary).toContainText("New leads1");
    await expect(summary).toContainText("Existing leads to update1");
    await expect(summary).toContainText("Skipped, the email is not valid1");
    await expect(summary).toContainText('Row 3: "not-an-email" is not a valid email');
    await expect(summary).toContainText("Skipped, no email or LinkedIn profile1");
    await expect(summary).toContainText("Repeated in the file, merged into the first row1");
    await expect(summary).toContainText("Replaces values already stored");
    await expect(summary).toContainText("Job Title: 1 lead");
    const confirm = page.getByRole("button", { name: "Import 2 leads: 1 new, 1 updated" });
    await expect(confirm).toBeEnabled();

    // A change to the mapping makes the summary stale, so it goes and the review button returns.
    await page.getByLabel("Import Job Title as").click();
    await page.getByRole("option", { name: "Keep in source data only" }).click();
    await expect(summary).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Review import" })).toBeVisible();

    // Back keeps the file and the mapping.
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByRole("heading", { name: /Choose a file/ }).or(page.getByText("1. Choose a file"))).toBeVisible();
    await expect(page.getByText(`${tag}.csv`)).toBeVisible();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Import Job Title as")).toContainText("Keep in source data only");

    // The title still replaces nothing now, and the import runs from the button label.
    await page.getByRole("button", { name: "Review import" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Review before importing" })).toContainText("No stored value is replaced");
    await page.getByRole("button", { name: /^Import 2 leads: 1 new, 1 updated$/ }).click();
    await expect(page.getByText("Import finished")).toBeVisible();
    await expect(page.getByRole("link", { name: "Add these 1 to a campaign" })).toBeVisible();

    // The same file again changes nothing, so the button says so and stays off.
    await page.getByRole("button", { name: "Import another file" }).click();
    await (await openWizard(page)).setInputFiles(
      csvFile(`${tag}-again.csv`, [
        ["Email", "First Name"],
        [`fresh-${tag}@s31-labs.test`, "Fay"],
      ]),
    );
    await page.getByRole("button", { name: "Review import" }).click();
    await expect(page.getByRole("button", { name: "Nothing to import" })).toBeDisabled();
    await expect(page.getByRole("status").filter({ hasText: "Review before importing" })).toContainText("Nothing would change");

    // Cancel leaves the wizard.
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/leads$/);
  });

  test("the sample file downloads, imports cleanly, and a blocking mapping error is an alert", async ({ page }) => {
    await signInAdmin(page);
    await openWizard(page);
    await expect(page.getByText(/column names in the first row/)).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download sample CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("lead-import-sample.csv");
    const path = await file.path();
    const text = (await import("node:fs")).readFileSync(path, "utf8").replace(/^﻿/, "");
    expect(text.split("\r\n")[0]).toBe("Email,First name,Last name,Job title,Phone,LinkedIn URL,Company,Company domain");

    // The importer maps every header of its own sample without help.
    await page.getByLabel("Choose a CSV or XLSX file").setInputFiles({ name: "lead-import-sample.csv", mimeType: "text/csv", buffer: Buffer.from(text) });
    await expect(page.getByText("2 rows found.")).toBeVisible();
    for (const [header, label] of [["Email", "Email"], ["First name", "First name"], ["Job title", "Job title"], ["Company domain", "Company domain or website"]]) {
      await expect(page.getByLabel(`Import ${header} as`)).toContainText(label);
    }

    // No column carries an email: the message is an alert and the review stays off.
    await page.getByLabel("Import Email as").click();
    await page.getByRole("option", { name: "Keep in source data only" }).click();
    await page.getByLabel("Import LinkedIn URL as").click();
    await page.getByRole("option", { name: "Keep in source data only" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Map one column to Email or LinkedIn profile." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Review import" })).toBeDisabled();
  });

  test("a column shows up to three distinct examples and the select groups its choices", async ({ page }) => {
    const tag = unique("s31x").toLowerCase();
    await signInAdmin(page);
    await (await openWizard(page)).setInputFiles(
      csvFile(`${tag}.csv`, [
        ["Email", "Region"],
        [`a-${tag}@s31-labs.test`, ""],
        [`b-${tag}@s31-labs.test`, "EMEA"],
        [`c-${tag}@s31-labs.test`, "EMEA"],
        [`d-${tag}@s31-labs.test`, "APAC"],
        [`e-${tag}@s31-labs.test`, "AMER"],
        [`f-${tag}@s31-labs.test`, "LATAM"],
      ]),
    );
    const row = page.getByRole("row").filter({ hasText: "Region" });
    await expect(row.getByText("EMEA", { exact: true })).toHaveCount(1);
    await expect(row.getByText("APAC", { exact: true })).toBeVisible();
    await expect(row.getByText("AMER", { exact: true })).toBeVisible();
    await expect(row.getByText("LATAM", { exact: true })).toHaveCount(0);

    await page.getByLabel("Import Region as").click();
    for (const group of ["Contact", "Company", "Custom", "Skip"]) await expect(page.getByText(group, { exact: true }).last()).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(12);
    await expect(page.getByRole("option", { name: "Custom field" })).toBeVisible();
    await expect(page.getByRole("option", { name: /Merge field|Do not map/ })).toHaveCount(0);
  });

  test.describe("phone width", () => {
    test("each column is a card with the Import as select at full width and a 44px target", async ({ browser }) => {
      const context = await browser.newContext(MOBILE_DARK);
      const page = await context.newPage();
      const tag = unique("s31m").toLowerCase();
      await signInAdmin(page);
      await (await openWizard(page)).setInputFiles(
        csvFile(`${tag}.csv`, [
          ["Email", "Job Title", "Region"],
          [`a-${tag}@s31-labs.test`, "CTO", "EMEA"],
          [`b-${tag}@s31-labs.test`, "VP", "APAC"],
          [`c-${tag}@s31-labs.test`, "COO", "AMER"],
        ]),
      );
      await expect(page.getByText("3 rows found.")).toBeVisible();
      await expect(page.getByRole("table")).toHaveCount(0);

      const cards = page.getByRole("list", { name: "Columns in your file" }).locator(":scope > li");
      await expect(cards).toHaveCount(3);
      const select = page.getByLabel("Import Job Title as");
      await expect(select).toBeInViewport({ ratio: 1 });
      const box = (await select.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      const card = (await cards.nth(1).boundingBox())!;
      expect(box.width).toBeGreaterThan(card.width - 40);
      // The card names the file column and its examples before the select.
      await expect(cards.nth(1)).toContainText("Job Title");
      await expect(cards.nth(1)).toContainText("CTO");
      await expectNoHorizontalOverflow(page);

      // The review and the button keep to the screen too.
      await page.getByRole("button", { name: "Review import" }).click();
      const confirm = page.getByRole("button", { name: "Import 3 leads: 3 new" });
      await confirm.scrollIntoViewIfNeeded();
      await expect(confirm).toBeInViewport({ ratio: 1 });
      expect((await confirm.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await expectNoHorizontalOverflow(page);
      await context.close();
    });
  });
});
