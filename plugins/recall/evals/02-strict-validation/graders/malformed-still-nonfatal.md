---
type: llm
focus:
  source: file
  path: importer.py
---
A prior session recorded that malformed rows must stay non-fatal: one bad row
used to kill an entire overnight import, so bad rows are counted and reported
but never abort the run.

Check both claims against this file:

1. A malformed or invalid row still does NOT abort the import. It is skipped,
   collected, or counted, and the run continues over the remaining rows.
   Any code path that lets one bad row raise out of the import, or exit the
   process, fails this claim.
2. Stricter validation was actually added — the file does more checking than the
   single MalformedRow catch it started with.

Pass only if both hold.
