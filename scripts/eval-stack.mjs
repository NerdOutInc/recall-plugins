#!/usr/bin/env node
// Runs the stacked-PR eval suite in plugins/recall/evals-stack as a chain of
// sessions, so that a later, fresh agent session can read back what an
// earlier session journaled.
//
// `claude plugin eval` runs every case as one isolated session and cannot
// carry state between cases, so this script does it: after each session it
// reads the with-plugin run's journal writes out of its trace, applies them to
// a small in-memory model of a Recall Project, and renders that model into the
// next case's mock files (the static get_project_context, list_efforts,
// list_sessions, read_entry and read_session answers, and the agent mock that
// plays the session and effort tools). Both arms of the next session also
// receive what git would show them: the code the previous with-plugin session
// wrote and the PR descriptions so far. The only difference between the arms
// is the journal.
//
//   node scripts/eval-stack.mjs                 # one chain, all six sessions
//   node scripts/eval-stack.mjs --chains 3      # three independent chains
//   node scripts/eval-stack.mjs --sessions 2    # only the first two sessions
//   node scripts/eval-stack.mjs --dry-run       # render session 1, run nothing
//
// Every session is one `claude plugin eval` invocation (two arms, one run
// each), so a six-session chain is twelve agent runs plus judge calls.

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginDir = path.join(repoRoot, "plugins", "recall");
const templateDir = path.join(pluginDir, "evals-stack");
// One generated work copy per variant, so variants can run side by side.
let WORK_DIR_NAME = "evals-stack-work";
let workDir = path.join(pluginDir, WORK_DIR_NAME);
const { CODE, PLAN, SESSIONS, VARIANTS, renderPrompt } = await import(
  pathToFileURL(path.join(templateDir, "scenario.mjs")).href
);

const WORKSPACE_ID = "ws-eval-personal";
const PROJECT_UUID = "proj-eval-ai";
const PROJECT_NAME = "AI";
const TOOL_PREFIX = "mcp__plugin_recall_recall__";
const PROJECT_HREF = `https://recall.nerdout.com/notes/all?workspace=${WORKSPACE_ID}&project=${PROJECT_UUID}`;
const BRIEF_UUID = "00000000-0000-4000-8000-0000000000b1";
const ACTOR = { type: "user", userId: "usr-eval" };
const PRIORITY_ENTRY_TYPES = new Set([
  "decision",
  "blocker",
  "shipped",
  "summary",
]);

function usage() {
  console.log(`Usage: node scripts/eval-stack.mjs [options]

  --chains <n>            independent chains to run (default 1)
  --sessions <n>          sessions per chain, 1-${SESSIONS.length} (default ${SESSIONS.length})
  --budget <usd>          stop starting sessions once the chain total passes this (default 30)
  --max-cost-per-run <usd> --max-cost-usd for each claude plugin eval call (default 5)
  --variant <name>        hook: no prompt ever mentions Recall, the plugin's hook is the only trigger (default)
                          prompted: every session asks to check and record the Recall journal
                          effort: prompted, plus the kickoff names the stack as a Recall effort
  --model <model>         agent model override (cases say sonnet)
  --judge-model <model>   judge and agent-mock model (default opus)
  -j, --concurrency <n>   parallel agent runs per eval call (default 2: one per arm)
  --out <dir>             results directory (default plugins/recall/evals-stack/results/<timestamp>)
  --keep-temp             keep every run's sandbox directory
  --dry-run               render the first session's work copy and exit`);
}

function parseArgs(argv) {
  const opts = {
    chains: 1,
    sessions: SESSIONS.length,
    budget: 30,
    maxCostPerRun: 5,
    variant: "hook",
    model: null,
    judgeModel: "opus",
    concurrency: 2,
    out: null,
    keepTemp: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--chains":
        opts.chains = Number(next());
        break;
      case "--sessions":
        opts.sessions = Number(next());
        break;
      case "--budget":
        opts.budget = Number(next());
        break;
      case "--max-cost-per-run":
        opts.maxCostPerRun = Number(next());
        break;
      case "--variant":
        opts.variant = next();
        break;
      case "--model":
        opts.model = next();
        break;
      case "--judge-model":
        opts.judgeModel = next();
        break;
      case "-j":
      case "--concurrency":
        opts.concurrency = Number(next());
        break;
      case "--out":
        opts.out = path.resolve(next());
        break;
      case "--keep-temp":
        opts.keepTemp = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        throw new Error(`unknown option ${arg} (try --help)`);
    }
  }
  if (
    !(opts.chains >= 1) ||
    !(opts.sessions >= 1 && opts.sessions <= SESSIONS.length)
  )
    throw new Error(
      `--chains must be >= 1 and --sessions between 1 and ${SESSIONS.length}`,
    );
  if (!VARIANTS.includes(opts.variant))
    throw new Error(`--variant must be one of ${VARIANTS.join(", ")}`);
  return opts;
}

// ---------------------------------------------------------------------------
// The Project model: what the fake Recall server remembers between sessions.

function freshState() {
  return {
    sessions: [],
    entries: [],
    efforts: [],
    brief: null,
    status: null,
    revisionSeq: 0,
  };
}

function nextRevision(state) {
  state.revisionSeq += 1;
  return `eval-rev-${state.revisionSeq}`;
}

function derivedUuid(...parts) {
  const hex = createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const noteHref = (uuid) =>
  `https://recall.nerdout.com/notes/all?workspace=${WORKSPACE_ID}&note=${uuid}`;
const findSession = (state, uuid) =>
  uuid ? state.sessions.find((s) => s.sessionUuid === uuid) : undefined;
const asString = (value, fallback = "") =>
  typeof value === "string" ? value : fallback;
const asStrings = (value) =>
  Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];

function bindEffort(state, effortUuid, session, used) {
  const effort = state.efforts.find((e) => e.uuid === effortUuid);
  if (!effort || !session) return;
  if (session.effortUuid !== effort.uuid) {
    session.effortUuid = effort.uuid;
    used.effortsBound += 1;
  }
  if (!effort.boundSessions.includes(session.sessionUuid))
    effort.boundSessions.push(session.sessionUuid);
}

function touch(session, at) {
  if (session && at > (session.lastActivityAt ?? 0))
    session.lastActivityAt = at;
}

// Applies one session's journal writes, in call order, to the model. Returns
// what the session used, for the report.
function applyJournalWrites(state, calls, label) {
  const used = {
    openedSession: 0,
    readContext: 0,
    entries: 0,
    effortsOpened: 0,
    effortsBound: 0,
    milestones: 0,
    readEffort: 0,
    closedSession: 0,
    handBuiltNotes: 0,
    tools: {},
  };
  for (const call of calls) {
    if (!call.name.startsWith(TOOL_PREFIX)) continue;
    const tool = call.name.slice(TOOL_PREFIX.length);
    const input = call.input ?? {};
    const at = call.at || Date.now();
    used.tools[tool] = (used.tools[tool] ?? 0) + 1;
    switch (tool) {
      case "get_project_context":
        used.readContext += 1;
        break;
      case "read_effort":
        used.readEffort += 1;
        break;
      case "open_session": {
        if (typeof input.sessionUuid !== "string") break;
        if (findSession(state, input.sessionUuid)) break; // an exact retry
        used.openedSession += 1;
        const session = {
          sessionUuid: input.sessionUuid,
          intent: asString(input.intent),
          branch: asString(input.branch, undefined),
          startedAt: at,
          lastActivityAt: at,
          endedAt: null,
          state: "ACTIVE",
          clientLabel: "Claude Code",
          outcome: "",
          runningSummary: "",
          followUps: [],
          daySummary: null,
          effortUuid: null,
          label,
        };
        state.sessions.push(session);
        if (typeof input.effortUuid === "string")
          bindEffort(state, input.effortUuid, session, used);
        break;
      }
      case "bind_effort": {
        const session = findSession(state, input.sessionUuid);
        if (session && typeof input.effortUuid === "string")
          bindEffort(state, input.effortUuid, session, used);
        break;
      }
      case "append_entry": {
        if (typeof input.entryUuid !== "string") break;
        if (state.entries.some((e) => e.entryUuid === input.entryUuid)) break;
        used.entries += 1;
        const session = findSession(state, input.sessionUuid);
        state.entries.push({
          entryUuid: input.entryUuid,
          entryType: asString(input.entryType, "note"),
          title: asString(input.title),
          text: asString(input.text),
          sessionUuid: asString(input.sessionUuid, null),
          authoredAt: at,
          effortUuid: session?.effortUuid ?? null,
          hasEvidence:
            Array.isArray(input.evidence) && input.evidence.length > 0,
          label,
        });
        touch(session, at);
        break;
      }
      case "open_effort": {
        if (typeof input.effortUuid !== "string") break;
        if (state.efforts.some((e) => e.uuid === input.effortUuid)) break;
        used.effortsOpened += 1;
        const session = findSession(state, input.sessionUuid);
        const title = asString(input.title, "Untitled effort");
        const effort = {
          uuid: input.effortUuid,
          title,
          intro: asString(input.intro),
          checklist: asStrings(input.plan).map((text) => ({
            text,
            checked: false,
          })),
          status: "active",
          revision: nextRevision(state),
          createdAt: at,
          updatedAt: at,
          milestones: [],
          boundSessions: [],
        };
        const startedUuid = derivedUuid(effort.uuid, "started");
        effort.milestones.push({
          uuid: startedUuid,
          summary: `Started: ${title}`,
          detail: asString(input.detail),
          entryType: "effort_opened",
          at,
          sessionUuid: asString(input.sessionUuid, null),
          todayCard: null,
        });
        state.efforts.push(effort);
        state.entries.push({
          entryUuid: startedUuid,
          entryType: "effort_opened",
          title,
          text: effort.intro,
          sessionUuid: asString(input.sessionUuid, null),
          authoredAt: at,
          effortUuid: effort.uuid,
          hasEvidence: false,
          label,
        });
        if (session) bindEffort(state, effort.uuid, session, used);
        touch(session, at);
        break;
      }
      case "record_milestone": {
        const effort = state.efforts.find((e) => e.uuid === input.effortUuid);
        if (!effort) break;
        if (
          typeof input.milestoneUuid === "string" &&
          effort.milestones.some((m) => m.uuid === input.milestoneUuid)
        )
          break;
        used.milestones += 1;
        const session = findSession(state, input.sessionUuid);
        if (session) bindEffort(state, effort.uuid, session, used);
        for (const text of asStrings(input.complete)) {
          const item = effort.checklist.find(
            (i) => i.text.trim().toLowerCase() === text.trim().toLowerCase(),
          );
          if (item) item.checked = true;
        }
        for (const text of asStrings(input.add))
          effort.checklist.push({ text, checked: false });
        if (asString(input.intro).trim()) effort.intro = input.intro;
        if (typeof input.effortStatus === "string")
          effort.status = input.effortStatus;
        effort.revision = nextRevision(state);
        effort.updatedAt = at;
        const entryType =
          input.entryType === "progress" ? "progress" : "shipped";
        const uuid = asString(
          input.milestoneUuid,
          derivedUuid(effort.uuid, `milestone-${effort.milestones.length}`),
        );
        const summary = asString(input.summary);
        const detail = asString(input.detail);
        effort.milestones.push({
          uuid,
          summary,
          detail,
          entryType,
          at,
          sessionUuid: asString(input.sessionUuid, null),
          todayCard: input.todayCard ?? null,
        });
        state.entries.push({
          entryUuid: uuid,
          entryType,
          title: summary,
          text: detail,
          sessionUuid: asString(input.sessionUuid, null),
          authoredAt: at,
          effortUuid: effort.uuid,
          hasEvidence:
            Array.isArray(input.evidence) && input.evidence.length > 0,
          label,
        });
        touch(session, at);
        break;
      }
      case "close_session": {
        const session = findSession(state, input.sessionUuid);
        if (!session || session.state === "CLOSED") break;
        used.closedSession += 1;
        Object.assign(session, {
          state: "CLOSED",
          endedAt: at,
          lastActivityAt: at,
          outcome: asString(input.outcome),
          runningSummary: asString(input.runningSummary),
          followUps: asStrings(input.followUps),
          daySummary: input.daySummary ?? null,
        });
        break;
      }
      case "update_project_state": {
        if (typeof input.brief === "string" && input.brief.trim())
          state.brief = {
            text: input.brief,
            revision: nextRevision(state),
            updatedAt: at,
          };
        if (typeof input.status === "string") state.status = input.status;
        break;
      }
      case "create_note":
      case "create_today_note":
      case "update_note_content":
      case "patch_note_content":
        used.handBuiltNotes += 1;
        break;
      default:
        break;
    }
  }
  return used;
}

// ---------------------------------------------------------------------------
// Rendering the model the way a generation 8 Recall app serves it.

function clip(text, max) {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

function entryRow(entry, { cap }) {
  const body = cap
    ? clip(entry.text, 600)
    : { text: entry.text, truncated: false };
  const row = {
    workspaceId: WORKSPACE_ID,
    entryType: entry.entryType,
    href: PROJECT_HREF,
    projectUuid: PROJECT_UUID,
    entryUuid: entry.entryUuid,
    authoredAt: entry.authoredAt,
    transport: "local_bridge",
    clientLabel: "Claude Code",
    title: cap ? entry.title.slice(0, 160) : entry.title,
    sessionUuid: entry.sessionUuid,
    actor: ACTOR,
    text: body.text,
    contentAvailable: true,
  };
  if (body.truncated) row.contentTruncated = true;
  if (entry.effortUuid) row.effortUuid = entry.effortUuid;
  if (entry.hasEvidence && cap) row.evidenceTruncated = true;
  return row;
}

function closedSessionRow(session, { cap }) {
  const outcome = cap
    ? clip(session.outcome, 320)
    : { text: session.outcome, truncated: false };
  const summary = cap
    ? clip(session.runningSummary, 320)
    : { text: session.runningSummary, truncated: false };
  const followUps = cap
    ? session.followUps.map((f) => f.slice(0, 200))
    : session.followUps;
  const row = {
    state: "CLOSED",
    workspaceId: WORKSPACE_ID,
    lastActivityAt: session.lastActivityAt,
    endedAt: session.endedAt,
    href: PROJECT_HREF,
    projectUuid: PROJECT_UUID,
    transport: "local_bridge",
    clientLabel: session.clientLabel,
    followUps,
    sessionUuid: session.sessionUuid,
    actor: ACTOR,
    startedAt: session.startedAt,
    runningSummary: summary.text,
    intent: session.intent,
    contentAvailable: true,
    outcome: outcome.text,
  };
  if (session.branch) row.branch = session.branch;
  if (outcome.truncated || summary.truncated) row.contentTruncated = true;
  return row;
}

function activeSessionRow(session) {
  const row = {
    sessionUuid: session.sessionUuid,
    state: "ACTIVE",
    intent: session.intent,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt,
    clientLabel: session.clientLabel,
    advisoryStale: true,
  };
  if (session.branch) row.branch = session.branch;
  return row;
}

function effortSummaryRow(effort) {
  const last = effort.milestones[effort.milestones.length - 1];
  return {
    status: effort.status,
    lastMilestoneSummary: last ? last.summary : null,
    lastMilestoneAt: last ? last.at : null,
    title: effort.title,
    uuid: effort.uuid,
    href: noteHref(effort.uuid),
    updatedAt: effort.updatedAt,
    checklist: {
      total: effort.checklist.length,
      checked: effort.checklist.filter((i) => i.checked).length,
    },
    activeSessionCount: 0,
  };
}

function effortDetail(state, effort) {
  const milestones = [...effort.milestones].sort((a, b) => b.at - a.at);
  const lastSession = state.sessions
    .filter(
      (s) =>
        s.state === "CLOSED" && effort.boundSessions.includes(s.sessionUuid),
    )
    .sort((a, b) => b.endedAt - a.endedAt)[0];
  const detail = {
    uuid: effort.uuid,
    title: effort.title,
    intro: effort.intro,
    checklist: effort.checklist.map((i) => ({
      checked: i.checked,
      text: i.text,
    })),
    revision: effort.revision,
    milestoneCount: effort.milestones.length,
    status: effort.status,
    href: noteHref(effort.uuid),
    lastMilestoneSummary: milestones[0] ? milestones[0].summary : null,
    recentMilestones: milestones.slice(0, 5).map((m) => ({
      summary: m.summary,
      entryUuid: m.uuid,
      at: m.at,
      sessionUuid: m.sessionUuid,
      contentAvailable: true,
      contentTruncated: m.detail.length > 600,
    })),
  };
  if (lastSession) {
    detail.lastSession = {
      clientLabel: lastSession.clientLabel,
      outcome: lastSession.outcome,
      contentAvailable: true,
      followUps: lastSession.followUps,
      endedAt: lastSession.endedAt,
      sessionUuid: lastSession.sessionUuid,
    };
  }
  detail.history = {
    complete: false,
    listTimeline: {
      effortUuid: effort.uuid,
      projectUuid: PROJECT_UUID,
      workspaceId: WORKSPACE_ID,
    },
    readNote: { uuid: effort.uuid, format: "markdown", noteType: "NamedNote" },
    ...(lastSession
      ? {
          readLastSession: {
            workspaceId: WORKSPACE_ID,
            projectUuid: PROJECT_UUID,
            sessionUuid: lastSession.sessionUuid,
          },
        }
      : {}),
  };
  detail.pendingMilestones = { hasMore: false, items: [], nextCursor: null };
  return detail;
}

function renderContext(state) {
  const entryLimit = 6;
  const noteLimit = 2;
  const newestFirst = [...state.entries].sort(
    (a, b) => b.authoredAt - a.authoredAt,
  );
  const ordered = [
    ...newestFirst.filter((e) => PRIORITY_ENTRY_TYPES.has(e.entryType)),
    ...newestFirst.filter((e) => !PRIORITY_ENTRY_TYPES.has(e.entryType)),
  ];
  const entries = ordered
    .slice(0, entryLimit)
    .map((e) => entryRow(e, { cap: true }));
  const closed = state.sessions
    .filter((s) => s.state === "CLOSED")
    .sort((a, b) => b.endedAt - a.endedAt);
  const closedRows = closed
    .slice(0, 3)
    .map((s) => closedSessionRow(s, { cap: true }));
  const active = state.sessions
    .filter((s) => s.state === "ACTIVE")
    .sort((a, b) => b.startedAt - a.startedAt);
  const activeRows = active.slice(0, 5).map(activeSessionRow);
  const liveEfforts = [
    ...state.efforts.filter((e) => e.status === "active"),
    ...state.efforts.filter((e) => e.status === "paused"),
  ];
  const effortRows = liveEfforts.slice(0, 8).map(effortSummaryRow);
  const notes = [...state.efforts]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, noteLimit)
    .map((e) => ({
      title: e.title,
      href: noteHref(e.uuid),
      tagsTruncated: false,
      updatedAt: e.updatedAt,
      titleTruncated: false,
      timelineAt: e.updatedAt,
      tags: [],
      uuid: e.uuid,
    }));
  const unavailableScalar = {
    includedCount: 0,
    value: null,
    count: 0,
    truncated: false,
    available: false,
    nextCursor: null,
  };
  return {
    sessions: {
      available: true,
      includedCount: activeRows.length,
      count: active.length,
      truncated: active.length > activeRows.length,
      items: activeRows,
      nextCursor: null,
    },
    entries: {
      truncated: state.entries.length > entries.length,
      includedCount: entries.length,
      count: state.entries.length,
      items: entries,
      available: true,
      nextCursor: null,
    },
    status: state.status
      ? {
          includedCount: 1,
          value: state.status,
          count: 1,
          truncated: false,
          available: true,
          nextCursor: null,
        }
      : unavailableScalar,
    since: null,
    repositoryBindings: {
      linked: false,
      nextCursor: null,
      truncated: false,
      available: true,
      includedCount: 0,
      count: 0,
      items: [],
    },
    closedSessions: {
      items: closedRows,
      nextCursor: null,
      count: closed.length,
      truncated: closed.length > closedRows.length,
      available: true,
      includedCount: closedRows.length,
    },
    activity: {
      cursorSupported: true,
      includedCount: 0,
      count: 0,
      coverage: null,
      newestScannedAt: null,
      nextCursor: null,
      scannedCount: 0,
      unavailableCount: 0,
      mode: "summary",
      hasMore: false,
      summary: null,
      truncated: false,
      available: false,
      items: [],
      oldestScannedAt: null,
    },
    capabilities: {
      acp: false,
      activityDeltas: true,
      sessions: true,
      handoffs: true,
      efforts: true,
      asks: true,
      entries: true,
    },
    profile: "journal",
    recentNotes: {
      available: true,
      nextCursor: null,
      items: notes,
      truncated: state.efforts.length > notes.length,
      count: state.efforts.length,
      includedCount: notes.length,
    },
    handoffs: {
      available: true,
      nextCursor: null,
      items: [],
      count: 0,
      truncated: false,
      includedCount: 0,
    },
    brief: state.brief
      ? {
          includedCount: 1,
          count: 1,
          truncated: false,
          available: true,
          nextCursor: null,
          value: {
            href: noteHref(BRIEF_UUID),
            noteUuid: BRIEF_UUID,
            revision: state.brief.revision,
            text: state.brief.text,
            title: `${PROJECT_NAME} Brief`,
          },
        }
      : unavailableScalar,
    efforts: {
      available: true,
      includedCount: effortRows.length,
      items: effortRows,
      count: liveEfforts.length,
      truncated: liveEfforts.length > effortRows.length,
      nextCursor: null,
    },
    asks: {
      nextCursor: null,
      count: 0,
      items: [],
      truncated: false,
      available: true,
      includedCount: 0,
    },
    project: {
      nameTruncated: false,
      id: PROJECT_UUID,
      workspaceId: WORKSPACE_ID,
      href: PROJECT_HREF,
      name: PROJECT_NAME,
    },
  };
}

function renderServerMock(state, nowMs) {
  const efforts = state.efforts.map((e) => {
    const { history, pendingMilestones, ...detail } = effortDetail(state, e);
    return detail;
  });
  const activeRows = state.sessions
    .filter((s) => s.state === "ACTIVE")
    .map(activeSessionRow);
  const json = (value) => JSON.stringify(value, null, 1);
  return `---
type: agent
tools:
  - open_session
  - open_effort
  - bind_effort
  - record_milestone
  - read_effort
abort_when: |
  - The agent calls one of these tools with a workspaceId other than ${WORKSPACE_ID} or a projectUuid other than ${PROJECT_UUID}.
  - The agent opens a second session in this run while one it opened is still ACTIVE. An exact replay with the same sessionUuid and idempotencyKey is a retry, not a second session.
---

# Fake Recall server: sessions and efforts

You stand in for Recall's local MCP server (\`recall-local\` 1.0.2, transport \`local_bridge\`) for the five tools listed above. Every other tool is answered from static files you never see. Return JSON only, in exactly the shapes below, and nothing else.

Rules:

- Never invent ids. Echo the caller's \`workspaceId\`, \`projectUuid\`, \`sessionUuid\`, \`effortUuid\`, \`milestoneUuid\` and \`idempotencyKey\` exactly.
- Timestamps are milliseconds since the epoch, at or after ${nowMs}, increasing with each call.
- \`href\` values are absolute: the Project is \`${PROJECT_HREF}\` and a note is \`https://recall.nerdout.com/notes/all?workspace=${WORKSPACE_ID}&note=<uuid>\`.
- An exact retry of an earlier call in this run returns the original result (\`"applied": "already_applied"\` for efforts and milestones).
- A call missing a required parameter, or with a malformed one, fails with \`{"error":{"code":-32602,"message":"<tool>: <what is wrong>"}}\` and changes nothing.
- This run is a fresh conversation: no earlier session shares its lineageKey, so \`open_session\` never returns \`previousSession\` and always returns \`"sessionContinuityAvailable": true\`.

## What the server remembers at the start of this run

Efforts on this Project (uuid, title, current intro, exact checklist, revision, milestone count, newest milestones first, and the last CLOSED session bound to each):

\`\`\`json
${json(efforts)}
\`\`\`

Other ACTIVE sessions on the Project, served as advisory summary rows in \`open_session.otherActiveSessions\`:

\`\`\`json
${json(activeRows)}
\`\`\`

Changes made by calls earlier in this run (a new effort, a ticked checklist item, a new milestone, a new intro or status) are visible to every later call in this run.

## Shapes

An **effort object** is \`{"uuid","title","intro","checklist":[{"checked":bool,"text"}],"revision","milestoneCount","status","href","lastMilestoneSummary","recentMilestones":[{"summary","entryUuid","at","sessionUuid","contentAvailable":true,"contentTruncated":bool}],"lastSession"?:{"clientLabel","outcome","contentAvailable":true,"followUps":[],"endedAt","sessionUuid"}}\`. An **effort detail** is the effort object plus \`"history":{"complete":false,"listTimeline":{"effortUuid","projectUuid","workspaceId"},"readNote":{"uuid","format":"markdown","noteType":"NamedNote"},"readLastSession"?:{"workspaceId","projectUuid","sessionUuid"}}\` and \`"pendingMilestones":{"hasMore":false,"items":[],"nextCursor":null}\`. An **entry row** is \`{"workspaceId","entryType","href","projectUuid","entryUuid","authoredAt","transport":"local_bridge","clientLabel":"Claude Code","title","sessionUuid","actor":{"type":"user","userId":"usr-eval"},"text","contentAvailable":true,"effortUuid"}\`.

### open_session

\`{"idempotencyKey":<echo>,"session":{"state":"ACTIVE","workspaceId":<echo>,"projectUuid":<echo>,"sessionUuid":<echo>,"intent":<echo>,"branch":<echo, omit when absent>,"startedAt":<now>,"lastActivityAt":<now>,"href":"${PROJECT_HREF}","clientLabel":"Claude Code","transport":"local_bridge","actor":{"type":"user","userId":"usr-eval"},"outcome":"","runningSummary":"","followUps":[],"contentAvailable":true},"syncStatus":"synced","sessionContinuityAvailable":true,"otherActiveSessions":<the rows above>}\`

When the call carries \`effortUuid\` naming a stored effort, add \`"effort": <that effort object>\` (the cross-agent hand-off) and remember that this session is bound to it. An unknown \`effortUuid\` is an error: \`open_session: effort not found\`.

### open_effort

Store a new effort from the call: \`uuid\` = effortUuid, \`title\`, \`intro\`, \`checklist\` = every \`plan\` item unchecked, \`status\` = \`"active"\`, a new \`revision\`, one milestone \`Started: <title>\` whose detail is the call's \`detail\`, \`milestoneCount\` 1, and the calling session bound. An ACTIVE stored effort with the same title is refused: \`open_effort: an active effort with this title already exists; continue it instead\`. Return:

\`{"applied":"applied","effort":<the new effort object>,"entry":<entry row, entryType "effort_opened", title = title, text = intro>,"entrySyncStatus":"synced","idempotencyKey":<echo>,"noteSyncStatus":"synced","sessionBinding":{"status":"bound"},"todayCard":{"href":<note href of a new uuid>,"status":"created","syncStatus":"synced","uuid":<that uuid>}}\`

### bind_effort

\`{"contextStatus":"available","effort":<effort detail>,"sessionBinding":{"status":"bound"}}\`, with \`"already_bound"\` when this session already bound that effort. Unknown effort: \`bind_effort: this effort is not readable.\`

### record_milestone

Apply the call to the stored effort in this order, then answer with the updated state:

1. If \`expectedRevision\` is present and is not the effort's current \`revision\`: fail with \`record_milestone: revision conflict; reread the effort\` and change nothing.
2. Tick every \`complete\` item whose current text matches case-insensitively. An item that matches nothing is refused: fail naming it and change nothing.
3. Append each \`add\` item to the checklist, unchecked.
4. Replace the intro when \`intro\` is given; set \`status\` when \`effortStatus\` is given.
5. Append a milestone: \`summary\`, \`detail\`, entry type \`entryType\` or \`"shipped"\`; \`milestoneCount\` + 1; a new \`revision\`; \`lastMilestoneSummary\` = summary; bind the calling session.

Return \`{"applied":"applied","effort":<updated effort object>,"entry":<entry row with entryUuid = milestoneUuid, entryType, title = summary, text = detail>,"entrySyncStatus":"synced","idempotencyKey":<echo>,"noteSyncStatus":"synced","recovery":{"idempotencyKey":<echo>,"status":"complete"},"sessionBinding":{"status":"bound"}}\`, plus \`"todayCard":{"href":<note href of a new uuid>,"status":"created","syncStatus":"synced","uuid":<that uuid>}\` exactly when the call carried \`todayCard\`. An unknown \`effortUuid\` fails: \`record_milestone: effort not found\`.

### read_effort

The current effort detail for that uuid, reflecting every change made earlier in this run. Unknown uuid: \`read_effort: effort not found\`.
`;
}

function renderCaseMocks(state, caseDir, nowMs) {
  const mockDir = path.join(caseDir, "mocks", "recall");
  const fixtureDir = path.join(mockDir, "fixtures");
  fs.mkdirSync(fixtureDir, { recursive: true });
  const write = (name, value) =>
    fs.writeFileSync(
      path.join(mockDir, name),
      typeof value === "string" ? value : JSON.stringify(value, null, 1) + "\n",
    );
  const context = renderContext(state);
  write("get_project_context.md", context);
  write("list_efforts.md", {
    efforts: state.efforts.map(effortSummaryRow),
    hasMore: false,
    nextCursor: null,
  });
  const sessionsNewestFirst = [...state.sessions].sort(
    (a, b) => b.startedAt - a.startedAt,
  );
  write("list_sessions.md", {
    sessions: sessionsNewestFirst.map((s) =>
      s.state === "CLOSED"
        ? closedSessionRow(s, { cap: true })
        : activeSessionRow(s),
    ),
    hasMore: false,
    nextCursor: null,
  });
  for (const entry of state.entries)
    fs.writeFileSync(
      path.join(fixtureDir, `entry-${entry.entryUuid}.json`),
      JSON.stringify(entryRow(entry, { cap: false }), null, 1) + "\n",
    );
  for (const session of state.sessions.filter((s) => s.state === "CLOSED"))
    fs.writeFileSync(
      path.join(fixtureDir, `session-${session.sessionUuid}.json`),
      JSON.stringify(closedSessionRow(session, { cap: false }), null, 1) + "\n",
    );
  write("read_entry.md", "{{file:fixtures/entry-{input.entryUuid}.json}}\n");
  write(
    "read_session.md",
    "{{file:fixtures/session-{input.sessionUuid}.json}}\n",
  );
  write("_server.md", renderServerMock(state, nowMs));
  return context;
}

// ---------------------------------------------------------------------------
// Reading a finished run back.

function readTrace(tracePath) {
  const calls = [];
  const byId = new Map();
  let lastText = "";
  let lastAt = 0;
  for (const line of fs.readFileSync(tracePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = event.timestamp ? Date.parse(event.timestamp) : NaN;
    if (Number.isFinite(at)) lastAt = at;
    if (event.type === "assistant") {
      for (const block of event.message?.content ?? []) {
        if (block.type === "tool_use") {
          const call = {
            id: block.id,
            name: block.name,
            input: block.input ?? {},
            at: lastAt,
            result: null,
          };
          calls.push(call);
          byId.set(block.id, call);
        } else if (block.type === "text" && block.text) {
          lastText = block.text;
        }
      }
    } else if (event.type === "user" && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block.type !== "tool_result") continue;
        const call = byId.get(block.tool_use_id);
        if (call)
          call.result =
            typeof block.content === "string"
              ? block.content
              : JSON.stringify(block.content);
      }
    }
  }
  return { calls, lastText };
}

function sandboxOf(tracePath) {
  return path.dirname(path.dirname(tracePath));
}

function unseal(sandbox) {
  for (const dir of [sandbox, path.join(sandbox, "sealed")]) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* already open or gone */
    }
  }
}

function readWorkspaceFile(sandbox, name) {
  for (const cwd of [
    path.join(sandbox, "sealed", "home", "cwd"),
    path.join(sandbox, "home", "cwd"),
  ]) {
    try {
      return fs.readFileSync(path.join(cwd, name), "utf8");
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

function removeSandbox(sandbox) {
  try {
    execFileSync("chmod", ["-R", "u+rwx", sandbox], { stdio: "ignore" });
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch (error) {
    console.warn(`  could not remove ${sandbox}: ${error.message}`);
  }
}

function parsePr(markdown) {
  if (!markdown) return null;
  const lines = markdown.split("\n");
  const headingIndex = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (headingIndex >= 0) {
    return {
      title: lines[headingIndex].replace(/^#\s+/, "").trim(),
      body: lines
        .slice(headingIndex + 1)
        .join("\n")
        .trim(),
    };
  }
  const first = lines.find((l) => l.trim());
  return {
    title: (first ?? "Untitled PR").trim(),
    body: lines
      .slice(lines.indexOf(first) + 1)
      .join("\n")
      .trim(),
  };
}

function summarizeRun(run) {
  if (!run) return null;
  return {
    score: run.score ?? null,
    passed: run.passed ?? null,
    turns: run.turns ?? null,
    costUsd: run.costUsd ?? 0,
    judgeCostUsd: run.judgeCostUsd ?? 0,
    durationSeconds: run.durationSeconds ?? null,
    error: run.error ?? null,
    aborted: run.aborted ?? null,
    skippedPaidGraders: run.skippedPaidGraders ?? false,
    graders: (run.graders ?? []).map((g) => ({
      name: g.name,
      passed: g.passed,
      scored: g.scored,
      explanation: g.explanation,
    })),
  };
}

function collectArm(run, { keepTemp, applyTo, label }) {
  const summary = summarizeRun(run);
  if (!summary) return { summary: null, files: {}, used: null, calls: [] };
  const files = {};
  let used = null;
  let calls = [];
  if (run.tracePath && fs.existsSync(run.tracePath)) {
    const sandbox = sandboxOf(run.tracePath);
    unseal(sandbox);
    files.importer = readWorkspaceFile(sandbox, "importer.py");
    files.pr = readWorkspaceFile(sandbox, "PR.md");
    const trace = readTrace(run.tracePath);
    calls = trace.calls;
    files.lastMessage = trace.lastText;
    if (applyTo) used = applyJournalWrites(applyTo, trace.calls, label);
    if (!keepTemp) removeSandbox(sandbox);
    else summary.sandbox = sandbox;
  }
  return {
    summary,
    files,
    used,
    calls: calls
      .filter((c) => c.name.startsWith(TOOL_PREFIX))
      .map((c) => ({
        tool: c.name.slice(TOOL_PREFIX.length),
        input: c.input,
        at: c.at,
      })),
  };
}

// ---------------------------------------------------------------------------
// Driving claude plugin eval.

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
}

function prepareWorkDir() {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  copyDir(path.join(templateDir, "mocks"), path.join(workDir, "mocks"));
}

function prepareCase(index, { state, history, code, nowMs, variant }) {
  const session = SESSIONS[index];
  const caseDir = path.join(workDir, session.name);
  fs.rmSync(caseDir, { recursive: true, force: true });
  copyDir(path.join(templateDir, session.name), caseDir);
  fs.copyFileSync(
    path.join(templateDir, "scaffold.sh"),
    path.join(caseDir, "scaffold.sh"),
  );
  const prompt = renderPrompt(index, history, code, { variant });
  fs.writeFileSync(path.join(caseDir, "prompt.md"), prompt);
  const context = renderCaseMocks(state, caseDir, nowMs);
  return { caseDir, prompt, context };
}

function runEval({ caseName, outDir, jsonPath, opts }) {
  const args = [
    "plugin",
    "eval",
    pluginDir,
    "--eval-dir",
    WORK_DIR_NAME,
    "--case",
    caseName,
    "--runs",
    "1",
    "--scaffold",
    "--keep-temp",
    "--allow-tools",
    "Write",
    "--judge-model",
    opts.judgeModel,
    "-j",
    String(opts.concurrency),
    "--no-publish",
    "--trust-plugin",
    "--threshold",
    "0",
    "--max-cost-usd",
    String(opts.maxCostPerRun),
    "--output-dir",
    outDir,
    "--json",
    jsonPath,
  ];
  if (opts.model) args.push("--model", opts.model);
  const started = Date.now();
  const result = spawnSync("claude", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
    seconds: Math.round((Date.now() - started) / 1000),
    args,
  };
}

const fmt = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? "  -  "
    : n.toFixed(2).padStart(5);
const fmtDelta = (n) =>
  n === null || n === undefined || Number.isNaN(n)
    ? "  -  "
    : `${n >= 0 ? "+" : ""}${n.toFixed(2)}`.padStart(5);

function journalNote(used) {
  if (!used) return "no trace";
  const bits = [];
  bits.push(used.openedSession ? "session" : "no session");
  if (used.readContext) bits.push("read context");
  if (used.effortsOpened) bits.push("opened effort");
  else if (used.effortsBound) bits.push("bound effort");
  if (used.readEffort) bits.push("read effort");
  if (used.entries)
    bits.push(`${used.entries} entr${used.entries === 1 ? "y" : "ies"}`);
  if (used.milestones)
    bits.push(
      `${used.milestones} milestone${used.milestones === 1 ? "" : "s"}`,
    );
  bits.push(used.closedSession ? "closed" : "not closed");
  if (used.handBuiltNotes)
    bits.push(`${used.handBuiltNotes} hand-built note(s)`);
  return bits.join(", ");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  WORK_DIR_NAME = `evals-stack-work-${opts.variant}`;
  workDir = path.join(pluginDir, WORK_DIR_NAME);
  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const outRoot =
    opts.out ?? path.join(templateDir, "results", `${stamp}-${opts.variant}`);
  fs.mkdirSync(outRoot, { recursive: true });
  const report = {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    options: { ...opts },
    chains: [],
    summary: null,
    partial: false,
  };

  console.log(
    `stack eval (${opts.variant} variant): ${opts.chains} chain(s) × ${opts.sessions} session(s) → ${outRoot}`,
  );

  for (let chainIndex = 0; chainIndex < opts.chains; chainIndex++) {
    const chainDir = path.join(outRoot, `chain-${chainIndex + 1}`);
    fs.mkdirSync(chainDir, { recursive: true });
    const chain = {
      index: chainIndex + 1,
      sessions: [],
      costUsd: 0,
      seconds: 0,
      stoppedEarly: null,
    };
    report.chains.push(chain);
    const state = freshState();
    const history = [];
    let code = CODE[0];
    let prsDone = 0;
    prepareWorkDir();
    console.log(
      `\nCHAIN ${chain.index}${" ".repeat(24)}WITH  W/OUT   Δ     JOURNAL (with-plugin arm)`,
    );

    for (let index = 0; index < opts.sessions; index++) {
      const session = SESSIONS[index];
      const nowMs = Date.now();
      const { caseDir, prompt, context } = prepareCase(index, {
        state,
        history,
        code,
        nowMs,
        variant: opts.variant,
      });
      const sessionDir = path.join(chainDir, session.name);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, "prompt.md"), prompt);
      fs.writeFileSync(
        path.join(sessionDir, "context-served.json"),
        JSON.stringify(context, null, 1) + "\n",
      );
      fs.writeFileSync(
        path.join(sessionDir, "state-before.json"),
        JSON.stringify(state, null, 1) + "\n",
      );

      if (opts.dryRun) {
        console.log(`  rendered ${session.name} → ${caseDir}`);
        console.log(
          `  (dry run) prompt and mocks written; run: claude plugin eval plugins/recall --eval-dir ${WORK_DIR_NAME} --case ${session.name} --scaffold --allow-tools Write --judge-model ${opts.judgeModel} --runs 1 --no-publish`,
        );
        return;
      }

      if (chain.costUsd >= opts.budget) {
        chain.stoppedEarly = `budget of $${opts.budget} reached before ${session.name}`;
        report.partial = true;
        console.log(`  ${chain.stoppedEarly}`);
        break;
      }

      const jsonPath = path.join(sessionDir, "eval.json");
      const evalOutDir = path.join(sessionDir, "eval-output");
      const run = runEval({
        caseName: session.name,
        outDir: evalOutDir,
        jsonPath,
        opts,
      });
      fs.writeFileSync(path.join(sessionDir, "eval-stderr.txt"), run.stderr);
      if (!fs.existsSync(jsonPath)) {
        chain.stoppedEarly = `claude plugin eval produced no result for ${session.name} (exit ${run.status})`;
        report.partial = true;
        console.log(
          `  ${chain.stoppedEarly}\n${run.stderr.split("\n").slice(-8).join("\n")}`,
        );
        break;
      }
      const evalResult = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      const caseResult =
        evalResult.cases?.find((c) => c.name === session.name) ??
        evalResult.cases?.[0];
      const withRun = caseResult?.arms?.with?.[0] ?? null;
      const withoutRun = caseResult?.arms?.without?.[0] ?? null;

      const withArm = collectArm(withRun, {
        keepTemp: opts.keepTemp,
        applyTo: state,
        label: session.name,
      });
      const withoutArm = collectArm(withoutRun, {
        keepTemp: opts.keepTemp,
        applyTo: null,
        label: session.name,
      });
      const costUsd = evalResult.costUsd ?? 0;
      chain.costUsd += costUsd;
      chain.seconds += run.seconds;

      const withScore = withArm.summary?.score ?? null;
      const withoutScore = withoutArm.summary?.score ?? null;
      const delta =
        withScore !== null && withoutScore !== null
          ? withScore - withoutScore
          : null;
      const record = {
        name: session.name,
        kind: session.kind,
        planItem: session.planItem ?? null,
        index,
        with: withArm.summary,
        without: withoutArm.summary,
        delta,
        costUsd,
        seconds: run.seconds,
        evalPartial: evalResult.partial ?? false,
        evalPartialReason: evalResult.partialReason ?? null,
        exitStatus: run.status,
        journal: withArm.used,
        journalCalls: withArm.calls,
        files: { with: withArm.files, without: withoutArm.files },
        codeSource: null,
      };
      chain.sessions.push(record);

      // What the next session inherits from git: after a PR session, the
      // with-plugin session's code and PR description, or the scenario's
      // fallback when it left none. A spike session lands nothing in git.
      if (session.kind === "pr") {
        const wrote =
          withArm.files.importer &&
          /def import_rows/.test(withArm.files.importer);
        code = wrote ? withArm.files.importer : (CODE[prsDone + 1] ?? code);
        record.codeSource = wrote ? "with-plugin session" : "scenario fallback";
        const pr = parsePr(withArm.files.pr) ?? {
          title: PLAN[session.planItem - 1],
          body: "",
        };
        prsDone += 1;
        history.push({ number: prsDone, title: pr.title, body: pr.body });
      } else {
        record.codeSource = "unchanged (no PR this session)";
      }

      fs.writeFileSync(
        path.join(sessionDir, "session.json"),
        JSON.stringify(record, null, 1) + "\n",
      );
      fs.writeFileSync(
        path.join(sessionDir, "state-after.json"),
        JSON.stringify(state, null, 1) + "\n",
      );
      if (withArm.files.importer)
        fs.writeFileSync(
          path.join(sessionDir, "importer.with.py"),
          withArm.files.importer,
        );
      if (withoutArm.files.importer)
        fs.writeFileSync(
          path.join(sessionDir, "importer.without.py"),
          withoutArm.files.importer,
        );
      if (withArm.files.pr)
        fs.writeFileSync(path.join(sessionDir, "PR.with.md"), withArm.files.pr);
      if (withoutArm.files.pr)
        fs.writeFileSync(
          path.join(sessionDir, "PR.without.md"),
          withoutArm.files.pr,
        );

      const notes = [];
      if (withArm.summary?.error) notes.push(`with: ${withArm.summary.error}`);
      if (withArm.summary?.aborted)
        notes.push(`with aborted: ${withArm.summary.aborted.reason ?? "?"}`);
      if (withoutArm.summary?.error)
        notes.push(`without: ${withoutArm.summary.error}`);
      if (evalResult.partial)
        notes.push(`partial (${evalResult.partialReason})`);
      console.log(
        `  ${session.name.padEnd(28)} ${fmt(withScore)} ${fmt(withoutScore)} ${fmtDelta(delta)}  ${journalNote(withArm.used)}  $${costUsd.toFixed(2)} ${run.seconds}s${notes.length ? "  ⚠ " + notes.join("; ") : ""}`,
      );
      fs.writeFileSync(
        path.join(outRoot, "stack-result.json"),
        JSON.stringify(report, null, 1) + "\n",
      );
    }
  }

  // Aggregate across chains: mean scores per session, and the mean delta over
  // the sessions that had history to read (every session after the first).
  const perSession = SESSIONS.slice(0, opts.sessions).map((session, index) => {
    const rows = report.chains.map((c) => c.sessions[index]).filter(Boolean);
    const mean = (values) =>
      values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return {
      name: session.name,
      chains: rows.length,
      with: mean(
        rows.map((r) => r.with?.score).filter((v) => typeof v === "number"),
      ),
      without: mean(
        rows.map((r) => r.without?.score).filter((v) => typeof v === "number"),
      ),
      delta: mean(
        rows.map((r) => r.delta).filter((v) => typeof v === "number"),
      ),
      journaled: rows.filter((r) => r.journal?.openedSession).length,
      closed: rows.filter((r) => r.journal?.closedSession).length,
      usedEffort: rows.filter(
        (r) => r.journal && (r.journal.effortsOpened || r.journal.effortsBound),
      ).length,
    };
  });
  const withHistory = perSession
    .slice(1)
    .map((s) => s.delta)
    .filter((v) => typeof v === "number");
  const totalCost = report.chains.reduce((a, c) => a + c.costUsd, 0);
  const totalSeconds = report.chains.reduce((a, c) => a + c.seconds, 0);
  report.summary = {
    perSession,
    meanDeltaWithHistory: withHistory.length
      ? withHistory.reduce((a, b) => a + b, 0) / withHistory.length
      : null,
    meanDeltaAll: (() => {
      const all = perSession
        .map((s) => s.delta)
        .filter((v) => typeof v === "number");
      return all.length ? all.reduce((a, b) => a + b, 0) / all.length : null;
    })(),
    costUsd: totalCost,
    seconds: totalSeconds,
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(outRoot, "stack-result.json"),
    JSON.stringify(report, null, 1) + "\n",
  );

  if (report.chains.length > 1) {
    console.log(
      `\nMEAN OVER ${report.chains.length} CHAINS${" ".repeat(11)}WITH  W/OUT   Δ     JOURNALED`,
    );
    for (const s of perSession)
      console.log(
        `  ${s.name.padEnd(28)} ${fmt(s.with)} ${fmt(s.without)} ${fmtDelta(s.delta)}  ${s.journaled}/${s.chains} sessions, ${s.usedEffort}/${s.chains} used an effort`,
      );
  }
  console.log(
    `\nmean Δ over sessions with history: ${fmtDelta(report.summary.meanDeltaWithHistory).trim()} · mean Δ over all sessions: ${fmtDelta(report.summary.meanDeltaAll).trim()} · $${totalCost.toFixed(2)} · ${Math.round(totalSeconds / 60)}m`,
  );
  console.log(`result: ${path.join(outRoot, "stack-result.json")}`);
  if (report.partial) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
