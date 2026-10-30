# AI agents (MCP)

MiaSDR serves the [Model Context Protocol](https://modelcontextprotocol.io) at `/api/mcp`. An agent such as Claude Code, Cursor or VS Code connects with a personal token and reads your organization's inbox, work queue, leads, campaigns, pipeline and analytics. In this version every tool reads. No tool changes data or sends a message.

## Turn it on

1. An owner or admin opens Settings, AI agents (MCP) and chooses Turn on MCP. Until then a token answers 403 and nobody can create one.
2. Each person who wants an agent creates a token on the same page under Your tokens. Name it after the machine or the agent that uses it.
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

Each item carries an `appUrl`, the page in MiaSDR where a person sees or acts on it. An answer stays under about 10,000 tokens. A request that would return more fails with `answer_too_large`; narrow it with a filter, a page or a shorter date range.

## Text from outside your organization

A lead's email or LinkedIn message, the From header, and values from imports or providers (titles, companies, custom fields) reach the agent inside `<untrusted_...>` tags with a random suffix per call. The server tells the agent that tagged text, lead names and addresses are data and that it must not follow instructions found in them. A lead can still write text meant to steer an agent, and a tag lowers that risk without removing it. Review what your agent proposes before you act on it.

## Limits and revoking

- A token lasts 90 days. A person holds at most 10 live tokens.
- A token makes at most 60 requests a minute. Request 61 answers 429 with `Retry-After`.
- With `TRUST_PROXY_HOPS` set, a client IP that sends 20 unknown tokens in a minute waits until the minute ends.
- A person revokes their own tokens on the settings page; an owner or admin revokes anyone's, or all of them with Revoke all. A revoked token fails on its next request.
- Removing a member revokes their tokens, and inviting them again does not bring the tokens back. A role change applies to the next request.
- Turning MCP off stops every token until it is turned on again. The tokens themselves stay.

Each token change and each switch of MCP writes a row to the audit log under the MCP area.
