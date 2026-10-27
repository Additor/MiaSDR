import type { Locator } from "@playwright/test";
import { expect, settled, signInAdmin, test, waitForHydrated } from "./support/fixtures";

/**
 * Popups open under their trigger with the left edges lined up ("Popups" in DESIGN.md). A mouse opens them: Base UI's
 * Select laid its list over a mouse-opened trigger, so the chosen option in the middle of the list pushed it upward.
 */
async function expectUnder(trigger: Locator, popup: Locator) {
  await settled(popup);
  const [t, p] = [await trigger.boundingBox(), await popup.boundingBox()];
  if (!t || !p) throw new Error("No box for the trigger or the popup.");
  expect(p.y).toBeGreaterThanOrEqual(t.y + t.height);
  expect(Math.abs(p.x - t.x)).toBeLessThan(1);
}

test.describe("popup placement", () => {
  test("a Select whose chosen option sits mid-list opens under its trigger", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/settings/audit-log?area=person");
    const trigger = page.getByRole("combobox", { name: "Area" });
    await waitForHydrated(trigger);
    await trigger.click();
    await expectUnder(trigger, page.locator('[data-slot="select-content"][data-open]'));
  });

  test("a menu opens under its trigger", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/inbox");
    const trigger = page.getByTestId("more-views");
    await waitForHydrated(trigger);
    await trigger.click();
    await expectUnder(trigger, page.locator('[data-slot="dropdown-menu-content"][data-open]'));
  });

  test("a menu whose trigger sits 8px from the viewport edge stays lined up with it", async ({ page }) => {
    await signInAdmin(page);
    await page.goto("/inbox");
    const trigger = page.getByTestId("org-switcher");
    await waitForHydrated(trigger);
    await trigger.click();
    await expectUnder(trigger, page.locator('[data-slot="dropdown-menu-content"][data-open]'));
  });
});
