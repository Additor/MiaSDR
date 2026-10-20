# Quick start

This guide takes you from a running instance to a first email campaign. Install the app first with the [README quick start](../../README.md#quick-start). Read [Responsible use](../responsible-use.md) before you send to real people.

## 1. Create your account and organization

Open the app. A fresh instance sends you to `/setup`. Create the first admin account and your organization. The setup guide at `/onboarding` shows what is connected and what is missing, and you can return to it at any time.

## 2. Connect a mailbox

Campaigns send from mailboxes you connect.

1. Follow [Gmail setup](../setup/gmail.md) once per Google Workspace domain. It creates a service account with domain-wide delegation.
2. Open Settings, Mailboxes and add the address. Set its daily limit, working hours and signature. Put your postal address in the signature.

To try the app without Google, set `MAILBOX_PROVIDER=fake` in `.env` and restart. The fake provider keeps mail in memory and sends nothing.

## 3. Set the rules

Open Settings, Organization and check the default time zone. Set the default phone country (for example `KR`) if your lead files hold numbers without a country code. Open Settings, Email rules to see the gap between sends. The default is 18 to 24 minutes.

## 4. Import leads

1. Open Leads, then Import. Upload a CSV or XLSX file (5 MB, 10,000 rows at most).
2. Check the column mapping. A lead needs an email address or a LinkedIn profile URL.
3. Import. The result screen lists rows that were skipped, merged or warned about. A phone number that cannot be read is ignored with a warning, and the rest of the row is kept.

A lead that matches an existing email or LinkedIn profile updates that lead. It does not create a duplicate.

## 5. Build a campaign

1. Open Campaigns and create an email campaign. On the Sequence tab, write up to 10 steps. These messages send automatically at their time, and a reply, bounce or unsubscribe stops them. Each step has a subject, a body and a wait before the next step. Merge fields such as the first name fill from the lead.
2. Preview the steps. Check that no field renders empty.
3. On the Leads tab, select Add leads and add the leads that match a search (up to 5,000 at a time). The app skips people with no email, unsubscribed addresses, do-not-contact people and people already in the campaign, and reports each count.
4. Select Start campaign. The note under the button links to the responsible-use page.

The campaign sends one email per mailbox per tick inside working hours and the daily limit. It will not start a mailbox's day faster than the gap allows.

## 6. Handle replies

Replies appear in the Inbox (`/inbox`). A reply stops that lead's sequence in the campaign. With an Anthropic key saved under Settings, Integrations, the app classifies each reply and writes a draft. Nothing sends until a person approves it. Without a key you write the reply yourself.

The campaign's Settings tab has an After a reply card. The default, "Stop and hand the conversation to the Inbox", leaves the reply to you. "AI drafts follow-ups for my approval" lets the AI write follow-up drafts for that conversation, and you approve each one before it sends. LinkedIn and Personal campaigns keep the default.

## 7. Watch it run

- Settings, Jobs lists recent runs and failures.
- Analytics shows sends, replies and bounces.
- Campaign pages list each lead's step and status in that campaign.

Next: [How MiaSDR works](how-it-works.md) explains what stops outreach and what data leaves your server.
