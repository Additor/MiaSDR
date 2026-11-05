# LinkedIn through Linked API

Read [Responsible use](../responsible-use.md) first. LinkedIn prohibits automation and can restrict the profile you connect.

## What Linked API is

Linked API ([linkedapi.io](https://linkedapi.io)) runs each LinkedIn account in its own cloud browser and works through that account's actions one at a time. You bring your own Linked API plan, with a seat per account. An organization connects one LinkedIn provider at a time. Linked API supports a LinkedIn interface in English, German, Spanish, French or Portuguese.

## Connect

1. In Linked API, create a token.
2. In MiaSDR open Settings, LinkedIn (an owner or admin), choose Linked API as the provider, and save the token.
3. Choose Connect a LinkedIn account, and sign in at Linked API in the tab it opens. Keep the settings page open, or come back to it. A link lasts 60 minutes, and only one can be open at a time.

**MiaSDR adds every LinkedIn account on the token and reads its messages.** Replies appear in the Inbox, including messages unrelated to a campaign. Give MiaSDR a token that holds only the accounts you want here.

## Set each account's working hours

In Linked API, set each account's working-hours window to cover its hours in MiaSDR, with the off-hours policy on Run anyway. Linked API's syncs stop outside that window under every policy, and its documents call round-the-clock activity the strongest automation signal.

MiaSDR cannot read this setting. If Linked API holds an action for its window, MiaSDR cancels the action and pauses the account for an hour.

## How it differs from the other providers

- **Sends finish later.** A campaign send or a reply shows as sending until Linked API runs it, which takes under a minute on an idle account and longer behind a queue. `linkedin.settle-operations` reads the outcome every tick.
- **One action at a time.** An account starts nothing new until its action settles. A search can hold it for up to an hour, and a reply a person sends can wait behind that.
- **An action still waiting after an hour is cancelled.** An invitation or lookup then counts a failed try and retries later. A message becomes unknown, and a person settles it, because it may have gone out.
- **Replies and acceptances are read, not pushed.** `linkedin.poll-inbound` reads what Linked API captured about every 10 minutes, inside each account's working hours. Its documents state no sync period, so **a reply can arrive late by an amount nobody can name here**. Until it arrives, the next message can go out. An account sends nothing until a read finished in the last 15 minutes, but that measures the read, not how fresh Linked API's capture is.
- **Monitoring is switched on for you.** The first read of an account starts inbox and network monitoring, and that account sends nothing until both finished. If someone switches monitoring off in Linked API later, reads answer empty and MiaSDR cannot tell.
- **Reconnecting.** A signed-out account shows as disconnected, with a Reconnect link. MiaSDR keeps its leads and threads, whether or not Linked API gives it a new id. Nothing written while it was gone is captured, so MiaSDR reads a lead's thread before its next campaign message. An email step or another account's message can still go out before that look. A second look at one person within 24 hours can answer before it read the thread, so two reconnects in a day can miss a reply. An acceptance during the gap is never captured, and that lead ends at the 30-day expiry.
- **A lapsed seat.** A frozen account shows as disconnected, and Reconnect refuses it. Renew the seat in Linked API, then choose Sync accounts.
- **Messages.** At most 1,900 characters. InMail and the Sales Navigator inbox are out.
- **A lost send.** If Linked API's answer to a send was lost, a message waits for a person, and an invitation retries after the grace period. Linked API has no idempotency key, so this relies on LinkedIn refusing a repeat invitation as a duplicate.
- **Searches.** LinkedIn and Sales Navigator people search URLs, read once each. Sales Navigator needs a seat on that account and a Linked API Plus seat. One read takes at most 1,000 people on LinkedIn and 2,500 on Sales Navigator, and at most what is left of the account's search allowance today. A search that wants more finishes with a note saying so, so raise the allowance or split it into narrower URLs. With under 10 left on every free account, it waits until one has room. A read that needs over an hour never finishes, so keep URLs narrow until you know how fast your account reads.
- **Recruiter leads.** Not reachable.
- **Moving a profile.** A profile connected through another provider cannot move to Linked API.

## Limits

MiaSDR turns Linked API's own limits off when an account connects through its link, so **MiaSDR's limits are the only gate**. MiaSDR has no daily limit on profile lookups, only on the invitations they lead to. An account connected in Linked API's dashboard may keep its limits on, and a refusal then holds invitations or the account as below.

A new account starts at 5 invitations a day, because Linked API reports no Premium flag. Tick Premium on the account to raise it, and a sync leaves your choice alone.

When Linked API refuses an invitation or a lookup for a limit, MiaSDR holds invitations and lookups for a day, or an hour when LinkedIn refused the request itself. Messages and replies go on. When it refuses a message for a limit, the account pauses. When LinkedIn limits notes on invitations, invitations wait a day, because MiaSDR does not drop a note someone wrote.

## Disconnect

Disconnecting deletes the saved token and marks the Linked API accounts disconnected. The accounts stay connected in Linked API, and it keeps billing their seats until you remove them there.
