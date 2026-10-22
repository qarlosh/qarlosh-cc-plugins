# session-desk

A pane for Claude Desktop that reminds you of your open Code sessions, so none is left
forgotten for days. `/session-desk` opens it beside the current session.

A selector picks the period listed in full: the last 48 hours, 48 hours to 10 days ago, this
week (since Monday) or the last 30 days. The pane remembers the choice. For each session last
used in that period it shows:

- the title, which opens the session when pressed;
- one line on where the session was left, taken from the session's own wrap-up when it has
  one, or written by a small model (Haiku by default);
- its sidebar section, its project folder, whether it is pinned, and when it was last used.

You keep the list short by hand:

- **✓** marks a session done and moves it to a collapsed "marked done" list, where it can be
  restored. A done session comes back on its own when it gets new activity.
- **●** opens a palette of six colors to mark a session your own way. With `groupByColor`
  on, marked sessions are listed first, grouped by color.
- Open sessions outside the period are counted below the list and can be expanded. Marks and
  done checks belong to the session, not the period: they stay when a session leaves it.

The pane refreshes itself while it is open, and with the **Refresh** button.

## Install

```bash
claude plugin marketplace add qarlosh/qarlosh-cc-plugins
claude plugin install session-desk@qarlosh-cc-plugins
```

## Requirements

- Claude Desktop on macOS or Windows (the pane also draws in the terminal, but reads the
  session records the desktop app keeps).
- `python3` on the `PATH`: a small helper reads the session records and transcripts.

## Options

Set with `claude plugin configure session-desk@qarlosh-cc-plugins`.

| Option | Default | What it does |
|---|---|---|
| `defaultPeriod` | `48h` | The period listed until you pick another: `48h`, `2d-10d`, `week` or `30d` |
| `refreshMinutes` | `10` | How often the open pane refreshes; `0` only on open and on Refresh |
| `model` | `haiku` | The model that writes the one-line summaries |
| `language` | `en` | Language of the pane and the summaries: `en` or `es` |
| `groupByColor` | `true` | List marked sessions first, grouped by color |

## Privacy and limits

- Everything is read locally. For each session without a wrap-up, the last user message and
  the assistant's last reply (a few hundred characters) are sent to the model through your
  own Claude account to write its summary. Summaries are cached until the session changes.
- Marks, done marks and summaries are kept in the plugin's own store. An archived session
  leaves the pane but keeps them, so unarchiving it brings them back; they are dropped once
  the session is deleted.
- The desktop app's session records, sidebar preferences and `claude://` session links are
  not a documented interface. When something cannot be read the pane leaves it out (no
  section label, say) rather than failing; a new app version may still break it.
- Sessions of the terminal CLI that the desktop app did not start are not listed.
