# Changelog

MiaSDR follows [Semantic Versioning](https://semver.org). Before 1.0, a minor version can change behavior or the database schema; the release notes say when.

## 0.1.0 (unreleased)

First public release.

- Leads: CSV and XLSX import with column mapping, custom fields, filters, export and do-not-contact.
- Campaigns: email sequences from Google Workspace mailboxes and LinkedIn steps through Unipile, with working hours, daily limits and a send pause.
- Replies stop outreach on every channel. The AI picks a reply type for each reply and drafts an answer that a person approves.
- Reply types: each type sits in one of four groups (Interested, Existing customer, Not interested, Other) and carries three rules: Check, Reply draft and Follow-ups. You edit them in Settings > Reply handling. A type set to Don't write skips step 1 of follow-ups after a reply.
- Confidence floor: an AI pick below it waits for a person, whatever its type's Check says.
- AI picks: the thread's type line, the AI picks history and the Actions section show each pick with Accept, Looks right or Undo. Each pick keeps a copy of the rules it used.
- Stop requests: a reply that asks to stop waits for a person under Review stop request, which opens Stop contacting. A reply type change never marks anyone do not contact.
- Schema: migration 0002 renames the reply taxonomy tables, columns and event types (`reply_types`, `reply_type_sets`, `reply_type_picks`, `reply_handling_settings`, `reply_type.changed`, `reply_type_pick.*`). Migration 0003 adds the type rules (`check_mode`, `reply_draft`, `follow_ups`, `system_role`) and `reply_type_picks.rules`, and drops `stage_rank` and the review settings.
- Inbox for conversations, and Actions as a queue of work waiting on a person, with assignment.
- CRM: contacts, companies with merge, deals on a pipeline board.
- Tables: a spreadsheet with formulas, enrichment and AI columns. Enrichment calls Hunter, ZeroBounce, MillionVerifier, NeverBounce, Findymail, Prospeo, LeadMagic, Apollo and People Data Labs natively, and vendors that share an action line up in a waterfall.
- Self-hosting with Docker Compose and Postgres 17.
- AI agents (MCP): an endpoint at `/api/mcp` with eleven read tools for the inbox, work queue, leads, campaigns, pipeline and analytics. People connect agents with personal tokens from Settings, AI agents (MCP), after an owner or admin turns MCP on. See [AI agents (MCP)](docs/guides/mcp.md).
- MCP write tokens: a token can also make changes through eight tools that write reply drafts, set reply types, assign, note and close conversations, manage tasks, pause sending, draft campaigns, move deals and import leads. No tool sends a message. Owners and admins choose whether members may create write tokens, and read each agent call under Agent activity.
- Agent sending: an owner or admin can let MCP agents send replies under Settings, Organization, Agents can send. It is off by default. A token that sends gets `send_reply`, which sends a saved draft by email or LinkedIn with every person's rule plus agent rules: only to people a campaign or a person already reached, no CC, one reply a day per reply handling, and daily limits per organization, person and mailbox. The thread marks each agent send. `MCP_SEND_ENABLED=false` refuses every agent send in the install.
- The product principle changes from "a person approves every reply" to "every send has someone answerable for it": a person who pressed Send, or an agent working with a send token a person created where an admin allowed it.
- Schema: migration 0005 adds `mcp_tokens`, migration 0006 adds `mcp_rate_limits`, migration 0007 adds `mcp_tool_calls`, migration 0008 adds `drafts.written_via_token_id` and migration 0009 adds `send_attempts.origin`, `mcp_token_id` and `client_name`.

### Upgrade notes

For a server that ran a build from before this release:

- Back up the database before you upgrade ([Backups](docs/deploy/self-host.md#backups)).
- Migrations run when the app boots, unless you set `RUN_MIGRATIONS=false` and run `scripts/migrate.mjs` yourself.
- You cannot roll back migrations 0002 and 0003. They rename the reply tables and drop columns, so an old instance fails against the new schema. Stop every old instance before the new version boots. A migration that waits more than 30 seconds for a table lock fails and rolls back. [Operations](docs/operations.md#upgrades-that-change-the-reply-tables) says how to find the session that holds it.
- Agent sending starts off in every organization. Nothing an agent does sends a message until an owner or admin turns it on.
- Out of office now ends a follow-up run already going. Before, it only kept a new run from starting.
- The stage rank is gone, so the AI may move a person to an earlier reply type. To review such moves, set the type's Check to Before it applies in Settings > Reply handling.
- If your organization archived Asked to stop, the upgrade restores it. Every AI pick of it waits for a person.
- The upgrade renames the default types and rewrites their default guidance only where your organization kept the old text. Guidance you edited stays as you wrote it and may still name a type by its old name, such as Not required right now (now Not now) or Connected to different contact (now Referred someone else). Read the AI guidance of each type in Settings > Reply handling.
