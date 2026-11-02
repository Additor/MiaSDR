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

### Sign in instead of a token

Apps such as claude.ai and ChatGPT connect without a token: add the endpoint in the app, sign in to MiaSDR when it asks, then choose the organization and what the app may do. An owner or admin turns MCP on first. The app shows under Connected apps on the settings page, and Disconnect stops it on its next request. Connecting it again asks you again.

This needs an HTTPS address, because the app has to reach your server. An install on plain HTTP uses tokens only. A change of address means connecting each app again.

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
| `pause_sending` | Pauses a campaign, a conversation's follow-ups or, for an owner or admin, all sending. It never resumes. The Sending paused banner names the person and the token, such as "Ana's agent (Work laptop)" |
| `draft_campaign` | Creates a draft campaign, edits its steps and senders, and adds leads to a draft or paused campaign, or to a running one with a token that sends |
| `update_deal` | Moves a deal to another stage or edits its fields |
| `import_leads` | Previews a CSV import of up to 500 rows, then commits it. A person holds three previews at once; when the server holds its limit, a preview waits (`import_busy`) |

Each item carries an `appUrl`, the page in MiaSDR where a person sees or acts on it. An answer stays under about 10,000 tokens. A request that would return more fails with `answer_too_large`; narrow it with a filter, a page or a shorter date range. Long text comes cut and marked `truncated`: a reply draft keeps 12,000 characters, and `get_campaign` keeps 300 of each step body except the step named in `previewStep`, which comes whole. A write that sends a cut copy back is refused (`truncated_text`), and `send_reply` refuses a draft longer than 12,000 characters (`draft_not_read`).

## Merge fields in campaign steps

`get_workspace` lists the fields a step can use in `mergeFields`. Steps write them as `{{firstName}}`, and `{{first_name}}` or `{{First Name}}` fill the same field. The list samples recent leads and companies, so a rarely used import column can work without appearing there.

After a save, `draft_campaign` answers `unknownFields`: the fields no lead in the organization has. They would reach every lead as a blank, so the save goes through but the campaign cannot start or resume until they change. `preview_campaign_launch` lists them under `problems`. It also answers `firstStep.unresolved`: the fields step 1 leaves blank for the lead it shows, `empty` when other leads may have a value and `unknown` when none does. A lead with an empty field still gets the message, with that field left out.

## Cards in the chat

A client that supports MCP Apps shows a card beside two tools' answers: `write_reply_draft` shows the draft, and `preview_campaign_launch` shows what a start would do. A card only displays the answer and opens MiaSDR, so a person reviews and sends there. Other clients read the same answer as text.

## Text from outside your organization

A lead's email or LinkedIn message, the From header, and values from imports or providers (titles, companies, custom fields) reach the agent inside `<untrusted_...>` tags with a random suffix per call. The server tells the agent that tagged text, lead names and addresses are data and that it must not follow instructions found in them. A lead can still write text meant to steer an agent, and a tag lowers that risk without removing it. Review what your agent proposes before you act on it.

## Agent sending

Agents send nothing until an owner or admin opens Settings, Organization, Agents can send, and picks Replies. The server administrator can refuse every agent send in the install with `MCP_SEND_ENABLED=false`.

With Replies on, a person can create a token that sends. Its agent gets one more tool, `send_reply`, which sends a conversation's saved draft (`draftId`, `revision` and an `idempotencyKey` the agent keeps for that send) by email or LinkedIn, as the token's person. A refused send names its reason as `code`:

| Code | Why | What to do |
|---|---|---|
| `agent_send_off` | Agent sending is off, or the token was made before it was last turned off, or the token cannot send | Turn agent sending on, or create a new token that sends |
| `agent_unverified_recipient` | No campaign reached this person in this conversation, and nobody in the organization replied there | Send the first reply yourself in MiaSDR |
| `agent_stop_requested` | The AI read the lead's latest message as a request to stop, and no person reviewed it | A person reviews it in MiaSDR |
| `agent_cc_not_allowed` | The draft has CC addresses | Remove them, or send it yourself |
| `agent_send_paused` | The organization's Sending pause or `PAUSE_OUTBOUND` is on | A person resumes sending |
| `agent_daily_cap` | Agents reached today's limit for the organization (100), the token's person (50) or the mailbox (30) | Wait for midnight UTC (`retryAfterSeconds`), or an owner or admin raises the limit |
| `agent_reply_gap` | An agent replied in this reply handling in the last 24 hours | Wait (`retryAfterSeconds`), or send it yourself |

Every rule of a person's send applies too: suppression, do not contact, closed reply handling, a newer message, and the LinkedIn account's limits. The answer's `status` is `sent`, `delivery_uncertain` (it may have gone out; do not send again, a person checks), `failed` or `blocked` (nothing went out; `retryable` says whether a new key may try again). The same key never sends twice.

With Replies and campaigns, a token that sends also gets `preview_campaign_launch` and `launch_campaign`. The agent previews a start, a resume or an enroll into a running campaign, shows the preview to the person, and passes its `launchToken` to `launch_campaign` (or to `draft_campaign` `add_leads` for a running campaign). A launch refuses when the campaign changed since the preview (`launch_token_stale`), when the organization allows replies only (`agent_campaigns_off`), while sending is paused, and for a Personal campaign unless it names its senders and the token's person owns each one (`agent_sender_not_owned`). Agents enroll at most 200 leads a day across both channels by default, drafts included (`agent_enroll_cap`); an owner or admin changes the limit in the same card. An owner or admin names the owner when connecting a LinkedIn account, or changes it later under Settings, LinkedIn; an account with no owner stays out of agents' Personal campaigns. An agent resumes only a campaign an agent paused: one a person paused, including through Pause campaigns agents started, refuses with `agent_resume_person_paused`.

Owners and admins see agents' sends under Agent sends on the settings page: today's counts against the limits, the latest agent replies, and the campaigns agents started, with Pause campaigns agents started to stop all of those at once. It also holds campaigns an agent paused, so no agent resumes them. An agent's send with an unconfirmed outcome shows in Actions under Problems, naming the token.

Turning agent sending off stops every token that sends at once, and turning it on later needs new tokens. A message an agent sent shows "Sent by an agent ({token name})" in the thread, and the history reads "{person} via {token}".

## Actions no one can undo

Agents complete campaigns and delete records only when all of these hold:

1. The server allows it. `MCP_IRREVERSIBLE_ENABLED=false` refuses it for the whole install.
2. An owner or admin sets a daily limit above 0 under Settings, Organization, Agents can spend and delete.
3. An owner or admin creates a token, or connects an app, with Complete campaigns and delete records ticked. Members cannot, and an admin demoted to member loses it on the next request.

Such a token gets two tools:

| Tool | What it does |
|---|---|
| `preview_irreversible` | States what the action would do to one target, what stops it, and an `actionToken`. It changes nothing and counts against no limit |
| `apply_irreversible` | Runs the action with the preview's token. One target per call. It counts against the daily limit, and a refusal gives the count back |

`kind` picks the action: `complete_campaign`, `delete_draft_campaign`, `delete_lead`, `delete_contact` or `delete_deal`. A person's rules apply as they do in MiaSDR, and each refusal keeps its code, such as `contact_blocked` or `has_sends`. Agents meet these as well:

| Code | Why | What to do |
|---|---|---|
| `agent_irreversible_off` | The limit is 0, the token was made before it last went to 0, or the token lacks the option | Set a limit, or create a new token |
| `agent_irreversible_cap` | Agents reached today's limit | Wait for midnight UTC (`retryAfterSeconds`), or an owner or admin raises it |
| `action_token_stale` | The target changed since the preview | Preview again and check the new answer |
| `agent_delete_protected` | The person is marked do not contact, on the suppression list, asked to stop, or was removed from a campaign | A person deletes them in MiaSDR |
| `agent_complete_person_paused` | A person paused the campaign | A person completes it in MiaSDR |
| `agent_sender_not_owned` | A Personal campaign sends from another member's accounts | Its owner acts on it |

Deleting a contact erases its conversations, messages, closed deals, notes and tasks, and nobody can get them back. An agent that followed instructions planted in a lead's message could do this within the limit, so keep the limit low and tick the option only on tokens that need it. Agent activity lists each call with its target, and the audit log names the token.

Setting the limit to 0 stops these tokens at once, and setting it above 0 later needs new tokens.

## Limits and revoking

- A token lasts 90 days. A person holds at most 10 live tokens.
- A token makes at most 60 requests a minute. Request 61 answers 429 with `Retry-After`.
- A token makes at most 20 changes a minute, asks the AI for at most 60 drafts an hour, imports at most 10 times an hour, sends at most 10 replies a minute starts at most 10 campaigns an hour, and takes at most 30 actions it cannot undo an hour. A call past a limit fails with `rate_limited` and the seconds to wait.
- With `TRUST_PROXY_HOPS` set, a client IP that sends 20 unknown tokens in a minute waits until the minute ends.
- A person revokes their own tokens on the settings page; an owner or admin revokes anyone's, or all of them with Revoke all. A revoked token fails on its next request.
- Removing a member revokes their tokens, and inviting them again does not bring the tokens back. A role change applies to the next request.
- Turning MCP off stops every token until it is turned on again. The tokens themselves stay.

Each token change and each switch of MCP writes a row to the audit log under the MCP area.

## Agent activity

Owners and admins see each agent call under Agent activity on the same page: the tool, the person and token, the client when it names itself, and a link to the conversation or deal. Changes show by default; Show reads adds the reads. The list keeps the ids a call named and never its text, and drops calls older than `RETENTION_MCP_TOOL_CALLS_DAYS` (90 days by default). A draft an agent wrote shows "Written by an agent" with the token's name until a person edits it, and a conversation's history reads "{person} via {token}" beside each change an agent made.
