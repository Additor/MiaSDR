# Apollo setup (enrichment)

MiaSDR calls Apollo from Tables enrichment columns with your own Apollo API key. [Enrichment providers](enrichment.md) covers the other vendors and how to combine them in a waterfall. The key is saved per organization, encrypted with `INTEGRATION_CREDENTIALS_KEY`, and never appears in cell results, audit rows or logs.

## Credits

Apollo bills by credit. Revealing a work email or other person data uses 1 credit per match, and a company lookup uses 1 credit. The free plan has a small monthly allowance, and Apollo requires a work email on the account for free API use. A match that Apollo rates `none` costs nothing, and MiaSDR shows it as "Not found". MiaSDR never asks Apollo for phone numbers or personal emails, so the extra credits for those never apply.

Apollo's rate limits are per team and per endpoint. The free plan allows 50 requests a minute, 200 an hour and 600 a day. When Apollo answers 429 it sends a `retry-after` in seconds, and MiaSDR schedules the cell to run again after that wait (one minute when the header is missing, one hour at most). The provider's rate limit (`rateLimitPerMin`) has no field in the UI yet. Set it with `PATCH /api/grid/providers/<id>` to stay under your plan.

## Connect

1. In Apollo, open Settings, Integrations, API and create an API key. A master key is not required for the two actions below.
2. In MiaSDR, open a table, press Enrichment, then "Connect or manage providers", press Connect on Apollo and paste the key. Every other vendor's key goes in the same place, and Settings, Integrations does not list either of them (it holds the AI provider keys only). MiaSDR checks the key with `GET https://api.apollo.io/api/v1/auth/health` before it saves anything. A rejected key is not stored.
3. Optionally set a price in cents per call (`defaultCostCents`) with `PATCH /api/grid/providers/<id>`. The UI has no field for it, and Apollo credits are not money, so MiaSDR cost totals use this number.

## Actions

| Action | Apollo call | Inputs | Outputs |
| --- | --- | --- | --- |
| Enrich person | `POST /api/v1/people/match` | An email, or a LinkedIn URL, or a full name with a company domain | Work email, email status, title, company, LinkedIn URL, match confidence |
| Enrich company | `GET /api/v1/organizations/enrich?domain=` | Company domain | Name, industry, employees, website, LinkedIn URL, city, country |

## Errors

| Apollo status | MiaSDR treats it as |
| --- | --- |
| 401, 403 | The key is wrong or lacks access. The cell fails and is not retried. |
| 422 | The input is not enough for Apollo. The cell fails and is not retried. |
| 429 | Rate limit. The cell waits for `retry-after`, then runs again. |
| 5xx, timeout | Temporary. The cell retries with backoff. |

## Verification status

Written from docs.apollo.io (people enrichment, organization enrichment, rate limits, authentication) on 2026-10-16. No live call has been made. The `auth/health` response for a bad key is not documented, so the check treats 401 and 403 as rejected and also treats a body with `is_logged_in: false` as rejected.
