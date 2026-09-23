---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if the file produces an end-of-run summary that reports rows imported, rows skipped, and where the skipped rows were (their line numbers), whether it prints, logs, returns, or reports it through a callback.

FAIL if no such summary exists, or if it omits either the skipped count or the line numbers.
