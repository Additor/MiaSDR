# Changelog

MiaSDR follows [Semantic Versioning](https://semver.org). Before 1.0, a minor version can change behavior or the database schema; the release notes say when.

## 0.1.0 (unreleased)

First public release.

- Leads: CSV and XLSX import with column mapping, custom fields, filters, export and do-not-contact.
- Campaigns: email sequences from Google Workspace mailboxes and LinkedIn steps through Unipile, with working hours, daily limits and a send pause.
- Replies stop outreach on every channel. AI classifies each reply and drafts an answer that a person approves.
- Inbox for conversations, and Actions as a queue of work waiting on a person, with assignment.
- CRM: contacts, companies with merge, deals on a pipeline board.
- Tables: a spreadsheet with formulas, enrichment and AI columns. Enrichment calls Hunter, ZeroBounce, MillionVerifier, NeverBounce, Findymail, Prospeo, LeadMagic, Apollo and People Data Labs natively, and vendors that share an action line up in a waterfall.
- Self-hosting with Docker Compose and Postgres 17.
