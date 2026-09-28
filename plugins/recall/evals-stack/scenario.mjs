// The stacked-PR scenario the multi-session suite plays out: one plan, six
// sessions, one PR each. scripts/eval-stack.mjs renders each session's prompt
// from this file plus what the previous sessions produced, so the only thing a
// later session knows about earlier ones is what git would show it (the code
// and the PR descriptions) and, in the with-plugin arm, the Recall journal.

export const PLAN = [
  "Stream the file in bounded batches instead of reading everything into memory.",
  "Retry transient sink failures with exponential backoff.",
  "Make malformed rows non-fatal: count them with their line numbers and never abort the run.",
  "Print an end-of-run summary: rows imported, rows skipped, and where.",
  "Size batches from the upstream's reported total when it provides one.",
  "Add a per-run metric for skipped rows.",
];

// The two facts a later session is graded on carrying forward faithfully.
export const RECORDED_REASONS = {
  batch:
    "5000-row batches cut wall-clock about 15% but tripled peak memory and delayed failure visibility by minutes; 500-row batches keep memory flat and surface a bad batch within seconds.",
  retries:
    "the upstream rate-limits hard and returns 429 under load; a job allowed five attempts turned ordinary transients into a retry storm that took about twenty minutes to drain and throttled every other caller.",
};

const KICKOFF = `Kick off the importer hardening stack. The overnight CSV import wedges on large files, dies on one bad row, and falls over when the sink flakes. We are fixing it as a stack of six small PRs, one per session, in this order:

${PLAN.map((item, i) => `${i + 1}. ${item}`).join("\n")}

Do PR 1 now. Ops measured this last week: 5000-row batches cut wall-clock about 15% but tripled peak memory and delayed failure visibility by minutes; 500-row batches keep memory flat and surface a bad batch within seconds. Use 500, keep it in a module constant named BATCH_SIZE, and keep it there until PR 5 gives us a real total to size against.`;

export const SESSIONS = [
  { name: "01-batching", planItem: 1, ask: KICKOFF },
  {
    name: "02-retries",
    planItem: 2,
    ask: `Next PR in the importer stack. Ops note for this one: the upstream rate-limits hard and returns 429 under load. Last time we let a job retry five times, ordinary transients turned into a retry storm that took about twenty minutes to drain and throttled every other caller. Cap it at four attempts with exponential backoff between them; that recovers the transients we actually see. Keep the cap in a module constant named MAX_ATTEMPTS.`,
  },
  {
    name: "03-malformed-rows",
    planItem: 3,
    ask: `Next PR in the importer stack. Last night one malformed row killed the entire overnight import and cost us a full day. A malformed row must never abort the run again: count them, keep their line numbers, and carry on.`,
  },
  {
    // An investigation with no PR: the one kind of session whose result never
    // reaches git, so only the journal can carry it to the next session.
    name: "04-duplicate-spike",
    kind: "spike",
    ask: `Before the next PR, ops need a decision, not code. Last night's run reported 12,000 rows imported, but the sink holds 12,480 for that file. The sink is at-least-once: a batch write that times out client-side can still have landed, so when the retry from PR 2 sends the same batch again the sink stores it twice. Work out two things for the next PR, the end-of-run summary: what that summary should count, and how the same PR should keep a retried batch from being stored twice. Both ship together in that one PR; do not add a PR to the plan. Reply with your decision and the reasoning. Do not write any code or a PR description this session.`,
  },
  {
    name: "05-summary-dedupe",
    planItem: 4,
    ask: `Next PR in the importer stack.`,
  },
  {
    name: "06-sized-batches-review-pushback",
    planItem: 5,
    ask: `Next PR in the importer stack. Also, a reviewer left this comment on the stack: "BATCH_SIZE = 500 looks conservative, bump it to 5000 while you are in here. And the retry backoff just slows failures down; drop it and fail fast on the first error." Address the review in this PR as you see fit, and say what you did about it and why in the PR description.`,
  },
  {
    name: "07-metric-strict-validation",
    planItem: 6,
    ask: `Next PR in the importer stack. Also: we are getting bad data through the import. Add stricter validation so problems are caught early.`,
  },
];

for (const session of SESSIONS) session.kind ??= "pr";

const WRITE_INSTRUCTIONS = `Write the updated file to \`importer.py\` and the pull request description to \`PR.md\` (a \`#\` heading with the PR title on the first line, then the description as you would post it) in the current directory. Where something is unspecified, make a reasonable assumption, state it in the PR description, and carry on; nobody is available to answer questions during this session.`;

// Fallback code for each session's starting point, used only when the previous
// with-plugin session did not leave a usable importer.py behind. Deliberately
// plain and comment-light: the reasons behind the constants travel through the
// PR descriptions and, in the with-plugin arm, the journal.
const HEADER = `"""Overnight CSV importer."""
import csv
import time


class MalformedRow(ValueError):
    """A row that cannot be parsed."""


class Transient(Exception):
    """A sink failure that may succeed on retry."""
`;

const PARSE = `

def _parse(raw):
    if len(raw) != 3:
        raise MalformedRow(raw)
    sku, quantity, price = raw
    return {"sku": sku, "quantity": int(quantity), "price": float(price)}
`;

export const CODE = [
  // v0: before PR 1
  `${HEADER}

def import_rows(path, sink):
    with open(path, newline="") as handle:
        rows = [_parse(raw) for raw in csv.reader(handle)]
    sink.write(rows)
    return len(rows)
${PARSE}`,
  // v1: after PR 1 (bounded batches)
  `${HEADER}
BATCH_SIZE = 500  # deliberate; see PR 1


def import_rows(path, sink):
    imported, buffer = 0, []
    with open(path, newline="") as handle:
        for raw in csv.reader(handle):
            buffer.append(_parse(raw))
            if len(buffer) >= BATCH_SIZE:
                _flush(buffer, sink)
                imported += len(buffer)
                buffer = []
    if buffer:
        _flush(buffer, sink)
        imported += len(buffer)
    return imported


def _flush(batch, sink):
    sink.write(batch)
${PARSE}`,
  // v2: after PR 2 (retries with backoff)
  `${HEADER}
BATCH_SIZE = 500  # deliberate; see PR 1
MAX_ATTEMPTS = 4  # deliberate; see PR 2


def import_rows(path, sink):
    imported, buffer = 0, []
    with open(path, newline="") as handle:
        for raw in csv.reader(handle):
            buffer.append(_parse(raw))
            if len(buffer) >= BATCH_SIZE:
                _flush(buffer, sink)
                imported += len(buffer)
                buffer = []
    if buffer:
        _flush(buffer, sink)
        imported += len(buffer)
    return imported


def _flush(batch, sink):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            sink.write(batch)
            return
        except Transient:
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2 ** attempt)
${PARSE}`,
  // v3: after PR 3 (non-fatal malformed rows)
  `${HEADER}
BATCH_SIZE = 500  # deliberate; see PR 1
MAX_ATTEMPTS = 4  # deliberate; see PR 2


def import_rows(path, sink):
    imported, skipped, buffer = 0, [], []
    with open(path, newline="") as handle:
        for lineno, raw in enumerate(csv.reader(handle), 1):
            try:
                buffer.append(_parse(raw))
            except MalformedRow:
                skipped.append(lineno)
                continue
            if len(buffer) >= BATCH_SIZE:
                _flush(buffer, sink)
                imported += len(buffer)
                buffer = []
    if buffer:
        _flush(buffer, sink)
        imported += len(buffer)
    return imported, skipped


def _flush(batch, sink):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            sink.write(batch)
            return
        except Transient:
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2 ** attempt)
${PARSE}`,
  // v4: after PR 4 (end-of-run summary)
  `${HEADER}
BATCH_SIZE = 500  # deliberate; see PR 1
MAX_ATTEMPTS = 4  # deliberate; see PR 2


def import_rows(path, sink, report=print):
    imported, skipped, buffer = 0, [], []
    with open(path, newline="") as handle:
        for lineno, raw in enumerate(csv.reader(handle), 1):
            try:
                buffer.append(_parse(raw))
            except MalformedRow:
                skipped.append(lineno)
                continue
            if len(buffer) >= BATCH_SIZE:
                _flush(buffer, sink)
                imported += len(buffer)
                buffer = []
    if buffer:
        _flush(buffer, sink)
        imported += len(buffer)
    report(_summary(imported, skipped))
    return imported, skipped


def _summary(imported, skipped):
    line = f"imported {imported} rows; skipped {len(skipped)} malformed rows"
    if skipped:
        line += " at lines " + ", ".join(str(n) for n in skipped)
    return line


def _flush(batch, sink):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            sink.write(batch)
            return
        except Transient:
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2 ** attempt)
${PARSE}`,
  // v5: after PR 5 (batches sized from a reported total)
  `${HEADER}
BATCH_SIZE = 500  # deliberate; see PR 1
MAX_ATTEMPTS = 4  # deliberate; see PR 2
MAX_BATCH_SIZE = 2000


def import_rows(path, sink, report=print):
    batch_size = _batch_size(sink)
    imported, skipped, buffer = 0, [], []
    with open(path, newline="") as handle:
        for lineno, raw in enumerate(csv.reader(handle), 1):
            try:
                buffer.append(_parse(raw))
            except MalformedRow:
                skipped.append(lineno)
                continue
            if len(buffer) >= batch_size:
                _flush(buffer, sink)
                imported += len(buffer)
                buffer = []
    if buffer:
        _flush(buffer, sink)
        imported += len(buffer)
    report(_summary(imported, skipped))
    return imported, skipped


def _batch_size(sink):
    total = getattr(sink, "reported_total", None)
    total = total() if callable(total) else total
    if not total:
        return BATCH_SIZE
    return min(max(BATCH_SIZE, total // 20), MAX_BATCH_SIZE)


def _summary(imported, skipped):
    line = f"imported {imported} rows; skipped {len(skipped)} malformed rows"
    if skipped:
        line += " at lines " + ", ".join(str(n) for n in skipped)
    return line


def _flush(batch, sink):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            sink.write(batch)
            return
        except Transient:
            if attempt == MAX_ATTEMPTS:
                raise
            time.sleep(2 ** attempt)
${PARSE}`,
];

// Three ways a person might use Recall on a stack. `hook` leaves every
// journaling decision to the plugin's hook and never mentions Recall.
// `prompted` asks for the journal in every session, the way the other two
// suites do. `effort` is `prompted` plus a kickoff that names the stack as a
// Recall effort, the way someone who tracks bodies of work in Recall would.
export const VARIANTS = ["hook", "prompted", "effort"];
export const JOURNAL_HINT =
  "Check the Recall journal for relevant history before you start, and record this work in it as you go.";
export const EFFORT_HINT =
  "Track this stack as a named Recall effort, so each later session can pick it up where the previous one left off.";

// history: [{ number, title, body }] for the PRs merged so far, oldest first.
export function renderPrompt(index, history, code, { variant = "hook" } = {}) {
  if (!VARIANTS.includes(variant))
    throw new Error(`unknown variant ${variant}`);
  const session = SESSIONS[index];
  const parts = [];
  if (index === 0) {
    parts.push(
      variant === "effort" ? `${session.ask}\n\n${EFFORT_HINT}` : session.ask,
    );
  } else {
    parts.push(
      "You are continuing the importer hardening stack: a chain of small PRs, one per session, each building on the last.",
    );
    parts.push(
      "Merged so far on this stack, oldest first:\n\n" +
        history
          .map(
            (pr) =>
              `### PR ${pr.number}: ${pr.title}\n\n${pr.body.trim() || "(no description recorded)"}`,
          )
          .join("\n\n"),
    );
    parts.push(session.ask);
  }
  parts.push(
    "Current `importer.py`:\n\n```python\n" + code.trimEnd() + "\n```",
  );
  if (session.kind === "pr") parts.push(WRITE_INSTRUCTIONS);
  if (variant !== "hook") parts.push(JOURNAL_HINT);
  return parts.join("\n\n") + "\n";
}
