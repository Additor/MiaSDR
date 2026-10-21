# Enrichment providers

Tables enrichment columns call data vendors with your organization's own API keys. This page covers the vendors MiaSDR calls natively, how to line several of them up in a waterfall, and what each one costs and returns. Apollo has its own page with more detail: [Apollo setup](apollo.md).

## Vendors

| Vendor | Actions | Key check (spends nothing) | A call is free when |
| --- | --- | --- | --- |
| Hunter | Verify email, Find work email, Find emails by company | `GET /v2/account` | Hunter's plan decides |
| ZeroBounce | Verify email | `GET /v2/getcredits` | The verdict is unknown |
| MillionVerifier | Verify email | `GET /api/v3/credits` | The verdict is unknown or catch-all (refunded as credits) |
| NeverBounce | Verify email | `GET /v4.2/account/info` | NeverBounce does not document it |
| Findymail | Find work email | `GET /api/credits` | Nothing is found |
| Prospeo | Find work email | `GET /account-information` | Nothing is found, or Prospeo marks it a free enrichment |
| LeadMagic | Find work email | `GET /v1/credits` | Nothing is found |
| Apollo | Enrich person, Enrich company | `GET /api/v1/auth/health` | The match confidence is `none` |
| People Data Labs | Enrich person, Enrich company | `GET /v5/autocomplete` | Nothing matches (HTTP 404) |

Every vendor has a fixed host, so none needs an entry in `GRID_HTTP_ALLOWED_HOSTS`. For any other vendor, use the Custom HTTP API provider and allow-list its host.

MiaSDR records a call that the vendor does not bill at 0 cents. Every other call costs the price you set on the provider (`defaultCostCents`, 0 by default), because vendor credits are not money.

## Connect a vendor

1. Create an API key in the vendor's dashboard.
2. In MiaSDR, open a table, press Enrichment, then "Connect or manage providers". Press Connect on the vendor and paste the key. Owners and admins can do this.
3. MiaSDR checks the key with the vendor's key-check call before it saves anything. A rejected key is not stored. The key is encrypted with `INTEGRATION_CREDENTIALS_KEY` and never appears in cells, audit rows or logs, in any encoding.

Some vendors block a key after repeated failed checks: ZeroBounce after 200 bad-key calls in an hour, LeadMagic after 10 in ten minutes. MiaSDR checks once per save and never retries a check.

## Shared actions and waterfalls

Vendors that offer the same action take the same inputs and fill the same columns, so you can line them up in a waterfall. A waterfall tries each step in order and stops at the first hit.

| Action | Inputs | Columns every vendor fills |
| --- | --- | --- |
| Verify email | Email | Status, Provider status, Score |
| Find work email | Full name, Company domain | Work email, Confidence, Verification status |
| Enrich person | Email, or LinkedIn URL, or Full name with Company domain | Work email, Title, Company, LinkedIn URL |
| Enrich company | Company domain | Company name, Industry, Employees, Website, LinkedIn URL, City, Country |

A vendor can add columns of its own, such as ZeroBounce's Sub-status or Hunter's Position. Those columns stay empty when another step of the waterfall answers.

In the Enrichment dialog, choose Waterfall. "Start from" offers Verify email and Find work email with every connected vendor that has the action. After the first step, the dialog lists only vendors that offer the first step's action.

## Verification status

Every verifier's answer maps to one Status. The vendor's own word stays in Provider status.

| Status | Hunter | ZeroBounce | MillionVerifier | NeverBounce |
| --- | --- | --- | --- | --- |
| valid | valid, webmail | valid; do_not_mail with sub-status role_based | ok | valid |
| invalid | invalid | invalid, spamtrap, abuse, other do_not_mail | invalid | invalid |
| disposable | disposable | do_not_mail with sub-status disposable | disposable | disposable |
| catch_all | accept_all | catch-all; do_not_mail with sub-status role_based_catch_all | catch_all | catchall |
| unknown | unknown and anything else | unknown | unknown | unknown |

Valid, invalid and disposable settle an address, so a verification waterfall stops there. Catch-all and unknown move on to the next verifier. When no step settles the address, the cell shows the first catch-all or unknown verdict and its columns, marked as a miss, so you keep the answer you paid for.

Find work email vendors return Confidence from 0 to 100 when they have one (Hunter's score); the others return verified emails only and leave Confidence empty.

## People Data Labs and personal data

MiaSDR asks People Data Labs for work fields only (work email, job title, company, LinkedIn URL), so personal emails, phone numbers and home addresses never arrive. A person match needs a likelihood of 6 or more; PDL's default of 2 means a 10 to 30 percent chance of the right person. On PDL's free plan contact fields come back as true or false, and MiaSDR leaves the email empty.

## Rate limits

A new provider starts with the vendor's published per-minute limit where there is one: Prospeo 300 (Starter plan), LeadMagic 600 and People Data Labs 100 (free plan, person lookups). Others start without a limit. Change it with `PATCH /api/grid/providers/<id>` and `rateLimitPerMin` to match your plan. When a vendor answers 429, the cell waits for its `retry-after` and runs again.

## Errors

| Answer | MiaSDR treats it as |
| --- | --- |
| 401, 403, or a body that says the key is wrong | The key is wrong. The step fails and is not retried. |
| 402, or a body that says the credits ran out | Out of credits. The step fails and a waterfall moves on. |
| 429, 5xx, timeout, Hunter's 202 and 222 | Temporary. The cell retries, and steps that already missed are not asked again. |
| Any other 4xx | The input is wrong for that vendor. The step fails. |

ZeroBounce, MillionVerifier and NeverBounce can report errors with HTTP 200; MiaSDR reads the body. Prospeo reports most errors with HTTP 400 and an error code.

## Verification of these adapters

Each adapter was written from the vendor's public API docs on 2026-10-20 (2026-10-16 for Apollo), and its tests use the response samples those docs show. Each adapter file in `src/contexts/grid/infrastructure/vendors` names the pages it follows.

On 2026-10-20 the seven newer vendors were called live with an invalid key. Every key check answered "rejected", and every call failed as a permanent error with the vendor's own text, which confirms the hosts, paths, key placement and bad-key handling. NeverBounce repeats the key in that text; MiaSDR removes it before anything is stored.

MillionVerifier also publishes a test key (`API_KEY_FOR_TEST`) that answers with random verdicts and `livemode: false`. Its invalid, unknown, catch-all and disposable bodies match the shapes MiaSDR reads. MiaSDR fails a test-mode answer, so a random verdict never fills a cell. The test key gave no ok verdict, and the credits endpoint refuses it, so MillionVerifier's valid answer and key check rest on the docs too.

No vendor has run with a paid key yet. Their success shapes rest on the docs.

To check a vendor with your own key, run the smoke script. Each call spends at most one credit, and a vendor without a key is skipped:

```bash
SMOKE_ZEROBOUNCE_KEY=... SMOKE_PROSPEO_KEY=... pnpm vitest run -c scripts/smoke/vitest.config.mts
```

`SMOKE_EMAIL`, `SMOKE_NAME` and `SMOKE_DOMAIN` set the inputs. The script checks the key, makes one call per action, and asserts that the answer has every shared column and carries no form of the key.
