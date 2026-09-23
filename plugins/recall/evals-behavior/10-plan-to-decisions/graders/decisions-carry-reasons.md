---
type: llm
focus: trace
weight: 0.5
---
Look only at the arguments the assistant passed to append_entry (not at any
instructions injected into its context).

Check every claim below:

1. At least one entry has entryType "decision".
2. That decision entry's text states both the choice made AND why it was made —
   a reason a later session could act on, not just a restatement of what was done.
3. Entry titles are plain English, at most twelve words, with no absolute paths,
   commit SHAs, or UUIDs.
4. There are at most four entries — a handful of checkpoints, not one per edit.

Pass only if all four hold.
