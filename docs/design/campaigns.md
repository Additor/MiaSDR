# Campaigns

How the campaign pages behave. The parts and rules they build on live in [DESIGN.md](../../DESIGN.md).

Campaign pages use the record frame. `PageHeader` keeps the breadcrumb (Campaigns / name) and `RecordHeader` carries the name as the h1. Beside it sits `CampaignStatusToken`, one neutral token with an icon per status (Draft, Active, Paused, Completed, Archived), in the same quiet token look as `LeadStatusToken` (`stateTokenClass`). The Campaigns list shows the same token in its `compact` size. The controls go in `actions`, the main move first; on a phone, Mark completed and Delete move into a More menu. One `MetaLine` names the channel (`ChannelName`: the icon and the name in muted text, as on the Campaigns list), the step count and the senders ("All mailboxes", "From a and b"), on one wrapping row on a phone too, and the campaign counts follow it. The Leads heading carries no count: the All chip and the summary say it.

- **Follow-ups after a reply.** The campaign's Settings tab has one section with that name. A `RadioGroup` picks the mode: "Off, hand to the Inbox" (the AI still drafts a first reply for reply types set to Write one) or "AI drafts, you approve", which edits the steps: 1. Reply to their answer, then the follow-ups. Under the form, "Stops for these reply types" lists the organization's types whose Follow-ups rule is Stop, with Change in Settings, and one muted line names the fixed stops (a new reply, do not contact, an unsubscribe, a bounce, the suppression list, a conversion, closed reply handling). Follow-ups in progress closes the section as a table under its head with a `Count`.
- Every block below the tabs is a ruled section (`CampaignSection`, the shell's `Section`), never a card. Steps form a divided list, and the step you edit gets a 1px foreground rule on its left.
- The Leads tab speaks the lead status vocabulary scoped to the campaign. `campaignLeadStatus()` runs `leadStatus()` on one enrollment and the campaign status, so a row reads Queued, In sequence, Paused, Replied, Finished or Stopped through `LeadStatusToken`. A removed lead shows no token.
- The status filters above the list are `FilterChips` with the same words, because they narrow the list, and they share `ListToolbar` with the search. Rows per page sits with the pager. The campaign tabs stay a `ViewSwitch`.
- An uncertain state, such as a send that may or may not have gone out, uses `text-warning` on its icon and label, never a fill and never red.

Removing leads from a campaign ticks rows and opens the shell's `BulkBar` above the list, in the flow.
