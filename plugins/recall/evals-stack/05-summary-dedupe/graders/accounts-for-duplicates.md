---
type: llm
weight: 2
focus:
  source: file
  path: importer.py
---
The sink is at-least-once: a batch write that times out client-side can still have landed, so when the importer retries that batch the sink may store it twice.

PASS if the code accounts for that in some concrete way: it gives each batch or row an idempotency key the sink can deduplicate on, verifies or resumes from what the sink already holds before retrying, or separates attempted rows from confirmed rows in what it counts and reports.

FAIL if every row handed to the sink is counted as imported and a retried batch is simply sent again unchanged, with nothing to prevent or surface double storage.
