import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { agentRequestContext } from "../plugins/recall/hooks/agent-request-context.mjs";

// The plugin keeps the manual generation-9 inbox contract while the Recall app
// adds optional automatic replies. These cases pin what an installed plugin
// does when the app is older or newer than it, without any new tool, bridge
// change, or network: the fixtures are static copies of the advertised tool
// schemas and of results the app returns.
const repositoryRoot = new URL("../", import.meta.url);
const fixtureRoot = new URL("fixtures/agent-request-compat/", import.meta.url);

const read = (url) => fs.readFileSync(url, "utf8");
const readJson = (url) => JSON.parse(read(url));
const flat = (text) => text.replaceAll(/\s+/g, " ");

const generation8 = readJson(new URL("fixtures/recall-catalog/generation-8.json", import.meta.url));
const inboxTools = readJson(new URL("generation-9-inbox-tools.json", fixtureRoot));
const managedList = readJson(new URL("list-agent-requests-managed.json", fixtureRoot));
const claimResults = readJson(new URL("claim-results.json", fixtureRoot));
const reference = flat(read(new URL("plugins/recall/skills/recall/references/agent-requests.md", repositoryRoot)));

const requiredInboxTools = [
  "list_agent_requests",
  "claim_agent_request",
  "resolve_agent_request",
  "read_comment_thread",
  "reply_comment",
];
const requestRowKeys = [
  "commentUuid",
  "createdAt",
  "parent",
  "requestUuid",
  "status",
  "targetAgentKind",
  "threadUuid",
  "updatedAt",
  "workspaceId",
];
const statuses = ["OPEN", "PICKED_UP", "RESOLVED", "DISMISSED"];

/** A generation-9 app advertises the inbox beside the generation-8 tools. */
function generation9Catalog() {
  return { catalogVersion: 9, tools: [...generation8.tools, ...inboxTools.tools] };
}

/** The gate the reference teaches: every tool must be advertised; nothing substitutes. */
function inboxAvailability(catalog) {
  const names = new Set(catalog.tools.map((tool) => tool.name));
  const missing = requiredInboxTools.filter((name) => !names.has(name));
  return { available: missing.length === 0, missing };
}

/** Reference reading of one list row: only the four-value status decides. */
function interpretRow(row) {
  if (row.status === "OPEN") return { queued: true, claimable: true };
  if (row.status === "PICKED_UP") return { queued: true, claimable: false };
  return { queued: false, claimable: false };
}

/** Reference reading of a claim receipt: applied or information, never a retry loop. */
function interpretClaim(result) {
  if (result.applied === true) return { proceed: true, replayed: result.replayed === true };
  return {
    currentStatus: result.currentStatus ?? null,
    proceed: false,
    reason: result.reason,
    retry: false,
    rotateClaimUuid: false,
  };
}

test("old app, new plugin: a generation-8 catalog advertises no inbox and the plugin skips it", () => {
  const availability = inboxAvailability(generation8);
  assert.equal(availability.available, false);
  // The comment tools alone do not make an inbox; the three request tools are absent.
  assert.deepEqual(availability.missing, ["list_agent_requests", "claim_agent_request", "resolve_agent_request"]);
  for (const host of ["claude-code", "codex"]) {
    const text = agentRequestContext({ hook_event_name: "SessionStart", source: "startup" }, host)
      .hookSpecificOutput.additionalContext;
    assert.match(text, /if list_workspaces and list_agent_requests are callable/);
    assert.match(text, /If tools are absent, skip; never change journal configuration\./);
  }
  assert.match(reference, /Missing support means unavailable on this connection; never substitute `list_asks`/);
});

test("new app, old plugin: managed-reply list rows keep the generation-9 row shape", () => {
  const catalog = generation9Catalog();
  assert.equal(inboxAvailability(catalog).available, true);
  const list = catalog.tools.find((tool) => tool.name === "list_agent_requests");
  assert.deepEqual(list.inputSchema.properties.status.enum, statuses);
  assert.deepEqual(Object.keys(list.inputSchema.properties).sort(), [
    "cursor",
    "limit",
    "projectUuid",
    "status",
    "targetAgentKind",
    "workspaceId",
  ]);
  const claim = catalog.tools.find((tool) => tool.name === "claim_agent_request");
  assert.deepEqual(claim.inputSchema.required, ["workspaceId", "requestUuid", "claimUuid"]);

  const rows = [...managedList.open.requests, ...managedList.pickedUp.requests];
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const key of requestRowKeys) assert.ok(Object.hasOwn(row, key), `${row.requestUuid} lacks ${key}`);
    // The only addition is an optional, read-only scheduling reason.
    const extra = Object.keys(row).filter((key) => !requestRowKeys.includes(key) && key !== "projectUuid");
    assert.ok(extra.every((key) => key === "schedulingReason"), `${row.requestUuid}: ${extra.join(", ")}`);
    assert.ok(statuses.includes(row.status), row.status);
    // No lease, mode, claim, or attempt identity ever reaches the plugin.
    for (const hidden of ["handlingMode", "leaseExpiresAt", "claimUuid", "attemptUuid", "fence"]) {
      assert.equal(Object.hasOwn(row, hidden), false, `${row.requestUuid} exposes ${hidden}`);
    }
  }
  // The projection puts an expired automatic lease on the OPEN page and a live one on PICKED_UP.
  assert.ok(managedList.open.requests.every((row) => row.status === "OPEN"));
  assert.ok(managedList.pickedUp.requests.every((row) => row.status === "PICKED_UP"));
  for (const row of managedList.open.requests) assert.deepEqual(interpretRow(row), { claimable: true, queued: true });
  for (const row of managedList.pickedUp.requests) assert.deepEqual(interpretRow(row), { claimable: false, queued: true });
  // A live automatic attempt and a manual claim look the same in the list.
  const [automatic, manual] = managedList.pickedUp.requests;
  assert.deepEqual(Object.keys(automatic).sort(), Object.keys(manual).sort());
  assert.match(reference, /A `PICKED_UP` request is claimed and unresolved: a manual claim or a live automatic attempt\./);
  assert.match(reference, /do not infer who claimed it, that a model is replying, or that it is stuck/);
});

test("manual pickup after failed automation: an OPEN request with a scheduling reason is claimable", () => {
  const interrupted = managedList.open.requests.filter((row) => typeof row.schedulingReason === "string");
  assert.deepEqual(
    interrupted.map((row) => row.schedulingReason),
    ["transient_failure", "paused_by_user", "retry_budget_exhausted", "source_changed"],
  );
  for (const row of interrupted) assert.deepEqual(interpretRow(row), { claimable: true, queued: true });
  const transient = interrupted.find((row) => row.schedulingReason === "transient_failure");
  const pickup = claimResults.manualPickupAfterFailedAutomation;
  assert.equal(pickup.requestUuid, transient.requestUuid);
  assert.deepEqual(interpretClaim(pickup), { proceed: true, replayed: false });
  // The same claimUuid after a lost response replays instead of conflicting.
  assert.equal(claimResults.sameClaimReplay.requestUuid, transient.requestUuid);
  assert.deepEqual(interpretClaim(claimResults.sameClaimReplay), { proceed: true, replayed: true });
  assert.match(reference, /Every `OPEN` request stays manually claimable, including a paused one\./);
  assert.match(reference, /fences out any automatic reply, which the app never publishes after a winning manual claim/);
});

test("live managed-claim conflict: state_conflict is information, never a retry or a new UUID", () => {
  const live = interpretClaim(claimResults.liveManagedAttempt);
  assert.deepEqual(live, {
    currentStatus: "PICKED_UP",
    proceed: false,
    reason: "state_conflict",
    retry: false,
    rotateClaimUuid: false,
  });
  for (const terminal of ["resolvedElsewhere", "dismissedByOwner"]) {
    const result = interpretClaim(claimResults[terminal]);
    assert.equal(result.proceed, false, terminal);
    assert.equal(result.retry, false, terminal);
    assert.ok(["RESOLVED", "DISMISSED"].includes(result.currentStatus), terminal);
  }
  assert.match(
    reference,
    /`state_conflict` means another claim, a live automatic attempt \(`currentStatus: "PICKED_UP"`\), or a terminal request; do not retry in a loop or rotate the UUID to bypass it\./,
  );
});

test("missing capability: without claim_agent_request the inbox is unavailable", () => {
  for (const removed of ["claim_agent_request", "list_agent_requests", "resolve_agent_request"]) {
    const catalog = generation9Catalog();
    catalog.tools = catalog.tools.filter((tool) => tool.name !== removed);
    assert.deepEqual(inboxAvailability(catalog), { available: false, missing: [removed] }, removed);
  }
  assert.match(reference, /Inspect the actual tool schemas before calling/);
  assert.match(reference, /never substitute `list_asks`, change journal configuration, or probe unsupported arguments/);
});

test("the guidance states the lease boundary and promises no background answering", () => {
  assert.match(reference, /Manual claims have no lease or automatic reclaim; never take over a `PICKED_UP` request by age or mint a replacement claim UUID\./);
  assert.match(reference, /Only an automatic attempt holds a server lease; when it expires, the request lists as `OPEN` again with no plugin action\./);
  assert.match(reference, /Dismiss is the owner's terminal decision, not a cancellation: it does not stop an agent already working outside Recall\./);
  assert.doesNotMatch(reference, /\. Claims have no lease or automatic reclaim;/);
  assert.doesNotMatch(reference, /in the background|on your behalf/i);

  const pluginReadme = flat(read(new URL("plugins/recall/README.md", repositoryRoot)));
  assert.match(pluginReadme, /Plugin `0\.41\.0` aligns the agent-request guidance with Recall's optional automatic replies\./);
  assert.match(pluginReadme, /manual claims have no lease or automatic reclaim/);
  assert.doesNotMatch(pluginReadme, /there is no claim lease or automatic reclaim/);
  assert.match(pluginReadme, /This is regular plugin access: the agent handles a request only inside a conversation the user is running\./);
  assert.match(pluginReadme, /the plugin does not launch it/);

  const rootReadme = flat(read(new URL("README.md", repositoryRoot)));
  assert.match(rootReadme, /The plugin's comment-mention inbox is manual/);
  assert.match(rootReadme, /automatic replies to mentions are a separate, opt-in Recall app feature that the plugin does not provide\./);

  const doctor = flat(read(new URL("plugins/recall/skills/doctor/SKILL.md", repositoryRoot)));
  assert.match(doctor, /Doctor diagnoses regular plugin access only/);
  assert.match(doctor, /never creates or launches a test request/);
  assert.match(doctor, /working tools here are not evidence that automatic replies are on/);
});
