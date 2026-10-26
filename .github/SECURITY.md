# Security policy

## Reporting a vulnerability

Report a vulnerability privately. Do not open a public issue or pull request that describes it.

Use the private vulnerability reporting of the host that serves this repository (on GitHub: Security, then Report a vulnerability). If the host has no such feature, email the repository owner at the address on their profile and ask for a private channel before you send details.

Include:

- the affected version or commit,
- steps to reproduce, with the smallest example you can build,
- what an attacker gains,
- whether you saw the issue on a running instance (do not test an instance you do not own).

## What to expect

These are targets for a project with one maintainer, not guarantees.

| Step | Target |
| --- | --- |
| Acknowledge your report | 3 working days |
| First assessment (accepted, needs more information, or out of scope) | 10 working days |
| Fix or mitigation for a confirmed high-severity issue | 30 days |

We credit you in the fix notes if you want that. We ask you to hold disclosure until a fix ships or 90 days pass, whichever comes first.

## Scope

In scope: this repository's code, its Docker image and Compose files, and the default configuration they produce. Examples: authentication and session handling, cross-organization data access, credential storage, unsubscribe and webhook endpoints, the job tick endpoint, SSRF through enrichment providers, injection through imported data.

Out of scope:

- vulnerabilities in Google, Unipile, Anthropic, Resend or another service MiaSDR calls (report to that vendor),
- an instance whose owner turned off a protection (for example `AUTH_SIGNUP=open`, a weak `CRON_SECRET`, or a public database),
- denial of service by sending large volumes of traffic,
- missing hardening that needs a privileged position (root on the host, a leaked `.env`),
- social engineering of the maintainer or of an instance's users.

## Safe harbor

We treat good-faith research that follows this policy as authorized. Stay within your own instance and test data, do not read or change another person's data, do not degrade service for others, and give us time to fix before you disclose. We will not start legal action against research that meets these terms.

## Operating an instance safely

Instance owners protect their own deployment. The key points are in [Self-hosting](../docs/deploy/self-host.md) and [Operations](../docs/operations.md): generate every secret with `openssl rand -hex 32`, keep `.env` at mode `600`, back up `INTEGRATION_CREDENTIALS_KEY` off the server, serve the app over HTTPS, keep `AUTH_SIGNUP=invite-only`, and restrict mailbox domains with `MAILBOX_ALLOWED_DOMAINS`.
