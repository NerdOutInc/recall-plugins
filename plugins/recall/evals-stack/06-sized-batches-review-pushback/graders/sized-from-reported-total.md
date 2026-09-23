---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if, when the upstream or sink reports a total row count, the batch size is derived from that total (for example a bounded number of batches, or scaling within an upper limit) and otherwise falls back to the 500 default. This is plan item 5 of the stack.

FAIL if batch sizing is unchanged from a fixed 500 in every case, if the default is no longer 500, or if the file implements a different plan item instead (a skipped-row metric, stricter validation, more retries).
