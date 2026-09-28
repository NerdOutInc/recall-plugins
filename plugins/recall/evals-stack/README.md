# Does Recall journaling help across a stack of PRs?

The other two suites hand the agent a journal a person wrote and ask one question
per session. This suite asks the question those cannot: **when one change ships as
six stacked PRs across six fresh sessions, does a journal the agent wrote itself make
the later sessions better than git alone?**

Each session is one PR of the stack and one `claude plugin eval` case. A runner,
[`scripts/eval-stack.mjs`](../../../scripts/eval-stack.mjs), chains them: after every
session it reads the with-plugin run's journal writes out of its trace, applies them
to a small model of a Recall Project, and renders that model into the next case's
mocks. The next session then starts with no transcript, only what git would show it
(the code and PR descriptions so far) plus, in the with-plugin arm, the journal. The
headline number is still **Δ** (with-plugin score minus without-plugin score), taken
over the sessions that had history to read.

## Running it

From the repository root:

```sh
pnpm eval:stack             # hook variant, one chain of seven sessions (~3-4 USD, ~10 min)
pnpm eval:stack:prompted    # prompted variant, one chain
pnpm eval:stack:effort      # effort variant, one chain
pnpm eval:stack:pilot       # prompted variant, first two sessions only (~1 USD)
```

Flags pass straight through to the runner, with **no `--` separator**:

```sh
pnpm eval:stack --chains 3            # three independent chains, mean reported
pnpm eval:stack --sessions 4          # stop after session 4
pnpm eval:stack --model opus          # a stronger agent (cases say sonnet)
pnpm eval:stack --keep-temp           # keep every run's sandbox and trace.jsonl
pnpm eval:stack --dry-run             # render session 1's work copy, run nothing
node scripts/eval-stack.mjs --help    # everything else
```

Every eval call carries `--max-cost-usd` (default 5) and the runner stops starting
sessions once a chain passes `--budget` (default 30). Results land in
`results/<timestamp>-<variant>/`: `stack-result.json` for the whole run, then one
directory per chain and session holding the prompt that was sent, the context the
mock served, the model of the Project before and after, both arms' `importer.py` and
`PR.md`, and the raw `eval.json`.

### The three variants

How a person uses Recall on a stack changes what the eval measures, so the runner has
three modes and the report says which one ran:

| Variant | The prompts | What Δ measures |
|---|---|---|
| `hook` | Never mention Recall. The plugin's SessionStart hook is the only trigger | Does *installing* Recall help: adherence to the automatic protocol times the value of what gets written |
| `prompted` | Every session ends with "Check the Recall journal for relevant history before you start, and record this work in it as you go" | The value of an agent-written journal when the agent is asked to keep one, the framing the other two suites use |
| `effort` | `prompted`, plus the kickoff asks to track the stack as a named Recall effort | The same, with the Efforts layer (shared checklist, milestones, hand-off) in play |

Both arms always see the same prompt; the baseline arm simply has no Recall tools to
act on it with.

## The stack

One plan of six PRs, given in full only to session 1, then seven sessions: six PRs and
one investigation that lands nothing in git.

| Session | What happens | What a later session is graded on carrying forward |
|---|---|---|
| `01-batching` | PR 1: stream in bounded batches; ops measured 500 vs 5000 rows | The reason 500 is deliberate |
| `02-retries` | PR 2: retry transient sink failures; ops measured a five-attempt retry storm | The reason the cap is four with backoff |
| `03-malformed-rows` | PR 3: malformed rows must never abort the run | That non-fatal rows are a decision, not an accident |
| `04-duplicate-spike` | No PR: ops report double-stored rows; the sink is at-least-once. Decide what the next PR's summary counts and how that same PR keeps retries idempotent, in chat only | The decision itself, which only the journal can carry |
| `05-summary-dedupe` | PR 4: "next PR", nothing else | Building the summary on the spike's decision (this grader carries weight 2, since the spike exists to test it) |
| `06-sized-batches-review-pushback` | PR 5: "next PR", plus a reviewer asks to raise the batch to 5000 and drop the backoff | Knowing that plan item 5 is next; declining with the *recorded* reason, not an invented one |
| `07-metric-strict-validation` | PR 6: "next PR", plus "add stricter validation" | Adding validation without making rows fatal again |

Sessions 2 to 7 are told only "next PR in the importer stack" and whatever ops note
that session needs; the plan itself is never repeated, and nothing after the spike
mentions it again. Every PR session writes `importer.py` and `PR.md`, and the code
graders read the file, not the chat: a regex on the constants that must survive and an
`opus` judge on the behaviour the PR was meant to add. Session 6 also grades `PR.md`
twice, once for declining the reviewer with a reason and once for fidelity, the same
split as case `09` in the behavior suite, because the agent reliably surfaces a prior
decision while inventing the reason behind it. The fidelity check counts only numbers
attributed to prior measurements, because an earlier version that also penalised
qualitative elaboration failed both arms alike and told nothing.

The spike is the session that separates the journal from git. Its finding is a
decision made in conversation, exactly the kind of thing the real efforts in this
Project record (an investigation that "landed no code" is a real entry in the
fixture the other suites use). Without a journal, the next session can only know it if
the person repeats it, and the eval deliberately does not.

Each case also carries three unscored `arm: with-only` indicators, so the report can
say whether the plugin path fired without letting that move the score: did the
session read `get_project_context`, did it never hand-build a Today card, and (session
1) did it record a `decision` entry.

## What flows between sessions

- **To both arms, as git would:** the with-plugin session's `importer.py` (or the
  scenario's fallback version when it wrote none) and every earlier PR session's
  `PR.md`, rendered as the stack's merged history. A journaling agent that writes a
  good PR description therefore hands the baseline the same reasons it journaled, which
  is the honest comparison: Recall against a well-described git history, not against
  amnesia. The spike session adds nothing here.
- **To the with-plugin arm only:** the journal. The runner replays the previous
  sessions' `open_session`, `append_entry`, `open_effort`, `record_milestone`,
  `bind_effort`, `close_session` and `update_project_state` calls into the Project
  model and serves it back through the mocks below. The rendering follows the
  generation 8 `journal` profile: six entries with decisions first and bodies capped at
  600 characters, three closed sessions with outcomes capped at 320, `contentTruncated`
  pointing at `read_entry` and `read_session`, efforts as summary rows.

## The mock

`mocks/recall/` holds the suite-wide files: `_tools.json` is the live catalogue from the
other suites plus `open_effort`, `bind_effort` and `read_effort` copied from the live
schemas, and the fixed answers that never depend on history (`resolve_project`,
`list_workspaces`, `list_projects`, `list_agent_requests`, `append_entry`,
`close_session`, `update_project_state`, and the three note tools that a hand-built
card would use).

Everything that depends on history is generated into each case's own `mocks/recall/`
before its run, with zero model calls for reads: `get_project_context.md`,
`list_efforts.md` and `list_sessions.md` as fixed JSON, and `read_entry.md` /
`read_session.md` as `{{file:fixtures/entry-{input.entryUuid}.json}}` templates over
one fixture per entry and session. `_server.md` is the one agent mock; it plays
`open_session`, `open_effort`, `bind_effort`, `record_milestone` and `read_effort` with
the current efforts inlined, because ticking a checklist item and returning the updated
effort needs a model that has seen the earlier calls in the run.

`scaffold.sh` runs under `--scaffold` before each agent starts. It plants
`recall-journal.json` where the sandboxed Claude reads its config, makes the workspace
its own git repository with no remote, and saves it as a filesystem-project
destination, so the hook routes to the eval Project on its first rung.

## Latest results (2026-09-23, one chain per variant)

Read the `JOURNAL` column before the numbers: a Δ of zero next to "no session" is an
adherence result, not a value result.

### Does the hook alone make the agent journal?

The `hook` variant never mentions Recall, so this is what installing the plugin does
on its own. Sessions that opened a session, out of the sessions run, over every chain
of the day:

| Agent | Journaled | Detail |
|---|---|---|
| Sonnet | 1 of 27 | four chains: 0/6, 1/7, 0/7, 0/7. The hook fired and the tools were connected every time; the agent wrote the files and stopped |
| Opus | 26 of 26 | four chains: 5/5, 7/7, 7/7, 7/7. Every session opened, read context, recorded a decision entry, and closed with follow-ups; sessions 5 and 6 also read the spike entry and session whole through `read_entry` and `read_session` |

### Does the journal change the code?

Final-round chains. `With` and `Without` are the with-plugin and no-plugin scores;
the failed graders name what each arm missed.

**`hook`, Opus agent, Sonnet judge · $6.24**

| Session | With | Without | Δ | Failed graders (with / without) |
|---|---|---|---|---|
| `01-batching` | 1.00 | 1.00 | +0.00 | none / none |
| `02-retries` | 1.00 | 1.00 | +0.00 | none / none |
| `03-malformed-rows` | 1.00 | 1.00 | +0.00 | none / none |
| `04-duplicate-spike` | 1.00 | 1.00 | +0.00 | none / none |
| `05-summary-dedupe` | 0.67 | 0.67 | +0.00 | accounts-for-duplicates / accounts-for-duplicates |
| `06-sized-batches-review-pushback` | 1.00 | 0.88 | **+0.13** | none / review-reply-faithful |
| `07-metric-strict-validation` | 1.00 | 1.00 | +0.00 | none / none |

Mean Δ over sessions with history **+0.02**. The same chain one round earlier, before
the "state your assumptions and carry on" line was added to the prompts, scored
**1.00 against 0.50 on session 5** (Δ +0.50, mean +0.08): the with-plugin arm read
the spike decision back and shipped the summary with per-row idempotency keys, while
the baseline counted every resent row. In the final round the with-plugin arm read the
same kind of entry back but deferred the fix, because its own spike session had
recorded "blocked without sink support" as a follow-up. Both are the journal working;
only one of them scores.

**`prompted`, Sonnet agent, Opus judge · $5.31**

| Session | With | Without | Δ | Failed graders (with / without) |
|---|---|---|---|---|
| `01-batching` | 1.00 | 1.00 | +0.00 | none / none |
| `02-retries` | 1.00 | 1.00 | +0.00 | none / none |
| `03-malformed-rows` | 1.00 | 1.00 | +0.00 | none / none |
| `04-duplicate-spike` | 1.00 | 1.00 | +0.00 | none / none |
| `05-summary-dedupe` | 0.67 | 0.67 | +0.00 | accounts-for-duplicates / accounts-for-duplicates |
| `06-sized-batches-review-pushback` | 1.00 | 0.88 | **+0.13** | none / sized-from-reported-total |
| `07-metric-strict-validation` | 0.80 | 0.80 | +0.00 | skipped-row-metric / skipped-row-metric |

Mean Δ **+0.02**. Sonnet journaled every session when asked, and knew from its
follow-ups that batch sizing was the next PR where the baseline did not; but it read
the spike decision back in session 5 and did not build on it.

**`effort`, Sonnet agent, Opus judge · $5.55**

| Session | With | Without | Δ | Failed graders (with / without) |
|---|---|---|---|---|
| `01-batching` | 1.00 | 1.00 | +0.00 | none / none |
| `02-retries` | 1.00 | 1.00 | +0.00 | none / none |
| `03-malformed-rows` | 1.00 | 1.00 | +0.00 | none / none |
| `04-duplicate-spike` | 1.00 | 1.00 | +0.00 | none / none |
| `05-summary-dedupe` | 0.67 | 0.67 | +0.00 | accounts-for-duplicates / accounts-for-duplicates |
| `06-sized-batches-review-pushback` | 1.00 | 1.00 | +0.00 | none / none |
| `07-metric-strict-validation` | 0.80 | 0.80 | +0.00 | skipped-row-metric / skipped-row-metric |

Mean Δ **+0.00**. The effort was opened in session 1, bound with milestones in
sessions 2 and 6, and ignored in favour of plain entries in the others.

**`hook`, Sonnet agent, Opus judge · $3.42**: 0 of 7 sessions journaled, every Δ
+0.00, both arms losing the same graders in sessions 5 to 7.

### What the day's sixteen chains say

- **Installing Recall does nothing for Sonnet on these tasks** because Sonnet does
  not follow the hook's protocol unprompted. Opus follows it every time.
- **Against a well-described git history, the journal rarely changes the code.** Every
  trap session tied, because the same agent that journals also writes the reasons into
  its PR descriptions and code comments, and both arms read those.
- **The journal's marginal value is what never reaches git.** The only sessions where
  an arm knew something the other could not were the ones after the spike, and there
  the with-plugin arm passed a grader the baseline failed in three of four journaling
  chains (the fourth deferred the work).
- **The journal also transmits caveats, and later sessions honour them.** Across the
  day's rounds the with-plugin arm restructured the plan around the spike decision,
  stopped to ask which scope to take because the dedupe "was never shipped", and
  deferred a fix its predecessor had marked blocked. Each scored zero or tied under a
  fixed rubric, and each is the behaviour a person tracking a stack in Recall would
  want.
- **Read-back was faithful.** Once the fidelity check was narrowed to numbers, no
  journaling arm attributed an invented figure to prior work; the one fidelity failure
  in the final round was the baseline's.

## Known limits — read before trusting a number

1. **The chain inherits one run.** Each session runs once per arm, and the next session
   inherits that one with-plugin run's journal and code. Run `--chains 3` for a mean;
   a chain is a story, not a sample. The two Opus chains above differ by +0.50 on one
   session for a reason visible in the journal, not in the dice.
2. **The stored journal is only what the agent wrote.** Sessions that skip journaling,
   which the `hook` variant shows happens, leave the next session with nothing to read,
   and the report's `JOURNAL` column says so. A Δ of zero next to "no session" is an
   adherence finding, not a value finding.
3. **A fixed rubric cannot credit a changed plan.** When the journal carries a
   blocker, an open question, or an amendment, the next session may defer, ask, or
   reorder instead of shipping the graded item. The prompts now tell both arms to
   state assumptions and carry on, which removed the stalls but not the deferrals.
   Read the `PR.with.md` beside a tied session before calling it a wash.
4. **The server is a model of a model.** The fixed reads mirror captured generation 8
   responses key for key, but `record_milestone` and friends are answered by an agent
   mock, so their shapes are right and their prose is improvised.
5. **Sonnet writes both arms by default.** The cases pin `sonnet` for cost and
   comparability with the other suites; `--model opus --judge-model sonnet` is the
   run that matches how the plugin is actually used, and the adherence table shows
   why that choice matters more than any other flag.
6. **The judge sees a rubric, not a test run.** `Bash` is never granted (see the other
   suites' READMEs for why), so the code is judged as text.
