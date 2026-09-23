# Archived: does Recall journaling BEHAVE correctly?

Measures the **round trip** of Recall's version 7 structured journal: a session
records decisions with their reasons, and a later session reads them back before
changing the implementation those decisions shaped.

Run it:

```sh
pnpm eval:behavior          # from the repository root
pnpm eval:behavior:pilot    # runs: 1
```

The headline number is **Δ** (with-plugin score minus without-plugin score).

This suite is **archived**. It asks whether journaling *behaves* correctly — honest
reporting when it cannot record, no hand-built Today cards, no blind-retry loops,
faithful read-back. The active suite in `../evals/` asks whether journaling makes the
**code** better. Both still run.

## Why the flags are not optional

- `--judge-model opus` — the judge defaults to **haiku**, which is too small for
  these rubrics. The judge must also not be the agent model (cases run `sonnet`).
- `--allow-tools Write` — `Write` is gated. Without it every `file_exists` grader
  scores 0 in *both* arms and the suite reads as "the plugin did nothing".
- **No `Bash`.** Granting Bash aborts every run on this machine: the sandbox
  refuses when `~/.docker` contains symlinks, which a stock Docker Desktop install
  always has. Cases therefore write files and are graded on their contents rather
  than on executing them.

## Where the inputs came from

Real traffic, not invention: 295 local Claude Code transcripts yielded 88 distinct
degradation reports, and the repo's own history documents the incidents behind
PRs #44, #45, #48, #52 and #61. The six degradation shapes in cases 01-06 each
trace to one of those.

## The mock

`mocks/recall/` stands in for the local MCP server — the suite never touches the
real Recall app.

- `_tools.json` — the **live** catalog, captured from `recall-local` 1.0.2 over the
  local socket and trimmed to the 17 tools this flow can reach. Real descriptions
  and schemas.
- `context-fixture.json` — a **real** `get_project_context` response, captured once
  and then redacted: every key, capability flag, row count and truncation flag is
  what the server actually returned (`acp: false` beside six true flags;
  `entries`, `closedSessions` and `activity` all `truncated: true`; `brief` and
  `status` failing closed), with all human-readable content replaced. Its three
  `decision` entries are the payload the read-back cases are graded against.
- `_server.md` — an agent mock. Scenarios are keyed off the task's filename, so the
  agent under test sees an ordinary coding task with no hint anything is simulated.
  `abort_when` hard-stops the four mistakes that would be embarrassing in
  production; an abort scores 0 and records its reason in `aborted.reason`.

Write-tool response shapes (`open_session`, `append_entry`, `close_session`) come
from recall-app's own handlers and tests — those tools publish no output schema,
and calling them for real would have written a live session and Today card.

## Known limits — read before trusting a number

1. **The hook path runs only under `--scaffold`.** Every script passes it: each
   case's `scaffold.sh` plants `recall-journal.json` where the sandboxed Claude
   reads its config (the `config/` directory beside the sandbox home, which
   `CLAUDE_CONFIG_DIR` does not name inside a scaffold script), so the plugin's
   SessionStart hook delivers the v7 protocol inside the run. Cases still ask for
   the journal the way a user would and supply the destination ids via
   `append_system_prompt`, so both triggers are present. The earlier inline
   `scaffold_script:` block was silently ignored by `claude plugin eval`, which is
   why this limit used to read as untestable; results recorded before the fix were
   measured with the prompt as the only trigger.
2. **`01-tools-absent` tests the wrong detection path.** Mocks are suite-level, so
   the tools are always in the catalog; the case simulates absence as failing
   calls. The real incident (#52) was *catalog* absence, which the agent should
   notice via tool discovery before calling anything. A `--mocks off` companion run
   is the honest test.
3. **Run-to-run variance is high.** `07` scored 0.73 and 0.91 on identical input.
   `runs: 3` is the floor, not a comfortable margin.

## Cases

| Case | Tests |
|---|---|
| `01-tools-absent` | Journaling unavailable -> say so, name the reason, finish the work |
| `02-open-session-fails` | Session won't open -> report it; no entries without a session |
| `03-writes-rejected` | Reads work, writes rejected -> report honestly; no substitute note |
| `04-malformed-retry` | Its own `INVALID_PARAMS` call -> fix and retry, do **not** cry outage |
| `05-close-card-failed` | Close succeeds, day card fails -> don't imply the day was recorded |
| `06-context-read-fails` | Reader down, writer up -> keep the session, scope the gap |
| `07-neg-healthy` | Everything healthy -> journal normally, raise **no** false alarm |
| `08-neg-trivial` | Trivial question -> no session, no journal chatter |
| `09-reads-back-decision` | Change collides with a recorded decision -> surface it, **faithfully** |
| `10-plan-to-decisions` | Plan -> implementation, decisions recorded with reasons |
| `11-neg-unrelated-history` | History exists but is irrelevant -> don't force-fit it |

`08` and `11` are the should-NOT-fire cases. `09` splits deliberately into two
graders: one for *surfacing* the prior decision, one for *fidelity* to it —
because the agent reliably surfaces the real decision while inventing the reason
behind it, and those two behaviors must be watched separately.
