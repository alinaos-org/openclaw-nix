#!/usr/bin/env python3
"""Fold a Control UI overlay (runtime shape) into a gateway's source config.

usage: fold-overlay.py <overlay.json> <source openclaw.json> [renames.json]

Each overlay entry (a set or delete at a path, from `openclaw-overlay-<name>
preview`) is written into the source config:

- agents.entries.<id>... goes to the agent with that id in agents.list when the
  source keeps its roster as a list (nix-openclaw's shape); a whole-agent
  replacement or an agent the source does not have is reported, not folded.
- renames.json, a list of {"from": [...], "to": [...]}, maps a runtime path
  prefix to the source's own spelling, applied only where the `to` path already
  exists in the source (for example a key the host's render transform renames).
- Everything else is written at its own path.

Prints a commit-message body listing what was folded and what was not.
"""
import json
import sys

DELETE = object()


def put(cfg, path, value):
    node = cfg
    for k in path[:-1]:
        if not isinstance(node.get(k), dict):
            if value is DELETE:
                return
            node[k] = {}
        node = node[k]
    if value is DELETE:
        node.pop(path[-1], None)
    else:
        node[path[-1]] = value


def exists(cfg, path):
    node = cfg
    for k in path:
        if not isinstance(node, dict) or k not in node:
            return False
        node = node[k]
    return True


def to_source(src, path, renames):
    for rule in renames:
        prefix, target = rule["from"], rule["to"]
        if path[: len(prefix)] == prefix and exists(src, target):
            return target + path[len(prefix):]
    return path


def main():
    overlay = json.load(open(sys.argv[1], encoding="utf-8"))
    src_path = sys.argv[2]
    renames = json.load(open(sys.argv[3], encoding="utf-8")) if len(sys.argv) > 3 else []
    src = json.load(open(src_path, encoding="utf-8"))
    roster = src.get("agents", {}).get("list")
    agents = {a.get("id"): a for a in roster} if isinstance(roster, list) else None
    folded, skipped = [], []
    for e in overlay.get("entries", []):
        path = e["path"]
        value = DELETE if e["op"] == "delete" else e["value"]
        label = ".".join(path)
        if agents is not None and path[:2] == ["agents", "entries"] and len(path) > 2:
            agent = agents.get(path[2])
            if agent is None:
                skipped.append(f"{label} (agent {path[2]} not in this gateway's source)")
                continue
            if len(path) == 3:
                skipped.append(f"{label} (whole-agent replacement is not folded)")
                continue
            put(agent, path[3:], value)
        else:
            put(src, to_source(src, path, renames), value)
        folded.append(label + (" (deleted)" if value is DELETE else ""))
    with open(src_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(src, indent=2, ensure_ascii=False) + "\n")
    lines = [f"Folded {len(folded)} Control UI change(s):"] + [f"- {x}" for x in folded]
    if skipped:
        lines += ["", f"Not folded ({len(skipped)}), handle by hand:"] + [f"- {x}" for x in skipped]
    print("\n".join(lines))


if __name__ == "__main__":
    main()
