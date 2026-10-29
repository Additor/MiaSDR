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
  section-heading:
    fontFamily: "Geist, sans-serif"
    fontSize: "1rem"
    fontWeight: 600
  subsection-heading:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 600
  item-heading:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  bar:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
  body:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  meta:
    fontFamily: "Geist, sans-serif"
    fontSize: "0.75rem"
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
  inset: "1rem"
  page-end: "3rem"
components:
  top-bar:
    height: "3.5rem"
    padding: "0 {spacing.gutter}"
    typography: "{typography.bar}"
---

# MiaSDR design system

The code is the authority. When this file and the code disagree, `src/app/globals.css` (tokens and roles), `src/components/ui` (primitives) and `src/components/shell` (shared shell parts) win, and this file needs a fix. The YAML frontmatter above holds machine-readable tokens for design tooling: a plain key is the light value, and the same key with `-dark` is the value under `.dark`.

This file holds the system: tokens, roles, parts and the rules that pick between them. How each screen behaves lives in the feature specs:

- [Actions, Inbox and the thread](docs/design/inbox-and-actions.md)
- [Leads and the CRM](docs/design/crm.md): the lead header, stop controls, the deal board
- [Campaigns](docs/design/campaigns.md)
- [Tables](docs/design/tables.md)
- [Settings and the setup guide](docs/design/settings.md)

## Overview

MiaSDR is an operating tool. A sales rep scans lists, opens a record and acts, many times a day, starting from Actions, the home page. The surface stays neutral grey on white (and its dark counterpart). Structure comes from type weight, hairlines and spacing, not from boxes or color.

## Colors

Everything is grey. Normal states use the secondary badge; a colored badge marks an exception. Three hues carry meaning, each with one job:

| Hue | Token | Means | Form |
|---|---|---|---|
| Red | `--destructive`, `text-destructive` | An error or an irreversible action: a failed send, a refused registration, a dead inbound event, Delete | Error text, the destructive button, the badge of a failed row, `Count tone="error"` for errors no retry fixes |
| Amber | `--warning`, `text-warning` | An uncertain or degraded state: an unconfirmed send, an unknown outcome, a paused send engine, a limit near its end, a stale table | The icon and a short lead label only. Never a fill, a tinted band or a colored badge. The sentence beside it stays in the foreground. |
| Lavender | `--sidebar-count`, `text-sidebar-count`, the rail dot `bg-sidebar-primary` | Work that waits for a person: Actions pending, open setup steps, Settings areas an admin must look at | `Count tone="waiting"`: a plain count in the brand hue with no capsule, and a dot where no count fits (the collapsed rail, the Settings nav) |

- Success is the normal outcome, so it reads in the foreground. No green: a delivered test email shows a muted check and the message.
- Inbox unread is not lavender. The replies that need a person already count in Actions, so the Inbox shows a muted count in the sidebar and a foreground dot on an unread row.
- A count goes red only when the row is an error that a retry cannot fix by itself (dead letters). "2 failed" on the Settings overview is lavender: it waits for an admin.
- The Setup guide item in the sidebar shows "3 of 5" as lavender count text and the lavender dot on the rail, like Actions. No amber fill, no badge.
- `--warning` keeps 4.5:1 on the background in both themes (`oklch(0.52 0.13 60)` light, `oklch(0.83 0.14 80)` dark).
- Red has two tokens. `--destructive` colors text and its 10% tint. `--destructive-solid` fills a solid destructive button behind white text. In light mode they match. In dark mode the text red (`oklch(0.704 0.191 22.216)`) gives white text only 3.4:1, so the fill takes a darker red (`oklch(0.55 0.22 27)`).
- The lavender count changes with the sidebar. The brand hue `#b9aaff` reaches only about 2:1 as text on the light sidebar, so `--sidebar-count` mixes it toward `#1e1724` there (`color-mix(in oklab, #b9aaff 55%, #1e1724)`) until it reaches 4.5:1. On the dark sidebar the count uses `#b9aaff` as is. The rail dot (`--sidebar-primary`) stays `#b9aaff` in both themes, and stays in the sidebar: on white it reaches only about 2:1.
- Charts stay grey while they show one series: a bar is `bg-foreground/80` with its value printed as text. The `chart-1` to `chart-5` tokens are for a chart that has to tell series apart.
- Dark mode redefines the same tokens under `.dark` in `src/app/globals.css`. Light and dark values for the main tokens sit in the frontmatter.

## Typography

Geist Sans for everything, Geist Mono for code. Tables and fact lists use tabular numerals.

A heading takes its role by name, a utility in `globals.css`, never a size and a weight picked on the spot. Four steps, each apart from the next in size or in weight, never by a pixel. The step follows what the part is to the page: a page's own sections at 16px, the parts under or beside them at 14px semibold, so a side panel block or a folded history never competes with the work column.

| Role | Utility | Size and weight | Where |
|---|---|---|---|
| Record title | `heading-record` | text-2xl, semibold, tight | The h1 of a lead, contact, company, deal or campaign page (`RecordHeader`) |
| Section heading | `heading-section` | text-base, semibold | A part of the page itself, through `Section`/`SectionHead` (an h2 by default): a Settings block, a record's or a campaign's work-column section, the thread's Next step, Follow-ups, Earlier messages and History, an Actions list, an analytics report, a step of the lead import, an error page |
| Subsection heading | `heading-subsection` | text-sm, semibold | A part under or beside a section (`role="subsection"`, the default for an h3): a side panel block (`AsideSection`), a folded history (`AsideDisclosure`, `RecordDisclosure`), a drawer's or a dialog's part, a deal board column |
| Item heading | `heading-item` | text-sm, medium | An item's name in a ruled list, a group inside a section, the Inbox day labels (muted) |
| Top bar | none | text-sm; parent step muted, current step medium | `PageHeader` |
| Body and labels | none | text-sm | Everything else; helper text in muted-foreground |
| Meta | none | text-xs, muted | Timestamps, footnotes under a list, a grid header's type and fill rate |

The top bar is navigation, so it carries one size. "Leads / Ada Lovelace" reads as one breadcrumb: the parent in muted text, the slash dimmer, the current page in the foreground at medium weight. A page with a display title shows it in the body (record pages); every other page names itself in the bar.

Nothing in the app is smaller than text-xs. Button `sm` and Toggle `sm` use text-xs.

**Numbers.** Counts print through `formatCount` and `countOf` (`src/shared/format-number.ts`): grouped the English way ("1,204"), with the noun in the right number ("1 lead", "2 replies"). A count beside a heading, a segment or a list is a `Count`: one size, no capsule, no parentheses.

## Layout

### Spacing roles

Spacing follows the relationship between two things, never a number picked on the spot. Five roles, loose to tight:

| Role | Token | Use it between | Narrow / wide |
|---|---|---|---|
| gutter | `--space-gutter` | The page edge and the content. The top bar and the body share it, so the title and the first column start on one line. | 1rem / 1.5rem |
| section | `--space-section` | Independent parts of a page: the record header and its body, record sections, Settings blocks, the work column and the side column. | 1.5rem / 2rem |
| inset | `--space-inset` | The edge of a bordered panel and the block inside it: a side panel section, a skeleton's side panel. | 1rem |
| group | `--space-group` | Parts of one thing: a toolbar and its table, a section heading and its content, form fields, list rows. | 0.75rem |
| field | `--space-field` | A label and its control, a heading and its one-line description. | 0.375rem |

Gutter and section open up from the `lg` breakpoint. The others stay fixed, so a form reads the same in a side panel and on a full page.

Each role is a Tailwind spacing key, so any spacing utility takes it by name: `gap-section`, `py-section`, `px-gutter`, `p-inset`, `gap-group`, `pt-section`.

### Patterns

| Class | What it does |
|---|---|
| `page` | The body under a `PageHeader`: gutter on three sides, 3rem at the bottom, one column that never overflows. Pair it with a stack. A page that ends in a sticky bottom bar (Leads, Contacts) adds `pb-0`: the bar carries its own padding. |
| `stack-section` | A grid whose children are independent sections. |
| `stack-group` | A grid whose children are parts of one thing. |
| `stack-field` | A label and its control. |

Pick the stack by asking what the children are to each other:

- A list page (Actions, Inbox, Leads, Contacts, Campaigns, Analytics) is one task: `page stack-group`. The filters, the count line and the list sit close.
- A record page (`RecordPage`) is several independent parts: `page stack-section`.
- A ruled sheet (`Section`, the default frame) puts a hairline between sections and section space on both sides of it.
- A side panel (`AsideSection`, `Section frame="inset"`) pads its blocks by the inset role and stacks their content by group. A block a person reads now and then (histories, lists) is an `AsideDisclosure`: the same padding and head, folded, with its count beside the title.
- A Settings page is a column of blocks (Settings pages, below).
- A form stacks its fieldsets by section, the fields inside a fieldset by group, and each label and control by field.

A heading always sits closer to its content than to the block above it. A section heading gets section space above and group space below.

### Layers

z-index stays on four steps, never an arbitrary value:

| Step | Use |
|---|---|
| `z-10` | Raised: a control above a stretched `RowLink`, the active cell of a grid |
| `z-20` | Sticky: a sticky table header, pinned columns, the grid gutter |
| `z-30` | Bars: the selection bar, a grid's header row over its sticky cells |
| `z-50` | Overlays: popups, tooltips, dialogs, sheets |

A component with layers of its own (the grid) sets `isolate` on its scroller, so its steps stay inside it.

### Touch

Below `sm`, a control a person taps is 44px. `Button` and `buttonVariants` take `touch` (a text button grows to 44px tall, an icon button to a 44px square) and `Input` takes `touch`. Dense surfaces that fold on a phone, such as grid cells, leave it off.

### Settings pages

`SettingsSection` (`src/app/(app)/settings/settings-section.tsx`) is the only block on a Settings page.

- Each block is the shell's `Section`: a `heading-section` h2 and an optional one-line muted description, set as `stack-field`. The content follows by `stack-group`.
- Blocks sit one after another with `border-t py-section`. The first block has no rule and no top padding, the last no bottom padding (`first-of-type`, `last-of-type`), so put intro text in a `div` or `p` before the first block, not between blocks.
- A form lives inside its block and ends with its own Save button in a plain row. No card, no footer band.
- A list of items inside a block (mailboxes, LinkedIn accounts, documents, stages, fields, invitations, jobs) is one ruled list: `RULED_LIST` (`divide-y`) with `RULED_ROW` rows. No box around the list and no box per item. An item's name is an h3 at `heading-item`.
- Two levels at most: block, then rows. Settings > Reply handling lists reply types under an h3 per group inside one Reply types block ([Settings and the setup guide](docs/design/settings.md)).
- Width: the content column is `max-w-3xl`. Jobs and Inbound events take `max-w-5xl`: their tables carry six to eight columns of times, counts and errors. Tables in Settings sit flush in the column (`ScrollableTable`), not in a card.

### Forms

Every form in the app builds from the same parts, so a person learns one way to change a value. Settings, dialogs, side panels and the sign-in pages alike:

- **Fields.** shadcn's `Field` family (`src/components/ui/field.tsx`): `FieldGroup` stacks fields at group space, `Field` holds a `FieldLabel`, the control and an optional `FieldDescription` at field space, `FieldSet` with a `FieldLegend variant="label"` groups related controls, and `FieldError` carries the error. A checkbox or radio sits in `Field orientation="horizontal"`. In a flex row a field takes `className="w-auto"`.
- **Save (Settings).** A Settings form is controlled and compares its values with what is saved. `SaveRow` (`settings/settings-form.tsx`) ends it: the error, then Save, which stays off until something changed, then "Unsaved changes" and a ghost Discard while it is on. The button is always the default size and reads Save. `useLeaveGuard` asks before the tab closes with unsaved changes. A list that saves each step at once (custom fields, stages) has no Save.
- **Members (Settings).** A member sees the same page with the controls off or hidden and the `AdminNotice` once at the top, before the first block. No Save row. A page with nothing a member may see (Audit log, Integrations, Inbound events, Jobs, LinkedIn) shows only the notice (`replacesPage`).
- **Add and edit.** A list of things (reply types, knowledge documents) leads the page. Add sits on the block's heading row as an outline button, and Add and Edit open the same `ConfirmDialog` with the form in its body and Save as the confirm. A list whose items are only a name (custom fields, pipeline stages) adds in place instead: a Name field and an Add button after the list, Add off while the name is empty, no Save row. A short single-value change (a field or stage name) edits in place: Enter saves, Escape cancels, Save stays off while the name is unchanged.
- **Empty and archived.** An empty list inside a block is an `EmptyState` with its title only; an empty group under a group h3 keeps a muted line. An archived item keeps full-strength text and says its state with an Archived badge, never with opacity.
- **Row actions.** Ghost `sm` buttons at the end of the row (Edit, Recheck, Requeue, Retry, Manage, Reconnect); the destructive step is the dialog's red confirm, never a red button in the row. Reordering uses `ReorderButtons` (arrow icons, "Move {name} up").
- **Pickers.** A long list is a searchable `Combobox` (`TimeZoneSelect`, `CountrySelect`); a short fixed list is a `Select`. `WorkingHoursFields`, shared by mailboxes and LinkedIn accounts, sets the sending days with a `ToggleGroup` of outline buttons and the window with two `TimeSelect`s, From and Until. A choice between two modes with an explanation is a `RadioGroup` of horizontal fields. See Pickers.

- **Choices.** A checkbox or a radio is always the app's `Checkbox` or `RadioGroupItem`, in a horizontal `Field`. A choice that needs more than a label is a `ChoiceCard`.
- **Errors.** A field's error is `FieldError` under it; the form's error sits in its Save row or in the dialog's alert line. Error text is plain red text, never a tinted box.

## Shapes

Radius 0.5rem for panels, inputs and buttons; badges and state tokens use rounded-md; dialogs use rounded-xl (Dialogs). Hairline borders, no shadows on page surfaces. A side panel is one bordered box with `divide-y` between its blocks. Cards are not the page structure: Settings, the Inbox side panel, the setup guide, the lead import, analytics and Unmatched senders use ruled sections and divided lists. A list of rows a person works through (the Actions lists, the Inbox) sits in one framed list (`divide-y rounded-lg border`), so its rows read as one unit. Cards remain for the sign-in pages, the deal board's cards and the frames of a thread: its latest message and the reply panel. No tinted box holds content or a status line.

## Components

- `PageHeader`: the 3.5rem top bar on every page. `rename` makes its title an `EditableTitle`.
- `ButtonGroup` (`src/components/ui/button-group.tsx`): buttons read as one control, such as a main button and the chevron that opens its menu (Run) or two related actions (Push to campaign and Export CSV).
- `RecordHeader`, `RecordBody`, `RecordSection`, `AsideSection`, `MetaLine`: the record frame shared by lead, contact, company and deal pages. `MetaLine` carries company and deal facts; lead and contact pages pass none. The header's actions hold at most one filled button, the move that fits the record's state, then outline buttons, then the ghost More menu for rare actions.
- `LeadStatusToken`, `ReachLinks`, `ReachIcons`: the state forms in `src/app/(app)/_components/person`, described under State.
- `Fact`, `EditableFact`, `InlineForm` (`src/app/(app)/_components/record/inline-field.tsx`): the rows of a Details panel and the deal Summary. A fact you can change edits and saves on its own row: a quiet pencil (shown on hover and focus, always on touch) or a click on the value opens the inputs in place; Enter saves only that field, Escape cancels and returns focus to the pencil, and a failed save keeps what you typed with the reason under it. Facts nobody edits close the panel as one muted text-xs line, not as rows. Add field gives a value to a field that has none.
- `OffAction` (`src/app/(app)/_components/off-action.tsx`): an action that is off for a reason. An outline button that stays focusable (`aria-disabled`), shows the reason on a tip and carries it in its accessible name, so a person on a phone or a keyboard learns why.
- `Tabs`, `ViewSwitch`, `FilterChips`, `EmptyState`, `StatusBadge`: shared shell parts in `src/components/shell`.
- `SettingsSection`, `RULED_LIST`, `RULED_ROW`: the Settings block and its ruled list (`src/app/(app)/settings/settings-section.tsx`).

The primitives in `src/components/ui` come from shadcn's `base-nova` style built on `@base-ui/react` (`components.json`). Extend a primitive with a variant or a prop in place; don't fork a copy into a feature folder.

### Badges

A badge says one thing about a row, and its variant says what kind of thing:

| Variant | Means | Examples |
|---|---|---|
| `secondary` (the default) | A state | Archived, Always included, Locked, Off, a sent or active status |
| `outline` | A descriptor, a label that sorts or names | Contact, Auto-reply, You, Optional, Personal, a role, a tag |
| `destructive` | An error | Failed, Bounced, Disconnected |

`StatusBadge` maps a stored status token to its variant; pass the token as `status` and the words as `label`. A row carries one badge per state; other facts (a kind, tags, a version) read as one muted line. The black `default` variant is for an explicit ask only.

### Focus

Two focus languages, one per kind of target:

- A control with a border (an input, a button, a select) keeps the primitives' border in the ring color with a soft halo.
- A target without a border (a link, a segment, a chip, a `summary`, an info mark, a list row) takes `focus-ring`: a 2px outline in the ring color that follows the radius. A list row's stretched link draws it on the row.

### Shell parts

The app layout and many pages share these parts from `src/components/shell`:

| Part | Use it for |
|---|---|
| `AppSidebar` | The one app sidebar, mounted by the app layout: organization switcher, the place rows with their lavender counts, the setup guide item and the user menu. Rows are 32px on a desktop pointer and 44px in the phone sheet. A row is a place; views and filters stay in the page. |
| `CommandPalette` | Jump to any page by name with Cmd or Ctrl+K. `AppSidebar` mounts it; don't mount a second one. With nothing typed, recent picks come first. |
| `OutboundPauseBanner` | The one line across the top of every page while `PAUSE_OUTBOUND` is set. Amber icon and lead words, no tinted band. The app layout renders it. |
| `ResponsibleUseNote` | The one-line consent and LinkedIn terms note where a campaign starts and where LinkedIn accounts connect. Keep its text in the component. |
| `ListSkeleton` | A list while its rows stream in, at the height of the real rows, so the page does not jump. `bordered` for framed lists like the Actions groups, `toolbar={false}` for a list without a toolbar. |
| `PageSkeleton` | A page while it streams in, in its shape: `list`, `record`, `form` or `table`. One status region. Never a lone grey block. |
| `SummaryLine` | A compact row of label and value pairs ("Sent 120 · Replied 14") above a table or in a detail header, a pair's `hint` on an info mark. It is not a metric card and does not headline a page. |
| `TouchTip` | Secondary text on a trigger: a tooltip on hover and keyboard focus, a popover on a tap where the device cannot hover. `InfoTip` and `StateTip` build on it. A link trigger keeps a tooltip, because a tap navigates. |
| `ScrollCue` | A horizontal scroller that fades the edges with more content and shows a hint while the right edge is out of sight, such as the deal board. A strip with no room for the hint, such as the table tabs, leaves `hint` out; `after` places a control past the scroller. |
| `EditableTitle`, `NameInput` | A name you rename where you read it: a page title through `PageHeader`'s `rename`, or a tab that swaps in `NameInput`. Enter or leaving the field saves, Escape cancels, an empty name on Enter says "Give it a name.", and a refused save keeps your text with the reason floating under the field. |
| `ReachFlag` | A neutral badge for Do not contact or Email suppressed where a send is blocked. The sentence that explains why stays red. |
| `Section`, `SectionHead`, `Count` | Every section head: the heading in its role, an optional icon, a `Count`, an info mark, a description and an action. `Section` frames it `ruled` (a hairline and section space, the default), `plain` (a list's own grid, the Actions sections) or `inset` (a side panel block). `RecordSection`, `AsideSection`, `CampaignSection` and `SettingsSection` wrap it. |
| `ErrorState` | Something did not load: the missing thing as the title, the reason in red, the way back (Try again). No box, like `EmptyState`; `inline` inside a section or a drawer. |
| `Spinner` | Work in progress beside the words that name it ("Sending…"). Decoration; `label` only when it stands alone. |
| `ChoiceCard`, `CHOICE_CARD`, `CHOICE_TILE` | A choice that needs more than a label (a company to merge into, a person to file a sender under): a 44px hairline card around a `RadioGroupItem` or `Checkbox` that takes the ring border and a muted ground when checked. `CHOICE_TILE` is a button that opens a choice (the enrichment outcomes). |
| `BulkBar` | The selection bar. See Bulk bar. |
| `ErrorWithLinks` | A stored error text that names the inbound events page; it turns that path into a link. |
| `DatePicker` | One calendar day, as yyyy-MM-dd. See Pickers. |
| `TimeSelect` | A time of day on the half hour. See Pickers. |
| `Time` | Every timestamp: a `time` element in the organization's time zone with the UTC original in its native title (the one native title the app keeps: a rare extra, and a tab stop on every time would cost more), `dateOnly` for dates, `relativeTo` with the server's `now` for "5 min ago", and `label` for a caller's own wording of the same instant. Outside JSX, use `formatDateTime` from `@/shared/format-time`. |

### List parts

Every list page builds from the same parts in `src/components/shell`:

| Part | Use it for |
|---|---|
| `ListToolbar` | The one row between the header and the list: chips, search and the Filters button on the left, list options (Columns, Export, the keyboard mark, a side count) on the right. |
| `ToolbarPopover` | The popover behind a toolbar button that edits a draft: Filters on a list with two or more filter fields (Leads, Contacts, Inbox, Actions, Analytics), Filter and Sort on a table. The trigger is an outline button with an icon, a label and a muted count; the popup holds a scrolling body and a footer with Reset and Apply. See Filters and sorts. |
| `FilterPopover` | `ToolbarPopover` for a list's GET form. Its fields stay mounted inside the form while it is closed, so Enter in the search keeps the filters in force. |
| `FilterSection`, `FilterRow`, `SelectField`, `TristateField`, `DateRangeField` | The fields of a Filters popover: a ruled section title, a row with the label on the left and the control on the right (stacked on a phone), the app's `Select` posted under a `name`, an Any, Yes and No segment, and a from and to pair of `DatePicker`s on one row. |
| `AppliedFilters`, `FilterChip` | The filters and sorts in force as removable chips under the toolbar, with the one Clear filters at the end. These are the only round pills in a toolbar. A chip is a link on a list and a button on a table; a muted table condition reads struck through. |
| `InfoTip` | A definition on demand: an info mark beside a heading whose name needs explaining, the text in a tooltip on hover and keyboard focus, in a popover on a tap on a touch screen, and in screen-reader text. A sentence that says what an action or a setting does stays visible as a description; an info mark never hides a consequence. |
| `SearchField` | The search box: icon inside the field, Enter submits the GET form, a screen-reader Search button. No Apply button beside it. |
| `FilterChips` | A row that narrows the list on screen (Mine, Unassigned and Others, a lifecycle, a state): one segmented control in the `TristateField` frame, `role="group"`, the active segment on a muted ground at medium weight, a `count` in one muted tabular style. A row too long for a phone scrolls inside the frame. |
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

### Pickers

Every choice in the app goes through one of these parts. The app has no native `select`, date or time control: each browser draws those its own way, in its own language, and outside the tokens and the dark theme.

| Part | Use it for |
|---|---|
| `Select` (`src/components/ui/select.tsx`) | One value from a short fixed list: a currency, a member, a stage, a column type. The trigger shows the label of the value. |
| `Combobox` (`src/components/ui/combobox.tsx`) | One value from a long list you search by typing: `TimeZoneSelect`, `CountrySelect`, the AI model, Change type. |
| `SelectField` | A `Select` in a Filters row. The first option is the one Reset picks, and an empty value (Any, All) posts an empty param. A value the options do not hold shows the first option. |
| `DatePicker` (`src/components/shell/date-picker.tsx`) | One calendar day: a task's due date, a deal's expected close. The outline trigger has the Select trigger's height, radius, border and focus ring, shows the day or a muted placeholder, and puts a calendar icon where the Select has its chevron. shadcn's `Calendar` opens in a popover on the menu surface. `clearable` adds Clear under the calendar for an optional day. |
| `DateRangeField` | A from and to pair on one row of a Filters popover: two clearable `DatePicker`s, "{label} from" and "{label} to". |
| `TimeSelect` (`src/components/shell/time-select.tsx`) | A time of day as HH:mm: a `Select` every 30 minutes from 00:00 to 23:30. `endOfDay` adds 23:59 for the end of a window. A saved time off the step shows in its place, so a save sends it unchanged. |
| `ToggleGroup` | Several on or off choices side by side: the Send on days of working hours. |
| `RadioGroup` | One choice between modes that each need a sentence: Organization hours or Custom hours, Follow-ups after a reply, a reply type's rules, the rows a run takes. |

- **Dates.** A day reads and writes as yyyy-MM-dd, the format of `formatDate` and `<Time dateOnly>`. The value is a calendar date with no time zone: "2026-03-08" stays March 8 in every browser. Weeks start on Monday, as the Send on days do.
- **Keyboard.** Enter, Space or ArrowDown on a trigger opens the popup. In the calendar the arrows move by day, Page Up and Page Down by month and with Shift by year; Enter picks and closes, and Escape closes and returns focus to the trigger.
- **Forms.** A part with a `name` posts a hidden input, so a GET filter form or a POST form sends the same params a native control did. In a Filters popover the pickers follow the draft: Reset sets them to the first option or no day, and a discard puts back the value in force.
- **Phone.** Below `sm`, triggers, options and calendar days are 44px tall, and the calendar popover fits a 390px screen.
- **Quick choices first.** Where a few days cover most picks, buttons come before the calendar. Due offers Today, Tomorrow and Next week, and Pick a date shows a `DatePicker` with its calendar open.
- **Exception.** Add field on a person's Details suggests field names through an Input with a `datalist`. It takes a new field name as typed text, and the list only suggests.

### Popups

`Select`, `DropdownMenu`, `Popover` and `Combobox` open one way. Each spreads `popupPositioner(...)` from `src/components/ui/popup.ts` onto its positioner and draws `POPUP_SURFACE`:

- **Place.** Under the trigger, left edges lined up, 4px below it, and 8px from the viewport edge, the inset of the sidebar's own triggers, so a menu there stays lined up with its trigger. A popup without room below opens above. A `Select` list opens under its trigger like the rest; it never lays itself over the trigger to line the chosen option up with it, and a long list scrolls with the scrollbar.
- **Surface.** The menu surface (`bg-popover`, `shadow-md`, the foreground ring) scales from 95% and fades in from the trigger's side over `--duration-menu`. A submenu takes `shadow-lg`, a step above the menu under it. A `Select` list closes at once: its backdrop takes outside clicks until it unmounts, so a fading list would swallow the click on the next field.
- **Moving one.** A trigger at the right edge (a More menu, a row's actions) opens with `align="end"`, so the popup grows to the left. A trigger at the bottom edge (the selection bar, the sidebar footer) opens with `side="top"`. The primitives' props accept nothing else, so tsc refuses any other placement.
- **Tips and submenus.** A tooltip opens above the trigger and centered (`TIP_POSITIONER`), and `beside` opens it to the right for an icon in the collapsed sidebar. `TouchTip`'s popover on a tap opens where its tooltip does (`PopoverContent tip`). A submenu opens to the right of its item (`SUBMENU_POSITIONER`).
- **Enforcement.** `src/architecture/popup-placement.test.ts` holds `@ts-expect-error` lines that fail `pnpm typecheck` once a primitive accepts another placement, fails on a positioner in `src/components/ui` that sets its own placement or does not spread one from popup.ts, and fails on a Base UI import outside `src/components/ui`.

### Dialogs

Every confirm and form dialog builds on `ConfirmDialog` (`src/components/shell/confirm-dialog.tsx`): Add contact, Add company, Make contact, Create deal, the company merge, Delete contact and Delete company, New campaign, Add to campaign, New search, Upload sheet, Change type, the mailbox test send, and the tables dialogs that name, move, describe, add rows, import and push. The column dialogs and the run dialog stay plain `Dialog`s ([Tables](docs/design/tables.md)).

- A dialog is an overlay, so its panel takes `rounded-xl` and its footer a muted band that keeps the actions apart from a scrolling body. Pages keep 0.5rem panels and no footer band.
- `secondary` adds a second way forward as an outline button before the confirm (Only change the type beside Stop contacting), with its own pending label.

- The title names the object, the confirm repeats the action ("Delete 2 leads", "Remove mailbox"), and the cancel names the safe choice when "Cancel" would read as the destructive one ("Keep contact", "Keep company", "Keep contacting"). Pending labels name the action and end in "…" ("Deleting…").
- Enter in a text field of the body presses the confirm, as a form submit would. A textarea and a control that handles Enter itself keep the key.
- The panel stops at the viewport height minus 2rem. The header and the footer stay in place and the body scrolls, so the confirm stays on screen at 390x844 with a deal's fields or a merge preview open.
- A dialog with two steps keeps one panel and swaps the body: Add contact's matching-lead step, the merge picker and its preview, the bulk conversion's second confirm. `back` puts a ghost Back button at the start of the footer, and Back keeps what you typed or picked.
- Errors and outcomes the caller renders as data (a blocker list, changed counts, a bulk report) sit in the body in a `role="status"` region, in body text, never muted.
- Delete lead and Delete contact sit in the header's ghost More menu ([Leads and the CRM](docs/design/crm.md#stop-controls)). The item opens the confirm with counts when the record qualifies, or a plain dialog with the reason and nothing to confirm when the rules protect it.
- A company with people left opens a plain `Dialog` with the reason and a link to find them, and no confirm.

### Bulk bar

Leads and Contacts share the selection model (`SelectionProvider`, `src/components/shell/selection.tsx`), keyed by the list's filter so a selection survives paging and resets on a filter change. Every selection bar is `BulkBar` (`src/components/shell/bulk-bar.tsx`). On a list it sticks to the bottom edge, in the thumb zone on a phone, and while rows are ticked the page reserves the bar's height as scroll padding (`useBarScrollPadding`), so a focused row never sits under it. Above a grid or a short list (a table, a search batch, a campaign's leads) it sits in the flow with `sticky={false}` and takes no room while nothing is ticked. The bar holds the "{n} selected." line, then at most four controls: the bulk actions first, then Clear selection (Esc clears too) and More actions with "Select all {N} matching". The status line stays mounted, so a screen reader hears the count as it changes. A failed bulk step (Select all matching, Export) puts its reason on the bar while the rows stay ticked; it leaves with the selection, so ticking rows later never shows an old failure.

### Feedback

Every action says what it did, where the person is looking:

- **On the spot.** A step on one item says its outcome where the item was: an Actions row folds into one line that names what happened, a saved field closes with its new value, a failed field keeps what was typed with the reason under it.
- **Toast.** A toast carries an outcome that lands off screen or across many items: a bulk step ("Marked 7 AI picks as looked at."), a change made from a dialog that then closes, a step after which the page moves. One sentence in the past tense. An error toast only when no place on the page can hold the reason.
- **Status region.** A dialog that stays open says its outcome in the body, in a `role="status"` region in body text (Dialogs).
- **Pending.** The button that runs names the work and ends in "…" ("Saving…", "Sending…") and stays off. Background work shows a `Spinner` beside its words. A page waiting on the server refreshes itself; it never asks a person to reload while the work is in flight.
- **Undo.** Offer Undo only where the server has an inverse (an AI pick's Undo, Reopen). A step without one that acts on many items confirms first and lists what it will touch.
- **Errors.** Next to the control (`FieldError`), in the Save row or the dialog's alert line, or as `ErrorState` when content did not load. Plain red text with the reason and the way out.
- **Loading.** A page streams in as a `PageSkeleton` or `ListSkeleton` in its own shape.

### State

A person carries three states, each with one form. Lists and record pages read the same function for each, so a row and its page agree.

| State | Who has it | Form | Where |
|---|---|---|---|
| Lead status | Leads only | `LeadStatusToken`: a neutral token (`stateTokenClass`: secondary ground, no border, text-xs medium, so it never reads as a button), a lucide icon per state and the label (New, Queued, In sequence, Paused, Replied, Finished, Stopped) | Beside the h1 in `RecordHeader`'s `state` slot; the Status column of Leads, with the campaign as a muted second line |
| Deal stage | Contacts, through their deals | The stage badge | The Deals section of the contact page, the Latest deal column of Contacts, the deal page |
| Reach | Leads and contacts | `ReachLinks` in a record header and the Inbox side panel, `ReachIcons` in a list row | Do not contact is a neutral badge with a ban icon in front of the links, which turn muted. A suppressed address keeps its link with a crossed mail icon and a line through. A missing channel is left out of the header and shows as a dashed mark in a list. |

- One form per state. The token, the badge or the link says the state; dates, the campaign, the step, the next send and reasons sit in a tooltip on hover and on keyboard focus (`StateTip`), in a popover on a tap on a touch screen unless the trigger is a link, and in screen-reader text inside the trigger.
- A contact carries no status token. Its header shows who the person is, how to reach them and what to do next; Contact since and the source campaign are Details facts.
- An open channel is a working link. No text says "can be contacted".
- State tokens stay neutral grey: no lavender and no red. Red stays for irreversible actions and errors.
- A list shows both a Reach column and an Email column. The icons act (write, open the profile) and show the reach state; the Email column is data a rep scans, sorts by eye and copies. The Leads and Contacts lists both carry the pair.

## Enforcement

`src/architecture/design-system.test.ts` reads the JSX of every page and shell part and fails on a native checkbox or radio, a native `title` (outside `Time`), a raw `time` element, a heading without a heading role, lavender outside the counts that wait on a person, an arbitrary z-index, and a feature folder that defines a UI kit component again. Each allowance in it names its file and the reason. `src/architecture/popup-placement.test.ts` holds the popup rules (Popups), and `copy-vocabulary.test.ts` the words.

## Do's and Don'ts

- Do pick a spacing role from the relationship. Don't write `gap-4 p-4` on a new page body; write `page stack-group` or `page stack-section`.
- Do give a heading its role (`heading-section`). Don't write `text-sm font-semibold` on a heading.
- Do keep the top bar on one size. Don't give the current page a larger size than its parent step.
- Do let hairlines and space separate sections. Don't wrap each section, or a status line, in a card or a tinted box.
- Do draw a section through `Section` and a count through `Count`. Don't build a section head, a count capsule or a selection bar in a feature folder.
- Don't use lavender outside work that waits on a person.
- Do mark an uncertain state with a `text-warning` icon. Don't tint a row, a band or a badge amber, and don't use green for success.
- Do keep red for errors and irreversible actions. Don't use it for a count that waits on an admin.
- Do say why an action is off where a person can read it. Don't put the reason in a native `title`.
- Do show the outcome of every step. Don't make a row disappear without a word, or ask for a reload.
