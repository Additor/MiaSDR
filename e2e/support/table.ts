import { expect, type Locator } from "@playwright/test";

/**
 * The position of the column whose header reads `header`, counted from 0 across the header row. Header text drops
 * aria-hidden parts such as sort arrows. Waits for the header row to render. A column hidden by CSS still counts, so the position matches the body cells.
 */
export async function columnIndex(table: Locator, header: string): Promise<number> {
  await table.locator("thead th").first().waitFor({ state: "attached" });
  const names = await table.locator("thead tr").first().locator(":scope > th").evaluateAll((cells) =>
    cells.map((cell) => {
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("[aria-hidden]").forEach((el) => el.remove());
      return (copy.textContent ?? "").trim();
    }),
  );
  // A header may add a screen-reader hint after a comma, such as "Deal owner, Owner of the latest deal".
  const index = names.findIndex((name) => name === header || name.startsWith(`${header},`));
  expect(index, `a "${header}" column among ${JSON.stringify(names)}`).toBeGreaterThanOrEqual(0);
  return index;
}

/** The cell of `row` under the column headed `header`. */
export async function cellUnder(table: Locator, row: Locator, header: string): Promise<Locator> {
  return row.locator(":scope > td, :scope > th").nth(await columnIndex(table, header));
}

/** Every body cell under the column headed `header`, top to bottom. */
export async function columnCells(table: Locator, header: string): Promise<Locator> {
  return table.locator(`tbody > tr > :nth-child(${(await columnIndex(table, header)) + 1})`);
}
