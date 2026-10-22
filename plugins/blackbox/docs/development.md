# blackbox — development

How the code is laid out, how to work on it, what it relies on that Claude Code does not document,
and what is left to do. Read this first when picking the plugin up in a new session; then
[design.md](design.md) (why it is shaped this way), [events.md](events.md) (the log format) and
[limitations.md](limitations.md) (what users see as gaps).

## Code map

| File | What it is |
|---|---|
| `.claude-plugin/plugin.json` | Manifest and options (`enabled`, `logDir`, `maxTextChars`, `flushMs`) |
| `hooks/hooks.json`, `hooks/register.tsx` | The collector, a mod (function hooks). One `Collector` object holds the state; functions that use `$` live at the top level of the file (the validator requires it) |
| `tests/no-interference.test.ts` | Engine tests: a tool call and a prompt pass through unchanged |
| `viewer/server.py` | Local server (stdlib only): serves the page, lists logs, returns records from an offset, infers hook configuration (settings and plugins), reads the transcript for hook detail and the session's entrypoint |
| `viewer/app.js` | The page, plain JS. `build()` turns records into the tree model (agents merged with their Agent calls); `computeVisible()` applies filters, scope and promotion; `drawGantt()` is the timeline, `drawDiagram()` the sequence diagram (both take their lanes from `laneList()`, which applies the agent scope); `loadComponents()`/`collect()` the components view; `health()` the log checks |
| `viewer/index.html`, `viewer/style.css` | Layout and theme (dark and light, colour per kind and tool family) |
| Viewer preferences | `savePrefs()`/`loadPrefs()` keep view, filters, sidebar and inspector width in `localStorage` (`blackbox-prefs`, per origin, so per port) |
| `tools/hook-timings.py` | Per-event hook time from a `--debug` log: the collector's real cost |
| `tools/selfcheck.py` | Regression check: a scripted `claude -p` session, then the log is checked record by record |

## Working on it

- **Collector, live in Claude Desktop**: symlink the plugin folder into the session's mods folder,
  `~/.claude/dev-mods/<session-id>/blackbox`, and accept hot reloading when asked. Each edit
  reloads when the turn that made it ends. In a terminal: `claude --plugin-dir plugins/blackbox`.
- **Checks**: `claude plugin validate plugins/blackbox`, `claude plugin test plugins/blackbox`,
  and `tsc` (once the plugin has loaded, `.claude-plugin/types/` holds the engine's types and
  `tsconfig.json` extends them; that folder is ignored by git).
- **Viewer**: run a second server on another port against the working copy, so an installed
  version on 7777 keeps running: `python3 viewer/server.py --port 7788`. It sends `no-store`, so a
  reload picks up edits. The installed copy lives in `~/.claude/plugins/cache/` and does not change
  until the plugin is updated.
- **Debugging the engine side**: `claude -p --debug --plugin-dir …` writes
  `~/.claude/debug/<session-id>.txt`; grep it for `blackbox` to see each hook's time and any hook
  the engine skipped (`bypassed by …`).
- **Releasing**: bump `version` in `plugin.json`, then `claude plugin marketplace update
  qarlosh-cc-plugins` and `claude plugin update blackbox@qarlosh-cc-plugins`, and restart the
  sessions that use it. The next `/blackbox` replaces a viewer of the old version still running
  on the port (`--open` compares the running server's `/api/info` root with its own). An idle viewer
  stops after `--idle-hours` (8) without requests.

## Platforms

Tested on macOS only. The collector shells out three times, each written for both families:

| Step | macOS and Linux | Windows (`OS=Windows_NT`, untested) |
|---|---|---|
| Append to the log (`flush`) | `sh -c 'mkdir -p … && cat >> …'` | PowerShell `[IO.File]::AppendAllText` |
| Find the transcript (`locateTranscript`) | `find ~/.claude/projects -maxdepth 2 -name …` | PowerShell `Get-ChildItem -Depth 1` |
| Start the viewer (`openViewer`) | `nohup python3 server.py … &` | PowerShell `Start-Process -WindowStyle Hidden python` |

The viewer server is plain Python: it opens the browser with `webbrowser` and stops an older viewer
through `POST /api/shutdown` (with the `X-Blackbox: shutdown` header); `lsof` and `ps` are only
a fallback for viewers older than 0.5.1. Home is `HOME`, else `USERPROFILE`.

## After a Claude Code update

Run `python3 tools/selfcheck.py`. It needs `claude` logged in (an expired login makes the session
fail; the script says so and exits with 2). Every required check failing points at one event or
behaviour below; the viewer's health badge shows the same kind of signs on real sessions.

## What it relies on that is not documented

Found by testing on Claude Code 2.1.295–2.1.296. Each is a guess about the engine's behaviour that
held then; if a check fails, start here.

| Behaviour | Where it is used | How it was found |
|---|---|---|
| The mod API itself (event names and fields) is "early access" and may change without notice | Everything in `register.tsx` | The types file says so |
| `cc-plugin-sec-default` skips user plugins on every `classic.*` event, and answers `skill.prompt` first | Why the collector hooks neither, and skills come from the Skill tool | `--debug`: `classic.<Event> bypassed by cc-plugin-sec-default`; from 2.1.308 also a line in the conversation per skip |
| In a session that fails to authenticate, `classic.*` events do reach the plugin | Explains `hook` records in old logs of failed sessions | Seen twice, both with an expired login (0.6) |
| Each settings-hook run leaves a conversation row: `session.append` with `origin.kind: 'hook'`, `origin.event`, `name` such as `hook_success`, and no payload | How the viewer sees hooks at all | Logs |
| Hook rows are appended after the tool ends, not when the hook runs | Attaching hooks to the tool just ended | Record order in logs |
| The transcript keeps no `hook_success` detail, except `UserPromptSubmit` (`hookName`, `command`, `durationMs`) | `transcript_hooks()` in the server | Grep over transcripts |
| Claude Desktop registers its own hooks as SDK callbacks: `PostToolUse` on every tool, `PreToolUse` on some, two `Stop` | Attributing extra hook rows to "Claude Desktop app" | Hook counts per tool; `stop_hook_summary` lists `command: "callback"` |
| The transcript's first rows carry `entrypoint` (`claude-desktop`, `cli`, `sdk-cli`) | Detecting Desktop sessions | Transcript |
| Transcripts live at `~/.claude/projects/<dir>/<session-id>.jsonl`, subagents' under `<session-id>/subagents/agent-<id>.jsonl` | `locateTranscript()` (find by id) and the server | Filesystem |
| Settings hooks: `hooks.<Event>[].{matcher, hooks[].command}` in user, project and plugin `hooks/hooks.json`; enabled plugins in `enabledPlugins`; install paths in `~/.claude/plugins/installed_plugins.json` (`plugins.<key>[].installPath`, `scope`, `projectPath`) | `hook_config()` in the server | Files on disk |
| Plugins under `~/.claude/skills/<name>/.claude-plugin/` load as plugins with their hooks | `hook_config()` | A plugin kept in `~/.claude/skills` |
| Engine events carry no timestamps; `Date` and `performance.now()` work in the mod's environment | `ts` of every record | Tests |
| Thinking blocks sometimes reach plugins with empty text (Opus 5.5 and Haiku 5.5 in Desktop: always, in one session) | "Empty thinking" toggle | Logs |
| Subagents get no `turn.start`; their `turn.complete` and `turn.step` carry `agentId` | Building agent runs | Logs |
| `agent.spawn` resolves at launch: its result has only `{ model, agentId }` | End of an agent comes from its `turn.end` | Types and logs |
| The agent listing reaches the model as an attachment row `agent_listing_delta` whose text has lines `- <type>: <description>` | "Offered" agent types in the components view | Logs |
| `$.session.usage({ breakdown: 'summary' })` lists the skills offered (`context.breakdown.skills.skillFrontmatter`) | `offer.skills` | Types |
| A mod's own `next.trace` covers only the links beneath it, so it cannot time its own round trip | Why cost is measured from `--debug` logs | Types |
| On Desktop a pane `Link` opens only `https:` URLs | Why `/blackbox` opens the viewer with `open` | Types |
| Built-in tool names (about 70) | `FAMILIES` in `app.js`; unknown tools show as Other and the health check lists them | `.claude-plugin/types/claude-code-tools/index.d.ts` |

## Status and what is left

Done: event format, collector, web viewer (tree with agents as the backbone, timeline, sequence
diagram, components view, inspector, presets, agent scope, kinds and tool families, promotion of hidden kinds, hook
inference, health checks, help), `/blackbox`, cost measurement, self-check.

Left for later sessions, roughly in order of value:

1. **Desktop pane**: a compact live view inside Claude Desktop (a "now" strip with running agents and
   tools, the agent backbone), opening the web viewer for detail. See the `plugin-authoring` skill
   for panes (`$.ui.open`, `ui.render`, the `Client` element for interaction).
2. **Expectations**: rules such as "under `~/work`, a PR URL in the prompt should load skill X",
   checked by the components view, with the sessions that broke them.
3. **Workflows**: agents launched by a workflow carry `agent.spawn.workflow { runId, agentIndex }`;
   group them under their run and show its phases (parallel, pipeline).
4. **More views**: flame graph of time or tokens, files (who read or edited each file).
5. **Smaller**: per-command hook detail if a later Claude Code exposes it; deduplicate the injected
   context repeated on every turn (log size); the components view reads every log in the browser,
   which will need a server-side index once there are hundreds of sessions.

## Removed hooks

0.7.2 removed two hooks that `cc-plugin-sec-default` skipped in every normal session, because
Claude Code 2.1.308 started showing a line in the conversation for each skip:

| Hook | Recorded | Replaced by |
|---|---|---|
| `classic.*`, timed around `next` | `hook` (event, duration, tool or prompt id, aggregated outcome) | Hook rows (`row` with `origin.kind: 'hook'`) joined to the transcript |
| `skill.prompt` | `skill.expand` (skill, text length); would also catch skills preloaded into a subagent | `skill.load` from the Skill tool and `/<name>` prompts |

The viewer and `tools/selfcheck.py` still read both kinds. To restore them, check first that the
skip is gone: in a session started with `claude --debug`, no `bypassed by cc-plugin-sec-default`
lines for `classic.*` or `skill.prompt`. Then bring the two hooks back from 0.7.1:

```bash
git show 8333b2b:plugins/blackbox/hooks/register.tsx | sed -n "/on('skill.prompt'/,\$p"
```

`8333b2b` is the 0.7.1 commit, the last with both hooks.
