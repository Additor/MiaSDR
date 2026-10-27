# Changelog

MiaSDR follows [Semantic Versioning](https://semver.org). Before 1.0, a minor version can change behavior or the database schema; the release notes say when.

## 0.1.0 (unreleased)

First public release.

- Leads: CSV and XLSX import with column mapping, custom fields, filters, export and do-not-contact.
- Campaigns: email sequences from Google Workspace mailboxes and LinkedIn steps through Unipile, with working hours, daily limits and a send pause.
- Replies stop outreach on every channel. The AI picks a reply type for each reply and drafts an answer that a person approves.
- Reply types: each type sits in one of four groups (Interested, Existing customer, Not interested, Other) and carries three rules, Check, Reply draft and Follow-ups, edited in Settings > Reply handling. A type set to Don't write skips step 1 of follow-ups after a reply.
- Confidence floor: an AI pick below it waits for a person, whatever its type's Check says.
- AI picks: the thread's type line, the AI picks history and the Actions section show each pick with Accept, Looks right or Undo. Each pick keeps a copy of the rules it used.
- Stop requests: a reply that asks to stop waits for a person under Review stop request, which opens Stop contacting. A reply type change never marks anyone do not contact.
- Schema: migration 0002 renames the reply taxonomy tables, columns and event types (`reply_types`, `reply_type_sets`, `reply_type_picks`, `reply_handling_settings`, `reply_type.changed`, `reply_type_pick.*`). Migration 0003 adds the type rules (`check_mode`, `reply_draft`, `follow_ups`, `system_role`) and `reply_type_picks.rules`, and drops `stage_rank` and the review settings.
- Inbox for conversations, and Actions as a queue of work waiting on a person, with assignment.
- CRM: contacts, companies with merge, deals on a pipeline board.
- Tables: a spreadsheet with formulas, enrichment and AI columns. Enrichment calls Hunter, ZeroBounce, MillionVerifier, NeverBounce, Findymail, Prospeo, LeadMagic, Apollo and People Data Labs natively, and vendors that share an action line up in a waterfall.
- Self-hosting with Docker Compose and Postgres 17.
