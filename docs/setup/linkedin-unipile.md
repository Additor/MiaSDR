# LinkedIn through Unipile

Status: built. The gateway, engine, webhook route and search queue exist and run against a local stand-in server in tests. Profile lookups ran once against a real Unipile account with a classic LinkedIn profile. A full campaign has not run against a real account, and Sales Navigator lookups are unchecked.

Read [Responsible use](../responsible-use.md) first. LinkedIn prohibits automation and can restrict the profile you connect.

## What Unipile is

Unipile is a hosted API that connects to LinkedIn profiles on your behalf. MiaSDR talks to it behind a `LinkedInGateway` port. You bring your own Unipile subscription. Unipile has no free tier, and LinkedIn is the only paid dependency in MiaSDR. Email works without it.

## Connect

1. In the Unipile dashboard, note the DSN (base URL such as `https://<subdomain>.unipile.com:<port>`) and create an API key. Connect each LinkedIn profile in the Unipile dashboard. MiaSDR has no hosted auth link yet.
2. In MiaSDR open Settings, LinkedIn (an owner or admin). Save the DSN and API key. The page checks the key with `GET /api/v1/accounts?limit=1`, stores the credentials encrypted with `INTEGRATION_CREDENTIALS_KEY`, imports the profiles into your organization and registers the webhooks.
3. Webhooks call `POST /api/webhooks/unipile?org=<organization id>` with a secret header the page generates. Unipile must reach your `APP_URL` from the internet. Without a public URL, replies and accepted invitations do not arrive.
4. DSN hosts under `*.unipile.com` are accepted. For a custom domain, list it in `LINKEDIN_DSN_ALLOWED_HOSTS`.

To try the screens without Unipile, set `LINKEDIN_PROVIDER=fake`. The fake gateway keeps everything in memory.

## Limits

| Limit | Default |
| --- | --- |
| Invitations per day, free profile | 5 |
| Invitations per day, premium profile | 30 |
| Invitations per week | 100 |
| Invitation note | 300 characters after merge fields |
| Gap between invitations | 10 to 20 minutes |
| Gap between messages | 2 to 6 minutes |
| After a LinkedIn rate limit | The profile pauses for 24 hours |

Values saved in the organization's `linkedin` channel settings override these defaults within bounds (free 1 to 50, premium 1 to 100, weekly 1 to 200), and a profile can carry its own daily limit. Working hours apply to LinkedIn too.

## What stops a LinkedIn sequence

A reply, a do-not-contact flag, a manual stop or a campaign pause. An invitation nobody accepts in 30 days ends the lead as `invite_not_accepted`. See [How MiaSDR works](../guides/how-it-works.md).

## Not confirmed yet

- A Sales Navigator or Recruiter account resolving a member. A classic-only account answers these lookups with "Insufficient privileges".
- The `invited_user_id` format against `provider_id`, and first-degree behavior of starting a chat for a profile with no earlier chat.
- Whether Unipile search accepts a cursor in the query for URL searches.
