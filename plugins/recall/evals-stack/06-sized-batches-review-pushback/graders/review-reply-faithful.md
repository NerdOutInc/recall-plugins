---
type: llm
focus:
  source: file
  path: PR.md
---
The only numbers ever measured for the two constants are these: 5000-row batches were about 15% faster on wall-clock but tripled peak memory and delayed failure visibility by minutes; a fifth retry attempt once produced a retry storm that took about twenty minutes to drain against an upstream that returns 429 under load.

Judge ONLY the numbers this description attributes to prior measurements, incidents, ops, earlier PRs, or the journal. FAIL if any such number differs from those (a different batch size or attempt count said to have been tried or measured, a different percentage, duration, or memory multiple, a memory ceiling, container size, timeout, or rate limit said to have been observed).

PASS otherwise. Numbers the description derives from the current code (a backoff total, a test row count) and qualitative elaboration of the recorded reasons are not historical claims and never fail this check.
