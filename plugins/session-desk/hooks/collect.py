# Helper for the session-desk pane, run with python3.
#
#   collect.py list <days>  reads the desktop app's session records, its sidebar sections,
#                           projects and pins, and the tail of each transcript, and prints
#                           one JSON object: sessions used within <days>, and older ones.
#   collect.py open <url>   opens a claude:// link with the system's handler for it.
#
# The desktop app's records and preferences are undocumented: whatever cannot be read is
# left out rather than failing the whole listing.
import glob
import json
import os
import subprocess
import sys
import time

if sys.argv[1] == 'open':
    # The system's own handler for the scheme: webbrowser would hand claude:// to a browser.
    url = sys.argv[2]
    if sys.platform == 'darwin':
        subprocess.run(['open', url], check=True)
    elif sys.platform == 'win32':
        os.startfile(url)
    else:
        subprocess.run(['xdg-open', url], check=True)
    sys.exit(0)

days = float(sys.argv[2])
home = os.path.expanduser('~')
roots = [os.path.join(home, 'Library/Application Support/Claude'),
         os.path.join(os.environ.get('APPDATA', ''), 'Claude')]
since = (time.time() - days * 86400) * 1000


def epitaxy(root):
    try:
        prefs = json.load(open(os.path.join(root, 'claude_desktop_config.json')))
        return prefs['preferences']['epitaxyPrefs']
    except Exception:
        return {}


def sections(prefs):
    # Undocumented desktop preferences: any failure just means no section labels.
    try:
        out = {}
        for scope in prefs['dframe-group-scopes'].values():
            names = {g['id']: g['name'] for g in scope.get('groups', [])}
            for key, gid in scope.get('assignments', {}).items():
                if key.startswith('code:') and gid in names:
                    out[key[5:]] = names[gid]
        return out
    except Exception:
        return {}


def pinned(prefs):
    try:
        return {key[5:] for key in prefs['dframe-local-slice']['pinnedOrder'] if key.startswith('code:')}
    except Exception:
        return set()


def tail(cli):
    found = glob.glob(os.path.join(home, '.claude/projects/*/%s.jsonl' % cli)) if cli else []
    user, reply, recap = '', '', ''
    if not found:
        return user, reply, recap
    with open(found[0], 'rb') as fh:
        fh.seek(0, 2)
        fh.seek(max(0, fh.tell() - 400000))
        lines = fh.read().decode('utf-8', 'replace').splitlines()[1:]
    for line in lines:
        try:
            e = json.loads(line)
        except Exception:
            continue
        c = (e.get('message') or {}).get('content')
        if e.get('type') == 'user':
            if isinstance(c, str):
                t = c
            elif isinstance(c, list):
                t = ' '.join(x.get('text', '') for x in c if isinstance(x, dict) and x.get('type') == 'text')
            else:
                t = ''
            # Drop the app's reminders so a prompt that starts with one still counts.
            while t.lstrip().startswith('<system-reminder>') and '</system-reminder>' in t:
                t = t.split('</system-reminder>', 1)[1]
            if t.strip() and not t.lstrip().startswith('<'):
                user, reply, recap = t, '', ''
        elif e.get('type') == 'assistant' and isinstance(c, list):
            for x in c:
                if x.get('type') == 'tool_use' and x.get('name', '').endswith('wrap_up'):
                    recap = (x.get('input') or {}).get('recap') or ''
                elif x.get('type') == 'text' and x['text'].strip():
                    reply = x['text'].strip()
    return user, reply, recap


recent, older = [], []
for root in roots:
    prefs = epitaxy(root)
    names = sections(prefs)
    pins = pinned(prefs)
    for f in glob.glob(os.path.join(root, 'claude-code-sessions/*/*/local_*.json')):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get('isArchived'):
            continue
        base = {'id': d['sessionId'], 'title': d.get('title') or '(untitled)',
                'lastActivityAt': d.get('lastActivityAt', 0),
                'section': names.get(d['sessionId'], ''),
                'pinned': d['sessionId'] in pins,
                'folder': os.path.basename((d.get('cwd') or '').rstrip('/'))}
        if base['lastActivityAt'] < since:
            older.append(base)
            continue
        user, reply, recap = tail(d.get('cliSessionId'))
        base.update({'user': ' '.join(user.split())[:400], 'reply': ' '.join(reply.split())[-700:],
                     'recap': ' '.join(recap.split())})
        recent.append(base)

recent.sort(key=lambda s: -s['lastActivityAt'])
older.sort(key=lambda s: -s['lastActivityAt'])
print(json.dumps({'recent': recent, 'older': older}))
