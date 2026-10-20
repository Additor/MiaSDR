import type { Page } from "@playwright/test";
import { alertWith, devFakes, ensureMailbox, expect, signInAdmin, signOut, test, waitForEmailLink } from "./support/fixtures";

const NEWBIE = { name: "Dee Pending", email: "dee@e2e-corp.test", password: "dee-password-1" };

async function trySignIn(page: Page) {
  // The sign-ins of earlier tests and the sign-up redirects count against the rate limit, so clear it first.
  await devFakes(page.request, { action: "resetRateLimits" });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(NEWBIE.email);
  await page.getByLabel("Password").fill(NEWBIE.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(alertWith(page, "Confirm your email first")).toBeVisible();
}

test.describe("confirmation dialogs and resend", () => {
  test("cancelling the mailbox disable dialog keeps the mailbox connected", async ({ page }) => {
    await signInAdmin(page);
    const email = "c2-disable@e2e-corp.test";
    const id = await ensureMailbox(page.request, email, "C2 Disable");
    await page.goto("/settings/mailboxes");
    const card = page.getByTestId("mailbox-row").filter({ hasText: email });
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: /^More/ }).click();
    await page.getByRole("menuitem", { name: "Disable", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Disable ${email}?` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(card.getByText("Connected", { exact: true })).toBeVisible();
    await card.getByRole("button", { name: /^More/ }).click();
    await expect(page.getByRole("menuitem", { name: "Disable", exact: true })).toBeVisible();
    const listed = await page.request.get("/api/mailboxes");
    const box = ((await listed.json()) as Array<{ id: string; status: string }>).find((m) => m.id === id);
    expect(box?.status).toBe("connected");
  });

  test("an unverified sign-in offers a new link and unknown addresses get the same answer", async ({ page, watch }) => {
    watch.tolerate(/response 403: POST .*\/api\/auth\/sign-in\/email/, /Failed to load resource.*403/);
    await signInAdmin(page);
    await page.goto("/settings/members");
    await page.getByLabel("Email address").fill(NEWBIE.email);
    await page.getByRole("button", { name: "Send invitation" }).click();
    await expect(page.getByRole("status")).toContainText(`Invitation created for ${NEWBIE.email}`);
    const link = await page.getByLabel("Invitation link").first().inputValue();

    await signOut(page);
    await page.goto(new URL(link).pathname);
    await page.getByRole("link", { name: "Create an account" }).click();
    await page.getByLabel("Name").fill(NEWBIE.name);
    await page.getByLabel("Password").fill(NEWBIE.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(`If ${NEWBIE.email} can join, a confirmation link is on its way.`)).toBeVisible();
    await waitForEmailLink(NEWBIE.email, "Confirm your email");

    await trySignIn(page);
    const resend = page.getByRole("button", { name: "Resend verification link" });
    const known = page.waitForResponse((r) => r.url().includes("/api/auth/send-verification-email"));
    await resend.click();
    await expect(page.getByRole("status").filter({ hasText: `If an account exists for ${NEWBIE.email}, we sent a new link.` })).toBeVisible();
    await expect(resend).toBeDisabled();
    const knownResponse = await known;
    expect(knownResponse.status()).toBe(200);

    // An address with no account gets the identical answer, so the form cannot be used to probe for accounts.
    const unknown = await page.request.post("/api/auth/send-verification-email", { data: { email: "nobody-c2@e2e-corp.test", callbackURL: "/leads" } });
    expect(unknown.status()).toBe(200);
    expect(await unknown.json()).toEqual(await knownResponse.json());
  });
});
