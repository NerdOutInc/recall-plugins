---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if transient sink failures are still retried with a growing wait between attempts (the backoff was not removed and the code does not fail fast on the first transient error).

FAIL if the first transient error now aborts the batch, or if the wait between attempts is gone.
