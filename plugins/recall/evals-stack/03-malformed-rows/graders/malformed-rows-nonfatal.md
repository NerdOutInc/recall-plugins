---
type: llm
focus:
  source: file
  path: importer.py
---
A malformed row is one with the wrong number of fields, or one whose quantity or price fails integer or float conversion.

PASS if both kinds are caught inside import_rows, directly or through _parse raising the importer's own MalformedRow, so that the row is skipped, counted with its line number, and the loop carries on with the remaining rows.

FAIL if either kind can propagate out of import_rows, if the run stops on a bad row, or if skipped rows are dropped without being counted.
