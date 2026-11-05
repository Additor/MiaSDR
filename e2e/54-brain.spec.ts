import { expect, seedMember, signInAdmin, sql, test } from "./support/fixtures";
import { secondBrowser } from "./support/grid";

const MEMBER = { name: "Bea Brain", email: "bea54@e2e-corp.test", password: "bea54-password-1" };

/** A document pasted before the kinds existed. */
async function pastedDocument(title: string, content: string): Promise<string> {
  const [org] = await sql()`select id from organizations where name = 'E2E Corp' limit 1`;
  return sql().begin(async (tx) => {
    const [doc] = await tx`insert into knowledge_documents (organization_id, title, kind) values (${org.id}, ${title}, 'unsorted') returning id`;
    await tx`insert into knowledge_document_versions (organization_id, document_id, version, content) values (${org.id}, ${doc.id}, 1, ${content})`;
    return doc.id as string;
  });
}

test.describe("Brain", () => {
  test("sits in the sidebar, and the old Settings page leads to it", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/knowledge");
    await expect(page).toHaveURL(/\/brain$/);
    const link = page.getByRole("link", { name: "Brain", exact: true }).first();
    await expect(link).toHaveAttribute("aria-current", "page");
    await page.goto("/settings");
    await expect(page.getByRole("link", { name: /^Knowledge/ })).toHaveCount(0);
  });

  test("a member adds, finds, edits, archives and restores an item", async ({ page, browser }) => {
    await signInAdmin(page);
    await seedMember(page.request, MEMBER);
    const member = await secondBrowser(browser, MEMBER.email, MEMBER.password);
    const p = member.page;
    const name = `Mia ${Date.now()}`;

    await p.goto("/brain");
    await p.getByRole("button", { name: "Add to Brain" }).first().click();
    const dialog = p.getByRole("dialog");
    await dialog.getByLabel("Product name").fill(name);
    await dialog.getByLabel("Overview").fill("An AI SDR");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();

    await p.getByRole("searchbox", { name: "Search Brain" }).fill(name);
    await p.getByRole("searchbox", { name: "Search Brain" }).press("Enter");
    await expect(p.getByTestId("brain-item")).toHaveCount(1);
    await p.getByRole("link", { name }).click();
    await expect(p.getByTestId("brain-item-fields")).toContainText("An AI SDR");

    await p.getByRole("button", { name: "Edit" }).click();
    await p.getByRole("dialog").getByLabel("Overview").fill("A self-hosted AI SDR");
    await p.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(p.getByTestId("brain-item-fields")).toContainText("A self-hosted AI SDR");
    await expect(p.getByText(/Version 2/)).toBeVisible();

    await p.getByRole("button", { name: "Archive" }).click();
    await expect(p.getByRole("button", { name: "Restore" })).toBeVisible();
    await p.goto(`/brain?status=archived&q=${encodeURIComponent(name)}`);
    await expect(p.getByTestId("brain-item")).toHaveCount(1);
    await p.getByRole("link", { name }).click();
    await p.getByRole("button", { name: "Restore" }).click();
    await expect(p.getByRole("button", { name: "Archive" })).toBeVisible();
    await member.done();
  });

  test("sorts a pasted document into a kind and keeps the text as a version", async ({ page }) => {
    await signInAdmin(page);
    const title = `Old notes ${Date.now()}`;
    const id = await pastedDocument(title, "We sell to SaaS teams.");
    await page.goto("/brain?view=needs_sorting");
    await page.getByRole("link", { name: title }).click();
    await page.getByRole("button", { name: "Sort" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("brain-legacy-text")).toHaveText("We sell to SaaS teams.");
    await expect(dialog.getByRole("button", { name: "Save" })).toBeDisabled();
    await dialog.getByLabel("Product name").fill(`${title} sorted`);
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("brain-item-fields")).toContainText("Product name");
    await expect(page.getByText(/Version 2/)).toBeVisible();
    const versions = await sql()`select version, content from knowledge_document_versions where document_id = ${id} order by version`;
    expect(versions[0].content).toBe("We sell to SaaS teams.");
    expect(versions[1].content).toContain("Product name");
  });

  test("offers one company profile, and says why another one cannot be restored", async ({ page }) => {
    await signInAdmin(page);
    const [org] = await sql()`select id from organizations where name = 'E2E Corp' limit 1`;
    await sql()`update knowledge_documents set active = false where organization_id = ${org.id} and kind = 'company_profile'`;

    const add = async (company: string) => {
      await page.goto("/brain");
      await page.getByRole("button", { name: "Add to Brain" }).first().click();
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Kind").click();
      await page.getByRole("option", { name: "Company profile" }).click();
      await dialog.getByLabel("Company name").fill(company);
      await dialog.getByRole("button", { name: "Add", exact: true }).click();
      await expect(dialog).toBeHidden();
    };

    const first = `Acme ${Date.now()}`;
    await add(first);
    await page.goto(`/brain?q=${encodeURIComponent(first)}`);
    await page.getByRole("link", { name: first }).click();
    await expect(page.getByRole("button", { name: "Archive" })).toBeVisible();
    const firstUrl = page.url();
    await page.getByRole("button", { name: "Archive" }).click();
    await expect(page.getByRole("button", { name: "Restore" })).toBeEnabled();

    await add(`${first} two`);
    await page.getByRole("button", { name: "Add to Brain" }).first().click();
    await page.getByRole("dialog").getByLabel("Kind").click();
    await expect(page.getByRole("option", { name: "Company profile" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await page.goto(firstUrl);
    await expect(page.getByRole("button", { name: "Restore" })).toBeDisabled();
    await expect(page.getByText("Another company profile is active.", { exact: false })).toBeVisible();
  });

  test("refuses a price it cannot read instead of dropping it", async ({ page, watch }) => {
    watch.tolerate(/response 4\d\d: POST .*\/api\/brain/, /Failed to load resource.*4\d\d/);
    await signInAdmin(page);
    await page.goto("/brain");
    await page.getByRole("button", { name: "Add to Brain" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Kind").click();
    await page.getByRole("option", { name: "Pricing" }).click();
    await dialog.getByLabel("Plan name").fill(`Pro ${Date.now()}`);
    await dialog.getByLabel("Currency").fill("USD");
    await dialog.getByLabel("Monthly price").fill("49 USD");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog.getByText("Monthly price must be a number", { exact: false })).toBeVisible();
    await dialog.getByLabel("Monthly price").fill("49");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();
  });

  test("clears an optional topic and shows no page for an unknown item", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/brain");
    await page.getByRole("button", { name: "Add to Brain" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Kind").click();
    await page.getByRole("option", { name: "Objection" }).click();
    const title = `Too dear ${Date.now()}`;
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByLabel("Topic").click();
    await page.getByRole("option", { name: "Price" }).click();
    await dialog.getByLabel("Objection", { exact: true }).fill("It costs too much");
    await dialog.getByLabel("Response strategy").fill("Show the return");
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(dialog).toBeHidden();

    await page.goto(`/brain?q=${encodeURIComponent(title)}`);
    await page.getByRole("link", { name: title }).click();
    await expect(page.getByTestId("brain-item-fields")).toContainText("Price");
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("dialog").getByLabel("Topic").click();
    await page.getByRole("option", { name: "None" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await expect(page.getByTestId("brain-item-fields")).not.toContainText("Topic");

    await page.goto("/brain/not-an-id");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Page not found");
  });
});
