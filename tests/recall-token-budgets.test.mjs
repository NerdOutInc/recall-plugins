import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { measureCatalog, measureEvent, measureHook, measureSkills } from "../scripts/measure-context-cost.mjs";

// Every byte the plugin puts into an agent's context has a ceiling here, so a
// wording change that quietly grows the per-prompt reminder or the skill bundle
// fails in CI instead of in every user's transcript. The numbers are UTF-8
// bytes; docs/token-usage-optimization-plan.md explains where they come from.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repositoryRoot, "tests/fixtures/recall-journal-hook");
const KIB = 1024;
const BUDGETS = {
  hookSessionStartup: 4.25 * KIB,
  hookSessionCompact: 4.75 * KIB,
  hookReminder: 400,
  hookAbsentConnectorReminder: 640,
  hookInvalidConfigReminder: 256,
  hookCursorSession: 4.5 * KIB,
  // Additional inbox context is allowed only at session start/compaction.
  // Keep the existing journal ceilings independently enforced below.
  hookAgentRequestsSession: 1000,
  recallSkill: 26 * KIB,
  agentRequestsReference: 6 * KIB,
  dispatcher: 4.5 * KIB,
  writer: 12.5 * KIB,
  projectContext: 4.5 * KIB,
  efforts: 9 * KIB,
  effortsRecovery: 4 * KIB,
  ordinaryBundle: 21.5 * KIB,
  effortsBundle: 30 * KIB,
  descriptionJournal: 400,
  descriptionDoctor: 256,
  descriptionRecall: 160,
};

const bytes = (text) => Buffer.byteLength(text, "utf8");

function goldens(predicate) {
  const rows = [];
  for (const version of fs.readdirSync(fixtureRoot)) {
    const directory = path.join(fixtureRoot, version);
    if (!fs.statSync(directory).isDirectory()) continue;
    for (const filename of fs.readdirSync(directory)) {
      if (!filename.endsWith(".txt") || !predicate(filename)) continue;
      rows.push([`${version}/${filename}`, bytes(fs.readFileSync(path.join(directory, filename), "utf8").trimEnd())]);
    }
  }
  assert.ok(rows.length > 0, "expected at least one golden");
  return rows;
}

test("every session-start golden stays under its budget", () => {
  for (const [name, size] of goldens((filename) => filename.endsWith("-context.txt"))) {
    assert.ok(size <= BUDGETS.hookSessionStartup, `${name}: ${size} > ${BUDGETS.hookSessionStartup}`);
  }
});

test("every per-prompt reminder golden stays under its budget", () => {
  for (const [name, size] of goldens((filename) => filename.endsWith("reminder.txt"))) {
    const budget = name.includes("bridge-missing") ? BUDGETS.hookAbsentConnectorReminder : BUDGETS.hookReminder;
    assert.ok(size <= budget, `${name}: ${size} > ${budget}`);
  }
});

test("all registered hooks fit their combined and individual event budgets", () => {
  for (const row of measureHook()) {
    const cursor = row.route.includes("Cursor");
    for (const event of ["sessionStart", "sessionCompact", "prompt"]) {
      const components = row.components[event];
      if (row[event] === null) {
        assert.deepEqual(components, []);
        continue;
      }
      const names = components.map(({ command }) => /\/hooks\/([^" ]+)/.exec(command)?.[1]);
      const expected = ["journal-context.mjs"];
      if (!cursor && event !== "prompt") expected.push("agent-request-context.mjs");
      // New or duplicate registrations cannot hide outside the measured total
      // or acquire an implicit allowance by growing a different hook's budget.
      assert.deepEqual(names.sort(), expected.sort(), `${row.route} ${event}`);
      assert.equal(row[event], components.reduce((total, component) => total + component.bytes, 0));
      const journal = components.find(({ command }) => command.includes("/hooks/journal-context.mjs")).bytes;
      const inbox = components.find(({ command }) => command.includes("/hooks/agent-request-context.mjs"))?.bytes ?? 0;
      const journalBudget = cursor ? BUDGETS.hookCursorSession
        : event === "sessionStart" ? BUDGETS.hookSessionStartup
          : event === "sessionCompact" ? BUDGETS.hookSessionCompact : BUDGETS.hookReminder;
      const inboxBudget = !cursor && event !== "prompt" ? BUDGETS.hookAgentRequestsSession : 0;
      assert.ok(journal <= journalBudget, `${row.route} ${event} journal: ${journal} > ${journalBudget}`);
      assert.ok(inbox <= inboxBudget, `${row.route} ${event} inbox: ${inbox} > ${inboxBudget}`);
      if (inboxBudget) assert.ok(inbox > 0, `${row.route} ${event}: registered inbox hook was omitted`);
      assert.ok(row[event] <= journalBudget + inboxBudget, `${row.route} ${event}: ${row[event]}`);
    }
    if (!cursor && row.route.includes("writer")) {
      const journalStart = row.components.sessionStart.find(({ command }) => command.includes("/hooks/journal-context.mjs")).bytes;
      assert.ok(row.prompt * 8 < journalStart, `${row.route}: reminder ${row.prompt} is not small beside ${journalStart}`);
    }
  }
});

test("measurement includes every registered command, including a second hook group", () => {
  const pluginRoot = path.join(repositoryRoot, "plugins/recall");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, "hooks/hooks.json"), "utf8"));
  const environment = {
    ...process.env,
    CODEX_HOME: path.join(fixtureRoot, "v5"),
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    PLUGIN_ROOT: pluginRoot,
  };
  const input = { cwd: repositoryRoot, hook_event_name: "SessionStart", source: "startup" };
  const baseline = measureEvent(environment, input, manifest);
  const inboxHook = manifest.hooks.SessionStart.flatMap((group) => group.hooks)
    .find(({ command }) => command.includes("/hooks/agent-request-context.mjs"));
  const inboxBytes = baseline.components.find(({ command }) => command === inboxHook.command).bytes;
  assert.ok(inboxBytes > 0);
  manifest.hooks.SessionStart.push({ hooks: [inboxHook] });
  const duplicate = measureEvent(environment, input, manifest);
  assert.equal(duplicate.components.length, baseline.components.length + 1);
  assert.equal(duplicate.bytes, baseline.bytes + inboxBytes);
});

test("an invalid config produces a short per-prompt reminder", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "recall-budget-"));
  try {
    fs.writeFileSync(path.join(directory, "recall-journal.json"), JSON.stringify({ version: 5, projectMemory: { enabled: true } }));
    const environment = { ...process.env, CODEX_HOME: directory, PLUGIN_ROOT: path.join(repositoryRoot, "plugins/recall") };
    delete environment.CLAUDE_CONFIG_DIR;
    delete environment.CLAUDE_PLUGIN_ROOT;
    const result = spawnSync(process.execPath, [path.join(repositoryRoot, "plugins/recall/hooks/journal-context.mjs")], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({ hook_event_name: "UserPromptSubmit", cwd: repositoryRoot }),
    });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.ok(bytes(context) <= BUDGETS.hookInvalidConfigReminder, `${bytes(context)}`);
  } finally {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

test("the journal skill references and bundles stay under budget", () => {
  const skills = measureSkills();
  const expectations = [
    ["recall-journal/SKILL.md", BUDGETS.dispatcher],
    ["structured-writer.md", BUDGETS.writer],
    ["project-context.md", BUDGETS.projectContext],
    ["efforts.md", BUDGETS.efforts],
    ["efforts-recovery.md", BUDGETS.effortsRecovery],
  ];
  for (const [name, budget] of expectations) {
    assert.ok(skills.files[name] <= budget, `${name}: ${skills.files[name]} > ${budget}`);
  }
  assert.ok(
    skills.bundles["v5/v7 ordinary (dispatcher, writer, project context)"] <= BUDGETS.ordinaryBundle,
    `ordinary bundle: ${skills.bundles["v5/v7 ordinary (dispatcher, writer, project context)"]}`,
  );
  assert.ok(skills.bundles["v5/v7 with efforts"] <= BUDGETS.effortsBundle, `efforts bundle: ${skills.bundles["v5/v7 with efforts"]}`);
  // Recovery is read only on failure, so it must stay out of the efforts basics.
  const efforts = fs.readFileSync(path.join(repositoryRoot, "plugins/recall/skills/recall-journal/references/efforts.md"), "utf8");
  assert.match(efforts, /Read \[efforts-recovery\.md\]\(efforts-recovery\.md\) only when/);
  assert.doesNotMatch(efforts, /resume_milestone|freshMilestoneAllowed|pendingCursor/);
});

test("the Recall skill and optional agent request protocol have separate budgets", () => {
  const skills = measureSkills();
  const reference = skills.files["recall/references/agent-requests.md"];
  const recall = skills.files["recall/SKILL.md"];
  assert.ok(recall > 0 && recall <= BUDGETS.recallSkill, `Recall skill: ${recall}`);
  assert.ok(reference > 0 && reference <= BUDGETS.agentRequestsReference, `Agent request reference: ${reference}`);
  assert.equal(skills.bundles["Recall with optional agent requests"], recall + reference);
});

test("the always-on skill descriptions stay short", () => {
  const { descriptions } = measureSkills();
  assert.ok(descriptions["recall-journal"] <= BUDGETS.descriptionJournal, String(descriptions["recall-journal"]));
  assert.ok(descriptions.doctor <= BUDGETS.descriptionDoctor, String(descriptions.doctor));
  assert.ok(descriptions.recall <= BUDGETS.descriptionRecall, String(descriptions.recall));
});

test("the catalog fixture is the generation the guidance was measured against", () => {
  const catalog = measureCatalog();
  assert.equal(catalog.catalogVersion, 8);
  assert.equal(catalog.toolCount, 40);
  // Six tools carry the evidence schema. Generation 8 dropped its flattened
  // item-level copy, so the whole catalog is smaller than generation 7's
  // 64,938 bytes even with read_entry added.
  assert.equal(catalog.evidenceTools, 6);
  assert.ok(catalog.descriptionBytes + catalog.schemaBytes < 64_938, String(catalog.descriptionBytes + catalog.schemaBytes));
  assert.ok(catalog.coreFive > 0 && catalog.journalingTen > catalog.coreFive);
});

test("the measurement script prints every table", () => {
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/measure-context-cost.mjs")], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const heading of ["## Registered hooks, combined", "## Skill bundles", "## Tool catalog fixture", "## Cost model"]) {
    assert.ok(result.stdout.includes(heading), heading);
  }
  const json = spawnSync(process.execPath, [path.join(repositoryRoot, "scripts/measure-context-cost.mjs"), "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), ["catalog", "hook", "model", "skills"]);
});
