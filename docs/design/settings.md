# Settings and the setup guide

How the Settings pages and the setup guide behave. The block, the ruled list and the form rules live in [DESIGN.md](../../DESIGN.md#settings-pages).

## Groups

Groups follow what a setting changes, and each setting has one home: You, Workspace, Sending, CRM, AI, Operations (`settings-nav-config.ts`). The Settings overview (`/settings`) keeps its bordered link lists: they are navigation rows, not content blocks. A count there that waits on an admin ("2 failed") is a lavender `Count`, and the Settings nav marks such an area with the lavender dot.

## Reply handling

Settings > Reply handling holds three blocks. Reply types comes first, with Add reply type on its heading row. A type row shows the name, a Locked badge on Customer question, an Archived badge when archived, the count of people, and the rules summary in muted text ("Check after · Draft · Follow-ups keep going"). Asked to stop and Customer question add their reason sentence. Edit opens the dialog: Group (when adding), Name, Description, AI guidance, then the fieldset "When the AI picks {type}" with "Applies to replies picked from now on." and three radio groups: Check (Before it applies, After it applies, Skip), Reply draft (Write one, Don't write) and Follow-ups (Keep going, Stop). Asked to stop shows its fixed rules and reason in place of the radios. The archive dialog says how many people keep the type and where the AI sends replies that would have fit it. Confidence floor follows as one percent field with the help "Below this, an AI pick waits for a person." The floor holds a pick whatever its Check says. Unknown senders closes the page.

A sentence that states what a setting does stays visible as the block's or the field's description ("Below this, an AI pick waits for a person."); an info mark only defines a name.

## Setup guide

The setup guide (`/onboarding`) is one divided list of steps with no box around it. "Next: …" is the one filled button and leads to the next step; the other steps keep a ghost action, and on a phone the action sits under the step's text. Step marks stay neutral: the open step in the foreground, a done step muted. Hide setup guide asks first, says the step count and highlight leave the sidebar for every owner and admin, and lands on Actions.
