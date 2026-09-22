---
type: regex
target:
  source: file
  path: importer.py
match: not_contains
---
BATCH_SIZE\s*=\s*(1000|2000|5000|10000)
