import { ADMIN, MOBILE_DARK, expect, expectNoHorizontalOverflow, signInAs, test } from "./support/fixtures";

test.describe("first-run setup and onboarding", () => {
  test.use({ timezoneId: "Europe/Berlin" });

  test("an empty instance sends the visitor to setup, then walks the checklist", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/setup$/);

    await page.getByLabel("Your name").fill(ADMIN.name);
    await page.getByLabel("Email").fill(ADMIN.email);
    await page.getByLabel("Password").fill(ADMIN.password);
    await page.getByLabel("Organization").fill(ADMIN.organization);
    await page.getByRole("button", { name: "Create admin" }).click();

    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("main").getByText("1 of 5 required steps done")).toBeVisible();
    // The browser time zone was saved at setup, so the profile step reads as done.
    await expect(page.getByText("Time zone saved")).toBeVisible();

    // The next step's one action is the filled Next link above the list.
    await page.getByRole("link", { name: "Next: Connect a mailbox" }).click();
    await expect(page).toHaveURL(/\/settings\/mailboxes$/);
    await page.getByLabel("Email address").fill("sdr@e2e-corp.test");
    await page.getByLabel("Sender name (optional)").fill("Sam from E2E");
    await page.getByRole("button", { name: "Connect mailbox" }).click();
    await expect(page.getByText("sdr@e2e-corp.test")).toBeVisible();

    await page.goto("/onboarding");
    await expect(page.getByRole("main").getByText("2 of 5 required steps done")).toBeVisible();
    await expect(page.getByText("1 mailbox connected")).toBeVisible();

    await page.getByRole("button", { name: "Hide setup guide" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Hide setup guide" }).click();
    await expect(page).toHaveURL(/\/actions$/);
  });

  test("a second setup is refused once an admin exists", async ({ page, watch }) => {
    watch.tolerate(/409/);
    const res = await page.request.post("/api/setup", {
      data: { name: "Eve", email: "eve@e2e-corp.test", password: "another-pass-1", organizationName: "Other", timeZone: "UTC" },
    });
    expect(res.status()).toBe(409);
    // The page itself sends a visitor on to sign-in once an admin exists.
    await page.goto("/setup");
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe("smoke at 390x844 in dark mode", () => {
  test.use(MOBILE_DARK);

  test("sign-in and onboarding render without overflow", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expect(page.locator("html")).toHaveClass(/dark/);
    await signInAs(page);
    await page.goto("/onboarding");
    await expect(page.getByRole("main").getByText(/required steps done/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});
