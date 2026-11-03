# Changelog

MiaSDR follows [Semantic Versioning](https://semver.org). Before 1.0, a minor version can change behavior or the database schema; the release notes say when.

## Unreleased

### Database

The migrations are now one baseline, `drizzle/0000_baseline.sql`. An install from an earlier version fails on it with `already exists`, so start from an empty database.

### MCP

Agents can now spend on enrichment, run LinkedIn searches and take actions a person cannot undo. All of it stays off until an owner or admin sets a daily limit under Settings, Organization and creates a token with the option ticked. Connected apps need to connect again to ask for the new permissions.

- `list_tables` and `get_table` read enrichment tables. `run_enrichment` fills empty cells of one provider column, after a dry run states the worst case, and reserves that against the daily limit. `stop_enrichment` stops queued cells. A column with no price, and an AI column, refuse.

- `create_linkedin_search` starts a search whose results become leads, on accounts the token's person owns or no member owns, and counts its `maxResults` against the daily limit. It cannot enroll anyone. `list_linkedin_searches` reads searches, and `cancel_linkedin_search` ends one an agent created.
- `preview_irreversible` and `apply_irreversible` complete a campaign, or delete a lead, contact, deal or draft campaign, one target per call. A token from the preview catches a change in between.
- An agent never deletes someone marked do not contact, on the suppression list, who asked to stop, or who was removed from a campaign. A person still can.
- `draft_campaign` takes a `remove_lead` action, which a person can restore.
- New settings and switches: `agentSpendCentsPerDay`, `agentSearchLeadsPerDay`, `agentIrreversiblePerDay`, `MCP_SPEND_ENABLED`, `MCP_IRREVERSIBLE_ENABLED`. The database gains `mcp_agent_usage`, two columns on `mcp_tokens` and one on `linkedin_search_queries`, all with defaults.

### Changed

- One install now serves one organization. First-run setup creates it, and the server refuses another. Creating and switching organizations are gone. `AUTH_SIGNUP` is removed, so accounts need an invitation. `MAILBOX_ALLOWED_DOMAINS` stays optional.
- AI picks follow one fixed rule: a pick waits for a person only for a stop request, confidence under 85%, or a move out of Existing customer. Every other pick applies at once, and Change type or Undo corrects it. Reply types are fixed, and Settings > Reply handling lists them read-only. Looks right, Check before and after, the confidence floor setting and the MCP `confirm_pick` action are gone.
- Every LinkedIn reply now lands in the Inbox and Actions and reaches the AI. Personal campaigns are gone, along with the MCP fields `personal`, `hiddenSends` and the campaign list's `type`, and the refusal `agent_sender_not_owned`.
- Tables keep enrichment columns, AI columns and the handoff to a campaign. Formula columns, LOOKUP, Recalculate and the AI formula helper are gone.

### Database and code names

The tables and code now use the words the screens use, so start from an empty database. `records` became `conversations`, the old `conversations` became `threads`, and the follow-up tables became `follow_up_flows`, `follow_up_versions`, `follow_up_steps`, `follow_up_runs` and `follow_up_step_runs`.

- MCP fields changed with them: a thread's id is `threadId` and a conversation's id is `conversationId`, which used to be `recordId`.
- `/api/records` moved to `/api/conversations`.
- Inbox URLs use `group` and `type`. Actions URLs use `group` and `list`.
- Stopping contact has one owner, `src/contexts/conversations/stopping`, with one table of what each trigger ends. Stop requests read the flag stored at ingest.
- The workflow states `paused`, `classifying` and `error` are gone because nothing set them, and `unclassified` is now `no_type`.

### Stopping contact

- An unsubscribe, a suppression added by hand and Suppress in the Inbox now end the LinkedIn enrollments and follow-ups of the people with that address too. They used to end email enrollments only, while ending follow-ups on every channel.
- A hard bounce now ends email enrollments and email follow-ups only. A LinkedIn enrollment or follow-up of that person goes on.
- A reply and do not contact now clear the LinkedIn resolve retry of an enrollment they end.
- Every stop now takes the person's locks in one order and takes the outreach lock, so a stop can no longer commit between the checks and the write of a restore of a removed lead or of a person delete. Do not contact on a single person now runs once more after a lock conflict, then answers 409 `try_again`.

### Removed

Nothing used these, and the database baseline drops them, so start from an empty database.

- The redirects from old URLs such as `/crm/records/[id]` and `/settings/email`.
- 24 `GET` API handlers that no screen, MCP tool or test called. Screens read through the server, and MCP tools call the same use cases.
- `draft_knowledge_citations` and 12 columns with no reader. A draft's stored request still names the knowledge it used.
- The `complaint` suppression reason and its label, because no path ever wrote it. The Replies report no longer counts complaints.
- The `shadcn` and `date-fns` packages. `src/app/globals.css` keeps the few CSS rules the app uses.

### Fixed

- Two AI or enrichment columns can no longer read each other's output, which would have queued paid runs forever.
- Recheck connection no longer turns a disabled mailbox back on. Only Enable does, and a check still running when a person disables the mailbox changes nothing.
- A reply whose own words ask to stop now shows Review stop request in Actions and on the thread before any AI pick reads it. An MCP work queue row for one has `aiPick.replyTypePickId: null`.
- A new reply on a closed conversation clears its old closed reason.
- A campaign can't start with Gmail on while `APP_URL` is a local address, because every unsubscribe link would point there.

- The contact delete preview no longer waits on its own database connection when the pool holds one connection.

- The OAuth consent route now refuses access the app did not ask for. Before, a person who edited their own consent request could grant more than the page offered.

## 0.1.0 (2026-11-02)

First public release.

- Leads: CSV and XLSX import with column mapping, custom fields, filters, export and do-not-contact.
- Campaigns: email sequences from Google Workspace mailboxes and LinkedIn steps through Unipile, with working hours, daily limits and a send pause.
- Merge fields: `{{first_name}}` and `{{First Name}}` fill the same field as `{{firstName}}`. A campaign with a field no lead in the organization has does not start or resume, and the refusal names the field and its step. You cannot rename or delete a field a running campaign reads until you pause that campaign.
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
- Agent sending: an owner or admin can let MCP agents send replies under Settings, Organization, Agents can send. It is off by default. A token that sends gets `send_reply`, which sends a saved draft by email or LinkedIn with every person's rule plus agent rules: only to people a campaign or a person already reached, no CC, one reply a day per reply handling, and daily limits per organization, person and mailbox. The thread marks each agent send. With Replies and campaigns, agents also start and resume campaigns and fill running ones through `preview_campaign_launch` and `launch_campaign`, with a launch token that fails when the campaign changed, a daily enroll limit, and Personal campaigns only from accounts the token's person owns. LinkedIn accounts now have an owner, which an owner or admin names when connecting one or later under Settings, LinkedIn. An agent resumes only a campaign an agent paused; one a person paused waits for a person. `MCP_SEND_ENABLED=false` refuses every agent send in the install.
- The product principle changes from "a person approves every reply" to "every send has someone answerable for it": a person who pressed Send, or an agent working with a send token a person created where an admin allowed it.
- Schema: migration 0005 adds `mcp_tokens`, migration 0006 adds `mcp_rate_limits`, migration 0007 adds `mcp_tool_calls`, migration 0008 adds `drafts.written_via_token_id` migration 0009 adds `send_attempts.origin`, `mcp_token_id` and `client_name`, migration 0010 adds `campaigns.started_via_token_id`, `campaign_enrollments.enrolled_via_token_id` and `linkedin_accounts.owner_user_id`, migration 0011 adds `campaigns.person_paused`, and migration 0012 adds `linkedin_connect_links.owner_user_id`.

### MCP tools

This release adds the endpoint and its first tools. From here on, an answer only gains fields; a renamed tool or field keeps its old name, hidden, for one minor version, and this section lists each change.

- Read: 11 tools, `get_workspace` among them. A token with no write scope sees only these.
- Change: `write_reply_draft`, `set_reply_type`, `update_conversation`, `manage_task`, `pause_sending`, `update_deal`, `draft_campaign`, `import_leads`.
- Send: `send_reply`, `preview_campaign_launch`, `launch_campaign`, listed only while the organization allows them.
- OAuth: apps such as claude.ai and ChatGPT connect by signing in, on an HTTPS address. Adds migration 0013 and `MCP_OAUTH_DCR`.
- Cards: a client that supports MCP Apps shows `write_reply_draft` and `preview_campaign_launch` answers as a card.
- Merge fields: `get_workspace` lists them in `mergeFields`, `draft_campaign` answers `unknownFields` after a save, and `preview_campaign_launch` lists what step 1 leaves blank in `firstStep.unresolved`. `preview_campaign_launch` also lists a field no lead has under `problems`, and `launch_campaign` refuses it.
- Client names: a client on protocol 2025-11-25 gets its name in `Mcp-Session-Id` on the answer to `initialize` and returns it with each request, so the activity log names it. The id grants nothing, and the name is whatever the client reports.
- One JSON-RPC message per request: the endpoint answers a batch `400 batch_not_supported`.
- A tool's published output schema lists its top-level keys as optional, plus `error`, so a client that checks results keeps a refusal.

### Upgrade notes

For a server that ran a build from before this release:

- Back up the database before you upgrade ([Backups](docs/deploy/self-host.md#backups)).
- Migrations run when the app boots, unless you set `RUN_MIGRATIONS=false` and run `scripts/migrate.mjs` yourself.
- You cannot roll back migrations 0002 and 0003. They rename the reply tables and drop columns, so an old instance fails against the new schema. Stop every old instance before the new version boots. A migration that waits more than 30 seconds for a table lock fails and rolls back. [Operations](docs/operations.md#upgrades-and-table-locks) says how to find the session that holds it.
- A campaign that uses a field no lead has sent those fields as blanks before. It now refuses to start or resume until you change its steps. A running campaign keeps running.
- Campaigns paused at upgrade time count as paused by a person, so only a person resumes them.
- Agent sending starts off in every organization. Nothing an agent does sends a message until an owner or admin turns it on.
- Existing LinkedIn accounts have no owner after the upgrade. Set owners under Settings, LinkedIn before agents start Personal campaigns.
- Out of office now ends a follow-up run already going. Before, it only kept a new run from starting.
- The stage rank is gone, so the AI may move a person to an earlier reply type. To review such moves, set the type's Check to Before it applies in Settings > Reply handling.
- If your organization archived Asked to stop, the upgrade restores it. Every AI pick of it waits for a person.
- The upgrade renames the default types and rewrites their default guidance only where your organization kept the old text. Guidance you edited stays as you wrote it and may still name a type by its old name, such as Not required right now (now Not now) or Connected to different contact (now Referred someone else). Read the AI guidance of each type in Settings > Reply handling.
