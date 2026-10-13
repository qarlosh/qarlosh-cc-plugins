# blackbox — event log format (v1)

One JSON object per line in `<logDir>/<sessionId>.jsonl`. The collector writes it; the viewer
reads it. Source API: Claude Code 2.1.295 function hooks.

## Envelope

Every record has:

| Field | Type | Meaning |
|---|---|---|
| `v` | `1` | Format version |
| `seq` | number | Counter within one load of the module (it restarts when the module reloads). The file's line order is the order of records |
| `ts` | number | Epoch ms, from `$.clock.now()` when the collector saw the event |
| `sid` | string | Session id (`$.session.id()`) |
| `agent` | string \| null | `agentId` of the loop the event belongs to; `null` is the main loop |
| `kind` | string | Record kind, below |

Long texts are cut to the `maxTextChars` option (default 20000). A cut field `x` gets a sibling
`xLen` with the original length.

## Kinds

### Session

| `kind` | Source | Fields |
|---|---|---|
| `session.start` | `session.start` | `cwd`, `surface`, `isInteractive`, `continued` (the log already existed: a module reload or a resumed session) |
| `session.info` | the collector finds the session's transcript under `~/.claude/projects` (at a flush, once the file exists) | `transcriptPath` |
| `session.end` | `session.end` | `reason` (`clear`, `prompt_input_exit`, `resume`, `logout`, `other`) |
| `offer.skills` | `$.session.usage({ breakdown: 'summary' })` at session start and on reload | `skills[{ name, source, plugin?, tokens }]` |
| `collector.stats` | the collector itself, at each flush that saw events | `events` (count per kind), `ownMs` (time in its own code per kind, not the round trip to its process), `errors[]` |

Agent types offered to the model are not recorded as their own kind: hooking `agent.offer` cost a
round trip on every offer (about 28 per session) for little; the agent listing is in the `row`
records of injected context (`name: 'agent_listing_delta'`).

### Turns and steps

| `kind` | Source | Fields |
|---|---|---|
| `prompt` | `prompt.submit`, before `next` | `text`, `origin` (kind), `attachments` (names), `dropped?` (set when a hook dropped it) |
| `turn.start` | `turn.start` (main loop only) | `turnId`, `text` |
| `turn.end` | `turn.complete` (main and subagents) | `turnId`, `durationMs`, `reason`, `isAborted`, `usage`, `answer`, `refusal?` |
| `step.start` | `turn.step`, before `next` | `turnId`, `index`, `model`, `effort?`, `messageCount` |
| `step.end` | `turn.step`, after `yield* next(e)` (chunks are never iterated) | `turnId`, `index`, `durationMs`, `stopReason`, `usage`, `toolCount`, `serverTools?[{ name, startedAt, endedAt }]` |

### Conversation rows

| `kind` | Source | Fields |
|---|---|---|
| `row` | `session.append`, after `next` | `uuid`, `type`, `door`, `origin` (`{ kind, event?, tool?, model? }`), `name?` (attachment type), `isMeta?`, `blocks[]` |

`blocks[]` keeps each content block compact: `{ type: 'text', text }`, `{ type: 'thinking', text }`,
`{ type: 'tool_use', id, name }` (input is in `tool.start`), `{ type: 'tool_result', toolUseId,
isError }` (its output is in `tool.end`), `{ type: <other> }`. Rows give the texts and thinking of
every agent, and the text of injected context (`type: 'attachment'`, `name` such as `skill_listing`,
`instructions`, `environment`); steps give request boundaries, model and usage.

### Tools and permissions

| `kind` | Source | Fields |
|---|---|---|
| `tool.start` | `tool.call`, before `next` | `toolUseId`, `tool`, `input` (the call's arguments) |
| `tool.end` | `tool.call`, after `next` | `toolUseId`, `tool`, `durationMs` (includes permission wait), `isError`, `denied?`, `text`, `stats?` |
| `permission` | `tool.check`, after `next` | `toolUseId`, `tool`, `decision` (`allow`, `ask`, `deny`), `reason?`, `rule?`, `hook?` |

`stats` is filled for `Agent` (`status`, `totalDurationMs`, `totalTokens`, `totalToolUseCount`,
`resolvedModel`, or `outputFile` when backgrounded) and `Skill` (`commandName`, `status`,
`model`).

### Agents

| `kind` | Source | Fields |
|---|---|---|
| `agent.spawn` | `agent.spawn`, after `next` | `toolUseId` (the Agent call), `child` (new `agentId`), `parent` (`parentAgentId` or `null`), `type`, `description`, `prompt`, `model` (resolved), `requestedModel?`, `background`, `fork`, `isTeammate?`, `name?`, `workflow?`, `permissionMode?`, `denied?` |

A subagent's end is its `turn.end` record (same `agent`), plus `tool.end` of the spawning Agent
call when it ran in the foreground.

### Skills

| `kind` | Source | Fields |
|---|---|---|
| `skill.load` | `tool.call` with `tool: 'Skill'` that succeeded | `skill`, `via: 'tool'`, `toolUseId`, `args?`, `status?` (`inline`, `forked`) |
| `skill.load` | `prompt.submit` whose text is `/<name> …` for a listed skill | `skill`, `via: 'command'`, `args?` |
| `skill.expand` | `skill.prompt`, where it reaches a user plugin | `skill`, `textLen` |

`skill.prompt` would also catch skills preloaded into a subagent, but a built-in security plugin
answers it before user plugins in current builds, so `skill.expand` is usually absent and
preloaded skills are not seen.

### Settings hooks

| `kind` | Source | Fields |
|---|---|---|
| `hook` | `classic.*`, timed around `next`, where it reaches a user plugin | `event` (`PreToolUse`, `Stop`, …), `durationMs`, `toolUseId?`, `promptId?`, `outcome` |

`outcome` is the aggregated result of every settings hook on that event: `{ block?, decision?,
stopReason?, preventContinuation?, hasContext? }`. In current builds a built-in security plugin
(`cc-plugin-sec-default`) skips user plugins on every `classic.*` event, so `hook` records are
usually absent. Settings hooks are still seen: each run leaves a `row` with `origin.kind: 'hook'`
(`origin.event` names the event, `name` is `hook_success`, `hook_additional_context`, …), and the
viewer joins it by `uuid` to the transcript (`session.info.transcriptPath`), whose attachment holds
`hookName`, `command`, `durationMs`, `exitCode`, `stdout`, `stderr`.

## Building the tree

- Agents: `agent.spawn.parent` → `agent.spawn.child`; `null` is the main loop.
- A subagent's node hangs from the Agent call that spawned it: `agent.spawn.toolUseId` =
  `tool.start.toolUseId`.
- Steps: `step.start` / `step.end` with the same `agent`, `turnId` and `index`. A step's tools are
  the `tool_use` blocks of the assistant `row` records of that agent between its `step.start` and
  its next one (to be confirmed against real logs).
- Turns of the main loop open with `turn.start` and close with the `turn.end` whose `agent` is
  `null`. A subagent's turns have no `turn.start`: they open at its `agent.spawn` (first run) or at
  its first `step.start` after a previous `turn.end` (a later run).
- Rows, tools, permissions and hooks belong to the agent in their `agent` field, in `seq` order.
