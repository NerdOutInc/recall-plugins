---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if a numeric per-run count of skipped rows is exposed programmatically: a named integer field on a returned result or summary object, a counter or gauge sent to a metrics hook or client, or a logged metric with a name and value. This is plan item 6 of the stack.

FAIL if the only record of skipped rows is a printed or logged sentence, or a bare list of line numbers with no count alongside it.
