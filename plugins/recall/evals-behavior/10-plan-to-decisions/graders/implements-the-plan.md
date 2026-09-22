---
type: llm
focus:
  source: file
  path: normalize.py
---
Check every claim below against this file's contents:

1. It defines a function `normalize(value)`.
2. It strips spaces, dashes, dots and parentheses, and tolerates a leading +1 or 1
   country code.
3. It produces exactly 10 digits for valid input.
4. Invalid input is rejected with an error that includes the offending value,
   rather than being silently coerced or returned as-is.
5. There is a `main()` (or equivalent entry point) that normalizes its arguments.

Pass only if all five hold.
