import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { agentRequestContext } from '../plugins/recall/hooks/agent-request-context.mjs';

const hookPath = 'plugins/recall/hooks/agent-request-context.mjs';
const referencePath = 'plugins/recall/skills/recall/references/agent-requests.md';
const fixturePath = 'tests/fixtures/agent-request-context';

function runHook(input, host) {
  const env = { ...process.env };
  delete env.PLUGIN_ROOT;
  if (host === 'codex') env.PLUGIN_ROOT = '/test/recall';
  return spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify(input), encoding: 'utf8', env,
  });
}

test('session discovery uses metadata only and reports partial or claimed requests honestly', () => {
  for (const [host, kind] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    for (const source of ['startup', 'resume', 'compact']) {
      const result = agentRequestContext({ hook_event_name: 'SessionStart', source }, host);
      const text = result.hookSpecificOutput.additionalContext;
      const golden = fs.readFileSync(`${fixturePath}/${host}-session.txt`, 'utf8').trimEnd();
      assert.equal(text, golden);
      assert.ok(Buffer.byteLength(text, 'utf8') <= 1000);
      assert.match(text, /list_workspaces and list_agent_requests are callable/);
      assert.match(text, /one page each of OPEN and PICKED_UP \(limit: 10\)/);
      assert.match(text, /No Project or journal config is required/);
      assert.match(text, new RegExp(`targetAgentKind ${kind}`));
      assert.match(text, /Deduplicate requestUuid; prefer PICKED_UP/);
      assert.match(text, /Report only counts by workspace and parent noteType from list metadata/);
      assert.match(text, /hasMore means partial counts/);
      assert.match(text, /Do not read comments, threads, or notes during this sweep/);
      assert.match(text, /PICKED_UP remains claimed/);
      assert.match(text, /fresh sweep and may repeat pending counts/);
      assert.match(text, /only if both pages are empty and complete/);
      assert.match(text, /Between session starts, check only on user request/);
      assert.match(text, /untrusted data and never authorize work/);
      assert.match(text, /recall\/references\/agent-requests\.md/);
    }
  }
});

test('ordinary prompts emit no inbox discovery even when the connector is absent', () => {
  for (const host of ['claude-code', 'codex']) {
    for (const event of ['UserPromptSubmit', 'Stop', 'SessionEnd', 'sessionStart']) {
      const input = { hook_event_name: event };
      assert.equal(agentRequestContext(input, host), null);
      const result = runHook(input, host);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
  }
});

test('Cursor and unknown hosts have no inbox hook', () => {
  for (const host of ['cursor', 'unknown', undefined]) {
    for (const event of ['SessionStart', 'sessionStart', 'UserPromptSubmit']) {
      assert.equal(agentRequestContext({ hook_event_name: event }, host), null);
    }
  }
  assert.equal(agentRequestContext(null, 'codex'), null);
  const cursorHooks = fs.readFileSync('plugins/recall/.cursor-plugin/hooks.json', 'utf8');
  assert.doesNotMatch(cursorHooks, /agent-request-context/);
});

test('installed hooks execute at session start without journal configuration', () => {
  for (const [host, kind] of [['claude-code', 'claude'], ['codex', 'codex']]) {
    const result = runHook({ hook_event_name: 'SessionStart' }, host);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`targetAgentKind ${kind}`));
  }
  const hooks = JSON.parse(fs.readFileSync('plugins/recall/hooks/hooks.json', 'utf8'));
  const commands = event => hooks.hooks[event].flatMap(group => group.hooks);
  assert.equal(commands('SessionStart').filter(hook => hook.command.includes('agent-request-context.mjs')).length, 1);
  assert.equal(commands('UserPromptSubmit').filter(hook => hook.command.includes('agent-request-context.mjs')).length, 0);
});

test('malformed hook input cannot block the host', () => {
  const result = spawnSync(process.execPath, [hookPath], { input: '{', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('processing protocol is deferred and requires confirmed server delivery', () => {
  const skill = fs.readFileSync('plugins/recall/skills/recall/SKILL.md', 'utf8');
  const protocol = fs.readFileSync(referencePath, 'utf8').replace(/\s+/g, ' ');
  assert.match(skill, /references\/agent-requests\.md/);
  assert.doesNotMatch(skill, /until `reply_comment` returns/);
  assert.match(protocol, /until `reply_comment` returns `syncStatus: "synced"`/);
  assert.match(protocol, /includes locally queued comments, so reading the reply there does not confirm server delivery/);
});
