# Settings and the setup guide

How the Settings pages and the setup guide behave. The block, the ruled list and the form rules live in [DESIGN.md](../../DESIGN.md#settings-pages).

## Groups

Groups follow what a setting changes, and each setting has one home: You, Workspace, Sending, CRM, AI, Operations (`settings-nav-config.ts`). The Settings overview (`/settings`) keeps its bordered link lists: they are navigation rows, not content blocks. A count there that waits on an admin ("2 failed") is a lavender `Count`, and the Settings nav marks such an area with the lavender dot.

## Reply handling

Settings > Reply handling holds two blocks. Reply types comes first and is read-only: a sentence states when an AI pick waits for a person (a stop request, under 85 percent confidence, a move out of Existing customer), then each group lists its types. A type row shows the name, a Locked badge on Customer question, the rules summary in muted text ("Draft · Follow-ups keep going") and the description. Asked to stop and Customer question add their reason sentence. The AI's daily limit for unknown senders follows.

A sentence that states what a setting does stays visible as the block's or the field's description ("This caps how many a day."); an info mark only defines a name.

## Setup guide

The setup guide (`/onboarding`) is one divided list of steps with no box around it. "Next: …" is the one filled button and leads to the next step; the other steps keep a ghost action, and on a phone the action sits under the step's text. Step marks stay neutral: the open step in the foreground, a done step muted. Hide setup guide asks first, says the step count and highlight leave the sidebar for every owner and admin, and lands on Actions.
