import { expect, seedMember, signInAdmin, sql, test, tick } from "./support/fixtures";
import { secondBrowser } from "./support/grid";

/**
 * Mia with `AI_PROVIDER=fake`: a fixed path through the tools and a fixed page. The page states a monthly price of 99 and no
 * yearly price, and the fake suggests both, so the review has a value to catch.
 */

const MEMBER = { name: "Mira Member", email: "mira56@e2e-corp.test", password: "mira56-password-1" };

async function pastedDocument(title: string, content: string): Promise<string> {
  const [org] = await sql()`select id from organizations where name = 'E2E Corp' limit 1`;
  return sql().begin(async (tx) => {
    const [doc] = await tx`insert into knowledge_documents (organization_id, title, kind) values (${org.id}, ${title}, 'unsorted') returning id`;
    await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${org.id}, ${doc.id}, 1, ${content})`;
    return doc.id as string;
  });
}

test.describe("Mia", () => {
  test("a member fills Brain from a website, and a value the page does not state waits for a person", async ({ page, browser }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    const { page: member, done } = await secondBrowser(browser, MEMBER.email, MEMBER.password, [/response 422: POST .*\/api\/mia\/runs/, /Failed to load resource.*422/]);
    await member.goto("/brain");
    await member.getByRole("button", { name: "Fill with Mia" }).first().click();
    const dialog = member.getByRole("dialog");
    await dialog.getByLabel("Your company's website").fill("http://not-https.example");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog.getByRole("alert")).toContainText("public https");
    await dialog.getByLabel("Your company's website").fill("https://fake-mia.test/");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();

    await member.goto("/brain?view=suggestions");
    await tick(member.request);
    await member.reload();
    const row = member.getByTestId("mia-suggestion");
    await expect(row).toContainText("Starter");
    await expect(row).toContainText("New Pricing");
    await expect(row).toContainText("1 value to check");

    await row.getByRole("button", { name: "Review" }).click();
    const review = member.getByRole("dialog");
    await expect(review.getByLabel("Monthly price")).toHaveValue("99");
    await expect(review.getByRole("link", { name: "Source" }).first()).toHaveAttribute("href", "https://fake-mia.test/");
    const save = review.getByRole("button", { name: "Save to Brain" });
    await expect(save).toBeDisabled();
    await expect(review.getByTestId("mia-unverified")).toHaveCount(1);

    // Changing the value makes it the person's own, so no tick is needed.
    await review.getByLabel("Annual price").fill("1000");
    await expect(review.getByTestId("mia-unverified")).toHaveCount(0);
    await expect(save).toBeEnabled();
    await review.getByLabel("Annual price").fill("990");
    await review.getByRole("checkbox", { name: /I checked this value/ }).check();
    await save.click();
    await expect(review).toBeHidden();

    await member.goto("/brain");
    await member.getByRole("link", { name: "Starter" }).click();
    await expect(member.getByText("USD 990")).toBeVisible();
    await done();
  });

  test("a person dismisses a suggestion", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/brain");
    await page.getByRole("button", { name: "Fill with Mia" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Text" }).click();
    await dialog.getByLabel("Text to read").fill("Pasted Widgets for testers");
    await dialog.getByRole("button", { name: "Start" }).click();
    await expect(dialog).toBeHidden();
    await page.goto("/brain?view=suggestions");
    const row = page.getByTestId("mia-suggestion").filter({ hasText: "Pasted Widgets for testers" });
    await tick(page.request);
    await page.reload();
    await row.getByRole("button", { name: "Dismiss" }).click();
    await expect(row).toHaveCount(0);
  });

  test("sorts an old document on request, and the pasted text stays as the earlier version", async ({ page }) => {
    await signInAdmin(page);
    const id = await pastedDocument("Old widgets note", "Sorted Widgets for testers");
    await page.goto(`/brain/${id}`);
    await page.getByRole("button", { name: "Sort with Mia" }).click();
    await expect(page.getByText(/Mia is sorting this/)).toBeVisible();
    await page.goto("/brain?view=suggestions");
    const row = page.getByTestId("mia-suggestion").filter({ hasText: "Sorted Widgets for testers" });
    await tick(page.request);
    await page.reload();
    await expect(row).toContainText("Sorts this document as Product");
    await row.getByRole("button", { name: "Review" }).click();
    const review = page.getByRole("dialog");
    await review.getByRole("button", { name: "Save to Brain" }).click();
    await expect(review).toBeHidden();
    const versions = await sql()`select version, content, structured_data is null as legacy from knowledge_document_versions where document_id = ${id} order by version`;
    expect(versions.map((v) => [v.version, v.legacy])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(versions[0].content).toBe("Sorted Widgets for testers");
  });

  test("an owner turns Mia off, and the button says why", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/organization");
    await page.getByRole("checkbox", { name: "Mia is on" }).uncheck();
    const section = page.locator("form", { has: page.getByRole("checkbox", { name: "Mia is on" }) });
    await section.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Mia settings saved.")).toBeVisible();
    await page.goto("/brain");
    const fill = page.getByRole("button", { name: "Fill with Mia" }).first();
    await expect(fill).toBeDisabled();
    await expect(fill).toHaveAttribute("title", /Mia is off/);
    await page.goto("/settings/organization");
    await page.getByRole("checkbox", { name: "Mia is on" }).check();
    await page.locator("form", { has: page.getByRole("checkbox", { name: "Mia is on" }) }).getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Mia settings saved.")).toBeVisible();
  });
});
