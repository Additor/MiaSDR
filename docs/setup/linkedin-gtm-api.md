# LinkedIn through gtm-api

Status: built, and not yet run against a real gtm-api account from MiaSDR. The adapter is tested against answers written from gtm-api's OpenAPI document, none recorded live. Read [Responsible use](../responsible-use.md) first. LinkedIn prohibits automation and can restrict the profile you connect.

## What gtm-api is

gtm-api ([gtm-api.com](https://gtm-api.com)) runs each LinkedIn account in its own cloud browser. You bring your own gtm-api team. An organization connects one LinkedIn provider at a time.

## Connect

1. In gtm-api, connect your LinkedIn accounts. This step only works in gtm-api's app, and each account takes a while to finish its first sync.
2. Create an API key there.
3. In MiaSDR open Settings, LinkedIn (an owner or admin), choose gtm-api as the provider, and save the key.
4. Choose Sync accounts. Accounts still on their first sync appear on a later sync, which also runs every hour.

**MiaSDR adds every LinkedIn account in the key's team and reads its messages.** Replies appear in the Inbox, including messages unrelated to a campaign. Give MiaSDR a team that holds only the accounts you want here.

## Set how often gtm-api syncs

Replies and acceptances reach MiaSDR only as fast as gtm-api stores them, and MiaSDR does not change these settings for you. For each account in gtm-api:

- Set the inbox (`conversations`) to 15 minutes and invitations (`connection_requests`) to 60 minutes. The defaults are 180 and 720.
- Make the sync window cover the account's working hours in MiaSDR. The default is Monday to Friday, 09:00 to 18:00.

Realtime delivery, which stores a reply in about 8 seconds while the account's browser runs, needs a paid plan. The free plan syncs each account once a day.

## How it differs from Unipile

- **Replies and acceptances are read, not pushed.** `linkedin.poll-inbound` reads what gtm-api has stored about every 10 minutes, inside each account's working hours.
- **An account sends nothing while gtm-api's sync has stalled.** A read fails when the inbox last synced over 25 hours ago, or the sync waits on a limit or a browser problem. Sending stops until a read finishes. The page shows this on the account.
- **A campaign message checks the thread first.** gtm-api reads the thread from LinkedIn before each campaign message and refuses it if the person wrote after outreach began. MiaSDR then stops all outreach to that person, as a filed reply does. An agent's reply gets the same check against when its draft was written. A reply a person sends does not, and how the check behaves for someone with no thread yet is not documented.
- **What the check does not cover.** It reads this account's thread only. Until a refusal or a read shows the reply, a message from another account or an email step can still go out. An invitation has nothing to check. On the free plan that can take up to a day. A reply from a lead who accepted on LinkedIn stays unfiled until gtm-api syncs it.
- **Acceptances can be late.** A lead accepting shows up after gtm-api's next invitations sync: 12 hours by default, 1 hour at the shortest, a day on the free plan.
- **Sends cannot go out twice under one send.** Each send carries a `client_reference`, so a retry gets the first answer back. A send whose outcome stays unknown waits and is checked again.
- **Sign-ins.** A signed-out account shows as disconnected. Sign in again in gtm-api, then choose Sync accounts. MiaSDR has no sign-in link for gtm-api.
- **Searches.** LinkedIn and Sales Navigator people search URLs. Sales Navigator needs a seat on that account. A search LinkedIn's monthly limit cuts short shows as failed.
- **Recruiter leads.** Not reachable.
- **Moving a profile.** A profile connected through another provider cannot move to gtm-api.

## Limits

MiaSDR's own limits apply, and new premium accounts start at 20 invitations a day. gtm-api's smart limits stay on, and MiaSDR does not change them. Its warm-up starts a new account below its usual budgets (25 invitations and 50 messages a day on a paid plan, 5 and 10 on the free plan).

When gtm-api refuses an invitation or a profile lookup for a limit, MiaSDR holds invitations and lookups until the time gtm-api names. Messages and replies go on. When it refuses a message for a limit, the account pauses until that time.

## Disconnect

Disconnecting deletes the saved key and marks the gtm-api accounts disconnected. The accounts stay connected in gtm-api, and it keeps syncing and billing them until you remove them there.
