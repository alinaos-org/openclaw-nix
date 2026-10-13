#!/usr/bin/env python3
"""Self-test for config-overlay.py: python3 config-overlay-test.py (exit 0 = pass)."""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "config-overlay.py")
POLICY = os.path.join(HERE, "config-overlay-policy.json")


def run(state, *args):
    return subprocess.run([sys.executable, TOOL, "--state", state, "--instance", "t", "--policy", POLICY, *args],
                          check=True, capture_output=True, text=True).stdout


def main():
    with tempfile.TemporaryDirectory() as d:
        state = os.path.join(d, "state"); os.mkdir(state)
        base = {"agents": {"defaults": {"model": {"primary": "astra", "fallbacks": ["best"]}, "models": {}},
                           "entries": {"coder": {"model": {"primary": "sol"}, "tools": {"deny": ["x"]}},
                                       "finance": {"decisionModel": ""}}},
                "plugins": {"allow": ["a"]}, "tools": {"exec": {"ask": "off"}}, "gateway": {"port": 1}}
        bp = os.path.join(d, "base.json"); json.dump(base, open(bp, "w"))
        rt = os.path.join(state, "openclaw-runtime.json")
        run(state, "capture"); run(state, "apply", "--base", bp, "--out", rt)
        cur = json.load(open(rt))
        # Control UI edits: three allowed, five that must never persist
        cur["agents"]["defaults"]["model"]["fallbacks"] = ["sonnet", "best"]
        cur["agents"]["entries"]["coder"]["model"]["primary"] = "opus"
        cur.setdefault("auth", {}).setdefault("profiles", {})["openai-codex:m"] = {"provider": "openai-codex", "mode": "oauth"}
        cur["plugins"]["allow"].append("slack")
        cur["tools"]["exec"]["ask"] = "always"
        cur["agents"]["entries"]["coder"]["tools"]["deny"] = []
        cur["agents"]["entries"]["finance"]["decisionModel"] = "typesafe/jev"
        cur["agents"]["defaults"]["thinkingDefault"] = "sk-ant-oat01-abcdefghijklmnopqrstu"
        # OpenClaw 9.8 writes this copy of the model list on every save: ignored,
        # so it is neither kept nor reported as drift.
        cur["agents"]["defaults"]["modelPolicy"] = {"allow": ["openai/gpt-6-astra"]}
        json.dump(cur, open(rt, "w"))
        # restart with a repo base that has adopted the fallbacks change
        base["agents"]["defaults"]["model"]["fallbacks"] = ["sonnet", "best"]
        json.dump(base, open(bp, "w"))
        run(state, "capture"); run(state, "apply", "--base", bp, "--out", rt)
        out = json.load(open(rt))
        assert out["agents"]["entries"]["coder"]["model"]["primary"] == "opus"
        assert "openai-codex:m" in out["auth"]["profiles"]
        assert out["plugins"]["allow"] == ["a"]
        assert out["tools"]["exec"]["ask"] == "off"
        assert out["agents"]["entries"]["coder"]["tools"]["deny"] == ["x"]
        assert out["agents"]["entries"]["finance"]["decisionModel"] == ""
        assert "thinkingDefault" not in out["agents"]["defaults"]
        assert "modelPolicy" not in out["agents"]["defaults"]
        ov = json.load(open(os.path.join(state, "config-overlay.json")))["entries"]
        assert len(ov) == 2, ov  # fallbacks pruned once the repo adopted it
        drift = json.load(open(os.path.join(state, "config-drift.json")))["events"]
        assert len(drift) == 5, drift
        assert all(e["value"] != "sk-ant-oat01-abcdefghijklmnopqrstu" for e in drift)
        run(state, "drop", "all"); run(state, "capture"); run(state, "apply", "--base", bp, "--out", rt)
        # The render always carries a meta object (OpenClaw restores an older
        # .bak over a config without one once it has seen meta).
        assert json.load(open(rt)) == {**base, "meta": {}}

    # F5 (2026-10-05 audit): denied changes are decided before secret
    # detection, so their values must be redacted on their own. A pre-existing
    # drift file with a raw value is scrubbed at the next capture.
    with tempfile.TemporaryDirectory() as d:
        state = os.path.join(d, "state"); os.mkdir(state)
        base = {"gateway": {"auth": {"mode": "token", "token": "$OPENCLAW_GATEWAY_TOKEN"}},
                "channels": {"slack": {"enabled": False}}, "plugins": {"allow": ["a"]}, "mcp": {"servers": {}}}
        bp = os.path.join(d, "base.json"); json.dump(base, open(bp, "w"))
        rt = os.path.join(state, "openclaw-runtime.json")
        json.dump({"version": 1, "events": [{"path": ["gateway", "auth", "token"], "op": "set",
                                             "value": "old-raw-token-value", "reason": "denied:gateway.**"}]},
                  open(os.path.join(state, "config-drift.json"), "w"))
        run(state, "capture"); run(state, "apply", "--base", bp, "--out", rt)
        cur = json.load(open(rt))
        cur["gateway"]["auth"]["token"] = "short-literal"  # no token pattern, under 12 chars
        cur["channels"]["slack"] = {"enabled": True, "botToken": "xoxb-1234567890-abcdefghijkl", "appName": "alina"}
        cur["plugins"]["allow"] = ["a", "evil"]
        cur["mcp"]["servers"]["x"] = {"command": "npx", "headers": {"X-Api": "abc"}, "env": {"K": "v"},
                                      "url": "https://bob:hunter2@mcp.example/sse", "apiKey": "$MCP_KEY"}
        cur["env"] = {"vars": {"DATABASE_URL": "postgres://u:p@db/x"}}
        json.dump(cur, open(rt, "w"))
        run(state, "capture")
        raw = open(os.path.join(state, "config-drift.json")).read()
        for leaked in ("old-raw-token-value", "short-literal", "xoxb-1234567890", "hunter2", "postgres://u:p", '"abc"', '"v"'):
            assert leaked not in raw, f"{leaked} leaked into config-drift.json"
        events = {".".join(e["path"]): e for e in json.loads(raw)["events"]}
        assert events["gateway.auth.token"]["value"] == "<redacted>"
        assert events["channels.slack.botToken"]["value"] == "<redacted>"
        assert events["channels.slack.appName"]["value"] == "alina"
        assert events["channels.slack.enabled"]["value"] is True
        assert events["env"]["value"] == {"vars": {"DATABASE_URL": "<redacted>"}}
        assert events["plugins.allow"]["value"] == ["a", "evil"], "non-secret denied values stay readable"
        mcp = events["mcp.servers.x"]["value"]
        assert mcp["command"] == "npx" and mcp["apiKey"] == "$MCP_KEY", mcp
        assert mcp["url"] == "https://<redacted>@mcp.example/sse", mcp
        assert mcp["headers"] == {"X-Api": "<redacted>"} and mcp["env"] == {"K": "<redacted>"}, mcp
        assert os.stat(os.path.join(state, "config-drift.json")).st_mode & 0o777 == 0o600
        out = subprocess.run([sys.executable, TOOL, "redact"], input='{"a": {"password": "p", "ref": {"source": "env", "id": "X"}}}',
                             check=True, capture_output=True, text=True).stdout
        assert json.loads(out) == {"a": {"password": "<redacted>", "ref": {"source": "env", "id": "X"}}}, out

    # F3 (2026-10-05 audit): capture used to start from the old overlay and only
    # add differences from the base, so a setting changed back to its Nix
    # default kept its old override and came back at the next start.
    with tempfile.TemporaryDirectory() as d:
        state = os.path.join(d, "state"); os.mkdir(state)
        base = {"agents": {"defaults": {"thinkingDefault": "high", "model": {"primary": "astra"}}}}
        bp = os.path.join(d, "base.json"); json.dump(base, open(bp, "w"))
        rt = os.path.join(state, "openclaw-runtime.json")
        restart = lambda: (run(state, "capture"), run(state, "apply", "--base", bp, "--out", rt))
        def edit(fn):
            cur = json.load(open(rt)); fn(cur); json.dump(cur, open(rt, "w"))
        overlay = lambda: {".".join(e["path"]): e.get("value") for e in json.load(open(os.path.join(state, "config-overlay.json")))["entries"]}
        restart()
        edit(lambda c: c["agents"]["defaults"].update(thinkingDefault="low", verboseDefault="on"))
        restart()
        assert json.load(open(rt))["agents"]["defaults"]["thinkingDefault"] == "low"
        captured_at = json.load(open(os.path.join(state, "config-overlay.json")))["entries"][0]["capturedAt"]
        # Revert one setting to the Nix value and remove the added one.
        edit(lambda c: (c["agents"]["defaults"].update(thinkingDefault="high"), c["agents"]["defaults"].pop("verboseDefault")))
        # F4: preview sees the live edit without writing any state.
        before = {f: open(os.path.join(state, f)).read() for f in ("config-overlay.json", ".nix-base.json")}
        assert json.loads(run(state, "preview"))["entries"] == [], "preview shows the reverted settings as gone"
        assert before == {f: open(os.path.join(state, f)).read() for f in before}, "preview must not write"
        restart()
        out = json.load(open(rt))["agents"]["defaults"]
        assert out["thinkingDefault"] == "high", f"reverted setting resurrected: {out}"
        assert "verboseDefault" not in out, out
        assert overlay() == {}, overlay()
        # An unchanged entry keeps its original capture time.
        edit(lambda c: c["agents"]["defaults"]["model"].update(primary="sol"))
        restart(); first = json.load(open(os.path.join(state, "config-overlay.json")))["entries"][0]["capturedAt"]
        restart(); assert json.load(open(os.path.join(state, "config-overlay.json")))["entries"][0]["capturedAt"] == first
        assert captured_at  # (timestamps exist at all)
        # F4: preview reports a live edit that capture has not seen yet.
        edit(lambda c: c["agents"]["defaults"].update(thinkingDefault="low"))
        prev = {".".join(e["path"]): e.get("value") for e in json.loads(run(state, "preview"))["entries"]}
        assert prev == {"agents.defaults.model.primary": "sol", "agents.defaults.thinkingDefault": "low"}, prev
        assert overlay() == {"agents.defaults.model.primary": "sol"}, "preview left config-overlay.json alone"
        # A refused entry (policy tightened) was never in the runtime file; its
        # absence there is not a revert, so it survives until the policy allows it again.
        strict = json.load(open(POLICY)); strict["deny"] = strict["deny"] + ["agents.defaults.model.**"]
        sp = os.path.join(d, "strict.json"); json.dump(strict, open(sp, "w"))
        tool = lambda pol, *a: subprocess.run([sys.executable, TOOL, "--state", state, "--instance", "t", "--policy", pol, *a],
                                              check=True, capture_output=True, text=True)
        tool(sp, "capture"); tool(sp, "apply", "--base", bp, "--out", rt)
        assert json.load(open(rt))["agents"]["defaults"]["model"]["primary"] == "astra"
        tool(sp, "capture"); tool(sp, "apply", "--base", bp, "--out", rt)
        assert "agents.defaults.model.primary" in overlay(), "refused entry dropped while the policy refused it"
        restart()
        assert json.load(open(rt))["agents"]["defaults"]["model"]["primary"] == "sol", "refused entry did not come back"
    print("config-overlay self-test: OK")


if __name__ == "__main__":
    main()
