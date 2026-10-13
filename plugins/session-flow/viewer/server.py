#!/usr/bin/env python3
"""session-flow viewer: a local web server over the session logs.

Serves the page in this folder and a small JSON API that reads the logs the
collector writes (default ~/.claude/flow). Listens on 127.0.0.1 only. No
dependencies beyond the Python 3 standard library.

    python3 server.py [--port 7777] [--log-dir ~/.claude/flow] [--open [SESSION_ID]]
"""

import argparse
import json
import os
import re
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
SID_RE = re.compile(r"^[A-Za-z0-9-]{8,64}$")
LIVE_SECONDS = 15
HEAD_LINES = 400

_hooks_cache: dict = {}
_hooks_lock = threading.Lock()


def read_head(path: Path, max_lines: int = HEAD_LINES):
    out = []
    with path.open("r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f):
            if i >= max_lines:
                break
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    return out


def read_tail(path: Path, max_bytes: int = 16384):
    with path.open("rb") as f:
        f.seek(0, os.SEEK_END)
        size = f.tell()
        f.seek(max(0, size - max_bytes))
        lines = f.read().splitlines()
    out = []
    for raw in lines:
        try:
            out.append(json.loads(raw))
        except ValueError:
            continue
    return out


def summarize(path: Path):
    head = read_head(path)
    tail = read_tail(path)
    last = tail[-1] if tail else {}
    stat = path.stat()
    first = head[0] if head else {}
    start = next((r for r in head if r.get("kind") == "session.start"), {})
    prompt = next(
        (r for r in head if r.get("kind") == "prompt" and r.get("origin") not in ("task-notification",)),
        None,
    )
    return {
        "sid": path.stem,
        "title": (prompt or {}).get("text", "")[:300],
        "cwd": start.get("cwd"),
        "startedAt": first.get("ts"),
        "endedAt": last.get("ts"),
        "ended": any(r.get("kind") == "session.end" for r in tail[-5:]),
        "size": stat.st_size,
        "live": stat.st_mtime > time.time() - LIVE_SECONDS,
    }


def transcript_hooks(log: Path):
    """Per-run detail of settings hooks, from the session's transcript, keyed by row uuid."""
    info = next((r for r in read_head(log, 100000) if r.get("kind") == "session.info"), None)
    if not info or not info.get("transcriptPath"):
        return {}
    main = Path(info["transcriptPath"])
    files = [main] + sorted((main.parent / main.stem / "subagents").glob("agent-*.jsonl"))
    files = [f for f in files if f.is_file()]
    key = tuple((str(f), f.stat().st_mtime, f.stat().st_size) for f in files)
    with _hooks_lock:
        cached = _hooks_cache.get(log)
        if cached and cached[0] == key:
            return cached[1]
    hooks = {}
    for f in files:
        with f.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"hook' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                a = r.get("attachment") or {}
                if r.get("type") != "attachment" or not str(a.get("type", "")).startswith("hook"):
                    continue
                hooks[r.get("uuid")] = {
                    "type": a.get("type"),
                    "hookName": a.get("hookName"),
                    "hookEvent": a.get("hookEvent"),
                    "toolUseId": a.get("toolUseID"),
                    "command": a.get("command"),
                    "durationMs": a.get("durationMs"),
                    "exitCode": a.get("exitCode"),
                    "stdout": (a.get("stdout") or "")[:20000],
                    "stderr": (a.get("stderr") or "")[:20000],
                    "content": a.get("content") if isinstance(a.get("content"), str) else None,
                }
    with _hooks_lock:
        _hooks_cache[log] = (key, hooks)
    return hooks


def load_json(path: Path):
    try:
        with path.open("r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def hooks_from(data, source, root=None):
    out = []
    for event, groups in ((data or {}).get("hooks") or {}).items():
        for g in groups if isinstance(groups, list) else []:
            for h in g.get("hooks") or []:
                cmd = h.get("command") or h.get("url") or h.get("prompt") or ""
                if root:
                    cmd = cmd.replace("${CLAUDE_PLUGIN_ROOT}", root)
                out.append({"event": event, "matcher": g.get("matcher"), "type": h.get("type"), "command": cmd, "source": source})
    return out


def hook_config(cwd):
    """Settings hooks that could run in a session started in `cwd`: user and
    project settings, and the hooks of enabled plugins. The engine does not say
    which one ran; the viewer matches them by event and matcher."""
    home = Path.home()
    out = []
    enabled = {}
    user = load_json(home / ".claude" / "settings.json") or {}
    out += hooks_from(user, "user settings")
    enabled.update(user.get("enabledPlugins") or {})
    project_dirs = []
    if cwd:
        p = Path(cwd)
        while p != p.parent and p != home:
            project_dirs.append(p)
            p = p.parent
    for d in project_dirs:
        for name in ("settings.json", "settings.local.json"):
            data = load_json(d / ".claude" / name)
            if data:
                out += hooks_from(data, f"{d / '.claude' / name}")
                enabled.update(data.get("enabledPlugins") or {})
    installed = (load_json(home / ".claude" / "plugins" / "installed_plugins.json") or {}).get("plugins") or {}
    for key, on in enabled.items():
        if not on:
            continue
        for inst in installed.get(key) or []:
            proj = inst.get("projectPath")
            if inst.get("scope") in ("local", "project") and proj and not any(str(d) == proj for d in project_dirs):
                continue
            root = inst.get("installPath")
            if root:
                out += hooks_from(load_json(Path(root) / "hooks" / "hooks.json"), f"plugin {key}", root)
                break
    for manifest in (home / ".claude" / "skills").glob("*/.claude-plugin/plugin.json"):
        root = manifest.parent.parent
        out += hooks_from(load_json(root / "hooks" / "hooks.json"), f"plugin {root.name} (skills folder)", str(root))
    return out


def session_entrypoint(log: Path):
    """How the session was started (claude-desktop, cli, sdk-cli…), from its transcript."""
    info = next((r for r in read_head(log, 100000) if r.get("kind") == "session.info"), None)
    path = Path(info["transcriptPath"]) if info and info.get("transcriptPath") else None
    if not path or not path.is_file():
        return None
    for r in read_head(path, 50):
        if r.get("entrypoint"):
            return r["entrypoint"]
    return None


# Hooks the host app registers through the SDK: they run as callbacks, so no
# settings file lists them. Claude Desktop adds PostToolUse on every tool, some
# PreToolUse and two Stop hooks.
HOST_HOOKS = {
    "claude-desktop": {"command": "Claude Desktop app", "source": "host app (SDK callback)"},
}


class Handler(SimpleHTTPRequestHandler):
    log_dir: Path = Path.home() / ".claude" / "flow"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_path(self, sid):
        if not SID_RE.match(sid or ""):
            return None
        p = self.log_dir / f"{sid}.jsonl"
        return p if p.is_file() else None

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        parts = [p for p in url.path.split("/") if p]
        if parts[:1] != ["api"]:
            if url.path not in ("/", "/index.html", "/app.js", "/style.css"):
                self.send_error(404)
                return
            return super().do_GET()
        try:
            if parts == ["api", "sessions"]:
                logs = sorted(self.log_dir.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
                return self.send_json([summarize(p) for p in logs])
            if len(parts) == 4 and parts[1] == "session" and parts[3] in ("records", "hooks", "hookconfig"):
                log = self.log_path(parts[2])
                if not log:
                    return self.send_json({"error": "unknown session"}, 404)
                if parts[3] == "hooks":
                    return self.send_json(transcript_hooks(log))
                if parts[3] == "hookconfig":
                    start = next((r for r in read_head(log, 50) if r.get("kind") == "session.start"), {})
                    conf = hook_config(start.get("cwd"))
                    host = HOST_HOOKS.get(session_entrypoint(log) or "")
                    if host:
                        conf.append({"event": "*", "matcher": None, "type": "callback", "host": True, **host})
                    return self.send_json(conf)
                offset = int((q.get("offset") or ["0"])[0])
                with log.open("rb") as f:
                    f.seek(offset)
                    data = f.read()
                end = data.rfind(b"\n") + 1
                records = []
                for raw in data[:end].splitlines():
                    try:
                        records.append(json.loads(raw))
                    except ValueError:
                        pass
                return self.send_json({"offset": offset + end, "records": records})
            self.send_json({"error": "not found"}, 404)
        except (OSError, ValueError) as err:
            self.send_json({"error": str(err)}, 500)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=7777)
    ap.add_argument("--log-dir", default=os.environ.get("SESSION_FLOW_LOG_DIR") or "~/.claude/flow")
    ap.add_argument("--open", nargs="?", const="", metavar="SESSION_ID", help="open the viewer in the browser")
    args = ap.parse_args()
    Handler.log_dir = Path(os.path.expanduser(args.log_dir))

    # A viewer already running on the port: just open it.
    if args.open is not None:
        try:
            from urllib.request import urlopen

            with urlopen(f"http://127.0.0.1:{args.port}/api/sessions", timeout=1) as r:
                if isinstance(json.load(r), list):
                    webbrowser.open(f"http://127.0.0.1:{args.port}/" + (f"#{args.open}" if args.open else ""))
                    return
        except (OSError, ValueError):
            pass

    server = None
    for port in range(args.port, args.port + 20):
        try:
            server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
            break
        except OSError:
            continue
    if not server:
        sys.exit(f"no free port from {args.port}")
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"session-flow viewer: {url}  (logs: {Handler.log_dir})", flush=True)
    if args.open is not None:
        webbrowser.open(url + (f"#{args.open}" if args.open else ""))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
