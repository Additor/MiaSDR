import { devFakes, signOut, alertWith, makeRoomForSignIns, expect, test, waitForEmailLink } from "./support/fixtures";

const USER = { email: "bea@e2e-corp.test", oldPassword: "bea-password-1", newPassword: "bea-new-password-2" };

test.describe("password reset", () => {
  test.beforeEach(async ({ page }) => {
    await signOut(page);
  });

  test("a reset link sets a new password once and signs out every device", async ({ page, watch }) => {
    watch.tolerate(/response 401: POST .*\/api\/auth\/sign-in\/email/, /Failed to load resource.*401/);

    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await page.getByLabel("Email").fill(USER.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(`If an account exists for ${USER.email}, we sent a link`)).toBeVisible();

    const link = await waitForEmailLink(USER.email, "Reset your MiaSDR password");
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?token=/);

    // Validation runs in the page before any request.
    await page.getByLabel("New password", { exact: true }).fill(USER.newPassword);
    await page.getByLabel("Confirm password").fill("something-else-3");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(alertWith(page, "The passwords do not match.")).toBeVisible();

    await page.getByLabel("Confirm password").fill(USER.newPassword);
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(page.getByText("Password updated")).toBeVisible();

    // The link works once.
    await page.goto(link);
    await expect(page.getByText("Link expired")).toBeVisible();
    await expect(page.getByRole("link", { name: "Request a new link" })).toBeVisible();

    // The old password no longer works, the new one does.
    await makeRoomForSignIns(page, 2);
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(USER.email);
    await page.getByLabel("Password").fill(USER.oldPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alertWith(page, "Invalid email or password.")).toBeVisible();
    await page.getByLabel("Password").fill(USER.newPassword);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/leads$/);
  });

  test("an unknown address gets the same answer as a known one", async ({ page }) => {
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill("nobody@e2e-corp.test");
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText("If an account exists for nobody@e2e-corp.test, we sent a link")).toBeVisible();
  });

  test("the e2e reset clears the sign-in rate limit that a spec file shares with the server", async ({ request }) => {
    const attempt = () => request.post("/api/auth/sign-in/email", { data: { email: "nobody@e2e-corp.test", password: "wrong-password-1" } });
    await devFakes(request, { action: "resetRateLimits" });
    for (let i = 0; i < 3; i++) expect((await attempt()).status()).toBe(401);
    expect((await attempt()).status(), "the fourth attempt inside 10 seconds").toBe(429);
    await devFakes(request, { action: "resetRateLimits" });
    expect((await attempt()).status(), "after the reset").toBe(401);
    await devFakes(request, { action: "resetRateLimits" });
  });

  test("a forged token shows the expired page", async ({ page, watch }) => {
    watch.tolerate(/response 400: POST .*\/api\/auth\/reset-password/, /Failed to load resource.*400/);
    await page.goto("/reset-password?token=not-a-real-token");
    // The form appears, the server rejects the token on submit.
    await page.getByLabel("New password", { exact: true }).fill("whatever-pass-1");
    await page.getByLabel("Confirm password").fill("whatever-pass-1");
    await page.getByRole("button", { name: "Update password" }).click();
    await expect(alertWith(page, "invalid, expired or already used")).toBeVisible();
  });
});
