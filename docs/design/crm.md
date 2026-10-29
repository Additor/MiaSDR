# Leads and the CRM

How the lead, contact, company and deal pages behave. The parts and rules they build on live in [DESIGN.md](../../DESIGN.md).

## Lead header

The lead status picks the filled action: Replied with a conversation leads with Open conversation, New, Finished and Stopped lead with Add to campaign, and Queued, In sequence and Paused have none, since the sequence is working the lead. Create deal follows as an outline button. More holds Add to campaign when the header does not show it, Make contact without a deal, and Delete lead. A do not contact lead is offered no campaign. Previous and Next lead sit in the top bar as two outline icon links that stay put from lead to lead, each with a tooltip that names its key ("Next lead (])"), and `[` and `]` follow them. At an end of the list the link becomes an `OffAction` that says why ("This is the last lead in the list."). Imported fields closes the page folded behind its count, with Copy and the Map buttons inside.

## Stop controls

Every person side panel on a lead, contact or deal page ends with the Do not contact block (`DoNotContactCard`): when and why the person was marked, if they were, then the control. What marking does is said in the confirm step, next to the reason. Each stop works the same way: a quiet outline button opens the reason or the consequence in place, and only the confirm button is red (`Confirm do not contact`, `Confirm stop` for follow-ups). Clearing do not contact asks too. The safe choice is named (`Keep do not contact`, `Keep following up`, and `Keep contacting` on a mark or a bulk mark).

Deleting a lead or a contact is a rare action, so it sits in the header's ghost More menu, as Delete company and Delete deal do. The dialog says whether the record qualifies; one the rules protect gets the reason and nothing to confirm. A side panel never ends on a refusal. The thread's own stop path is in [Actions, Inbox and the thread](inbox-and-actions.md#stopping-contact-from-a-thread).

## Deal board

The Pipeline page (`src/app/(app)/crm/pipeline`) is a `ScrollCue` of stage columns, 18rem wide, each a heading with its count and totals over a stack of deal cards.

- **Drag.** A card drags to another column. The column under it takes the `bg-primary/5` tint and a `ring-primary/30` hairline, and an empty one reads "Drop a deal here". The card moves on screen at once, faded until the server confirms, and the column counts and totals follow it; the board does not reload, so cards loaded with "N more" stay. A refused move puts the card back where it was before that drop, says why in a toast and reloads the board. A card whose move is on its way cannot drag again, and its Move stage button waits too. A drop on Won or Lost opens the move dialog on that stage, as Mark won and Mark lost ask first; Lost keeps its reason.
- **Move stage.** Each card keeps its Move stage button, the way to move from the keyboard or a touch screen.
