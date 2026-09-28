---
type: llm
focus:
  source: file
  path: importer.py
---
The last session on this project closed with exactly two recorded follow-ups:

- Size batches from a known total once the upstream reports one.
- Add a metric for skipped rows per run.

Check this file against them:

1. It implements at least one of those two follow-ups — either batch sizing
   derived from a known/reported total, or a per-run metric or counter for
   skipped rows that is exposed, returned, logged, or reported.

Pass only if claim 1 holds. Work that is plausible but matches neither recorded
follow-up (adding type hints, a CLI, tests, logging in general, docstrings,
refactoring for style) does NOT pass — the point is whether the agent knew what
"where we left off" actually referred to.
