# How MiaSDR works

## The loop

A job runner (the tick) runs every 60 seconds. Each tick does these steps in order:

1. **Read inboxes.** For every connected mailbox, the app asks Gmail for new messages since a stored cursor. It does not receive pushes from Google, so a reply can take up to a minute to appear. LinkedIn replies arrive by Unipile webhook.
2. **Apply what it found.** Bounces, replies and auto-replies update leads and campaigns.
3. **Send.** The app claims at most one due email per mailbox, checks the rules below one more time, and sends it through Gmail.

Reading comes before sending in each tick, so a reply that arrived since the last tick stops the next email before it is claimed.

## What stops outreach

Any of these ends a lead's sequence and cancels its unsent steps and unsent drafts.

| Event | Effect |
| --- | --- |
| A real reply on any channel (email or LinkedIn) | The lead's sequence stops in every campaign. The reply lands in the Inbox, except a reply to a Personal LinkedIn campaign (see below). |
| Do-not-contact on the person | Blocks every channel. A person sets it, with a reason, on the lead page, the contact page, the deal page or the Inbox thread, or for many contacts at once from the Contacts bulk bar. |
| Suppression list | An address that unsubscribed, hard-bounced, complained or was added by hand. It blocks email to that address in your organization. |
| Hard bounce | The address goes on the suppression list and its sequences end. |
| Unsubscribe link or one-click header | The address goes on the suppression list and its sequences end. |
| The lead becomes a contact: you create a deal for it, press Make contact on the lead page, or confirm the matching-lead step of Add contact | Its pending and active enrollments end in every campaign with the stop reason "Became a contact", its follow-ups after a reply end, and the app discards their unsent drafts. A contact cannot go back to Leads or join a campaign again, even after you delete its deal. The Create deal and Make contact dialogs name these counts before you confirm. |
| A person pauses or completes the campaign | Nothing more sends from it. A paused campaign releases a send that was reserved but not yet made. |

These do not stop outreach:

- An auto-reply (out-of-office) is counted and the sequence continues.
- A soft bounce is counted only.
- A bounce notice that cannot be tied to a mail you sent, or that fails the sender checks, does not suppress the address. It shows as an unverified bounce for a person to review.
- A reply that asks to stop gets the reply type Asked to stop, held for a check. The thread's type line and the Actions row show "Possible stop request" with Review stop request, which opens Stop contacting. Contact stops only when a person chooses Stop contacting there. The app does not suppress on its own, because quoted text can fake a stop request, and changing a reply type never marks anyone do not contact.

Before each send the app checks the campaign status, the suppression list, do not contact and the enrollment status again, right before the provider call. A reply that lands in the seconds between that check and Gmail's answer cannot be undone, so one more email can go out in that window. The same holds for a conversion: a send the app claimed before the deal and the conversion commit may still go out.

Replies to a Personal LinkedIn campaign stay out of the Inbox, get no AI draft and stay out of Actions and the CRM screens. The campaign creator, owners and admins read them from the campaign's lead list.

## Contacts that start in the CRM

Add contact on Contacts (or on a company page with no contacts) creates a person who is a contact from the start, with an optional deal in the same form. The person never enters a campaign. When a lead with the same email or LinkedIn profile exists, the dialog offers to make that lead a contact instead and keeps the lead's saved details. Add company lists a company in Companies before it has a contact.

## Contact delete and Email suppressed

You can delete a contact from its page once it has no open deal, no send in flight, no campaign send in the last 24 hours and no LinkedIn invitation in the last 7 days. If another member's personal campaign wrote to the contact, the delete falls to that campaign's creator, an owner or an admin. The dialog lists what goes with the contact: closed deals, conversations and messages, notes, tasks, history, enrollments and sends. Campaign reports drop those sends.

The delete keeps the address blocked when the contact was marked do not contact or the address already sat on the suppression list: the dialog reads "{email} stays Email suppressed." An unmarked contact's address leaves no block behind, and a LinkedIn-only do not contact ends with the delete. A new message, a re-import or a table handoff brings the person back as a new lead with no history.

## Reply types

The AI picks a reply type for each reply, such as Meeting requested, Not now or Out of office. Each type sits in one of four groups: Interested, Existing customer, Not interested and Other. You edit the types in Settings > Reply handling. Each type has three rules under "When the AI picks {type}":

- **Check.** Before it applies: the pick waits until a person accepts it. After it applies: the pick applies at once and waits in Actions for Looks right. Skip: nobody checks it.
- **Reply draft.** Write one or Don't write.
- **Follow-ups.** Keep going or Stop, for campaigns that draft follow-ups after a reply.

The Confidence floor in the same page holds any AI pick below it for a person, whatever its Check says. A rule change applies to replies picked from then on, and each pick keeps a copy of the rules it used. Asked to stop always has Check before, Don't write and Stop, and Customer question keeps a person in Existing customer until a person moves them. Neither type can be archived.

You change a conversation's type with Change type on the thread. The dialog says what the change does to the reply draft, follow-ups and contact before you confirm. Picking Asked to stop there asks whether to stop contacting the person too; Only change the type stops nothing.

## Follow-ups after a reply

Each email campaign has a setting, Follow-ups after a reply, on its Settings tab.

- **Off, hand to the Inbox** (default). The campaign writes nothing more for the lead. You answer from the Inbox. The AI still drafts a first reply for reply types set to Write one.
- **AI drafts, you approve.** The campaign has one flow. Step 1, "Reply to their answer", is the draft the AI pick already queued. Each "Follow-up" step waits a number of days, then the AI writes a draft from the step's Goal. A person approves every message. A follow-up flow only creates drafts.

The campaign that most recently emailed the lead owns the conversation. Its flow starts when the AI picks a reply type whose Follow-ups rule is Keep going. A type set to Don't write a reply draft skips step 1, and the later steps still run. A reply, do-not-contact, unsubscribe, bounce, closing reply handling and the lead becoming a contact stop the follow-ups, and so does a move to a reply type set to Stop. The campaign lists those types under "Stops for these reply types". The starter types that stop are Customer question, the Not interested types (Asked to stop, Not now, Already has a tool), Wrong person, Referred someone else, Left company and Out of office. The Inbox thread has Pause follow-ups, Resume, Skip step, Stop follow-ups and Restart follow-ups for one conversation, in its Follow-ups section. A contact gets no follow-ups: for a contact the section shows the controls disabled with "The person is a contact, so follow-ups do not apply." Follow-ups in progress are listed on the campaign's Settings tab, each with a link to its Inbox thread.

Save stores and publishes the flow. New follow-ups use the newest version, and follow-ups already in progress keep the version they started on. Switching back to "Off, hand to the Inbox" stops follow-ups in progress after you confirm. LinkedIn and Personal campaigns stay on the default because follow-up drafts support email only.

A global send pause exists for incidents, see [docs/operations.md](../operations.md).

## What leaves your server

MiaSDR runs on your server and database. It talks to these services, and only when you configure them.

| Service | What it receives | When |
| --- | --- | --- |
| Gmail (Google) | Each outgoing email with its recipient, subject and body. Requests to read new mail in the connected mailboxes. | Mailbox connected |
| Unipile | Your Unipile API key, LinkedIn profile lookups, invitations with their note, messages and search URLs, for the LinkedIn accounts you connect. | LinkedIn connected |
| AI provider (Anthropic, Vercel AI Gateway or OpenRouter) | The inbound message text and thread subject, the lead's name, title and company (and email for some prompts), your knowledge documents, operator instructions and business context, notes left on a reply type change, and the sender name. The grid's AI columns send the cell values their prompt uses. Calls use your organization's own key. A gateway forwards each request to the provider of the model you picked. | An AI provider is connected |
| Resend | Auth emails: invitations, password resets and verification. | `RESEND_API_KEY` and `AUTH_EMAIL_FROM` set. Without them the text goes to the server log. |
| Enrichment providers | The cell values a Tables enrichment sends to the provider you configured. Only the hosts in `GRID_HTTP_ALLOWED_HOSTS` can be called. | You run an enrichment |

Saved credentials stay encrypted in your database with `INTEGRATION_CREDENTIALS_KEY`. The AI adapter does not log message bodies or keys.

Every recipient also gets the unsubscribe link, which points at your own `APP_URL`.

## Who approves what

The AI picks reply types and writes drafts. Only a person can approve and send a reply. Follow-ups after a reply write drafts, and a person approves each one. Campaign emails you write yourself send on their own once you start the campaign.

## Limits you can rely on

- Daily limit per mailbox (1 to 200, default 30), counted in the mailbox's time zone.
- Working hours per mailbox.
- A random gap between sends (18 to 24 minutes by default).
- LinkedIn: 5 invitations a day on a free account and 30 on premium, 100 a week at most, with 10 to 20 minutes between invitations.

Details and tuning are in [Operations](../operations.md).
