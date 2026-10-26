---
name: MiaSDR
description: A quiet, grey working surface for small outbound sales teams, with lavender reserved for work that waits on a person.
colors:
  background: "oklch(1 0 0)"
  background-dark: "oklch(0.145 0 0)"
  foreground: "oklch(0.145 0 0)"
  foreground-dark: "oklch(0.985 0 0)"
  muted-foreground: "oklch(0.52 0 0)"
  muted-foreground-dark: "oklch(0.708 0 0)"
  border: "oklch(0.922 0 0)"
  border-dark: "oklch(1 0 0 / 10%)"
  primary: "oklch(0.205 0 0)"
  primary-dark: "oklch(0.922 0 0)"
  destructive: "oklch(0.505 0.213 27.518)"
  destructive-dark: "oklch(0.704 0.191 22.216)"
  destructive-solid: "oklch(0.505 0.213 27.518)"
  destructive-solid-dark: "oklch(0.55 0.22 27)"
  ring: "oklch(0.556 0 0)"
  ring-dark: "oklch(0.556 0 0)"
  warning: "oklch(0.52 0.13 60)"
  warning-dark: "oklch(0.83 0.14 80)"
  brand: "#b9aaff"
  brand-count: "color-mix(in oklab, #b9aaff 55%, #1e1724)"
  brand-count-dark: "#b9aaff"
typography:
  record-title:
    fontFamily: "Geist, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  settings-heading:
    fontFamily: "Geist, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  section-heading:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
  bar:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
rounded:
  md: "0.4rem"
  lg: "0.5rem"
spacing:
  field: "0.375rem"
  group: "0.75rem"
  section: "1.5rem"
  section-wide: "2rem"
  gutter: "1rem"
  gutter-wide: "1.5rem"
  page-end: "3rem"
components:
  top-bar:
    height: "3.5rem"
    padding: "0 {spacing.gutter}"
    typography: "{typography.bar}"
---

# MiaSDR design system

The code is the authority. When this file and the code disagree, `src/app/globals.css` (tokens), `src/components/ui` (primitives) and `src/components/shell` (shared shell parts) win, and this file needs a fix. The YAML frontmatter above holds machine-readable tokens for design tooling: a plain key is the light value, and the same key with `-dark` is the value under `.dark`.

## Overview

MiaSDR is an operating tool. A sales rep scans lists, opens a record and acts, many times a day. The surface stays neutral grey on white (and its dark counterpart). Structure comes from type weight, hairlines and spacing, not from boxes or color. The code is the source of truth: tokens live in `src/app/globals.css`, primitives in `src/components/ui`, and the shared shell in `src/components/shell`.

## Colors

Everything is grey. Normal states use the secondary badge; a colored badge marks an exception. Three hues carry meaning, each with one job:

| Hue | Token | Means | Form |
|---|---|---|---|
| Red | `--destructive`, `text-destructive` | An error or an irreversible action: a failed send, a refused registration, a dead inbound event, Delete | Error text, the destructive button, the badge of a failed row |
| Amber | `--warning`, `text-warning` | An uncertain or degraded state: an unconfirmed send, an unknown outcome, a paused send engine, a limit near its end, a stale table | The icon and a short lead label only. Never a fill, a tinted band or a colored badge. The sentence beside it stays in the foreground. |
| Lavender | `--sidebar-count`, `text-sidebar-count`, the rail dot `bg-sidebar-primary` | Work that waits for a person: Inbox unread, Actions pending, open setup steps, Settings areas an admin must look at | A plain count in the brand hue with no capsule, and a dot where no count fits (the collapsed rail, the Settings nav) |

- Success is the normal outcome, so it reads in the foreground. No green: a delivered test email shows a muted check and the message.
- A count goes red only when the row is an error that a retry cannot fix by itself. "2 failed" on the Settings overview is lavender: it waits for an admin.
- The Setup guide item in the sidebar shows "3 of 5" as lavender count text and the lavender dot on the rail, like Inbox and Actions. No amber fill, no badge.
- `--warning` keeps 4.5:1 on the background in both themes (`oklch(0.52 0.13 60)` light, `oklch(0.83 0.14 80)` dark).
- Red has two tokens. `--destructive` colors text and its 10% tint. `--destructive-solid` fills a solid destructive button behind white text. In light mode they match. In dark mode the text red (`oklch(0.704 0.191 22.216)`) gives white text only 3.4:1, so the fill takes a darker red (`oklch(0.55 0.22 27)`).
- The lavender count changes with the sidebar. The brand hue `#b9aaff` reaches only about 2:1 as text on the light sidebar, so `--sidebar-count` mixes it toward `#1e1724` there (`color-mix(in oklab, #b9aaff 55%, #1e1724)`) until it reaches 4.5:1. On the dark sidebar the count uses `#b9aaff` as is. The rail dot (`--sidebar-primary`) stays `#b9aaff` in both themes.
- Dark mode redefines the same tokens under `.dark` in `src/app/globals.css`. Light and dark values for the main tokens sit in the frontmatter.

## Typography

Geist Sans for everything, Geist Mono for code. Tables and fact lists use tabular numerals.

| Role | Size and weight | Where |
|---|---|---|
| Record title | text-2xl, semibold | The h1 of a lead, contact, company or deal page (`RecordHeader`) |
| Settings heading | text-base, semibold | The h2 of a `SettingsSection`, and a step of the lead import |
| Section heading | text-sm, semibold | `RecordSection`, `AsideSection`, the Actions groups, analytics report blocks |
| Top bar | text-sm; parent step muted, current step medium | `PageHeader` |
| Body and labels | text-sm | Everything else; helper text in muted-foreground |
| Meta | text-xs, muted | Timestamps, footnotes under a list |

The top bar is navigation, so it carries one size. "Leads / Ada Lovelace" reads as one breadcrumb: the parent in muted text, the slash dimmer, the current page in the foreground at medium weight. A page with a display title shows it in the body (record pages); every other page names itself in the bar.

## Layout

### Spacing roles

Spacing follows the relationship between two things, never a number picked on the spot. Four roles, loose to tight:

| Role | Token | Use it between | Narrow / wide |
|---|---|---|---|
| gutter | `--space-gutter` | The page edge and the content. The top bar and the body share it, so the title and the first column start on one line. | 1rem / 1.5rem |
| section | `--space-section` | Independent parts of a page: the record header and its body, record sections, Settings blocks, the work column and the side column. | 1.5rem / 2rem |
| group | `--space-group` | Parts of one thing: a toolbar and its table, a section heading and its content, form fields, list rows. | 0.75rem |
| field | `--space-field` | A label and its control, a heading and its one-line description. | 0.375rem |

Gutter and section open up from the `lg` breakpoint. Group and field stay fixed, so a form reads the same in a side panel and on a full page.

Each role is a Tailwind spacing key, so any spacing utility takes it by name: `gap-section`, `py-section`, `px-gutter`, `gap-group`, `pt-section`.

### Patterns

| Class | What it does |
|---|---|
| `page` | The body under a `PageHeader`: gutter on three sides, 3rem at the bottom, one column that never overflows. Pair it with a stack. A page that ends in a sticky bottom bar (Leads, Contacts) adds `pb-0`: the bar carries its own padding. |
| `stack-section` | A grid whose children are independent sections. |
| `stack-group` | A grid whose children are parts of one thing. |
| `stack-field` | A label and its control. |

Pick the stack by asking what the children are to each other:

- A list page (Leads, Contacts, Campaigns, Analytics) is one task: `page stack-group`. The filters, the count line and the table sit close.
- A record page (`RecordPage`) is several independent parts: `page stack-section`.
- A ruled sheet (`RecordSection`) puts a hairline between sections and section space on both sides of it: `border-t py-section`.
- A side panel (`AsideSection`) pads its blocks by `p-4` and stacks their content by group. A block a person reads now and then (histories, lists) is an `AsideDisclosure`: the same padding and head, folded, with its count beside the title.
- A Settings page is a column of blocks (`SettingsSection`, below).
- A form stacks its fieldsets by section, the fields inside a fieldset by group, and each label and control by field.

A heading always sits closer to its content than to the block above it. A section heading gets section space above and group space below.

### Settings blocks

`SettingsSection` (`src/app/(app)/settings/settings-section.tsx`) is the only block on a Settings page.

- Each block is a `section` with a text-base semibold h2 and an optional one-line muted description, set as `stack-field`. The content follows by `stack-group`.
- Blocks sit one after another with `border-t py-section`. The first block has no rule and no top padding, the last no bottom padding (`first-of-type`, `last-of-type`), so put intro text in a `div` or `p` before the first block, not between blocks.
- A form lives inside its block and ends with its own Save button in a plain row. No card, no footer band.
- A list of items inside a block (mailboxes, LinkedIn accounts, documents, stages, fields, invitations, jobs) is one ruled list: `RULED_LIST` (`divide-y`) with `RULED_ROW` rows. No box around the list and no box per item. An item's name is an h3 at text-sm medium.
- Two levels at most: block, then rows. The reply taxonomy groups subcategories under an h3 per category inside one Subcategories block.
- Width: the content column is `max-w-3xl`. Jobs and Inbound events take `max-w-5xl`: their tables carry six to eight columns of times, counts and errors. Tables in Settings sit flush in the column (`ScrollableTable`), not in a card.
- The Settings overview (`/settings`) keeps its bordered link lists: they are navigation rows, not content blocks.
- Groups follow what a setting changes, and each setting has one home: You, Workspace, Sending, CRM, AI, Operations (`settings-nav-config.ts`).

### Settings forms

Every Settings form builds from the same parts, so a person learns one way to change a value:

- **Fields.** shadcn's `Field` family (`src/components/ui/field.tsx`): `FieldGroup` stacks fields at group space, `Field` holds a `FieldLabel`, the control and an optional `FieldDescription` at field space, `FieldSet` with a `FieldLegend variant="label"` groups related controls, and `FieldError` carries the error. A checkbox or radio sits in `Field orientation="horizontal"`. In a flex row a field takes `className="w-auto"`.
- **Save.** A form is controlled and compares its values with what is saved. `SaveRow` (`settings/settings-form.tsx`) ends it: the error, then Save, which stays off until something changed, then "Unsaved changes" and a ghost Discard while it is on. The button is always the default size and reads Save. `useLeaveGuard` asks before the tab closes with unsaved changes. A list that saves each step at once (custom fields, stages) has no Save.
- **Members.** A member sees the same page with the controls off or hidden and the `AdminNotice` once at the top, before the first block. No Save row. A page with nothing a member may see (Audit log, Integrations, Inbound events, Jobs, LinkedIn) shows only the notice (`replacesPage`).
- **Add and edit.** A list of things (subcategories, knowledge documents) leads the page. Add sits on the block's heading row as an outline button, and Add and Edit open the same `ConfirmDialog` with the form in its body and Save as the confirm. A list whose items are only a name (custom fields, pipeline stages) adds in place instead: a Name field and an Add button after the list, Add off while the name is empty, no Save row. A short single-value change (a field or stage name) edits in place: Enter saves, Escape cancels, Save stays off while the name is unchanged.
- **Empty and archived.** An empty list inside a block is an `EmptyState` with its title only; an empty group under a category h3 keeps a muted line. An archived item keeps full-strength text and says its state with an Archived badge, never with opacity.
- **Row actions.** Ghost `sm` buttons at the end of the row (Edit, Recheck, Requeue, Retry, Manage, Reconnect); the destructive step is the dialog's red confirm, never a red button in the row. Reordering uses `ReorderButtons` (arrow icons, "Move {name} up").
- **Pickers.** A long list is a searchable `Combobox` (`TimeZoneSelect`, `CountrySelect`); a short fixed list is a `Select`. Sending days are a `ToggleGroup` of outline buttons (`WorkingHoursFields`, shared by mailboxes and LinkedIn accounts), and a choice between two modes with an explanation is a `RadioGroup` of horizontal fields.

### Inbox thread

The thread page uses `RecordBody`. The work column holds the conversation and every decision about it: the summary line (Waiting on, with the state in its tooltip, and the channel only when it is not email), the latest message, the reply panel, Next step, Follow-ups (only while a run exists or the campaign drafts follow-ups), earlier messages, then History, where Classification history (open while an entry waits for review), Drafts, Notes and Activity fold as `RecordDisclosure`s with their counts and a history with nothing in it is left out. The bordered side panel holds what is on file about the person, not decisions: the person, Assigned to (the assignee's name as a select with Take it, never a status badge or a sentence), Tasks (New task in its title row, `compact`), then Campaigns and Other conversations folded as `AsideDisclosure`s, and Do not contact with Clear only once the person is marked. A campaign that hands replies to the Inbox says so in its Campaigns row. Lists inside a block are plain rows, notes and classifications divided by hairlines. Messages keep their own frame; no rule covers them yet. Opened from Actions, the header breadcrumb reads Actions and Next in queue sits on the right; opened from the Inbox it reads Inbox with Next unread. Both answer `]` and show the key on the button. After a send, an accepted suggestion, Looks right or a step taken in Next step, the thread links to Next in the queue.

- **Decision first.** A held suggestion, an applied change nobody looked at, or a stop request opens the Classification card above the reply while no draft waits for approval; under a waiting draft it stays below with outline buttons, so one filled button leads the page. Hand-typing folds behind Write it yourself while the AI can draft.
- **Next step.** Under the reply, one section answers what happens to the person: the reply category (who set it is a sparkle or person mark beside it) with Change category, then three outline buttons to finish without a reply. Follow up later adds a task due tomorrow; Done, no reply needed closes reply handling with a reason that starts as the category, and Reopen undoes it, so its confirm is not red; Stop contacting… opens the stop dialog. Closed, the section says Done with the reason and Reopen in place of the buttons.
- **One home for the category.** The Classification card shows the AI's reading: the chip, then confidence and reasoning, inside the suggestion box when one is held. Changing the category happens only in Next step's Change category, a dialog with the AI's reading on top, whether the AI read the last reply wrong or something happened off the thread, a searchable picker grouped by category, and one line on what the change does to drafts, follow-ups and contact before you confirm.
- **Draft edits survive.** Change category, Done and Stop contacting retire the open draft, so they save unsaved edits in the reply editor first (`draft-edits.ts`), and the out-of-date preview shows what was typed.
- **Out of date.** A stale draft is a read-only preview with its cause in one sentence and the warning icon on its badge. Regenerate leads, Edit and send anyway copies the text into the composer, and no second editor stacks above it.
- **Message cards.** An inbound message names the person with title and company, the address on the line below.

### Actions and Inbox lists

Both pages are lists of rows, not tables. A row is one `RowLink` (a stretched link) in `LIST_ROW_FRAME` (`grid grid-cols-1`, so a long draft or subject cannot widen the page), at least 44px tall on a phone.

- **Actions.** The toolbar holds the scope chips (Mine, Unassigned, Others) with their counts and the Filters button. Under it one strip counts every list (Problems, Replies, Follow-ups, Classifications, Next steps, Tasks, and the shared lists when they hold something): a list with work is a jump link with a lavender count, an empty one a muted zero. The oldest wait sits at the strip's right, its name linked to its row. Sections run problem first. A section head is the text-sm semibold title with a lavender count, and an info mark only where the name needs explaining (Classifications, Problems, the shared lists); a section with nothing in it has no head. A row shows the name, the reply category and channel, the wait as a `time`, the start of the inbound message, and a detail line (the draft for a reply). The verb is trailing text at medium weight in the foreground. `Accept` and `Looks right` are small buttons above the stretched link (`relative z-10`).
- **Inbox.** The toolbar ends on a link to the conversations waiting in Actions ("1 waiting in Actions"). Rows sit under `h2` day headings in a `divide-y` bordered list: an unread dot in a fixed gutter, the name and email, the time on the right (`HH:mm` for today and yesterday, a date otherwise), the subject and snippet on one line, and one state (category badge, auto-reply badge or an amber bounce icon). The channel shows only when it is not email.
- **Marks.** An unconfirmed send carries the amber icon, a failed draft, job or dead letter the red icon, and each list uses the lavender count for work that waits on a person. No fills.
- **Hidden mail.** All leaves automated mail out. An eye-off mark with the count sits beside the Inbox chips, names the kinds in its tooltip and opens the Automated view, which the More menu also counts.
- **Keyboard.** `ListKeys` marks rows with `data-list-row`: j and k move, Enter opens. The keys sit on a keyboard mark (`KeyboardHint`) at the right of the toolbar, hidden on a phone. The thread adds `]` for the next queue item and Ctrl or Cmd+Enter to approve.

### Tables

A workbook (`src/app/(app)/tables`) is a spreadsheet and the densest surface in the app. The tables browser is an ordinary list page: New folder, New from file and New workbook (the filled one) in `PageHeader`, and a search that filters as you type in `ListToolbar`. A workbook page fills the viewport height (`h-svh`): `PageHeader` with the workbook name and Tables as the back step, a strip of table tabs, then the active table.

- **Names.** On the workbook page, the workbook name and each table tab rename in place. The title is an `EditableTitle` (`PageHeader`'s `rename`): hover or focus shows a muted ground and a pencil, a click, Enter or F2 opens the field, Enter or leaving it saves and Escape cancels. A tab opens the same field on a double-click, F2 or Rename in its menu, and a new table opens with its tab in rename under the default name. No dialog names a table or renames a workbook there. The tables browser is a list of many workbooks and folders, so its row menu renames one through a name dialog. The header's actions area holds one ghost More menu with Move to folder and Delete workbook.
- **Tabs.** The strip is a `ScrollCue` without a hint line, with New table after it. The open tab shows its More menu; the others show it on hover or focus, and a touch screen offers it on the open tab only. On a phone the tabs, the menus and New table are 44px tall. The table stacks its toolbar, the filter and sort chips, the selection bar and the grid at `gap-2` inside `p-3`, tighter than the page roles, because the grid needs the room.

- **Grid.** `DataGrid` is one `role="grid"` scroll container with a hairline border and rounded-lg. Rows are 32px and the header 36px on a muted band. A 72px gutter holds the row checkbox and number. Cells are text-sm. The header names the column at text-xs medium, with the type and the fill rate in 10px muted text. Numbers and currency align right in tabular numerals. Formula columns and columns a run fills are read-only and sit on a `bg-muted/30` tint. Pinned columns stay on the left behind a shadow edge; at phone width the grid ignores pins. The grid renders the rows in view and loads more near the end.
- **Toolbar.** Two groups. On the left, what you see: search, Filter, Sort, Columns and the row count. On the right, what you do, in the order the work goes and ending on the one filled button: Undo and Redo (ghost, left out on a phone, where the grid's keys do the work), Add (columns, then rows and Import file), Push to campaign paired with an Export CSV icon button (the two ways rows leave the table), Enrich, then Run. Enrich is a menu of the four outcomes, Ask AI about each row and All enrichments; it is filled until the table has a column that runs, and then Run takes the fill and stays last, so the filled button never moves inside the row. Push and Export, and Run with its options chevron, are `ButtonGroup`s; "Auto-run on" shows in Run's chevron while the table auto-runs. On a phone the left group takes the first line and the right group's secondary buttons show their icons; counts stay visible.
- **Enrichment start.** A table with rows and no running column shows one hairline-ruled line of text-xs under the toolbar: "Enrich these rows:", the four outcomes and Ask AI about each row as underlined links into the same choices as the Enrich menu, and "Nothing runs or spends until you press Run". It has no box and no buttons, so the toolbar keeps the one filled button. It goes once a column runs.
- **Enrichment dialog.** It opens on four outcome tiles (Find work emails, Verify emails, Enrich people, Enrich companies), or on one outcome straight from the Enrich menu, where Cancel replaces Back. An outcome reads as three ruled lines, each a label, a sentence and a Change link that opens its fields: Provider (the vendor and its price a lookup; a second tick tries providers in order, "Hunter, then ZeroBounce"), Match rows on (the mapped inputs, the columns they come from and how many rows have them; each input shows its column's first value, and the fields stay open while the mapping covers nothing) and Adds (the new columns as chips, ticked from what the outcome names, with the column name behind Edit). Options folds the caps, timing and reuse. Until a connected provider offers the outcome, the dialog lists only the vendors that do, each connecting in place with its key and price, and keeps what you set. The footer says what a full run can cost, or why the add buttons are off; "Add column" is the filled button and "Add and run first 10 rows" the outline one, so nothing spends until you choose to.
- **One enrichment, one column.** The enrichment column shows the action's main answer and is named for it (Work email, Email status). Other fields become columns only when ticked, or later from the cell drawer's More fields. An empty cell whose row lacks an input reads "Needs email" in muted text.
- **Selection.** The active cell takes a 2px primary ring, a range a `bg-primary/10` tint and a selected row `bg-primary/5`. The tints come from primary, so they stay grey. The fill handle at the corner of a range copies it down on drag. Selected rows open a bar above the grid: the count, "Select all {N} matching rows", then Run, Push to campaign, Export, Delete and Clear, all outline or ghost; red waits for the confirm step.
- **Keyboard.** Arrows, Page Up and Down, Home and End move; Ctrl or Cmd jumps, Shift extends the range. Tab moves across and leaves the grid at the first or last cell. Enter or F2 edits, and a typed character starts an edit with it. Delete clears the range, Shift+Space selects the row, Ctrl or Cmd+A selects every cell, Ctrl or Cmd+Enter runs the cell, Alt+Enter opens the cell drawer and Escape clears the row selection. Copy, cut and paste carry tab-separated text. Ctrl or Cmd+Z undoes and Shift+Z or Y redoes while the grid has focus. Table tabs move with the arrow keys and reorder with Alt+Arrow or a drag. A column's resize handle takes focus: Left and Right resize by 10px (50px with Shift), Home and End jump to the narrowest and widest.
- **Cell states.** A cell shows one trailing icon at most: a spinner while it runs, a red alert for an error, an amber alert for a skipped cell and an amber refresh icon for a stale one. The reason sits in the tooltip and the accessible label. "This table changed elsewhere." takes the amber icon and a Reload button. Run progress is a bordered status line with a thin primary bar, the counts, Stop and Retry failed.
- **Cell drawer.** `CellDrawer` is a right `Sheet`, full width on a phone and `sm:max-w-lg` from sm up (the width classes carry the `data-[side=right]:` prefix so they replace the Sheet's). The column name is the title and "Row n · type" sits under it. Three sections follow with the text-sm semibold heads of the record panels: Value in a muted block with Run this cell beside its head, Last run (the error in red as a sentence, then a `dl`) and Run history as a ruled list, each failed run with its reason. A history that does not load says so and offers Try again.
- **Column dialogs.** Add offers Column and Formula; enrichment and AI columns start from Enrich. The formula dialog previews the expression on one row. The AI dialog takes a prompt that reads other columns as `{{key}}` and makes one column per output field. The enrichment dialog runs one provider action, or several tried in order. The run dialog picks rows with a `RadioGroup`. These and the run dialog are plain `Dialog`s at `sm:max-w-2xl`, capped at 90 to 92svh with a scrolling body.
- **Filter and Sort.** Two `ToolbarPopover`s (see Filters and sorts). Filter holds the condition builder at the `builder` width: column, operator, value, mute and remove per condition, groups nested up to the view's depth, and Match all or any. Sort lists the sorts in order with Add sort. Each edits a draft and saves the view once on Apply, so a half-typed value never reaches the server. A muted condition stays in the view and filters nothing, and the Filter count leaves it out. `AppliedFilters` shows the conditions and sorts above the grid, with Match all or any beside them. A member looking at their own view gets a muted line with Reset to default view.
- **Conflicts.** When another person or a run changed rows you edited, `ConflictDialog` saves nothing and lists each cell with Now and Yours (yours at medium weight). The footer offers Keep current values and Retry my edits.
- **Empty and loading.** An empty table shows `EmptyState` with Import file and Add rows; a search or filter with no hits shows "No rows match". Loading shows skeleton bars. A failed load prints the error in red with Try again.

### Deal board

The Pipeline page (`src/app/(app)/crm/pipeline`) is a `ScrollCue` of stage columns, 18rem wide, each a heading with its count and totals over a stack of deal cards.

- **Drag.** A card drags to another column. The column under it takes the `bg-primary/5` tint and a `ring-primary/30` hairline, and an empty one reads "Drop a deal here". The card moves on screen at once, faded until the server confirms, and the column counts and totals follow it; the board does not reload, so cards loaded with "N more" stay. A refused move puts the card back where it was before that drop, says why in a toast and reloads the board. A card whose move is on its way cannot drag again, and its Move stage button waits too. A drop on Won or Lost opens the move dialog on that stage, as Mark won and Mark lost ask first; Lost keeps its reason.
- **Move stage.** Each card keeps its Move stage button, the way to move from the keyboard or a touch screen.

## Shapes

Radius 0.5rem for panels, inputs and buttons; badges use rounded-md. Hairline borders, no shadows on page surfaces. A side panel is one bordered box with `divide-y` between its blocks. Cards are not the page structure: Settings, the Inbox side panel, Actions, the setup guide, the lead import, analytics and Unmatched senders use ruled sections and divided lists. Cards remain for the sign-in pages, the deal board's cards and the frames of a thread: its messages, the reply panel and the Classification card.

## Components

- `PageHeader`: the 3.5rem top bar on every page. `rename` makes its title an `EditableTitle`.
- `ButtonGroup` (`src/components/ui/button-group.tsx`): buttons read as one control, such as a main button and the chevron that opens its menu (Run) or two related actions (Push to campaign and Export CSV).
- `RecordHeader`, `RecordBody`, `RecordSection`, `AsideSection`, `MetaLine`: the record frame shared by lead, contact, company and deal pages. `MetaLine` carries company and deal facts; lead and contact pages pass none. The header's actions hold at most one filled button, the move that fits the record's state, then outline buttons, then the ghost More menu for rare actions.
- **Lead header.** The lead status picks the filled action: Replied with a conversation leads with Open conversation, New, Finished and Stopped lead with Add to campaign, and Queued, In sequence and Paused have none, since the sequence is working the lead. Create deal follows as an outline button. More holds Add to campaign when the header does not show it, Make contact without a deal, and Delete lead. A do not contact lead is offered no campaign. Previous and Next lead sit in the top bar as two outline icon links that stay put from lead to lead, and `[` and `]` follow them. Imported fields closes the page folded behind its count, with Copy and the Map buttons inside.
- `LeadStatusToken`, `ReachLinks`, `ReachIcons`: the state forms in `src/app/(app)/_components/person`, described under State.
- `Fact`, `EditableFact`, `InlineForm` (`src/app/(app)/_components/record/inline-field.tsx`): the rows of a Details panel and the deal Summary. A fact you can change edits and saves on its own row: a quiet pencil (shown on hover and focus, always on touch) or a click on the value opens the inputs in place; Enter saves only that field, Escape cancels and returns focus to the pencil, and a failed save keeps what you typed with the reason under it. Facts nobody edits close the panel as one muted text-xs line, not as rows (a merge's domains, values of removed fields, a deal's source and stage dates). A person's added, changed and contact-since dates sit on a clock mark in the Details title row, and the campaign that made them a contact is a Source row. Add field gives a value to a field that has none.

### Stop controls

Every person side panel on a lead, contact or deal page ends with the Do not contact block (`DoNotContactCard`): when and why the person was marked, if they were, then the control. What marking does is said in the confirm step, next to the reason. Each stop works the same way: a quiet outline button opens the reason or the consequence in place, and only the confirm button is red (`Confirm do not contact`, `Confirm stop` for follow-ups). Clearing do not contact asks too. The safe choice is named (`Keep do not contact`, `Keep following up`, and `Keep contacting` on a mark or a bulk mark).

The Inbox thread stops contact in one place, Next step's Stop contacting…, which also answers a stop request under the AI's reading. Its dialog asks how far the stop reaches: every channel (do not contact, with a reason, which can be cleared) or only the email address (the suppression list, which stays). The description of each choice says which one lasts, the red confirm reads Stop contacting and the safe choice Keep contacting. The thread's side panel shows the Do not contact block only for a marked person, with Clear. A person who moves a reply to the Do not contact category, by a correction or a move off the thread, is marked too.

Deleting a lead or a contact is a rare action, so it sits in the header's ghost More menu, as Delete company and Delete deal do. The dialog says whether the record qualifies; one the rules protect gets the reason and nothing to confirm. A side panel never ends on a refusal.
- `Tabs`, `ViewSwitch`, `FilterChips`, `EmptyState`, `StatusBadge`: shared shell parts in `src/components/shell`.
- `SettingsSection`, `RULED_LIST`, `RULED_ROW`: the Settings block and its ruled list (`src/app/(app)/settings/settings-section.tsx`).
- Setup guide (`/onboarding`): one divided list of steps. "Next: …" is the one filled button, the next step's action is outline and the others ghost; on a phone the action sits under the step's text.

The primitives in `src/components/ui` come from shadcn's `base-nova` style built on `@base-ui/react` (`components.json`). Extend a primitive with a variant or a prop in place; don't fork a copy into a feature folder.

### Shell parts

The app layout and many pages share these parts from `src/components/shell`:

| Part | Use it for |
|---|---|
| `AppSidebar` | The one app sidebar, mounted by the app layout: organization switcher, the place rows with their lavender counts, the setup guide item and the user menu. Rows are 32px on a desktop pointer and 44px in the phone sheet. A row is a place; views and filters stay in the page. |
| `CommandPalette` | Jump to any page by name with Cmd or Ctrl+K. `AppSidebar` mounts it; don't mount a second one. With nothing typed, recent picks come first. |
| `OutboundPauseBanner` | The one line across the top of every page while `PAUSE_OUTBOUND` is set. Amber icon and lead words, no tinted band. The app layout renders it. |
| `ResponsibleUseNote` | The one-line consent and LinkedIn terms note where a campaign starts and where LinkedIn accounts connect. Keep its text in the component. |
| `ListSkeleton` | A list while its rows stream in, at the height of the real rows, so the page does not jump. `bordered` for framed lists like the Actions groups. |
| `SummaryLine` | A compact row of label and value pairs ("Sent 120 · Replied 14") above a table or in a detail header. It is not a metric card and does not headline a page. |
| `TouchTip` | Secondary text on a trigger: a tooltip on hover and keyboard focus, a popover on a tap where the device cannot hover. `InfoTip` and `StateTip` build on it. A link trigger keeps a tooltip, because a tap navigates. |
| `ScrollCue` | A horizontal scroller that fades the edges with more content and shows a hint while the right edge is out of sight, such as the deal board. A strip with no room for the hint, such as the table tabs, leaves `hint` out; `after` places a control past the scroller. |
| `EditableTitle`, `NameInput` | A name you rename where you read it: a page title through `PageHeader`'s `rename`, or a tab that swaps in `NameInput`. Enter or leaving the field saves, Escape cancels, an empty name on Enter says "Give it a name.", and a refused save keeps your text with the reason floating under the field. |
| `ReachFlag` | A neutral badge for Do not contact or Email suppressed where a send is blocked. The sentence that explains why stays red. |
| `ErrorWithLinks` | A stored error text that names the inbound events page; it turns that path into a link. |
| `Time` | Every timestamp: a `time` element in the organization's time zone with the UTC original in the tooltip, `dateOnly` for dates, and `relativeTo` with the server's `now` for "5 min ago". Outside JSX, use `formatDateTime` from `@/shared/format-time`. |

### List parts

Every list page builds from the same parts in `src/components/shell`:

| Part | Use it for |
|---|---|
| `ListToolbar` | The one row between the header and the list: chips, search and the Filters button on the left, list options (Columns, Export, the keyboard mark, a side count) on the right. |
| `ToolbarPopover` | The popover behind a toolbar button that edits a draft: Filters on a list with two or more filter fields (Leads, Contacts, Inbox, Actions, Analytics), Filter and Sort on a table. The trigger is an outline button with an icon, a label and a count; the popup holds a scrolling body and a footer with Reset and Apply. See Filters and sorts. |
| `FilterPopover` | `ToolbarPopover` for a list's GET form. Its fields stay mounted inside the form while it is closed, so Enter in the search keeps the filters in force. |
| `FilterSection`, `FilterRow`, `SelectField`, `TristateField`, `DateRangeField` | The fields of a Filters popover: a ruled section title, a row with the label on the left and the control on the right (stacked on a phone), a native select, an Any, Yes and No segment, and a from and to pair on one row. |
| `AppliedFilters`, `FilterChip` | The filters and sorts in force as removable chips under the toolbar, with the one Clear filters at the end. A chip is a link on a list and a button on a table; a muted table condition reads struck through. |
| `InfoTip` | Help on demand: an info mark beside a heading whose name needs explaining, the text in a tooltip on hover and keyboard focus, in a popover on a tap on a touch screen, and in screen-reader text. Use it in place of a muted description line. |
| `SearchField` | The search box: icon inside the field, Enter submits the GET form, a screen-reader Search button. No Apply button beside it. |
| `FilterChips` | A row that narrows the list on screen (Show all, a lifecycle, a state). Round chips, `role="group"`, the active chip filled, a `count` in one muted tabular style. |
| `ViewSwitch` | A row that switches to another view of the page with its own URL (Inbox Conversations and Scheduled, a campaign's Leads, Sequence and Settings, the Analytics reports). Underlined tabs in a `nav`. |
| `ListPager` | "12 contacts" at the foot of the list, and from two pages on "page 2 of 3" with ghost Previous and Next links. A page size control goes in its `size` slot, never at the top. |
| `EmptyState` | Nothing to show: the missing thing as the title, the next step as the description and action. It draws no box. |

Every list page (Inbox, Actions, Leads, Contacts, Companies, Campaigns, Tables, a campaign's leads) stacks the same way: the create action in `PageHeader` (Import, New campaign), an optional `ViewSwitch`, `ListToolbar`, `AppliedFilters`, the list, then `ListPager`. Actions pages each section with Load more instead, because its sections share one page. Explanations become a count, a mark or an `InfoTip`; a muted sentence between the toolbar and the list is reserved for an error or a load failure.

A row that narrows the list is `FilterChips`; a row that switches views is `ViewSwitch`. Client state without a URL (a record's Activity tabs, Settings field types, the Jobs page's Needs attention and History) uses `Tabs`.

### Filters and sorts

Three rules decide where a filter lives:

1. A control that narrows one dimension and that people switch often stays in the toolbar and applies at once: `FilterChips` (Mine, Unassigned and Others, the campaign states) and the board's Owner. A table's column menu sorts and filters one column at once for the same reason.
2. Two or more fields go behind one Filters button in a `ToolbarPopover`. The popover edits a draft. Apply commits it in one write (a URL or a saved view); Escape, a click outside or the trigger again throw the draft away. Reset empties the draft and leaves the page alone. Contacts' Deal owner and Deal stage live here.
3. A closed popover never hides what applies: `AppliedFilters` shows each filter and sort as a chip. Removing a chip applies at once, and Clear filters removes them all.

A table splits Filter and Sort into two popovers with the same anatomy: the trigger, the draft, Reset and Apply, the chips. A list sorts from its column headers and has no Sort popover.

The popup uses the menu surface (`bg-popover`, `shadow-md`, the foreground ring) and opens under its trigger at 30rem (`fields`) or 40rem (`builder`, a table's conditions and sorts). The body scrolls inside the available height and the footer stays in view. On a phone the same popup sits at the bottom edge at full width, and its controls are 44px tall. Opening focuses the first control; closing returns focus to the trigger. A failed Apply keeps the popover open with the reason above the footer.

The words are Filters, Filter, Sort, Reset, Apply and Clear filters.

### Dialogs

Every confirm and form dialog builds on `ConfirmDialog` (`src/components/shell/confirm-dialog.tsx`): Add contact, Add company, Make contact, Create deal, the company merge, Delete contact and Delete company, New campaign, Add to campaign, New search, Upload sheet, and the tables dialogs that name, move, describe, add rows, import and push. The column dialogs and the run dialog stay plain `Dialog`s (see Tables).

- The title names the object, the confirm repeats the action ("Delete 2 leads", "Remove mailbox"), and the cancel names the safe choice when "Cancel" would read as the destructive one ("Keep contact", "Keep company", "Keep contacting"). Pending labels name the action and end in "…" ("Deleting…").
- Enter in a text field of the body presses the confirm, as a form submit would. A textarea and a control that handles Enter itself keep the key.
- The panel stops at the viewport height minus 2rem. The header and the footer stay in place and the body scrolls, so the confirm stays on screen at 390x844 with a deal's fields or a merge preview open.
- A dialog with two steps keeps one panel and swaps the body: Add contact's matching-lead step, the merge picker and its preview, the bulk conversion's second confirm. `back` puts a ghost Back button at the start of the footer, and Back keeps what you typed or picked.
- Errors and outcomes the caller renders as data (a blocker list, changed counts, a bulk report) sit in the body in a `role="status"` region, in body text, never muted.
- Delete lead and Delete contact sit in the header's ghost More menu (Stop controls). The item opens the confirm with counts when the record qualifies, or a plain dialog with the reason and nothing to confirm when the rules protect it.
- A company with people left opens a plain `Dialog` with the reason and a link to find them, and no confirm.

### Bulk bar

Leads and Contacts share the selection model (`SelectionProvider`, `src/components/shell/selection.tsx`), keyed by the list's filter so a selection survives paging and resets on a filter change. While rows are ticked the page reserves the bar's height as scroll padding (`useBarScrollPadding`), so a focused row never sits under it. The bar sticks to the bottom edge: the "{n} selected." line, then at most four controls, the bulk actions first, then Clear selection (Esc clears too) and More actions with "Select all {N} matching".

### Campaign page

Campaign pages use the record frame. `PageHeader` keeps the breadcrumb (Campaigns / name) and `RecordHeader` carries the name as the h1. Beside it sits `CampaignStatusToken`, one neutral token with an icon per status (Draft, Active, Paused, Completed, Archived). The Campaigns list shows the same token in its `compact` size. The controls go in `actions`, the main move first; on a phone, Mark completed and Delete move into a More menu. One `MetaLine` names the channel, the step count and the senders ("All mailboxes", "From a and b"), on one wrapping row on a phone too, and the campaign counts follow it. The Leads heading carries no count: the All chip and the summary say it.

- Every block below the tabs is a ruled section (`CampaignSection`: a text-sm semibold h2 with `border-t py-section`), never a card. Steps form a divided list, and the step you edit gets a 1px foreground rule on its left.
- The Leads tab speaks the lead status vocabulary scoped to the campaign. `campaignLeadStatus()` runs `leadStatus()` on one enrollment and the campaign status, so a row reads Queued, In sequence, Paused, Replied, Finished or Stopped through `LeadStatusToken`. A removed lead shows no token.
- The status filters above the list are `FilterChips` with the same words, because they narrow the list, and they share `ListToolbar` with the search. Rows per page sits with the pager. The campaign tabs stay a `ViewSwitch`.
- An uncertain state, such as a send that may or may not have gone out, uses `text-warning` on its icon and label, never a fill and never red.

### State

A person carries three states, each with one form. Lists and record pages read the same function for each, so a row and its page agree.

| State | Who has it | Form | Where |
|---|---|---|---|
| Lead status | Leads only | `LeadStatusToken`: a neutral token, a lucide icon per state and the label (New, Queued, In sequence, Paused, Replied, Finished, Stopped) | Beside the h1 in `RecordHeader`'s `state` slot; the Status column of Leads, with the campaign as a muted second line |
| Deal stage | Contacts, through their deals | The stage badge | The Deals section of the contact page, the Latest deal column of Contacts, the deal page |
| Reach | Leads and contacts | `ReachLinks` in a record header and the Inbox side panel, `ReachIcons` in a list row | Do not contact is a neutral badge with a ban icon in front of the links, which turn muted. A suppressed address keeps its link with a crossed mail icon and a line through. A missing channel is left out of the header and shows as a dashed mark in a list. |

- One form per state. The token, the badge or the link says the state; dates, the campaign, the step, the next send and reasons sit in a tooltip on hover and on keyboard focus (`StateTip`), in a popover on a tap on a touch screen unless the trigger is a link, and in screen-reader text inside the trigger.
- A contact carries no status token. Its header shows who the person is, how to reach them and what to do next; Contact since and the source campaign are Details facts.
- An open channel is a working link. No text says "can be contacted".
- State tokens stay neutral grey: no lavender and no red. Red stays for irreversible actions and errors.
- A list shows both a Reach column and an Email column. The icons act (write, open the profile) and show the reach state; the Email column is data a rep scans, sorts by eye and copies. The Leads and Contacts lists both carry the pair.

## Do's and Don'ts

- Do pick a spacing role from the relationship. Don't write `gap-4 p-4` on a new page body; write `page stack-group` or `page stack-section`.
- Do keep the top bar on one size. Don't give the current page a larger size than its parent step.
- Do let hairlines and space separate sections. Don't wrap each section in a card.
- Don't use lavender outside work that waits on a person.
- Do mark an uncertain state with a `text-warning` icon. Don't tint a row, a band or a badge amber, and don't use green for success.
- Do keep red for errors and irreversible actions. Don't use it for a count that waits on an admin.
