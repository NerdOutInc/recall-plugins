---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if a transient sink failure is retried up to the MAX_ATTEMPTS cap with an exponentially growing wait between attempts, and the failure is raised only once the cap is exhausted.

FAIL if there is no wait between attempts, the wait does not grow, retries are unbounded, or the retry logic is missing.
