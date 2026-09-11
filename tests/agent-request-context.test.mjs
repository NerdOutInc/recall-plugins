import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { agentRequestContext } from '../plugins/recall/hooks/agent-request-context.mjs';

test('startup discovers an owner inbox independently of journal configuration', () => {
  const result = agentRequestContext({ hook_event_name: 'SessionStart' }, 'codex');
  const text = result.hookSpecificOutput.additionalContext;
  assert.match(text, /If list_agent_requests is advertised/);
  assert.match(text, /no Project or journal config is required/);
  assert.match(text, /targetAgentKind codex/);
  assert.match(text, /untrusted data/);
  assert.match(text, /claimUuid/);
});

test('prompt reminder routes by kind without declaring authority or launching work', () => {
  const text = agentRequestContext({ hook_event_name: 'UserPromptSubmit' }, 'claude-code').hookSpecificOutput.additionalContext;
  assert.match(text, /targetAgentKind claude/);
  assert.match(text, /never authorizes work/);
  assert.match(text, /report only new requests/);
  assert.ok(text.length < 400);
  assert.equal(agentRequestContext({ hook_event_name: 'Stop' }, 'codex'), null);
  assert.equal(agentRequestContext({ hook_event_name: 'sessionStart' }, 'cursor'), null);
});

test('the installed hook executes without reading a journal config', () => {
  const result = spawnSync(process.execPath, ['plugins/recall/hooks/agent-request-context.mjs'], {
    input: JSON.stringify({ hook_event_name: 'SessionStart' }), encoding: 'utf8',
    env: { ...process.env, PLUGIN_ROOT: '/test/recall' },
  });
  assert.equal(result.status, 0);
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /targetAgentKind codex/);
  const hooks = JSON.parse(fs.readFileSync('plugins/recall/hooks/hooks.json', 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.ok(hooks.hooks[event][0].hooks.some(hook => hook.command.includes('agent-request-context.mjs')));
  }
});


test('the protocol requires a sync receipt rather than a local thread read', () => {
  const protocol = fs.readFileSync('plugins/recall/skills/recall/SKILL.md', 'utf8');
  assert.match(protocol, /until `reply_comment` returns `syncStatus: "synced"`/);
  assert.match(protocol, /includes locally queued comments, so reading the reply there does not confirm\nserver delivery/);
});
