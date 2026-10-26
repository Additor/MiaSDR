# MiaSDR

<p align="center"><img src="docs/images/hero.jpg" alt="MiaSDR: the AI SDR you run on your own server" width="100%"></p>

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE) ![Next.js 16](https://img.shields.io/badge/Next.js-16-black) ![PostgreSQL 17](https://img.shields.io/badge/PostgreSQL-17-336791) ![Deploy: Docker Compose](https://img.shields.io/badge/deploy-Docker%20Compose-2496ED)

An AI SDR for email and LinkedIn that runs on your server and sends from your own accounts.

- **The AI drafts, your team sends.** No AI-written message leaves until a person approves it.
- **A reply anywhere stops everything.** Someone answers on LinkedIn and their email sequence stops too.
- **Your leads stay yours.** Leads, conversations and deals live in your Postgres, not a vendor's.

Free to run on your own server. You pay only for your AI provider's usage (Anthropic, Vercel AI Gateway or OpenRouter), plus Unipile if you use LinkedIn.

## Quick start

**1. Start it.** You need Docker with Compose v2. The whole setup takes about ten minutes.

```bash
git clone https://github.com/Additor/MiaSDR.git && cd MiaSDR
cp .env.example .env
# replace each CHANGEME in .env with a value from: openssl rand -hex 32
docker compose up -d --build
```

**2. Create your organization.** Open `http://localhost:3000` and create the first account. The app runs its database migrations on boot.

**3. Look around, then connect.** Set `MAILBOX_PROVIDER=fake` in `.env` to try campaigns without Google: the fake provider keeps mail in memory and sends nothing. To send real email, follow [Gmail setup](docs/setup/gmail.md).

The [quick start guide](docs/guides/quick-start.md) walks from install to a first campaign.

<p align="center"><img src="docs/images/actions-preview.jpg" alt="The Actions queue: replies to approve with AI drafts and their classification, follow-ups due and your tasks" width="100%"></p>

## Features

<p align="center"><img src="docs/images/features.jpg" alt="MiaSDR screens grouped as Reach out, Handle every reply, Close the deal, Research and Learn what works" width="100%"></p>

- **Leads**: import CSV or XLSX, or turn a LinkedIn search into a lead list.
- **Campaigns**: email from your Google Workspace mailboxes, LinkedIn invitations and messages through [Unipile](docs/setup/linkedin-unipile.md), inside the working hours and daily limits you set.
- **Inbox and Actions**: every conversation in one list, and one queue for replies to approve, follow-ups due and tasks.
- **CRM**: a pipeline board of deals. A lead becomes a contact when you create a deal from it, and leaves its campaigns.
- **Tables**: a spreadsheet with formulas, AI columns and a waterfall across nine enrichment vendors, one step from a campaign.
- **Analytics**: sends, replies, bounces and the LinkedIn funnel per campaign.

<p align="center"><img src="docs/images/how-it-works.jpg" alt="Four steps: import leads, send campaign steps within your limits, the AI reads replies and drafts answers, a person approves each draft" width="100%"></p>

[How MiaSDR works](docs/guides/how-it-works.md) covers the jobs, the send engine and the inbox.

## Deploy and safety

Docker Compose runs the app and Postgres 17, with Caddy in front for HTTPS. [Self-hosting](docs/deploy/self-host.md) covers the server, backups and upgrades.

- `PAUSE_OUTBOUND=true` holds every campaign send, email and LinkedIn, until you turn it off. Replies you approve still send.
- LinkedIn prohibits automation and can restrict accounts, and CAN-SPAM, GDPR and CASL limit who you may contact. Read [Responsible use](docs/responsible-use.md) before you send to real people.

## Docs

| Start here | Set up | Run it |
|---|---|---|
| [Quick start guide](docs/guides/quick-start.md) | [Gmail](docs/setup/gmail.md) | [Self-hosting](docs/deploy/self-host.md) |
| [How MiaSDR works](docs/guides/how-it-works.md) | [LinkedIn through Unipile](docs/setup/linkedin-unipile.md) | [Configuration](docs/configuration.md) |
| [Responsible use](docs/responsible-use.md) | [Enrichment providers](docs/setup/enrichment.md) | [Operations](docs/operations.md) |

## License

[AGPL-3.0-or-later](LICENSE).

- Run it for your own company freely.
- If you distribute a modified copy, or run one as a service for other people over a network, publish your modified source under the same license.
- Leads, conversations and reports you create with MiaSDR are your content.

The LICENSE file is the binding text.
