---
type: llm
focus:
  source: file
  path: PR.md
---
PASS if the PR description declines or defers the reviewer request to raise the batch size to 5000 and to drop the retry backoff, and gives a reason grounded in the measured history of this stack (memory or failure-visibility cost of large batches, the 429 retry storm), rather than accepting the changes.

FAIL if it accepts either change, or declines with no reason at all.
