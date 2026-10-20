## What this changes

<!-- What the code does now that it did not before, and why. Link the issue if there is one. -->

## How you checked it

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass
- [ ] Integration tests ran against a migrated Postgres 17 (`TEST_DATABASE_URL`), or the change touches no database code
- [ ] A bug fix comes with a test that fails without the fix
- [ ] A schema change has a new migration and a test over existing data
- [ ] `docs/decisions.md` and the user docs describe the new behavior
- [ ] Screens follow DESIGN.md (attach a screenshot for UI changes)
