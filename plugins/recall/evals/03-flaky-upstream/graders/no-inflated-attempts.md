---
type: regex
target:
  source: file
  path: importer.py
match: not_contains
---
MAX_ATTEMPTS\s*=\s*([5-9]|\d\d+)
