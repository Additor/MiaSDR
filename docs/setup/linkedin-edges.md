# LinkedIn through Edges

Status: built, and not yet run against a real Edges account from MiaSDR. The adapter is tested against recorded answer shapes. Read [Responsible use](../responsible-use.md) first. LinkedIn prohibits automation and can restrict the profile you connect.

## What Edges is

Edges ([edges.run](https://edges.run)) runs LinkedIn actions from its own sessions. In Edges each LinkedIn account is an identity. You bring your own Edges workspace. An organization connects one LinkedIn provider at a time, either Unipile or Edges.

## Connect

1. In Edges, open Settings, Developers. Turn on identity management through the API, and create an API key. Keep the workspace for this MiaSDR organization.
2. In MiaSDR open Settings, LinkedIn (an owner or admin), choose Edges as the provider, and save the key. The page checks it with `GET /v1/workspaces`.
3. Choose Connect a LinkedIn account. MiaSDR creates an identity and opens Edges' sign-in in a new tab. Sign in with the LinkedIn email and password there, and keep the settings page open or come back to it. The link lasts 48 hours.

MiaSDR asks for an engagement identity, which reads without credits, and falls back to a standard one when the workspace has not turned engagement on. On a standard identity, reading the inbox spends credits.

MiaSDR creates the identity in the organization's time zone, because Edges picks the address LinkedIn sees by it. Set the time zone in Settings before connecting. With none set, Edges uses Europe/Paris, and LinkedIn may ask for a check on a sign-in from far away. An identity keeps its zone.

MiaSDR uses only identities connected through this page. Others in the workspace never become accounts here.

## How it differs from Unipile

- **Replies and acceptances are read, not pushed.** Edges has no webhook for messages, so `linkedin.poll-inbound` reads each account about every 10 minutes, inside its working hours.
- **An account sends nothing until a read finished in the last 15 minutes.** This covers a stop request that arrived overnight and reads that keep failing. A campaign message or an agent's reply can still go out up to 15 minutes after a stop request.
- **Messages go to a person.** Edges cannot send into a thread by its id, and only to connections.
- **Invitation notes.** 300 characters at most. LinkedIn Basic accounts get 5 a month, and a refused note fails that lead only.
- **Searches.** Classic LinkedIn people search URLs only. A Sales Navigator URL fails.
- **Sales Navigator and Recruiter leads.** A Recruiter lead cannot be reached. Sales Navigator lookups have not been tried on an Edges account.
- **Moving a profile.** A profile already connected through Unipile cannot move to Edges. MiaSDR refuses it and leaves the Unipile row alone.

## Limits

MiaSDR's own limits for the account apply. Edges keeps quotas of its own that cannot be switched off through its API. When Edges refuses for one, the account pauses for as long as Edges says. A limit with no stated length pauses it for 24 hours. A short one, such as the API's rate limit, pauses it for 5 minutes. Running out of credits holds it for an hour at a time, and the attempt is not used up.

## Disconnect

Disconnecting deletes the saved key and marks the Edges accounts disconnected. It does not delete identities at Edges.
