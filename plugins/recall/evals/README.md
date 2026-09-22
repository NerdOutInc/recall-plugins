# Does Recall journaling produce better code?

This suite answers one question: **is Claude better at writing code for a project
when it can read that project's Recall journal?**

Each case runs twice — once with the plugin loaded, once without — and is graded on
**the code that gets written**, not on whether a session was opened or what the chat
said. The headline number is **Δ** (with-plugin score minus without-plugin score).

## Running it

All scripts run from the **repository root**:

```sh
pnpm eval                  # full suite, runs: 3        (~6 USD, ~12 min)
pnpm eval:local            # same, report stays local
pnpm eval:pilot            # runs: 1, cheap smoke test  (~2 USD, ~4 min)
pnpm eval:behavior         # the archived behavior suite (see bottom)
pnpm eval:ci               # non-interactive, no publish
pnpm run                   # list every script
```

No install step is needed — the scripts only invoke `claude`, which is already on
your PATH. Every script carries a `--max-cost-usd` ceiling so a mistake cannot run
away with your usage.

### Passing extra flags

Append them directly, with **no `--` separator**:

```sh
pnpm eval --case '04-*'          # one case
pnpm eval --keep-temp            # keep each run's sandbox + trace.jsonl
pnpm eval --runs 1               # override runs
```

> **Do not write `pnpm eval -- --case '04-*'`.** The `--` is forwarded to the CLI,
> which treats it as end-of-options, so your flags become operands, the filter is
> silently ignored, and the **entire suite runs**. It fails expensively rather than
> loudly.

### Why the scripts bake in flags

Running `claude plugin eval .` bare gives a **misleading zero**, for two reasons:

- **`--allow-tools Write`** — `Write` is gated. Without it the agent cannot create the
  file the graders read, so every case scores 0 in *both* arms and the suite looks
  like the plugin does nothing.
- **`--judge-model opus`** — the judge defaults to **haiku**, too small for these
  rubrics. It must also differ from the agent model (cases run `sonnet`), or the
  judge grades its own output.

**Never add `Bash`.** It aborts every run on a machine whose `~/.docker` contains
symlinks — which a stock Docker Desktop install always has. That is why cases write
files and are graded on their contents rather than by executing them.

## The cases

Four where the right answer depends on history only the journal holds, and two
negatives where it holds nothing relevant.

| Case | The task | What only the journal knows |
|---|---|---|
| `01-faster-import` | "Too slow — the batch size looks conservative, see if there's headroom" | 500-row batches are deliberate; 5000 tripled peak memory |
| `02-strict-validation` | "We're getting bad data, add stricter validation" | Malformed rows must stay non-fatal; one bad row used to kill overnight runs |
| `03-flaky-upstream` | "Four attempts seems low, see whether raising it helps" | The 4-retry cap is deliberate; a 5th caused a ~20-minute retry storm |
| `04-resume-followups` | "Pick up where the last session left off" | The two follow-ups that session actually recorded |
| `05-neg-unrelated` | WCAG contrast checker | nothing — guards against history leaking in |
| `06-neg-no-history` | ISO 8601 duration parser | nothing — guards against the journal distorting fresh work |

`01`–`03` are traps: the obvious fix is to raise the number, and raising it is wrong
*for this project* for a reason recorded only in the journal. `04` is the purest
test — "where we left off" is unanswerable without history.

## Latest results (runs: 2, 2026-09-21)

| Case | With | Without | Δ |
|---|---|---|---|
| `04-resume-followups` | 1.00 | 0.00 | **+1.00** |
| `01-faster-import` | 1.00 | 0.33 | **+0.67** |
| `02-strict-validation` | 1.00 | 0.50 | **+0.50** |
| `03-flaky-upstream` | 0.50 | 0.33 | +0.17 |
| `06-neg-no-history` | 0.83 | 0.67 | +0.17 |
| `05-neg-unrelated` | 1.00 | 1.00 | 0.00 |

**Mean Δ +0.42** · $4.17 · 469s

Read `05` at Δ 0.00 as correct, not weak: there is no history for the journal to
supply, so it cannot help. Uplift appears where the task *needs* recalled knowledge.

An earlier pass, before `01` and `03` were sharpened to actually push toward the
wrong change, scored Δ 0.00 on both — the baseline does not gratuitously change
constants it was not asked about. A trap only discriminates if the task pushes on it.

## Known limits — read before trusting a number

1. **This is not the automatic hook path.** Every prompt ends with "Check the project
   journal for relevant history before you start", and the destination ids arrive via
   `append_system_prompt`. Both arms get both, but only the with-arm can act on them.
   The journal hook only ships its protocol when `CLAUDE_CONFIG_DIR/recall-journal.json`
   exists, and the sandbox builds a fresh config dir. So this measures *"when the
   journal is consulted, is the code better"* — one step short of *"does installing
   Recall make the code better"*. Each case carries a `scaffold_script` that plants the
   config; it is inert because `--scaffold` does not currently execute it. When that is
   fixed, the scaffold closes this gap with no other changes.
2. **Run-to-run variance is real.** The agent occasionally answers without writing the
   file, which scores 0 and can make a grader throw. `runs: 3` is a floor, not comfort.
3. **The journal is a fixture, not a real project's history.** `mocks/recall/` holds a
   redacted capture of a real `get_project_context` response — every key, capability
   flag, row count and truncation flag is what the live server returned, with content
   replaced. Its three `decision` entries and two recorded follow-ups are what cases
   `01`-`04` are graded against.

## The mock

`mocks/recall/` stands in for the local MCP server; the suite never touches the real
Recall app.

- Deterministic reads (`get_project_context`, `list_workspaces`, `list_projects`,
  `list_agent_requests`, `list_efforts`, `list_sessions`, `resolve_project`,
  `update_project_state`, `record_milestone`) are **static files** — exact fixture,
  zero model calls.
- `_server.md` is an agent mock handling only the scenario-dependent writes, with
  `abort_when` hard-stopping four behaviours that would be embarrassing in production.
- `_tools.json` is the live catalogue captured from `recall-local` 1.0.2 over the local
  socket, trimmed to the tools this flow reaches and stripped of output schemas.

Write-tool response shapes come from recall-app's own handlers and tests — those tools
publish no output schema, and calling them for real would have written a live session
and Today card.

## The archived behavior suite

`../evals-behavior/` holds an earlier 11-case suite that asks a different question:
*does journaling behave correctly* — honest reporting when it cannot record, no
hand-built Today cards, no blind-retry loops, faithful read-back. It caught a repeat of
the PR #61 legacy-fallback regression and a confabulation bug where the agent invented
technical justifications and attributed them to journal entries. Run it with
`pnpm eval:behavior`.
