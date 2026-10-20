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
  brand-count: "#b9aaff"
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
- A side panel (`AsideSection`) pads its blocks by `p-4` and stacks their content by group.
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

### Inbox thread

The thread page uses `RecordBody`: the work column (summary line, the latest message, the reply panel, earlier messages) and one bordered side panel with `divide-y`. Each block of the panel is an `AsideSection`: the person, Assigned to (the assignee's name as a select with Take it, never a status badge), Do not contact, Reply category, Tasks, After a reply, Classification history, Campaigns, Other conversations, Drafts, Activity and Notes. Tasks render with `heading={false}` inside their `AsideSection`. Lists inside a block are plain rows, notes and classifications divided by hairlines. Messages keep their own frame; no rule covers them yet. Opened from Actions, the thread shows Back to Actions above the summary, and after a send the reply panel links to Next in the queue.

### Actions and Inbox lists

Both pages are lists of rows, not tables. A row is one `RowLink` (a stretched link) in `LIST_ROW_FRAME` (`grid grid-cols-1`, so a long draft or subject cannot widen the page), at least 44px tall on a phone.

- **Actions.** The first line is the scope chips (Mine, Unassigned, Others) and one sentence naming the oldest wait, linked to its row. With three or more sections a jump line follows. Sections run problem first. A section head is the text-sm semibold title with a lavender count; a section with nothing in it has no head and folds into one closing muted line. A row shows the name, the reply category and channel, the wait as a `time`, the start of the inbound message, and a detail line (the draft for a reply). The verb is trailing text at medium weight in the foreground. `Accept` and `Looks right` are small buttons above the stretched link (`relative z-10`).
- **Inbox.** Rows sit under `h2` day headings in a `divide-y` bordered list: an unread dot in a fixed gutter, the name and email, the time on the right (`HH:mm` for today and yesterday, a date otherwise), the subject and snippet on one line, and one state (category badge, auto-reply badge or an amber bounce icon). The channel shows only when it is not email.
- **Marks.** An unconfirmed send carries the amber icon, a failed draft, job or dead letter the red icon, and each list uses the lavender count for work that waits on a person. No fills.
- **Keyboard.** `ListKeys` marks rows with `data-list-row`: j and k move, Enter opens. Both pages print the hint line. The thread adds `]` for the next queue item and Ctrl or Cmd+Enter to approve.

### Tables

A workbook (`src/app/(app)/tables`) is a spreadsheet and the densest surface in the app. The tables browser is an ordinary list page. A workbook page fills the viewport height (`h-svh`): `PageHeader` with the workbook name and Tables as the back step, a strip of table tabs, then the active table. The table stacks its toolbar, the filter and sort chips, the selection bar and the grid at `gap-2` inside `p-3`, tighter than the page roles, because the grid needs the room.

- **Grid.** `DataGrid` is one `role="grid"` scroll container with a hairline border and rounded-lg. Rows are 32px and the header 36px on a muted band. A 72px gutter holds the row checkbox and number. Cells are text-sm. The header names the column at text-xs medium, with the type and the fill rate in 10px muted text. Numbers and currency align right in tabular numerals. Formula columns and columns a run fills are read-only and sit on a `bg-muted/30` tint. Pinned columns stay on the left behind a shadow edge; at phone width the grid ignores pins. The grid renders the rows in view and loads more near the end.
- **Selection.** The active cell takes a 2px primary ring, a range a `bg-primary/10` tint and a selected row `bg-primary/5`. The tints come from primary, so they stay grey. The fill handle at the corner of a range copies it down on drag. Selected rows open a bar above the grid: the count, "Select all {N} matching rows", then Run, Push to campaign, Export, Delete and Clear.
- **Keyboard.** Arrows, Page Up and Down, Home and End move; Ctrl or Cmd jumps, Shift extends the range. Tab moves across and leaves the grid at the first or last cell. Enter or F2 edits, and a typed character starts an edit with it. Delete clears the range, Shift+Space selects the row, Ctrl or Cmd+A selects every cell, Ctrl or Cmd+Enter runs the cell, Alt+Enter opens the cell drawer and Escape clears the row selection. Copy, cut and paste carry tab-separated text. Ctrl or Cmd+Z undoes and Shift+Z or Y redoes while the grid has focus. Table tabs move with the arrow keys and reorder with Alt+Arrow or a drag.
- **Cell states.** A cell shows one trailing icon at most: a spinner while it runs, a red alert for an error, an amber alert for a skipped cell and an amber refresh icon for a stale one. The reason sits in the tooltip and the accessible label. "This table changed elsewhere." takes the amber icon and a Reload button. Run progress is a bordered status line with a thin primary bar, the counts, Stop and Retry failed.
- **Cell drawer.** `CellDrawer` is a right `Sheet` (`sm:max-w-lg`): the column name as the title, "Row n · type · version n" under it, then Value in a muted block, State as a `dl` (an error in red) and Run history.
- **Column dialogs.** Add column offers Column, Formula, Enrichment and AI column. The formula dialog previews the expression on one row. The AI dialog takes a prompt that reads other columns as `{{key}}` and makes one column per output field. The enrichment dialog runs one provider action, or a waterfall of several tried in order. These, the run dialog and the filter panel are plain `Dialog`s at `sm:max-w-2xl`, capped at 90 to 92svh with a scrolling body.
- **Filters.** The filter panel edits a draft and saves once on Apply, so a half-typed value never reaches the server. A muted condition stays in the view and filters nothing. Active filters and sorts show above the grid as round chips, each with its own remove button, and a muted chip reads struck through. A member looking at their own view gets a muted line with Reset to default view.
- **Conflicts.** When another person or a run changed rows you edited, `ConflictDialog` saves nothing and lists each cell with Now and Yours (yours at medium weight). The footer offers Keep current values and Retry my edits.
- **Empty and loading.** An empty table shows `EmptyState` with Import file and Add rows; a search or filter with no hits shows "No rows match". Loading shows skeleton bars. A failed load prints the error in red with Try again.

## Shapes

Radius 0.5rem for panels, inputs and buttons; badges use rounded-md. Hairline borders, no shadows on page surfaces. A side panel is one bordered box with `divide-y` between its blocks. Cards are not the page structure: Settings, the Inbox side panel, Actions, the setup guide, the lead import, analytics and Unmatched senders use ruled sections and divided lists. Cards remain for the sign-in pages, the deal board's cards and the message frames of a thread.

## Components

- `PageHeader`: the 3.5rem top bar on every page.
- `RecordHeader`, `RecordBody`, `RecordSection`, `AsideSection`, `MetaLine`: the record frame shared by lead, contact, company and deal pages. `MetaLine` carries company and deal facts; lead and contact pages pass none.
- `LeadStatusToken`, `ReachLinks`, `ReachIcons`: the state forms in `src/app/(app)/crm/_components`, described under State.
- `Tabs`, `ViewSwitch`, `FilterChips`, `EmptyState`, `StatusBadge`: shared shell parts in `src/components/shell`.
- `SettingsSection`, `RULED_LIST`, `RULED_ROW`: the Settings block and its ruled list (`src/app/(app)/settings/settings-section.tsx`).

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
| `ScrollCue` | A horizontal scroller that fades the edges with more content and shows a hint while the right edge is out of sight, such as the deal board. |
| `ReachFlag` | A neutral badge for Do not contact or Email suppressed where a send is blocked. The sentence that explains why stays red. |
| `ErrorWithLinks` | A stored error text that names the inbound events page; it turns that path into a link. |
| `Time` | Every timestamp: a `time` element in the organization's time zone with the UTC original in the tooltip, `dateOnly` for dates, and `relativeTo` with the server's `now` for "5 min ago". Outside JSX, use `formatDateTime` from `@/shared/format-time`. |

### List parts

Every list page builds from the same parts in `src/components/shell`:

| Part | Use it for |
|---|---|
| `SearchField` | The search box: icon inside the field, Enter submits the GET form, a screen-reader Search button. |
| `FilterChips` | A row that narrows the list on screen (Show all, a lifecycle, a state). Round chips, `role="group"`, the active chip filled. |
| `ViewSwitch` | A row that switches to another view of the page with its own URL (People and Companies, Inbox Conversations and Scheduled). Underlined tabs in a `nav`. |
| `ListPager` | "12 contacts", and from two pages on "page 2 of 3" with ghost Previous and Next links. |
| `EmptyState` | Nothing to show: the missing thing as the title, the next step as the description and action. It draws no box. |

A row that narrows the list is `FilterChips`; a row that switches views is `ViewSwitch`. Client state without a URL (a record's Activity tabs, Settings field types) uses `Tabs`.

### Dialogs

Every confirm and form dialog builds on `ConfirmDialog` (`src/components/shell/confirm-dialog.tsx`): Add contact, Add company, Make contact, Create deal, the company merge, Delete contact and Delete company.

- The title names the object, the confirm repeats the action, and the cancel names the safe choice when "Cancel" would read as the destructive one ("Keep contact", "Keep company"). Pending labels end in "…".
- The panel stops at the viewport height minus 2rem. The header and the footer stay in place and the body scrolls, so the confirm stays on screen at 390x844 with a deal's fields or a merge preview open.
- A dialog with two steps keeps one panel and swaps the body: Add contact's matching-lead step, the merge picker and its preview, the bulk conversion's second confirm. `back` puts a ghost Back button at the start of the footer, and Back keeps what you typed or picked.
- Errors and outcomes the caller renders as data (a blocker list, changed counts, a bulk report) sit in the body in a `role="status"` region, in body text, never muted.
- A record page states whether it can be deleted before any click. The delete row sits in the do not contact slot (`DoNotContactCard`'s children) on the lead and the contact page: "This contact can be deleted." with a destructive outline button, or the blockers with no button. The dialog itself shows counts only.
- A company with people left opens a plain `Dialog` with the reason and a link to find them, and no confirm.

### Bulk bar

Leads and Contacts share the selection model (`SelectionProvider`, `src/components/shell/selection.tsx`), keyed by the list's filter so a selection survives paging and resets on a filter change. The bar sticks to the bottom edge: the "{n} selected." line, then at most four controls, the bulk actions first, then Clear selection (Esc clears too) and More actions with "Select all {N} matching".

### Campaign page

Campaign pages use the record frame. `PageHeader` keeps the breadcrumb (Campaigns / name) and `RecordHeader` carries the name as the h1. Beside it sits `CampaignStatusToken`, one neutral token with an icon per status (Draft, Active, Paused, Completed, Archived). The controls go in `actions`, the main move first; on a phone, Mark completed and Delete move into a More menu. One `MetaLine` names the channel, the step count and the senders, and the campaign counts follow it.

- Every block below the tabs is a ruled section (`CampaignSection`: a text-sm semibold h2 with `border-t py-section`), never a card. Steps form a divided list, and the step you edit gets a 1px foreground rule on its left.
- The Leads tab speaks the lead status vocabulary scoped to the campaign. `campaignLeadStatus()` runs `leadStatus()` on one enrollment and the campaign status, so a row reads Queued, In sequence, Paused, Replied, Finished or Stopped through `LeadStatusToken`. A removed lead shows no token.
- The status filters above the list are `FilterChips` with the same words, because they narrow the list. The campaign tabs stay a `ViewSwitch`.
- An uncertain state, such as a send that may or may not have gone out, uses `text-warning` on its icon and label, never a fill and never red.

### State

A person carries three states, each with one form. Lists and record pages read the same function for each, so a row and its page agree.

| State | Who has it | Form | Where |
|---|---|---|---|
| Lead status | Leads only | `LeadStatusToken`: a neutral token, a lucide icon per state and the label (New, Queued, In sequence, Paused, Replied, Finished, Stopped) | Beside the h1 in `RecordHeader`'s `state` slot; the Status column of Leads, with the campaign as a muted second line |
| Deal stage | Contacts, through their deals | The stage badge | The Deals section of the contact page, the Latest deal column of Contacts, the deal page |
| Reach | Leads and contacts | `ReachLinks` in a record header and the Inbox side panel, `ReachIcons` in a list row | Do not contact is a neutral badge with a ban icon in front of the links, which turn muted. A suppressed address keeps its link with a crossed mail icon and a line through. A missing channel is left out of the header and shows as a dashed mark in a list. |

- One form per state. The token, the badge or the link says the state; dates, the campaign, the step, the next send and reasons sit in a tooltip on hover and on keyboard focus (`StateTip`), and in screen-reader text inside the trigger.
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
