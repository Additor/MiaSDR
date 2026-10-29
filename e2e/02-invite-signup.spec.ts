import { signOut, alertWith, makeRoomForSignIns, expect, signInAdmin, signInAs, test, waitForEmailLink } from "./support/fixtures";

const INVITEE = { name: "Bea Member", email: "bea@e2e-corp.test", password: "bea-password-1" };

test.describe("invite and sign-up", () => {
  test("an admin invites a member, who signs up, confirms the email and joins", async ({ page, watch }) => {
    watch.tolerate(/response 403: POST .*\/api\/auth\/sign-in\/email/, /Failed to load resource.*403/);
    await signInAdmin(page);
    await page.goto("/settings/members");
    await page.getByLabel("Email address").fill(INVITEE.email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByRole("status")).toContainText(`Invitation created for ${INVITEE.email}`);
    const link = await page.getByLabel("Invitation link").first().inputValue();
    expect(link).toMatch(/\/accept-invitation\/[0-9a-f-]{36}$/);

    // The invitee has no session.
    await signOut(page);
    await page.goto(new URL(link).pathname);
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(INVITEE.email);
    await expect(page.getByLabel("Email")).toHaveAttribute("readonly", "");
    await page.getByLabel("Name").fill(INVITEE.name);
    await page.getByLabel("Password").fill(INVITEE.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(`If ${INVITEE.email} can join, a confirmation link is on its way.`)).toBeVisible();

    // Signing in before the address is confirmed is refused.
    await makeRoomForSignIns(page, 1);
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(INVITEE.email);
    await page.getByLabel("Password").fill(INVITEE.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(alertWith(page, "Confirm your email first")).toBeVisible();

    const confirm = await waitForEmailLink(INVITEE.email, "Confirm your email");
    await page.goto(confirm);
    await expect(page).toHaveURL(/\/accept-invitation\//);
    await page.getByRole("button", { name: "Accept invitation" }).click();
    await expect(page).toHaveURL(/\/actions$/);

    // A member sees the members page without the invite form.
    await page.goto("/settings/members");
    await expect(page.getByText("Only an owner or admin can invite people or change roles.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send invitation" })).toHaveCount(0);

    // The admin sees the new member and no pending invitation.
    await signOut(page);
    await signInAs(page);
    await page.goto("/settings/members");
    await expect(page.getByText(INVITEE.email).first()).toBeVisible();
    await expect(page.getByLabel(`Role of ${INVITEE.email}`)).toBeVisible();
    await expect(page.getByText("No pending invitations")).toBeVisible();
  });

  test("an uninvited address cannot sign up", async ({ page }) => {
    await signOut(page);
    await page.goto("/sign-up");
    await expect(page.getByText("Invitation only")).toBeVisible();
  });
});
