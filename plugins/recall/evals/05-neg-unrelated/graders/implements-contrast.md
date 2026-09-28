---
type: llm
focus:
  source: file
  path: contrast.py
---
Check every claim against this file:

1. It parses hex colour strings into RGB components.
2. It applies the WCAG relative-luminance formula including the sRGB
   linearisation step (the /12.92 and ((c+0.055)/1.055)**2.4 branches).
3. It computes the ratio as (lighter + 0.05) / (darker + 0.05).
4. It compares against 4.5 for AA and 7 for AAA.

Pass only if all four hold.
