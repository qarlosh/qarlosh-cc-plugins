#!/usr/bin/env python3
"""Regression check for session-flow: does the collector still see what it used to?

Run it after updating Claude Code. It starts a short scripted session in a
temporary folder with the plugin loaded (`claude -p --plugin-dir`), a Bash call
and an Explore subagent, then checks the session's log record by record.

    python3 tools/selfcheck.py [--model haiku] [--keep]

Costs one short model session. Needs `claude` on the PATH and logged in.
Exit code 0 when every required check passes.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
PROMPT = (
    "Run `ls` in this folder with Bash. Then use the Explore subagent to read every .txt file "
    "here and report their contents. Answer in one line."
)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--model", default="haiku")
    ap.add_argument("--keep", action="store_true", help="keep the temporary folder and print its path")
    args = ap.parse_args()

    version = subprocess.run(["claude", "--version"], capture_output=True, text=True).stdout.strip()
    work = Path(tempfile.mkdtemp(prefix="session-flow-check-"))
    logs = work / "logs"
    (work / "a.txt").write_text("alpha\n")
    (work / "b.txt").write_text("beta\n")
    env = dict(os.environ)
    # The plugin reads its log folder from its options; point it at the temp folder.
    settings = work / "settings.json"
    settings.write_text(json.dumps({"pluginConfigs": {"session-flow@inline": {"options": {"logDir": str(logs), "flushMs": 500}}}}))

    print(f"Claude Code {version}; plugin {PLUGIN}")
    started = time.time()
    run = subprocess.run(
        ["claude", "-p", "--model", args.model, "--plugin-dir", str(PLUGIN), "--settings", str(settings),
         "--allowedTools", "Bash(ls:*)", "Read", "Glob", "Grep", "Agent", "--output-format", "json", PROMPT],
        cwd=work, capture_output=True, text=True, env=env, timeout=600,
    )
    try:
        out = json.loads(run.stdout)
    except ValueError:
        print("FAIL  the session did not answer:", (run.stderr or run.stdout)[:500])
        return 1
    if out.get("is_error"):
        print("FAIL  the session ended in an error, so the log proves nothing:", str(out.get("result"))[:300])
        print("      (an expired login reads 'Failed to authenticate': run `claude` and /login)")
        return 2
    sid = out.get("session_id")
    log = logs / f"{sid}.jsonl"
    if not log.exists():
        fallback = Path.home() / ".claude" / "flow" / f"{sid}.jsonl"
        if fallback.exists():
            print("note  logDir option not applied; reading the default folder")
            log = fallback
    print(f"session {sid} in {time.time() - started:.0f}s; log {log}")
    if not log.exists():
        print("FAIL  no log written: the plugin did not load, or session.start no longer fires")
        return 1

    recs = [json.loads(line) for line in log.open() if line.strip()]
    kinds = {}
    for r in recs:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    spawns = [r for r in recs if r["kind"] == "agent.spawn"]
    child = spawns[0].get("child") if spawns else None
    tools = [r for r in recs if r["kind"] == "tool.start"]
    rows_tool_use = [b for r in recs if r["kind"] == "row" and r.get("type") == "assistant" for b in r.get("blocks", []) if b["type"] == "tool_use"]
    steps_end = [r for r in recs if r["kind"] == "step.end"]

    checks = [
        ("session.start recorded", kinds.get("session.start", 0) >= 1, True),
        ("prompt and turn.start recorded", kinds.get("prompt") and kinds.get("turn.start"), True),
        ("model requests: step.start and step.end", kinds.get("step.start") and kinds.get("step.end"), True),
        ("token usage on step.end", any(r.get("usage") for r in steps_end), True),
        ("conversation rows (session.append)", kinds.get("row", 0) > 5, True),
        ("tool_use blocks in rows", len(rows_tool_use) >= 2, True),
        ("Bash call: tool.start and tool.end", any(r["tool"] == "Bash" for r in tools) and kinds.get("tool.end"), True),
        ("permission decisions (tool.check)", kinds.get("permission", 0) >= 1, True),
        ("subagent spawn with its id (agent.spawn)", bool(child), True),
        ("subagent's own steps carry its agentId", bool(child) and any(r["kind"] == "step.start" and r.get("agent") == child for r in recs), True),
        ("subagent's tools carry its agentId", bool(child) and any(r["kind"] == "tool.start" and r.get("agent") == child for r in recs), True),
        ("turn.end recorded", kinds.get("turn.end", 0) >= 1, True),
        ("session.end recorded", kinds.get("session.end", 0) >= 1, True),
        ("transcript located (session.info)", kinds.get("session.info", 0) >= 1, False),
        ("skills offered listed (offer.skills)", kinds.get("offer.skills", 0) >= 1, False),
        ("no collector errors", not any(e for r in recs if r["kind"] == "collector.stats" for e in r.get("errors", [])), True),
    ]
    failed = 0
    for name, ok, required in checks:
        tag = "ok  " if ok else ("FAIL" if required else "warn")
        failed += 0 if ok or not required else 1
        print(f"{tag}  {name}")
    unknown = sorted(set(kinds) - {"session.start", "session.info", "session.end", "offer.skills", "collector.stats", "prompt",
                                   "turn.start", "turn.end", "step.start", "step.end", "row", "tool.start", "tool.end",
                                   "permission", "agent.spawn", "skill.load", "skill.expand", "hook"})
    if unknown:
        print(f"note  unknown record kinds: {', '.join(unknown)}")
    print(f"\n{'PASS' if not failed else f'{failed} required check(s) failed'} · record kinds: {json.dumps(kinds)}")
    if args.keep:
        print(f"kept {work}")
    else:
        shutil.rmtree(work, ignore_errors=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
