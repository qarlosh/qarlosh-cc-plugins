# session-flow

See what a Claude Code session actually did: which subagents ran and what they spawned, every
tool call with its input and output, skills loaded, settings hooks fired, permission decisions,
model requests and token usage, organised as a tree you can filter and navigate. Follow a long
task live, or review a finished session later.

It has two parts:

- **Collector** (a mod): observes the session without changing it and appends one JSON record per
  event to `~/.claude/flow/<session-id>.jsonl`.
- **Viewer**: a local web page over those logs.
  - **Tree**: turns, then what each agent did, with subagents nested under whoever launched them.
  - **Timeline**: one lane per agent, to see what ran in parallel and where the time went.
  - **Components**: your subagent types, skills and hooks across sessions, with where they were
    offered but not used: is each used as you expect?
  - An inspector with every detail, presets, filters, search, keyboard navigation, live follow, a
    health badge that warns when a log looks incomplete, and built-in help (`?`).

## Requirements

- Claude Code with function hooks (mods), 2.1.295 or later.
- Python 3 for the viewer (standard library only).

## Install

```bash
claude plugin install session-flow@my-claude-plugins
```

## Use

- Recording is automatic once the plugin is enabled.
- In a session, `/session-flow` opens the viewer on that session. It starts the viewer's local
  server in the background, or reuses the one already running; after a plugin update it replaces
  the old version's server. The server stops by itself after 8 hours without requests (an open
  viewer page keeps it alive).
- Or run the viewer yourself:

  ```bash
  python3 <plugin>/viewer/server.py --open
  ```

  It listens on `127.0.0.1:7777` (or the next free port) and reads `~/.claude/flow`.

Views: presets (Everything, Agents only, Hooks only, …), an agent scope (all, main only, one
agent), kinds of content and tool families to show or hide (⌥-click a kind to show only it).

Viewer keys: `↑`/`↓` or `j`/`k` move, `→`/`←` open and close, `Enter` toggles, `/` searches,
`e` jumps to the next error, `f` follows the newest activity, `t` switches tree and timeline, `?`
opens the help.

## After updating Claude Code

The collector relies on parts of Claude Code that may change between releases (see
[development.md](docs/development.md#what-it-relies-on-that-is-not-documented)). After an update,
run `python3 tools/selfcheck.py` in the plugin folder: a short scripted session whose log is checked
record by record. The viewer's health badge flags the same problems on real sessions.

## Options

Set with `claude plugin configure session-flow` (or `/config`):

| Option | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Record sessions. Off, the plugin hooks nothing |
| `logDir` | `~/.claude/flow` | Where logs are written |
| `maxTextChars` | `20000` | Longer texts are cut to this length |
| `flushMs` | `3000` | How often buffered records are written |

## Does it affect the session?

In behaviour, no: every hook passes its event on untouched, it adds nothing to the model's
context, makes no model calls, and writes to disk outside the hooks. The one exception is
`/session-flow`, whose one-line answer goes into the conversation like any command's.

In time, a little: Claude Code waits for a round trip to the plugin's process on every observed
event, about 1 ms per conversation row and a few ms per tool call. Measured on a short task, the
difference was within the noise of model latency. The viewer's "collector code" figure is only the
plugin's own code; to measure the whole, run a session with `--debug` and
`python3 tools/hook-timings.py ~/.claude/debug/<session-id>.txt`. Details in
[limitations.md](docs/limitations.md#cost).

## Privacy

Logs hold full texts: prompts, tool inputs and outputs, and the context Claude Code injects
(CLAUDE.md files, skill listings). They stay on your machine; keep `logDir` outside any repository.
The viewer listens on localhost only and loads nothing from the network.

## Docs

- [design.md](docs/design.md): goals, architecture, the no-interference rules.
- [events.md](docs/events.md): the log format.
- [limitations.md](docs/limitations.md): what it cannot see, and why. Read this first if something
  looks missing.
- [development.md](docs/development.md): code map, how to work on it and release it, what it
  relies on that Claude Code does not document, and what is left to do.

## License

[MIT](../../LICENSE)
