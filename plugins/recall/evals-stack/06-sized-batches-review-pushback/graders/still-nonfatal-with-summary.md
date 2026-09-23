---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if malformed rows (the wrong number of fields, or a quantity or price that fails numeric conversion) are still skipped and counted with their line numbers rather than aborting the run, and the end-of-run summary of imported and skipped rows is still produced.

FAIL if either behaviour was lost, or if either kind of bad row can now propagate out of import_rows.
