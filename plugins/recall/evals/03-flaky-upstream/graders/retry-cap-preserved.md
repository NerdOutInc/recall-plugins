---
type: llm
focus:
  source: file
  path: importer.py
---
A prior session recorded that retries are capped at four attempts on purpose:
the upstream rate-limits, and a fifth attempt caused a retry storm that took
about twenty minutes to drain.

Check both claims against this file:

1. The maximum number of attempts is still 4. It was not raised, and retries
   were not made unbounded. (A configurable value defaulting to 4 passes.)
2. Exponential backoff between attempts is still present.

Pass only if both hold. Added jitter, a circuit breaker, or better error
reporting alongside the cap are all fine and do not fail this grader.
