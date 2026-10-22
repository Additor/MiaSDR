# Responsible use

MiaSDR sends email and LinkedIn messages for you. You decide who receives them, so you carry the legal and account risk. This page lists what to check before you send. It is a checklist, not legal advice. Ask a lawyer about your own case, especially for recipients in the EU, the UK or Canada.

## LinkedIn terms and account risk

LinkedIn's User Agreement prohibits automated activity such as bots and scripts that send invitations or messages. MiaSDR drives LinkedIn through Unipile, a third-party gateway, and LinkedIn can detect it. The result can be a warning, a temporary restriction or a permanent ban of the profile. A banned profile loses its connections and conversations.

- Use a profile you can afford to lose. Do not connect your only sales profile first.
- Keep the defaults low. A free account sends 5 invitations a day and a premium account 30, with at most 100 a week. Limits are in Settings, LinkedIn. Raising them raises the risk.
- Leave the pacing alone. The app waits 10 to 20 minutes between invitations and pauses an account for 24 hours when LinkedIn rate-limits it.
- Write each invitation note for a person. Many invitations that get ignored or reported make a restriction more likely.
- Unipile bills separately and has its own terms. Read them.

## Email: CAN-SPAM (United States)

CAN-SPAM applies to commercial email, including email to business addresses.

- Do not use a misleading From name, subject or routing information.
- Say the message is an ad when it is one, and include a valid physical postal address. MiaSDR does not add an address. Put it in the signature of each mailbox (Settings, Mailboxes).
- Honor an opt-out within 10 business days. MiaSDR puts an unsubscribe link and the one-click `List-Unsubscribe` header on every email, and a confirmed unsubscribe stops that address in your organization at once.
- You remain responsible for mail that a vendor sends for you.

## GDPR and UK GDPR (EU and UK)

If a recipient is in the EU or UK, you process their personal data (name, address, job title, LinkedIn profile) and need a legal basis. Cold B2B outreach usually relies on legitimate interest, and national rules differ. Some countries require prior consent for email to individuals.

- Record where each lead came from. The import keeps the source and the unmapped columns.
- Tell people who you are and why you contacted them, and how to object. Answer an objection by marking the lead do-not-contact.
- Honor access and erasure requests. You can export leads from Leads, and you can delete a lead that has no sent mail or reply history. A lead with history is refused deletion. You can delete a contact that has no open deal from the contact page. The delete removes the person with their closed deals, notes, tasks, history, conversations, messages, campaign enrollments and sends. Some copies stay after it: audit log rows keep the person id; a suppression row keeps the email on purpose, so the address stays blocked; messages the person sent into another person's conversation stay there; stored inbound event payloads keep the raw provider message; other people's CC rows keep the address; unmatched-sender rows keep the address or profile; LinkedIn connections keep provider ids; and tables keep what their rows hold, including enrichment ledger rows, which keep a paid vendor answer for reuse until the table is deleted. A re-import, a table handoff or a new message brings the person back as a lead. For a lead with history, mark the person do-not-contact and handle the erasure in the database after you check your retention duties.
- Enrichment vendors receive the inputs you map (names, company domains, email addresses) and return data about people. Name the vendors you use in your privacy notice. MiaSDR asks for work data only, never personal emails or phone numbers, and drops People Data Labs matches below a likelihood of 6 (see [Enrichment providers](setup/enrichment.md)).
- Message text, names and company data from replies go to the AI provider you connect when AI is on (Anthropic directly, or a gateway such as Vercel AI Gateway or OpenRouter, which forwards them to the model's provider) (see [How MiaSDR works](guides/how-it-works.md)). Name that processor in your privacy notice.

## CASL (Canada)

CASL requires consent for commercial electronic messages. Express consent is safe. Implied consent applies in narrow cases, for example an existing business relationship, or an address that someone published without a "no unsolicited messages" notice and where the message relates to their role. Each message must identify you, give contact details and offer a working unsubscribe that you honor within 10 business days. Penalties are high. Do not import Canadian recipients without a documented basis.

## Consent and lists

- Send only to people you have a reason to contact. Do not buy or scrape lists you cannot explain.
- Keep proof of consent or of your legal basis next to the lead (a custom field works).
- Add anyone who asks to stop to the suppression list or mark them do-not-contact. Do not re-import them.
- Check the stop-request banner in the Inbox. MiaSDR flags a reply that asks to stop, and a person confirms the suppression.
- Warm up new mailboxes and keep the daily limits low. High complaint rates damage your domain whatever the law says.

## What MiaSDR does and does not do for you

| It does | It does not |
| --- | --- |
| Add an unsubscribe link and one-click header to every email | Add your postal address |
| Skip unsubscribed, bounced, suppressed and do-not-contact addresses | Check that you have consent or a legal basis |
| Stop a sequence on a reply, bounce or unsubscribe | Check the law that applies to a recipient's country |
| Limit daily volume and pace sends | Make LinkedIn automation permitted by LinkedIn |
