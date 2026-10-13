#!/usr/bin/env python3
"""Per-event time of a plugin's hooks, from a Claude Code debug log.

Run a session with --debug (the log lands in ~/.claude/debug/<session-id>.txt), then:

    python3 hook-timings.py ~/.claude/debug/<session-id>.txt [plugin]

Each time includes the round trip to the plugin's process and what the engine
does beneath the hook (`next()`); on events where the engine does little
(session.append, agent.offer) it is close to the round trip alone.
"""

import collections
import re
import statistics
import sys

path = sys.argv[1]
plugin = sys.argv[2] if len(sys.argv) > 2 else "session-flow"
pat = re.compile(rf"hooks module {re.escape(plugin)}@\S+ (\S+) settled in ([\d.]+)ms")
times = collections.defaultdict(list)
with open(path, encoding="utf-8", errors="replace") as f:
    for line in f:
        m = pat.search(line)
        if m:
            times[m.group(1)].append(float(m.group(2)))
if not times:
    sys.exit(f"no hook timings for {plugin} in {path}")
print(f"{'event':18} {'calls':>5} {'median':>8} {'max':>9} {'total':>9}  (ms, next() included)")
for event, v in sorted(times.items(), key=lambda kv: -sum(kv[1])):
    print(f"{event:18} {len(v):5} {statistics.median(v):8.1f} {max(v):9.1f} {sum(v):9.1f}")
