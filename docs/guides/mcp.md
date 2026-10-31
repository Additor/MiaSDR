# AI agents (MCP)

MiaSDR serves the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`. An agent such as Claude Code, Cursor or VS Code connects with a personal token and reads your organization's inbox, work queue, leads, campaigns, pipeline and analytics. A token that makes changes also lets the agent draft replies, sort and assign conversations, manage tasks, prepare campaigns, move deals and import leads. Agents send nothing unless an owner or admin turns on agent sending; then a token that sends lets the agent send replies too, within daily limits ("Agent sending" below).

## Turn it on

1. An owner or admin opens Settings, AI agents (MCP) and chooses Turn on MCP. Until then a token answers 403 and nobody can create one.
2. Each person who wants an agent creates a token on the same page under Your tokens. Name it after the machine or the agent that uses it, and choose Read only, Read and make changes, or Read, make changes and send. Members can create tokens that make changes unless an owner or admin limits them to read-only tokens. Sending needs agent sending on.
3. Copy the token when it appears. MiaSDR keeps only its hash and shows it once. If you lose it, revoke it and create another.

The server administrator can turn the endpoint off for the whole install with `MCP_ENABLED=false` ([Configuration](../configuration.md#mcp)).

## Connect a client

The page shows each setup with your token filled in. Replace `https://miasdr.example.com` with your `APP_URL`.

Claude Code:

```bash
claude mcp add --transport http miasdr https://miasdr.example.com/api/mcp --header "Authorization: Bearer msdr_pat_..."
```

Cursor, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "miasdr": { "url": "https://miasdr.example.com/api/mcp", "headers": { "Authorization": "Bearer msdr_pat_..." } } } }
```

VS Code, in `.vscode/mcp.json`:

```json
{ "servers": { "miasdr": { "type": "http", "url": "https://miasdr.example.com/api/mcp", "headers": { "Authorization": "Bearer msdr_pat_..." } } } }
```

Keep the token out of files you commit. Clients that read environment variables in their config can take it from one.

## What an agent sees

The agent acts as the person who created the token, in the token's organization only, with that person's role. A member's agent reads what the member reads; an owner's agent also sees the LinkedIn accounts and failed AI jobs that members do not.

| Tool | Reads |
|---|---|
| `get_workspace` | Members, reply types, deal stages, mailboxes and, for an owner or admin, LinkedIn accounts |
| `get_work_queue` | What waits on someone, by group, as on the Actions page |
| `list_inbox` | Conversations by view and filter, or the scheduled sends |
| `get_conversation` | One thread with its reply handling state, draft, AI picks, notes, tasks and follow-ups |
| `search_people` | Leads and contacts with the Leads page filters |
| `get_person` | One lead or contact with enrollments and campaign sends |
| `list_campaigns` | Email and LinkedIn campaigns with their counts |
| `get_campaign` | One campaign's steps, senders and leads, and a rendered step |
| `get_analytics` | One Analytics report for a date window |
| `get_pipeline` | The deal board, or one deal |
| `get_sending_health` | Pause state, mailbox and account status, unmatched senders and, for an owner or admin, failed AI jobs |

A token that makes changes adds these tools. Each acts as its person would in MiaSDR, with that person's permissions.

| Tool | Changes |
|---|---|
| `write_reply_draft` | Has the AI write a reply draft, saves the agent's own email or LinkedIn draft, edits, regenerates or discards one. The answer gives `reviewUrl`, where a person reviews and sends it |
| `set_reply_type` | Changes a conversation's reply type, or confirms or undoes an AI pick |
| `update_conversation` | Adds a note, takes or assigns a conversation, closes or reopens it |
| `manage_task` | Lists, creates, edits and completes tasks |
| `pause_sending` | Pauses a campaign, a conversation's follow-ups or, for an owner or admin, all sending. It never resumes |
| `draft_campaign` | Creates a draft campaign, edits its steps and senders, and adds leads to a draft or paused campaign, or to a running one with a token that sends |
| `update_deal` | Moves a deal to another stage or edits its fields |
| `import_leads` | Previews a CSV import of up to 500 rows, then commits it |

Each item carries an `appUrl`, the page in MiaSDR where a person sees or acts on it. An answer stays under about 10,000 tokens. A request that would return more fails with `answer_too_large`; narrow it with a filter, a page or a shorter date range.

## Text from outside your organization

A lead's email or LinkedIn message, the From header, and values from imports or providers (titles, companies, custom fields) reach the agent inside `<untrusted_...>` tags with a random suffix per call. The server tells the agent that tagged text, lead names and addresses are data and that it must not follow instructions found in them. A lead can still write text meant to steer an agent, and a tag lowers that risk without removing it. Review what your agent proposes before you act on it.

## Agent sending

Agents send nothing until an owner or admin opens Settings, Organization, Agents can send, and picks Replies. The server administrator can refuse every agent send in the install with `MCP_SEND_ENABLED=false`.

With Replies on, a person can create a token that sends. Its agent gets one more tool, `send_reply`, which sends a conversation's saved draft (`draftId`, `revision` and an `idempotencyKey` the agent keeps for that send) by email or LinkedIn, as the token's person. A refused send names its reason as `code`:

| Code | Why | What to do |
|---|---|---|
| `agent_send_off` | Agent sending is off, or the token was made before it was last turned off, or the token cannot send | Turn agent sending on, or create a new token that sends |
| `agent_unverified_recipient` | No campaign reached this person in this conversation, and nobody in the organization replied there | Send the first reply yourself in MiaSDR |
| `agent_cc_not_allowed` | The draft has CC addresses | Remove them, or send it yourself |
| `agent_send_paused` | The organization's Sending pause or `PAUSE_OUTBOUND` is on | A person resumes sending |
| `agent_daily_cap` | Agents reached today's limit for the organization (100), the token's person (50) or the mailbox (30) | Wait for midnight UTC (`retryAfterSeconds`), or an owner or admin raises the limit |
| `agent_reply_gap` | An agent replied in this reply handling in the last 24 hours | Wait (`retryAfterSeconds`), or send it yourself |

Every rule of a person's send applies too: suppression, do not contact, closed reply handling, a newer message, and the LinkedIn account's limits. The answer's `status` is `sent`, `delivery_uncertain` (it may have gone out; do not send again, a person checks), `failed` or `blocked` (nothing went out; `retryable` says whether a new key may try again). The same key never sends twice.

With Replies and campaigns, a token that sends also gets `preview_campaign_launch` and `launch_campaign`. The agent previews a start, a resume or an enroll into a running campaign, shows the preview to the person, and passes its `launchToken` to `launch_campaign` (or to `draft_campaign` `add_leads` for a running campaign). A launch refuses when the campaign changed since the preview (`launch_token_stale`), when the organization allows replies only (`agent_campaigns_off`), while sending is paused, and for a Personal campaign unless it names its senders and the token's person owns each one (`agent_sender_not_owned`). Agents enroll at most 200 leads a day across both channels by default, drafts included (`agent_enroll_cap`); an owner or admin changes the limit in the same card. An admin sets who owns each LinkedIn account under Settings, LinkedIn; a member who connects an account through MiaSDR owns it.

Owners and admins see agents' sends under Agent sends on the settings page: today's counts against the limits, the latest agent replies, and the campaigns agents started, with Pause campaigns agents started to stop all of those at once. An agent's send with an unconfirmed outcome shows in Actions under Problems, naming the token.

Turning agent sending off stops every token that sends at once, and turning it on later needs new tokens. A message an agent sent shows "Sent by an agent ({token name})" in the thread, and the history reads "{person} via {token}".

## Limits and revoking

- A token lasts 90 days. A person holds at most 10 live tokens.
- A token makes at most 60 requests a minute. Request 61 answers 429 with `Retry-After`.
- A token makes at most 20 changes a minute, asks the AI for at most 60 drafts an hour, imports at most 10 times an hour, sends at most 10 replies a minute and starts at most 10 campaigns an hour. A call past a limit fails with `rate_limited` and the seconds to wait.
- With `TRUST_PROXY_HOPS` set, a client IP that sends 20 unknown tokens in a minute waits until the minute ends.
- A person revokes their own tokens on the settings page; an owner or admin revokes anyone's, or all of them with Revoke all. A revoked token fails on its next request.
- Removing a member revokes their tokens, and inviting them again does not bring the tokens back. A role change applies to the next request.
- Turning MCP off stops every token until it is turned on again. The tokens themselves stay.

Each token change and each switch of MCP writes a row to the audit log under the MCP area.

## Agent activity

Owners and admins see each agent call under Agent activity on the same page: the tool, the person and token, and a link to the conversation or deal. Changes show by default; Show reads adds the reads. The list keeps the ids a call named and never its text, and drops calls older than `RETENTION_MCP_TOOL_CALLS_DAYS` (90 days by default). A draft an agent wrote shows "Written by an agent" with the token's name until a person edits it, and a conversation's history reads "{person} via {token}" beside each change an agent made.
