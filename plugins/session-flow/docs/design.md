# session-flow — design

See what a Claude Code session actually did: which subagents ran (and what they spawned), which
tools, skills and hooks fired, with every text and result, organised so a long cascade stays
readable. Built for two uses:

- **Live**: follow a long task while it runs.
- **After the fact**: review a finished session calmly, and check that your own subagents, skills
  and hooks are used the way you expect.

Status: collector and web viewer working (tree, timeline, components). What is left, and how to
work on the code: [development.md](development.md). Targets the function-hooks (mod) API of Claude Code 2.1.295.

## Architecture

Three parts that share one contract, the event log ([events.md](events.md)):

1. **Collector** (the mod, `hooks/register.tsx`). Observes engine events without changing them
   (every hook calls `next(e)` untouched) and appends normalised records to
   `<logDir>/<sessionId>.jsonl`. It captures what the transcript does not keep: which agent
   spawned which, permission decisions, settings-hook events and their aggregated outcome,
   agent types and skills offered to the model.
2. **Desktop pane** (same mod). A compact live view: a "now" strip (running agents, current tool,
   elapsed time) and the tree. Links to the web viewer.
3. **Web viewer** (`viewer/`). A local page plus a minimal server that reads every log in
   `<logDir>`: all views, the inspector, filters. Works on finished sessions and follows a live
   one as its log grows.

The log is the only contract: the viewer can evolve without touching the mod. Logs live outside
any repo (default `~/.claude/flow/`): they hold session content.

Only sessions where the mod is active are recorded. Importing old transcripts is out of scope.

## No interference (requirements)

The collector is a profiler: it must not change what the session does, and its cost must be
close to zero. These rules are requirements; the collector is written and tested against them.

Behaviour:

- **Observe only.** Every hook passes the event on untouched (`next(e)`) and returns what `next`
  returned. Never `deny`, `drop` or a rewritten event: the model, permissions and the user's own
  hooks see exactly what they would without the mod.
- **Zero context.** No `prompt.compose`, no registered tools, agents or skills, no
  `$.session.append`: the model does not know the mod exists and spends no tokens on it.
- **No model calls.** Nothing under `$.model`.
- **Failures stay inside.** Every hook wraps its own work in `try/catch`; a collector error is
  recorded and never reaches the engine.
- **Do not touch streams.** `turn.step` is a stream, and a hook that fails mid-stream is left where
  it stood, which could cut a response. The collector never iterates its chunks: it only does
  `const r = yield* next(e)` and reads the result afterwards.

Performance:

- **`next` first, record after.** Nothing of the collector's own is awaited before `next(e)`.
  Recording pushes an object onto an in-memory buffer.
- **No disk inside hooks.** A separate timer flushes the buffer, only when it holds something,
  every `flushMs` (default 3000).
- **Expensive reads once.** `$.session.usage` runs at session start and on reload, never per turn.
- **Quick shutdown.** `session.end` shares about 1.5 s with other plugins: it only writes what is
  buffered.
- **Few events.** The main cost is not the collector's code but the round trip to the plugin's
  process that every hooked event costs, while the engine waits. Hook only events that carry
  something the log needs (`agent.offer` was dropped for this).
- **Measured, not assumed.** `collector.stats` records the time in the collector's own code; the
  round trip can only be measured from outside, with `tools/hook-timings.py` over a `--debug` log.
  Compare a task with the plugin enabled and disabled too.
- **Off switch.** The `enabled` option makes `register` hook nothing; `claude plugin disable
  session-flow` stops it loading at all.

## Organising the information

- **Fixed hierarchy**: session → turn → agent → step (one model request: its text, thinking and
  the tools it called together) → tool call. Parallel calls group naturally under their step.
- **Meaningful labels, not ids**: a subagent is its `description`; a Bash call is its
  `description`; the text an agent writes ("Checking the API…") titles the stretch that follows,
  so a long cascade reads as a story in phases.
- **Collapse repetition**: consecutive calls to one tool fold into `Bash ×7`.
- **Rolled-up totals per node**: duration, tokens, cost, tool count, errors, summed over
  everything beneath, so the heavy branch stands out.
- **Three levels of detail**: one line per row → expanded row with input/output excerpts →
  inspector with everything (full prompt of a subagent, model, depth, spawner, full output,
  thinking, hooks fired around the call).

## Agents are the backbone

The agent is the only kind that nests without a fixed limit (agent → step → Agent call → agent →
…, capped only by the spawn-depth setting); everything else ends within two or three levels
(step → tool → hook). So the tree has two axes:

- **Backbone**: the agent hierarchy, who launched whom. The Agent call that launched an agent is
  merged into it: one row per agent, whose inspector shows the call (input, permission, hooks,
  result) and the run (prompt, model, steps, answer).
- **Content**: what each agent did, filtered by kind. Hiding a kind never hides its children: they
  move up to the nearest shown parent, and a moved row says where it came from ("in Bash: …").
- Agents are not filtered by kind but by **scope**: all agents, the main agent only (subagents shown
  as single rows), or one agent (its subtree, with the path to it).

## Interaction

- Presets: Everything, Agents only (the backbone), Hooks only, Tools only, Conversation, No context.
- Filters: kinds of content (⌥-click shows only one), tool families and tool names, agent scope,
  errors/denials only, duration above a threshold, empty thinking blocks, text search.
- Navigation: breadcrumb (`main › reviewer › …`), jump to parent or to the spawning call, next
  error, follow live, keyboard shortcuts.
- Linked views: selecting a node in one view selects it in all, and opens the inspector.

## Views

| View | Answers | Status |
|---|---|---|
| Tree with time bars | What happened, in what order (the navigation base) | Done |
| Timeline (Gantt, one lane per agent, idle gaps folded) | What ran in parallel, where the waits were | Done |
| Components | Per subagent type / skill / hook, across sessions: how often, where, triggered by what | Done |
| Swimlanes | Who spawned whom, and when each answer came back | Later |
| Flame graph / icicle | Where time or tokens went | Later |
| Files | Who read or edited each file | Later |
| Now strip | What is running at this moment | Later, with the Desktop pane |

The **components** view serves the "is it used as I expect?" question: a subagent's invocations
(who spawned it, with what prompt, cost) and the turns it was offered but not used; a hook's
firings and outcomes; a skill's loads versus the turns it was listed and not loaded, with the
prompt each time. A later step: user-written expectations ("under `~/work`, a PR URL in the prompt
should load skill X") checked by the viewer.

The viewer should look good, not like a plain admin table: strong visual hierarchy, colour that
encodes kind, subtle motion for live updates, dark mode.

## Roadmap

1. Event format ([events.md](events.md)). Done.
2. Collector, no UI, writing the log. Done.
3. Web viewer: tree, inspector, filters. Done, with presets, agent scope and tool families.
4. Components view and the timeline. Done; health checks, help and `tools/selfcheck.py` added.
5. Desktop pane, expectations, workflows, the remaining views: see
   [development.md](development.md#status-and-what-is-left).

## Constraints found in the API (2.1.295)

What these mean in use (symptom → cause) is in [limitations.md](limitations.md).

- No timestamps on engine events: the collector stamps each record with `$.clock.now()`.
- No `$.fs.append`, and `$.fs.write` writes whole files (4 MiB cap): the collector buffers records
  and flushes them with `$.process.run(["/bin/sh", "-c", "cat >> \"$0\"", path], { stdin })`.
- `session.end` gets about 1.5 s shared with other plugins: the final flush must be quick.
- A built-in security plugin (`cc-plugin-sec-default`, tier `prepend`) skips user plugins on every
  `classic.*` event and answers `skill.prompt` before them. Settings hooks are therefore seen
  through the rows they leave (`session.append` with `origin.kind: 'hook'`), joined by the viewer
  to the transcript's `hook_success` / `hook_additional_context` attachments for the per-command
  detail (hook name, command, duration, exit code, output). The collector finds the transcript
  itself.
- Where a hook comes from (user, project or plugin settings) is not reported anywhere; it can be
  inferred by matching the command against settings and plugin hook files.
- Skill loads come from the Skill tool call (`tool.call` with `tool: "Skill"`) and from a prompt
  typed as `/name`. Skills preloaded into a subagent are not seen.
- On Desktop a pane `Link` opens only `https:` URLs; the viewer is opened with
  `$.process.run(["open", url])` from a slash command.
- `$.process.spawn` dies with the session; a viewer server that outlives it is started detached.
