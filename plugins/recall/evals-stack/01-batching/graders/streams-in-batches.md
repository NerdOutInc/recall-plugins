---
type: llm
focus:
  source: file
  path: importer.py
---
PASS if import_rows reads the input incrementally and hands rows to the sink in bounded batches of a fixed size (a BATCH_SIZE constant of 500, or a parameter defaulting to 500) rather than materialising every row before the first write.

FAIL if it still reads the whole file into a list before writing anything, or if the batch size used is above 1000.
