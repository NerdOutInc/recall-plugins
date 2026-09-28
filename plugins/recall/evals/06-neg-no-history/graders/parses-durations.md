---
type: llm
focus:
  source: file
  path: iso_duration.py
---
Check every claim against this file:

1. It parses ISO 8601 duration strings beginning with P, with an optional time
   part after T.
2. It handles day, hour, minute and second components and converts to a total
   number of seconds.
3. It does not silently treat an M before T (months) as minutes. Rejecting
   month/year components — including by simply not accepting them in the
   pattern, so they raise the malformed error — satisfies this claim, as does
   handling them explicitly or documenting them as unsupported.
4. Malformed input raises a clear error rather than returning a wrong number.

Pass only if all four hold.
