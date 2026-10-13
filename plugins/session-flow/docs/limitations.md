# session-flow — known limitations

What the collector cannot see, or sees differently than you might expect. Each entry: the symptom,
then the cause. Found on Claude Code 2.1.295; later builds may change any of them.

## Not recorded

- **No `hook` records.** A built-in security plugin, `cc-plugin-sec-default` (tier `prepend`),
  skips user plugins on every `classic.*` event (the debug log says `classic.<Event> bypassed by
  cc-plugin-sec-default`). Settings hooks are still visible through the `row` they leave
  (`origin.kind: 'hook'`), and the viewer infers which configured hook each one was (next
  entry). A hook that runs
  without leaving a row is not seen at all. In one session that failed to authenticate the
  `classic.*` events did reach the plugin, so this may depend on the account or its state.
- **Which hook command ran is inferred.** Neither the events nor the transcript of this build say
  which command a hook row belongs to, nor its output or duration (the transcript keeps no
  `hook_success` attachments). The viewer matches the row's event, and the tool it ran around,
  against the hooks configured in user and project settings and in enabled plugins; with several
  candidates it assigns them in order. A hook from a built-in plugin or a `--plugin-dir` plugin
  shows as "not in settings". The transcript keeps the detail of some hooks (`UserPromptSubmit`
  with its command and duration); the viewer uses it where it is there.
- **Hooks of the host app.** Claude Desktop registers its own hooks through the SDK, as callbacks
  that no settings file lists: a `PostToolUse` on every tool, a `PreToolUse` on some, and two `Stop`
  hooks. In a Desktop session (the transcript's `entrypoint` is `claude-desktop`) the viewer
  attributes hook rows beyond the configured ones to "Claude Desktop app". Sessions in a terminal
  have none of these.
- **A hook row may hang from the wrong tool** when several tools of one agent run at once: rows
  carry no tool id, so the viewer attaches them to the only running tool, or the one just ended.
- **No skill preloaded into a subagent.** The same plugin answers `skill.prompt` before user
  plugins. Skill loads are taken from the Skill tool call and from prompts typed as `/<name>`;
  `skill.expand` records appear only where `skill.prompt` reaches the plugin.
- **Empty thinking, sometimes.** Some thinking blocks reach plugins with no text (the row shows a
  `thinking` block with `text: ''`); in other turns of the same session the text is there.
- **Server-side tools** (run by the API, such as the advisor) never fire `tool.call`; they appear
  only in `step.end.serverTools`.
- **A typed `/command` that is not a listed skill** is recorded as a plain prompt.

## Recorded, but not as you might expect

- **Times are the collector's.** Engine events carry no timestamps: `ts` is when the collector saw
  the event (its clock is read once per load, then advanced with `performance.now()`). Order by
  the log's line order, not by `ts`.
- **`tool.end.durationMs` includes the permission wait**, since it is timed around the whole call.
- **A subagent's turn has no `turn.start`.** It starts at its `agent.spawn` (or, for a later run,
  at its first `step.start`).
- **`session.start.cwd` can differ from where the session began.** In Claude Desktop it is the
  session's current primary directory when the module loads. The transcript is found by its
  session id, not from this path.
- **`offer.agent` is recorded once per agent type per module load**, not per turn.

## Gaps and duplicates

- **Up to `flushMs` of events can be lost** when the module reloads (a hot reload while developing
  it) or the process dies: records are buffered and written every `flushMs`. A normal exit flushes,
  but `session.end` has about 1.5 s shared with other plugins.
- **After `/clear`** the session gets a new id; the collector switches to the new log at the next
  prompt.
- **After a module reload** `session.start` is recorded again with `continued: true`, and `seq`
  restarts from 0.

## Cost

- **"Collector code" in the viewer is not the whole cost.** It is the time in the collector's own
  code. Every observed event also makes the engine wait for a round trip to the plugin's process,
  which the plugin cannot measure itself (`next.trace` covers only the links beneath it).
- **Measured on 2.1.295** (`tools/hook-timings.py` over `--debug` logs, a short task with one
  subagent): `session.append`, the most frequent event (one per conversation row), median 0.6 ms;
  `tool.check` about 4 ms; `turn.start` about 4 ms; `session.start` 20 ms, once. These include
  what the engine does beneath the hook. In total, under 200 ms for a 4 s task at worst, and the
  same task took 3.8–4.5 s without the plugin and 3.9–4.7 s with it: within the noise of model
  latency. A long session adds roughly 1 ms per conversation row and a few ms per tool call.

## Size and privacy

- Logs hold full texts: prompts, tool inputs and outputs, and the context the engine injects
  (CLAUDE.md files, skill listings, environment), repeated on every turn that injects them. Expect
  tens of KB for a short session and several MB for a long one. Keep `logDir` outside any
  repository, and lower `maxTextChars` to cap each text.
