# Recorded `claude -p` stream-json fixtures

Recorded by `scripts/capture.ts` against the real CLI, version **2.1.312**, on 2026-10-28.
Re-record with:

```
pnpm --filter @crystal-bridge/kingdom exec tsx scripts/capture.ts [allow|deny|followup|interrupt|slow-allow|background-agent|weekly-only ...]
```

Every run uses these flags, with `cwd` set to a fresh `mkdtemp` git repo:

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --mcp-config '{"mcpServers":{"crystal":{"type":"http","url":"http://127.0.0.1:<port>/mcp/<session>"}}}'
  --permission-prompt-tool mcp__crystal__approve
  --session-id <uuid>            # or --resume <uuid> for resume.ndjson
```

The MCP URL points at a small recording proxy in front of the Task 4 permission server. The proxy logs the raw
JSON-RPC `params` the CLI sends, so the "wire" section of `permission-calls.json` shows them before zod parses anything.

## Files

| File | Scenario | Permission answer | Outcome |
|---|---|---|---|
| `allow.ndjson` | Bash `touch crystal.txt`, then reply DONE | allow | exit 0, `result/success`, `result: "DONE"` |
| `deny.ndjson` | same prompt | deny, `denied in capture` | exit 0, `result/success`; model explains the denial |
| `followup.ndjson` | same prompt, then a second message "Reply with the single word AGAIN." | allow | exit 0, two `result/success` lines (`DONE`, `AGAIN`) |
| `interrupt.ndjson` | Bash `python3 -c 'import time; time.sleep(30)'`; SIGINT 2 s after the `tool_use` | allow | exit **0** about 0.6 s after SIGINT, `result/error_during_execution` |
| `resume.ndjson` | `--resume <interrupt session>`, "Reply with the single word RESUMED." | none | exit 0, `result/success`, `result: "RESUMED"`, same `session_id` |
| `slow-allow.ndjson` | same prompt as allow; answer held for 60 s | allow after 60 s | exit 0, `result/success`, `duration_ms` 64688 |
| `weekly-only.ndjson` | "Reply with the single word DONE.", on a plan with only a weekly limit (2.1.316) | none | exit 0, `result/success`; see Plan windows |
| `permission-calls.json` | `onRequest`: what Task 4's `onRequest` received. `wire`: raw `initialize`, `tools/list` and `tools/call` params per scenario | | |

**The prompt differs from the plan.** The plan's `echo crystal` never reached the permission tool. The CLI allows
read-only commands itself: the tool_result's `tool_result_meta[].permission_decision` is
`{"decision":"accept","source":"config","reason_type":"subcommandResults"}`, and `approve` is never called. So the
recorded prompt uses `touch crystal.txt`, which has a side effect. For the same reason, the plan's `sleep 30` is
refused by the CLI itself: the tool_result is an `is_error` `<tool_use_error>Blocked: standalone sleep 30 ...` with no
permission call, and the model ends its turn. The interrupt scenario therefore uses a python sleep.

## 1. Line types, with counts per fixture

The table counts `type`, or `type/subtype` (for `stream_event`, `type/event.type`).

| type/subtype | allow | deny | followup | interrupt | resume | slow-allow |
|---|---|---|---|---|---|---|
| system/hook_started | 1 | 1 | 1 | 1 | 1 | 1 |
| system/hook_response | 1 | 1 | 1 | 1 | 1 | 1 |
| system/init | 1 | 1 | **2** | 1 | 1 | 1 |
| system/status | 2 | 2 | 3 | 1 | 1 | 2 |
| system/task_summary | 2 | 2 | 2 | 1 | 0 | 2 |
| system/post_turn_summary | 1 | 1 | 2 | 0 | 1 | 1 |
| stream_event/message_start | 2 | 2 | 3 | 1 | 1 | 2 |
| stream_event/content_block_start | 2 | 3 | 3 | 1 | 1 | 2 |
| stream_event/content_block_delta | 7 | 21 | 8 | 8 | 1 | 7 |
| stream_event/content_block_stop | 2 | 3 | 3 | 1 | 1 | 2 |
| stream_event/message_delta | 2 | 2 | 3 | 1 | 1 | 2 |
| stream_event/message_stop | 2 | 2 | 3 | 1 | 1 | 2 |
| assistant | 2 | 3 | 3 | 1 | 1 | 2 |
| user | 1 | 1 | 1 | 2 | 0 | 1 |
| rate_limit_event | 1 | 2 | 1 | 1 | 1 | 1 |
| result/success | 1 | 1 | 2 | 0 | 1 | 1 |
| result/error_during_execution | 0 | 0 | 0 | 1 | 0 | 0 |

The expected types all appear: `system/init`, `stream_event`, `assistant`, `user` with `tool_result`, and `result`.
These also appear, and a parser must tolerate them: `system/hook_started` and `system/hook_response` (a SessionStart
hook from the user's settings runs even in `-p` mode), `system/status` (`{"status":"requesting"}` before each API
call), `system/task_summary` (`detail`: a short progress string, or `null`), `system/post_turn_summary`
(`status_category`, `status_detail`, `needs_action`, `summarizes_uuid`) and `rate_limit_event` (`rate_limit_info`
with `status`, `resetsAt`, `rateLimitType` and `unifiedWindows`; the recorded values are neutral placeholders; see
[Plan windows](#plan-windows)). Every
line carries `session_id` and `uuid`.

### Text delta (`stream_event`)

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"DONE"}},
 "session_id":"…","parent_tool_use_id":null,"uuid":"…","api_message_id":"msg_…"}
```

Other delta types: `input_json_delta` (`partial_json`) for tool input, which starts with a `content_block_start` of
`{"type":"tool_use","id":"toolu_…","name":"Bash","input":{}}`. Thinking blocks also appear (`content_block_start`
`{"type":"thinking"}`). Their thinking text is empty and only the `signature` is filled.

### Assistant message with `tool_use`

```json
{"type":"assistant","message":{"model":"claude-model","id":"msg_…","type":"message","role":"assistant",
  "content":[{"type":"tool_use","id":"toolu_…","name":"Bash","input":{"command":"touch crystal.txt","description":"…"},"caller":{"type":"direct"}}],
  "stop_reason":null,"usage":{…},…},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…","request_id":"req_…",
 "wire_tool_inputs":{"toolu_…":{"command":"touch crystal.txt","description":"…"}}}
```

**There is one `assistant` line per content block, not one per API message.** In `deny.ndjson`, a `thinking` block and
a `text` block arrive as two `assistant` lines with the same `message.id`. `message.stop_reason` is `null` on these
lines. The real stop reason arrives in `stream_event/message_delta` and in `result.stop_reason`.

### User message with `tool_result`

Allowed (allow.ndjson):

```json
{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_…","type":"tool_result","content":"(Bash completed with no output)","is_error":false}]},
 "parent_tool_use_id":null,"session_id":"…","uuid":"…","timestamp":"…",
 "tool_use_result":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":true},
 "tool_result_meta":[{"id":"toolu_…","permission_decision":{"decision":"accept","source":"user_temporary"}}]}
```

The messages we write to stdin are **not** echoed back as `user` lines; that would need `--replay-user-messages`,
which we don't pass. The only `user` lines are tool results and the CLI's interrupt marker.

### Result

Keys (allow): `type, subtype, is_error, result, session_id, uuid, stop_reason, terminal_reason, num_turns,
duration_ms, duration_api_ms, ttft_ms, ttft_stream_ms, time_to_request_ms, first_content_frame_ms, total_cost_usd,
usage, modelUsage, model_usage_since_last_result, permission_denials, api_error_status, fast_mode_state,
fast_mode_disabled_reason, subagent_stats, safety_stops, queued_turn_count, result_index`. On errors, `errors` (an
array of strings) appears too.

```json
{"type":"result","subtype":"success","is_error":false,"result":"DONE","stop_reason":"end_turn","terminal_reason":"completed",
 "num_turns":2,"total_cost_usd":0.1270636,"session_id":"…","permission_denials":[],"duration_ms":6064,…}
```

`"type":"result"` is **not** the first key on this line (the line starts with `duration_api_ms`), so match on the
parsed `type`, never on a line prefix. `total_cost_usd` is **cumulative for the conversation**: followup's two results
read 0.0139 and then 0.0199, and it carries across `--resume` (0.0818, 0.1451, 0.1497 over three processes, CLI
2.1.314). `result_index` counts results within one process.

### What `system/init` says a session can use

The fixtures ran with nothing installed, so these arrays are empty there. A live check (CLI 2.1.312, a project skill,
a project agent and a `--plugin-dir` plugin) showed the shapes the web Inventory reads:

- `skills`: names, e.g. `["demo-skill", "demo-plugin:plug-skill"]`. Every skill is also in `slash_commands`.
- `slash_commands`: names (skills, plugin commands as `plugin:command`, built-ins). `terminal_slash_commands` lists
  the ones that only work in a terminal.
- `plugins`: `{"name","path","source","version"?}`; built-in plugins have `"path":"builtin"`.
- `mcp_servers`: `{"name","status","source"}`; `status` is `connected`, `failed` or `pending`. Crystal's own
  permission tool shows up as `crystal` with `"source":"dynamic"`.
- `agents`: names, e.g. `["claude", "demo-agent", "Explore", "general-purpose", "Plan"]`.

Hooks aren't listed in `init`; each run shows up as `system/hook_started` and `system/hook_response` (`hook_name`,
`hook_event`, `outcome`).

### When a skill runs

A live check (CLI 2.1.312, a project skill, 2026-10-30): the `assistant` line has a `Skill` tool_use with
`input.skill` (the name); the tool_result's content is `Launching skill: <name>`; then a separate `user` line with
`"isSynthetic": true` carries the skill's text as one `text` block, starting `Base directory for this skill: <path>`.
The web folds that text into the Skill tool (`body`) instead of showing it as chat.

## 2. Arguments the CLI passes to `approve`

From `permission-calls.json`, `wire` (the same for allow, deny, followup and slow-allow):

```json
{"name":"approve",
 "arguments":{"tool_name":"Bash","input":{"command":"touch crystal.txt","description":"…"},"tool_use_id":"toolu_…"},
 "_meta":{"claudecode/toolUseId":"toolu_…","progressToken":2}}
```

These match Task 4's schema (`tool_name: string`, `input: record`, `tool_use_id?: string`) exactly, with no extra
arguments. **`permissions.ts` was not changed.** `tool_use_id` was always present, and it equals the `tool_use.id`
in the stream. The CLI's `initialize` uses `protocolVersion: "2025-11-25"` with `clientInfo.name: "claude-code"`.
Our JSON answer `{"behavior":"allow","updatedInput":…}` / `{"behavior":"deny","message":…}` was accepted.

Note: `mcp__crystal__approve` does not appear in `system/init.tools`. The permission-prompt tool is hidden from the
model. `mcp_servers` shows `{"name":"crystal","status":"connected","source":"dynamic"}`.

## 3. The stdin message shape

`{"type":"user","message":{"role":"user","content":"<prompt>"}}\n` is accepted, both as the first message and as a
second message after a `result`. The followup process emits a **second `system/init`** (same `session_id`) before
the second turn. With stdin left open the CLI waits for more input. In allow, deny and followup, we close stdin after
the final `result` and the CLI exits 0 straight away.

## 4. SIGINT and `--resume`

SIGINT sent 2 s after the `tool_use` line, while the python sleep was running (we had allowed it), made the process
**exit about 0.6 s later with exit code 0** (not 130, and no signal). The last lines are:

1. `user` tool_result `{"is_error":true,"content":"The user doesn't want to proceed with this tool use. The tool use was rejected …"}`
   with `tool_use_result: "User rejected tool use"` and `tool_result_meta[].non_execution_kind: "user-rejected"`.
2. `user` text `[Request interrupted by user for tool use]`.
3. `result` with `subtype:"error_during_execution"`, `is_error:true`, `result:null`, `stop_reason:"tool_use"`,
   `terminal_reason:"aborted_tools"`, `errors:["[ede_diagnostic] result_type=user …"]`.

The exit code can't tell an interrupt from success; check `result.subtype` / `terminal_reason`. In the first run, the
CLI blocked the standalone `sleep`, so SIGINT arrived while the model was streaming. That run ended the same way,
with `terminal_reason:"aborted_streaming"`.

**`--resume <session-id>` works.** A new process with the same flags, `--resume` in place of `--session-id`, and the
same cwd, reported the same `session_id` in `system/init` and answered `RESUMED` (`resume.ndjson`). The prior context
was loaded: the first turn read 27466 cached input tokens, against about 12.9k for a fresh session.

## 5. A permission request held for 60 s

It completes. `slow-allow` answered after 60.0 s (`at` → `answeredAt` in `permission-calls.json`), the command ran,
and the result was `success` / `DONE` with `duration_ms` 64688. No `MCP_TOOL_TIMEOUT` was needed at 60 s. The script
retries with `MCP_TOOL_TIMEOUT=300000` only when the slow run fails.

Past 300 s it fails unless the server's entry says otherwise. On CLI 2.1.316 a call held for 400 s ended at 300 s with a tool
error, "sent no response or progress for 300s", and the agent retried, so a second request arrived. `MCP_TOOL_TIMEOUT` and
SSE comments on the stream made no difference. A per-server `"timeout"` in milliseconds in `--mcp-config` did: the same hold
ran to `success` / `DONE`. An unknown key in that entry is ignored, so a CLI without this setting still starts.

## How a deny shows up

- `user` tool_result: `{"type":"tool_result","content":"denied in capture","is_error":true}`. The `content` is our
  `message`, verbatim. `tool_use_result` is `"Error: denied in capture"`, and `tool_result_meta[]` is
  `{"non_execution_kind":"permission-rule","permission_decision":{"decision":"reject","source":"user_reject"}}`.
- `result.permission_denials`: `[{"tool_name":"Bash","tool_use_id":"toolu_…","tool_input":{…}}]`.
- `result` stays `subtype:"success"`, `is_error:false`. The model replies in text (it declined to say DONE), and
  `post_turn_summary` reports `status_category:"blocked"` with a `needs_action` string.
- Permission decisions are visible on every tool result: `source` is `config` (CLI auto-allow), `user_temporary` (our
  allow) or `user_reject` (our deny).

## A background agent (2.1.314, recorded 2026-10-30)

`background-agent.ndjson` runs in `--permission-mode auto` without the permission tool, so it needs no local server.
Launching returns straight away, so a tool result doesn't mean a background agent finished:

- `system/task_started` carries `tool_use_id` and `is_backgrounded: true`. A call can land in the background without
  `run_in_background` in its input: the interactive CLI did this for all three agents of one Quest, and `result`'s
  `subagent_stats.requested` counts those as `unset`.
- The `user` line with the `tool_result` adds `tool_use_result: { isAsync: true, status: "async_launched", ... }`.
- The agent's own lines follow with a non-null `parent_tool_use_id`, then `system/task_progress` and
  `system/task_updated`.
- `system/task_notification` ends it, with `tool_use_id` and `status`. A new turn starts for the main agent.

An interactive transcript has none of the `system` lines. The launch's result line has `toolUseResult` (the same
fields), and the end is the text handed to the model, `<task-notification>` with `<tool-use-id>` and `<status>`, in up
to three places: a `queue-operation` with `operation: "enqueue"` the moment the task ends, then a `user` line with
`origin.kind: "task-notification"`, or an `attachment` of type `queued_command` when a running turn absorbs it.
`liveTranscriptEvent` relays these in the stream-json shape, so the client reads one form. One agent can notify twice.

An MCP server the CLI once reported as `needs-auth` stays that way for a while under that name, without a request
being made: `system/init` shows the status and the permission tool fails as "not found". Seen under a network sandbox
that blocks localhost, and it outlasted the sandbox. Any other server name connects.

## Scrubbing

`scrub()` in `capture.ts` rewrites every line before it is written. For any `system` line that carries inventory
keys: `tools` keeps only built-in names (it drops `mcp__*` except `mcp__crystal__approve`), `mcp_servers` keeps only
`crystal`, `slash_commands`, `skills`, `agents` and `plugins` become `[]`, `output_style` becomes `"default"`, and
`cwd` becomes `/tmp/FIXTURE`. On every line: the temp repo path (and its `-tmp-…` project-dir form) becomes
`/tmp/FIXTURE`, `$HOME` becomes `/HOME`, email addresses become the `user` placeholder at `example.com`, and account/org/user `*_id`/`*_uuid` keys
holding UUIDs become zero UUIDs. Model identifiers become `claude-model` (`claude-model-2` and so on for further
distinct models). Each `rate_limit_event`'s `rate_limit_info` keeps its keys but gets fixed values: `status` is `allowed`,
every `resetsAt` and `utilization` is `0`, `overageStatus` is `rejected`, and `overageDisabledReason` is dropped.
`--rescrub` re-applies all of this to the existing fixtures without running the CLI. Session ids, message uuids and tool-use ids are kept as recorded.

## Plan windows

Recorded from a plan with both limits (2.1.312, and again on 2026-10-31): `unifiedWindows` has `five_hour` and
`seven_day`, in that order, each with `utilization`, `resetsAt` and `status`. `rateLimitType` names one of them.

Recorded from a plan with only a weekly limit (2.1.316, 2026-10-31, `weekly-only.ndjson`): `unifiedWindows` has just
`seven_day`, in the same shape, and `rateLimitType` is `seven_day`. `five_hour` is absent, not empty. Record this one by
naming it, on such an account: `capture.ts weekly-only`. A run with no scenarios skips it.

`src/usage.ts` reads the length from the name (`seven_day`, `seven_day_<scope>`, `30_day`) rather than expecting set
names, and passes on any other name with no length. `status` is scrubbed to `allowed`; the app also handles
`allowed_warning` and `rejected`. An interactive Quest's statusline hasn't been recorded on a weekly-only plan; it's read
by the same rule.

## The interactive engine (2.1.312, observed 2026-10-29)

Not recorded as files: an interactive transcript carries the session's full context (including the account email),
so `interactive.test.ts` builds lines in the observed shapes instead. What the real CLI did, run as `claude
--session-id <id> --permission-mode default --settings <file>` in a pseudo-terminal:

- **Tools.** The interactive session had `Artifact`, `ArtifactComments` and `ArtifactData`; `claude -p` never has them
  (not with `enableArtifact: true` either). claude.ai connectors appear in `-p` too, from the second turn's init.
- **Hooks** (command hooks reading JSON on stdin), all with `session_id`, `transcript_path`, `cwd`:
  `SessionStart` (`source`: `startup` or `resume`, plus `model`); `UserPromptSubmit` (`prompt`);
  `PermissionRequest` (`tool_name`, `tool_input`, `permission_suggestions`, `permission_mode`), whose stdout
  `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` approves. It also
  fires for `AskUserQuestion`: allowing with `updatedInput: { ...input, answers }` answers it. `Stop`
  (`last_assistant_message`, `background_tasks`, `session_crons`) runs before the reply's last text block reaches the
  transcript.
- **Transcript** lines (`<projects>/<cwd>/<id>.jsonl`): `assistant` and tool-result `user` lines have the stream-json
  shape (`{type, message:{id, role, content, usage, model}}` plus bookkeeping keys); typed prompts are `user` lines
  with string content. Other types (`attachment`, `api-request*`, `mode`, `permission-mode`, `last-prompt`,
  `ai-title`, `tools-used`, `file-history-snapshot`, `system`, `cost-state`) are bookkeeping; `cost-state` wasn't
  written during the session.
- **Startup.** A folder not yet trusted shows the workspace-trust dialog with the cursor on "No, exit": Down then
  Enter accepts it. No other dialog appeared with hooks in `--settings`.
- **Statusline** (documented, code.claude.com/docs/en/statusline): a `statusLine` command in `--settings` gets JSON on
  stdin after each change (debounced 300 ms): `cost.total_cost_usd` (running, across resumes), `cost.total_api_duration_ms`,
  `context_window.context_window_size` (1000000 here), `context_window.total_input_tokens`, and
  `rate_limits.<five_hour|seven_day>.used_percentage` (0-100) with `resets_at` (epoch seconds). Crystal turns these into
  the turn result's `total_cost_usd` and `modelUsage.session.contextWindow`, a
  `system/context_window` line of Crystal's own as soon as the size is known or changes, and `usage` events.
  With a configured size (`src/compact.ts`) that line also carries `compactWindow`; the statusline doesn't report it.
  Crystal also adds a `system/turn_changes` line (`files`) after a turn, on both engines, from `src/changes.ts`. Per-turn tokens come from transcript `assistant` lines' `message.usage`, once per `message.id`.
- **Listing attachments** (internal): `attachment.type: skill_listing` with `names` (every skill, plugin skills
  prefixed `plugin:`; `isInitial`), and `deferred_tools_delta` with `addedNames`/`removedNames` (tool names, MCP ones as
  `mcp__<server>__<tool>`, claude.ai connectors as `mcp__claude_ai_<Name>__…`), `pendingMcpServers` and
  `failedMcpServers`. A server offering only `authenticate`/`complete_authentication` is waiting on sign-in. Slash
  commands other than skills aren't listed anywhere a session can read for free. `agent_listing_delta` (`addedTypes`)
  lists agent types.

## The `summon` tool (live check, CLI 2.1.316)

Not a recording: real Quests against a real SSH target, while building #126.

- `system/init.tools` lists `mcp__crystal__summon`, though it hides `mcp__crystal__approve`.
- Stream engine, `manual`: the call reaches the permission tool as `mcp__crystal__summon`, with the whole input, so the
  approval card shows the machine and the command.
- Interactive engine, `auto`: the CLI ran the call with no approval. That engine gets the tool through `--mcp-config`, and
  `system/init` lists the server there with no `source` field.
- Stream engine, `auto`: the same, no approval.
- Interactive engine in `manual` wasn't checked.
