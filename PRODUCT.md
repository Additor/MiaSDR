# Product

<!-- impeccable:product-schema 1 -->

Who MiaSDR is for, what it promises and the words the screens use. Design tooling reads this file, and `src/architecture/docs-vocabulary.test.ts` checks the Terminology list against the code.

## Platform

web

## Users
Small sales teams that run outbound themselves. The people in the app are SDRs and sales leads working inside one organization, with owner, admin and member roles. They import leads, run email and LinkedIn campaigns, review replies, and approve AI drafts before anything sends.

## Product Purpose
MiaSDR is a self-hosted AI SDR. It imports leads, runs email sequences from the team's own Google Workspace mailboxes, and stops a sequence when a lead replies, bounces or unsubscribes. Success is outreach that reaches real people within strict send rules, with a person approving every AI-written message.

## Positioning
Self-hosted (Docker Compose is the supported path), with each organization using its own mailboxes and its own AI provider key (Anthropic, Vercel AI Gateway or OpenRouter). Email, LinkedIn, campaigns with AI follow-ups after a reply, an Inbox, analytics and enrichment tables live in one app, together with a minimal CRM: a Pipeline of deals, Contacts and Companies. A person enters the CRM as a contact: Add contact creates one, and a lead becomes one when you create a deal from it or make it a contact.

## Operating Context
Teams operate it through routes such as `/leads`, `/campaigns`, `/inbox`, `/actions`, `/crm/pipeline`, `/crm/contacts`, `/crm/companies`, `/analytics`, `/tables`, `/onboarding` and `/settings/*`. Gmail is polled every minute for replies and bounces. LinkedIn runs through Unipile. Sends respect working hours, daily limits and a randomized gap between messages, and a send pause exists.

## Terminology
- **Campaign:** the container for Leads, a Sequence and Settings.
- **Sequence:** the tab and the campaign's own ordered outbound steps. They send automatically at their time. A reply, bounce or unsubscribe stops them.
- **Step:** one message in the Sequence.
- **Follow-ups after a reply:** a campaign setting, either "Off, hand to the Inbox" (default) or "AI drafts, you approve". With AI drafts, step 1 "Reply to their answer" answers the reply and the later steps follow up, each as a draft a person approves. Under it, "Stops for these reply types" lists the types whose Follow-ups rule is Stop. The code calls the setting After a reply (`after-reply`).
- **Follow-ups in progress:** the runs of Follow-ups after a reply that have not ended.
- **Lead status:** where a lead stands in outreach. One of New (in no campaign), Queued (waits for its first step), In sequence (inside the campaign's steps), Paused (its campaign is not running), Replied, Finished (every step went out, no reply) or Stopped (a bounce, a suppression, a failure or a cancellation cut it short). Leads only: a contact has no lead status.
- **In sequence:** the lead status for a lead inside the campaign's steps.
- **Reachability:** which channels can reach a person, kept apart from the lead status. The term stays internal; the UI shows "Do not contact" (no channel) and "Email suppressed" (email only, LinkedIn stays open).
- **Lead:** a person you are trying to reach, including an unknown sender who wrote first. Leads live in Leads, outside the CRM.
- **Contact:** a person you do business with. Add contact creates one, with or without a deal. A lead becomes a contact when you create a deal from it or make it a contact. Contacts cannot join a campaign and never go back to Leads. A contact without an open deal can be deleted.
- **Company:** the employer of a lead or a contact, identified by its domain. Companies lists a company once it enters the CRM (see Listed in Companies). Two companies can merge, and a company with no people can be deleted.
- **Other domains:** the domains a company took over when another company merged into it. An import or a person form with one of them attaches people to that company. The code calls them aliases (`company_domain_aliases`); the UI never says "alias".
- **Listed in Companies:** a company that the Companies list shows: one added with Add company, one that has or had a contact, or the kept company of a merge. It stays listed until someone deletes it or merges it into another company. A company with only leads stays off the list.
- **Deal:** one sales opportunity with a contact, with a title, stage, owner, amount and expected close date.
- **Stage:** a step of the deal Pipeline (New, Meeting, Proposal, Won, Lost by default). A stage never stops outreach.
- **Pipeline:** the board of deals by stage. Reply handling never says pipeline.
- **Reply type:** the label the AI picks for each reply, such as Meeting requested or Not now. An organization edits its reply types in Settings > Reply handling, and the AI picks one from its name, description and guidance. The code calls it `ReplyType` (`reply_types`). An organization's types form a `ReplyTypeSet` (`reply_type_sets`), which the UI never shows.
- **Group:** one of the four fixed groups of reply types: Interested, Existing customer, Not interested and Other. A group carries no behavior; the type rules do. Filters label it "Reply group". The code calls it `groupKey`.
- **Type rules:** what happens when the AI picks a type, set in Settings under "When the AI picks {type}". Check is "Check before" (the pick waits until a person accepts it), "Check after" (it applies at once and waits for Looks right) or "No check"; the dialog offers them as Before it applies, After it applies and Skip. Reply draft is Write one or Don't write. Follow-ups is Keep going or Stop. Rules count at the moment of a pick, and each pick keeps a copy of the rules it used.
- **Confidence floor:** one organization-wide percent in Settings > Reply handling. An AI pick below it waits for a person, whatever its type's Check says. The column keeps the name `auto_apply_confidence`.
- **AI pick:** the AI's choice of a reply type for one reply, with its confidence and reasoning. The thread's history and the Actions section both read "AI picks". The code calls it a `ReplyTypePick` (`reply_type_picks`) with `pickedBy: ai | person`.
- **Asked to stop:** the reply type for a reply that asks you to stop (system role `stop_request`, key `do_not_contact`). Its rules are fixed at Check before, Don't write and Stop, and it cannot be archived. Picking it never marks the person do not contact: only Stop contacting does.
- **Customer question:** the reply type for a sender who already pays (system role `customer`, key `customer`). Settings shows it as Locked: the AI cannot move a person it labels out of Existing customer, and it cannot be archived. Its rules stay editable.
- **Existing customer:** the group of Customer question. It labels the reply and says nothing about deals: a Won deal does not set it, and it does not make anyone a contact. The code key stays `customer`.
- **Looks right:** the button that confirms an AI pick that applied under Check after.
- **Review stop request:** the button on a reply the AI read as a possible stop request. It opens Stop contacting, where you choose how far the stop reaches, or you change the type instead.
- **Change type:** the dialog that changes a conversation's reply type, with three lines on what the change does to the reply draft, follow-ups and contact. Choosing Asked to stop adds the stop scope and reason, with Stop contacting and Only change the type. The code calls it `changeReplyType` and writes the `reply_type.changed` event.
- **Remind me:** the Next step button that adds a task to come back to the person, due tomorrow and assigned to you.
- **Custom fields:** the fields an organization adds to people and to companies, set in Settings > Custom fields. Person fields show on the lead and contact forms, company fields on the company page.
- **Became a contact:** what a person sees when a lead converts to a contact, as a stop reason and a history line.
- **Make contact:** turns a lead into a contact without a deal, from the lead page or from Add contact when the email or LinkedIn profile matches a lead.
- **Assigned to:** the member who handles a conversation, shown on the thread and on a queue row. The first reply goes to the creator of the campaign the person is in. Anyone can take an unassigned conversation or hand one over, and choosing Nobody keeps it unassigned. A task has its own Assigned to.
- **Owner:** the deal's field only (shown as Deal owner). A conversation has an assignee, not an owner.
- **Actions:** the work to do now: replies to approve, AI picks to review, follow-ups due, next steps, problems and tasks. It opens on Mine.
- **Mine, Unassigned, Others:** the three scopes of Actions. Mine is what is assigned to you, Unassigned has no assignee, Others is assigned to someone else. Unconfirmed sends, unmatched senders and dead letters are Shared and sit outside the scopes.
- **Waiting since:** the time of the last message from the person. Actions lists the longest wait first.
- **Inbox:** the conversations, read or not. Work that needs a person lives in Actions.
- **Conversation:** what a person assigns, reads and closes: one person's reply handling across email and LinkedIn. The code calls it a `record` (`records` table); a `conversations` row is one channel's thread inside it.
- **Tables:** the spreadsheet area: folders, workbooks, tables. The code calls it `grid` (`src/contexts/grid`, `/api/grid`).
- **Workbook:** one file in Tables. It holds one or more tables, shown as tabs.
- **Table:** one tab of a workbook, with typed columns and rows.
- **Enrichment column:** a table column that asks a provider for each row, such as Find work emails or Verify emails. A column that tries several providers in order is a `waterfall` in the code; the UI says "tried in order". The code calls the lookup a provider offers an action (`actionKey`).
- **Enrichment provider:** a data vendor an organization connects with its own key in Settings > Integrations. The AI provider is a separate connection on the same page.
- **Code names:** names that stay different in code and tables, so a reader can map them:
  - `records` holds Conversations.
  - The AI job kind `classification` is the job that picks a reply type.
  - The model output field `subcategoryKey` names the picked type.
  - The stored run reasons `stage_moved`, `classification_corrected` and `classification_undone` mean a person changed the reply type, corrected an AI pick or undid one.
  - The workflow states `unclassified` and `classifying` read as No type yet and the AI picking a type.
- A lead becomes a contact when you create a deal from it or make it a contact.
- "Sequence" never names the post-reply feature in user-facing text. Code and table names keep `sequence`.

## Capabilities and Constraints
- Stack: Next.js 16.4 (App Router), React 19, Tailwind CSS 4.
- AI picks a reply type for each reply and drafts responses; a human approves before sending. A follow-up flow only writes drafts.
- LinkedIn outreach is built and tested against a local stand-in. Profile lookups ran once against a real Unipile account; a full campaign has not.
- WhatsApp, calls, domain qualification and teams are out of scope for the MVP.
- `docs/decisions.md` records scope and design choices.

## Brand Commitments
Brand color is lavender `#b9aaff`, used so far for counts that wait for a person in the sidebar. The count is plain text in the brand hue with no capsule or fill: lavender on the dark sidebar, and the same hue mixed toward `#1e1724` on the light sidebar so it keeps 4.5:1 contrast. The collapsed rail marks the same state with a lavender dot. Everything else stays neutral grey; the existing UI is the design authority. No logo mark is chosen: the sidebar shows the text wordmark "MiaSDR".

## Evidence on Hand
README.md and `docs/` describe features, routes and decisions. The project has no testimonials, customer logos or benchmarks yet, so pages and copy cite none.

## Product Principles
- A person approves every message an AI writes before it sends.
- A reply, bounce or unsubscribe stops outreach to that lead.
- The team owns its data, mailboxes and keys.
- Send rules and responsible-use limits stay visible, not hidden.

## Accessibility & Inclusion
No formal standard yet. Text and the sidebar counts keep 4.5:1 contrast in light and dark mode, and the Inbox and Actions lists work from the keyboard (j, k and Enter).
