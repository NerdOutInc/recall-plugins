---
name: doctor
description: Diagnose missing or failing Recall MCP tools in Claude Code, Codex, or Cursor. Use when the user invokes doctor, Recall tools are missing, or a Recall call fails; it never certifies automatic journaling.
---

# Recall Doctor

Diagnose the current conversation without treating a bridge elsewhere on the
machine as proof that this conversation is connected. Process checks are
advisory; an actual read-tool result is stronger evidence.

## Running the diagnosis

First inspect this conversation's available tools, using the host's tool
discovery mechanism if needed. Classify **Recall read tools**, not write or
lifecycle tools:

- `available`: at least one Recall read tool is available here. If appropriate,
  use one small existing read, such as `get_index_status`, and report its actual
  outcome separately. Do not write a note/session or request more access to test
  the connection.
- `missing`: discovery completed and no Recall read tools are available here.
- `unknown`: the inventory is incomplete or cannot be inspected.

Missing `open_session`, `record_session_lifecycle`, or another write tool does
not establish a missing connector: workspace policy, scopes, and response
capabilities can legitimately withhold them. A listed read tool can still fail
when called; preserve that error instead of relabeling the inventory.
Workspace **Write includes Read**: working reads with missing write tools can
reflect workspace policy, scopes, or capabilities; missing reads cannot be
explained by that workspace being set to Write. An enabled server, registered
CLI entries, and approved live sessions do not establish this conversation's
tool attachment.
Do not ask the user to enable an already-enabled server, broaden workspace
access, revoke existing grants, or reset credentials as a diagnostic shortcut.

Resolve `scripts/recall-doctor` relative to this `SKILL.md` and run its absolute
path from the current working directory. Always select the current host with
`--host claude-code`, `--host codex`, or `--host cursor`, and pass
`--session-tools available|missing|unknown` from the observation above. This
flag is **caller-reported read-tool availability**, not host attestation,
authorization, a successful call, or recording status. Legacy
`--client-name Claude|Codex|Cursor` remains accepted; conflicting selections
are rejected. The omitted-host default remains Claude for compatibility.

The default run is passive: it reads process and socket metadata and, for
Claude Code only, local log filenames/timestamps. It does not read log bodies,
connect to a port, launch a bridge, change configuration, or grant access.

A separate listener-only check is allowed during diagnosis:
`nc -z 127.0.0.1 38473` (release; `38474` for debug). It sends no MCP request
and cannot trigger consent. Failure establishes only that port's unreachability;
check the app process and server setting rather than assuming either cause.
Success proves reachability, not authentication or tool attachment. This check
does not require Doctor's `--probe` and does not change its default behavior.

Only add `--probe` when the user explicitly requests or agrees to a **new
connection attempt**. Explain that it starts a temporary bridge using the
selected client's entrypoint and may surface Recall's consent or OAuth flow.
Never approve that flow or change trust/configuration on the user's behalf.
Do not run a fresh probe automatically from routine hooks. A separately
launched CLI, even one listing MCP tools, is not this conversation's inventory.

## Reading the report

The JSON includes `host`, `clientName`, `currentSessionTools`, `checks`,
`firstBrokenLink`, and `summary`. A null `firstBrokenLink` means no failing
check was observed; unknown and skipped checks remain unverified.

- `recall-app` — the Recall.app process exists.
- `mcp-listener` — skipped by default. With `--probe`, tests TCP reachability
  on 127.0.0.1:38473 (release) and :38474 (debug), not authentication.
- `app-group-socket` — the app-group socket the Recall-signed helper uses.
  Missing is a warning. OAuth fallback remains governed by the bridge's
  existing rules; a missing socket does not authorize a downgrade.
- `session-bridge` — a fresh bounded process snapshot, with no argv written to
  disk. Supported Claude Code session ancestry can report a bridge present or
  absent. Shared Codex app-server/TUI and Cursor IDE ancestry cannot identify
  an individual conversation and remains `unknown`. Unverified Codex CLI modes
  and Cursor CLI ownership also remain `unknown`; generic `agent` or `node`
  executable names do not establish Cursor identity. An absent process does
  not prove that a connector was never started, and a present process does not
  prove an authenticated tool connection.
- `current-session-tools` — the caller's read-tool inventory observation,
  independent of process presence and the optional fresh probe.
- `bridge-probe` — skipped unless requested. A successful new JSON-RPC
  `initialize` reports the server name/version but does not verify current
  conversation tools, workspace access, lifecycle delivery, or journaling.
- `connection-logs` — Claude Code log metadata for this working directory.
  Missing logs are not proof that no connection was attempted. Codex/Cursor
  log layouts remain unavailable; do not substitute Claude logs.
- `last-refusal` — skipped by default. With `--read-connection-log` (pass it
  only when the user explicitly asks for a log-based diagnosis or agrees to
  one), the newest Claude Code log's tail is scanned for the helper's last
  `RECALL_BRIDGE_STATUS` line and transport marker; only the allowlisted
  status/message/typed-diagnostic fields are surfaced, never raw log bodies.
  A recorded refusal is historical evidence, not the current state — a
  resilient bridge (plugin ≥ 0.33.0) retries refusals automatically, and
  `starting` refusals in particular clear on their own once Recall finishes
  launching or its webview recovers. `signed_out` from an app ≥ the `starting`
  split means the webview CONFIRMED no session.

## Recovery from specific evidence

For **Allow again**, confirmation means a current call error explicitly names
`denied` or `revoked`, or the user confirms that grant's state in Recall's
**Settings -> MCP Server -> Local bridge access**. A `RECALL_BRIDGE_STATUS`
line with either exact status is another source, subject to the log-read rules
above; a historical refusal needs current corroboration. Generic authorization
errors, probe exit 66, and successful initialize responses do not confirm denial.
An initialize response from `0.0.0-degraded` is the retrying bridge, not a ready
Recall app. When denial or revocation is confirmed and the user wants to
reconnect, offer **Allow again**; the user handles native consent.

`approval_pending` or `approval_timeout` means bring Recall forward for the
user's prompt. `starting` means wait for startup/recovery; `signed_out` or
`user_mismatch` means check the signed-in account. `unauthenticated` needs its
typed diagnostic investigated, not a grant reset or OAuth downgrade.

After approval, the resilient local bridge (plugin >= 0.33.0) retries and sends
`notifications/tools/list_changed`. Recheck this conversation's read tools and
retry a small read before suggesting a new conversation. For an interrupted
write, check whether it took effect before retrying. A notification does not
prove the host refreshed its catalog: if tools remain absent, report that
attachment failure and use the host's connector refresh/restart procedure.
Older bridges that exited may need a new conversation.

`transport: oauth-http` means the bundled legacy `mcp-remote` fallback is active
because the signed helper is absent or its protocol is unsupported. For a
confirmed OAuth sign-in failure, offer a fresh browser sign-in: stop the affected
agent's bridge, then move only its cache directory under `~/.mcp-auth/recall/`
(`codex`, `claude`, or `cursor`) to a backup and reconnect. If
`MCP_REMOTE_CONFIG_DIR` is overridden, resolve that agent's actual cache path
first. Explain that this removes only that agent's cached OAuth credentials
from use; preserve sibling directories and let the user handle authorization.
Do not reset a healthy local-socket grant.
Hermes uses its own OAuth cache: use `hermes mcp test recall` and, only for a
confirmed OAuth login failure or revoked grant, `hermes mcp login recall`.

## Presenting the result

Lead with the current read-tool result and the first observed failure, then
the next useful check. If a fresh probe succeeds but this conversation lacks
tools, report those two facts without inventing a cause. A connector refresh
or new conversation may help attachment failures, but neither is proven by
the process tree. Keep `unknown` visible and do not claim automatic recording
works without the separate lifecycle certification evidence. Read log bodies
only when requested, and never quote credentials, authorization URLs, or raw
process arguments.
