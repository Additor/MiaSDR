import { ensureMailbox, expect, importLeads, signInAdmin, test } from "./support/fixtures";

const NAME = "C2 archive me";

test.describe("campaign archive", () => {
  test("a completed campaign is archived, hidden from the default list, found under Archived and restored", async ({ page }) => {
    await signInAdmin(page);
    await ensureMailbox(page.request, "c2-archive@e2e-corp.test", "C2 Archive");
    await importLeads(page.request, [{ email: "fay@c2-archive.test", firstName: "Fay", lastName: "Kane", company: "C2 Archive Co" }]);
    const created = await page.request.post("/api/campaigns", { data: { name: NAME } });
    expect(created.status()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const steps = await page.request.patch(`/api/campaigns/${id}`, { data: { steps: [{ stepNumber: 1, kind: "email", subject: "Hello", body: "Hi {{firstName}}", waitDays: 0 }] } });
    expect(steps.status()).toBe(200);
    expect((await page.request.post(`/api/campaigns/${id}/enroll`, { data: { query: "fay@c2-archive.test" } })).status()).toBe(200);

    // Only a finished campaign can be archived.
    await page.goto(`/campaigns/${id}`);
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Start campaign" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Start campaign" }).click();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Mark completed" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark completed" }).click();
    const archive = page.getByRole("button", { name: "Archive", exact: true });
    await expect(archive).toBeVisible();
    await archive.click();
    await page.getByRole("dialog").getByRole("button", { name: "Archive campaign" }).click();
    await expect(page.getByText("Campaign archived.")).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Unarchive" })).toBeVisible();

    // The default list hides it. The Archived and All filters show it.
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: "Active", exact: true })).toHaveAttribute("aria-current", "true");
    await expect(page.getByRole("link", { name: NAME })).toHaveCount(0);
    await page.getByRole("link", { name: "Archived", exact: true }).click();
    await expect(page).toHaveURL(/show=archived/);
    const row = page.getByRole("row", { name: new RegExp(NAME) });
    await expect(row).toContainText("Archived");
    await page.getByRole("link", { name: "All", exact: true }).click();
    await expect(page.getByRole("link", { name: NAME })).toBeVisible();

    // An archived campaign cannot be started again, even by a direct call.
    const restart = await page.request.post(`/api/campaigns/${id}/status`, { data: { status: "active" } });
    expect(restart.status()).toBe(409);

    // Unarchive from the campaign page and it is back in the default list.
    await page.getByRole("link", { name: NAME }).click();
    await page.getByRole("button", { name: "Unarchive" }).click();
    await expect(page.getByText("Campaign unarchived.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Archive", exact: true })).toBeVisible();
    await page.goto("/campaigns");
    await expect(page.getByRole("link", { name: NAME })).toBeVisible();
    await page.getByRole("link", { name: "Archived", exact: true }).click();
    await expect(page.getByText("No archived campaigns")).toBeVisible();
  });
});
