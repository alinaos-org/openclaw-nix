#!/usr/bin/env bash
# Qualify an OpenClaw candidate against copies of live state (generalized from the
# 2026.9.8 qualification, 2026-10-03). Never touches live state with the candidate.
#
#   qualify-candidate.sh <candidate-bin/openclaw> <instance>...
#
# Per instance: snapshot the live state (SQLite online backup of every *.sqlite, plain
# copies of the rest, caches and old backups skipped) and copies of the workspaces the
# config names outside it -> SQLite schema, row and cron census -> optional
# QUAL_PRE_DOCTOR hook -> candidate `doctor --fix` on the copy (home read-only, only
# $QUAL_DIR writable, under 900 s) -> census again -> a second doctor pass, as the next
# upgrade would run it -> candidate opens the migrated copy -> the working copy, its
# workspaces and scratch home are deleted.
#
# The snapshot used to be `openclaw backup create --verify`, which gzipped a 5.7 GB
# state at about 1.1 MB/s (21 of 36 minutes of one qualification). The rollback
# snapshot is not this script's job; the host's rollback (host profile) covers it.
# QUAL_ARCHIVE=1 still makes a verified `backup create` archive too.
#
# Host defaults come from host.env beside this script (the host profile), else:
#   OPENCLAW_UPGRADE_STATE_DIR_PATTERN  an instance's state dir   ($HOME/.openclaw-%s)
#   OPENCLAW_UPGRADE_CONFIG_NAME        its config file there     (openclaw.json)
#   OPENCLAW_UPGRADE_BACKUP_ROOT        output root               ($HOME/openclaw-backups)
#   OPENCLAW_UPGRADE_SCRATCH_ROOT       working copies' root      (the backup root)
#   OPENCLAW_UPGRADE_INSTALLED_BIN      installed binary, for QUAL_ARCHIVE=1
# Env: QUAL_DIR       output root (default <scratch root>/qual-<candidate>-<date>)
#      QUAL_KEEP=1    keep the migrated working copy for inspection
#      QUAL_ARCHIVE=1 also write a verified `backup create` archive (slow; needs
#                     INSTALLED_BIN or OPENCLAW_UPGRADE_INSTALLED_BIN)
#      QUAL_PRE_DOCTOR=<cmd>  run as `<cmd> <instance> <instance dir> <state copy>` just
#                     before the doctor, to put what the activation would deploy into
#                     the copy (a changed workspace file, say); non-zero fails the instance
#      QUAL_SECOND_PASS=0  skip the second doctor pass
#      QUAL_DOCTOR_LIMIT  seconds a doctor pass may take (default 900, prepare-config's
#                     `timeout`); a pass at or over it fails
#      QUAL_RUNTIME_PLUGINS=0  do not copy the live runtime-plugin sets the config names
#                     (the copy then lacks every materialized plugin, as before 2026.11.5)
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
# shellcheck source=/dev/null
[ ! -f "$here/host.env" ] || . "$here/host.env"
state_pattern=${OPENCLAW_UPGRADE_STATE_DIR_PATTERN:-$HOME/.openclaw-%s}
config_name=${OPENCLAW_UPGRADE_CONFIG_NAME:-openclaw.json}
backup_root=${OPENCLAW_UPGRADE_BACKUP_ROOT:-$HOME/openclaw-backups}
scratch_root=${OPENCLAW_UPGRADE_SCRATCH_ROOT:-$backup_root}

[ $# -ge 2 ] || { echo "usage: $0 <candidate-bin/openclaw> <instance>..." >&2; exit 64; }
CAND=$1; shift
[ -x "$CAND" ] || { echo "candidate is not executable: $CAND" >&2; exit 66; }
if [ "${QUAL_ARCHIVE:-0}" = 1 ]; then
  GW=${INSTALLED_BIN:-${OPENCLAW_UPGRADE_INSTALLED_BIN:-}}
  [ -x "$GW" ] || { echo "installed binary not found: ${GW:-unset} (set INSTALLED_BIN)" >&2; exit 66; }
fi
case "$CAND" in
  /nix/store/*) ;;
  *) echo "refusing: candidate must be a built store path, not a checkout: $CAND" >&2; exit 65 ;;
esac
command -v jq >/dev/null || { echo "jq is required (workspace copies)" >&2; exit 69; }
doctor_limit=${QUAL_DOCTOR_LIMIT:-900}
# A fenced secondary binary (rescue's) refuses to run against the default state, so
# probe the version with a scratch state; never let the probe end the script silently.
probe=$(mktemp -d)
cand_version=$(OPENCLAW_STATE_DIR="$probe" OPENCLAW_CONFIG_PATH="$probe/openclaw.json" "$CAND" --version 2>/dev/null \
  | head -1 | tr -c 'A-Za-z0-9.\n-' '_' || true)
rmdir "$probe" 2>/dev/null || true
Q=${QUAL_DIR:-$scratch_root/qual-${cand_version:-candidate}-$(date +%Y%m%d)}
mkdir -p "$Q"
echo "candidate: $CAND (${cand_version:-unknown}); output: $Q"

census() { # census <state-dir> -> JSON {db: {user_version, rows}}
  python3 - "$1" <<'PY'
import json, pathlib, sqlite3, sys
root = pathlib.Path(sys.argv[1]); out = {}
for p in sorted(root.rglob("*.sqlite")):
    rel = str(p.relative_to(root))
    if rel.startswith(("backups/", "tmp/")): continue
    try:
        con = sqlite3.connect(f"file:{p}?mode=ro", uri=True)
        uv = con.execute("PRAGMA user_version").fetchone()[0]
        tables = [r[0] for r in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
        rows = {t: con.execute(f'select count(*) from "{t}"').fetchone()[0] for t in tables
                if any(k in t.lower() for k in ("event", "transcript", "message", "session"))}
        out[rel] = {"user_version": uv, "rows": rows}; con.close()
    except Exception as e:
        out[rel] = {"error": str(e)}
print(json.dumps(out, sort_keys=True))
PY
}

# cron_census <state-dir> -> JSON: cron_jobs by payload kind and enabled, the heartbeat
# rows (2026.11.4's payload "heartbeat", and the heartbeat-<agent> / "Proactive check
# (<agent>)" jobs 2026.11.5's doctor converts them to), the automation-default receipts
# by phase, and cron.defaultStoreKey. Read-only; the row census above never counts
# cron_jobs, so a conversion would be invisible there.
cron_census() {
  python3 - "$1" <<'PY'
import json, pathlib, sqlite3, sys
db = pathlib.Path(sys.argv[1]) / "state" / "openclaw.sqlite"
out = {"db": str(db), "kinds": [], "heartbeats": {}, "receipts": {}, "defaultStoreKey": None}
if not db.exists():
    out["absent"] = True
    print(json.dumps(out, sort_keys=True)); sys.exit(0)
try:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    tables = {r[0] for r in con.execute("select name from sqlite_master where type='table'")}
    if "cron_jobs" in tables:
        cols = {r[1] for r in con.execute("pragma table_info(cron_jobs)")}
        out["kinds"] = [list(r) for r in con.execute(
            "select payload_kind, enabled, count(*) from cron_jobs group by 1, 2 order by 1, 2")]
        decl = "declaration_key" if "declaration_key" in cols else "null"
        for job_id, name, enabled, kind, decl_key, job_json in con.execute(
                f"select job_id, name, enabled, payload_kind, {decl}, job_json from cron_jobs "
                "where payload_kind = 'heartbeat' or name like 'heartbeat-%' or name like 'Proactive check (%'"):
            job = json.loads(job_json or "{}")
            schedule = job.get("schedule") or {}
            out["heartbeats"][job_id] = {
                "name": name, "enabled": enabled, "kind": kind, "declarationKey": decl_key,
                "everyMs": schedule.get("everyMs"), "anchorMs": schedule.get("anchorMs"),
                "schedule": schedule, "payload": job.get("payload"), "delivery": job.get("delivery"),
                "sessionTarget": job.get("sessionTarget")}
    if "config_machine_state" in tables:
        for (phase, n) in con.execute(
                "select json_extract(value_json, '$.phase'), count(*) from config_machine_state "
                "where state_key like 'automation-default:%' group by 1"):
            out["receipts"][str(phase)] = n
        row = con.execute("select value_json from config_machine_state where state_key = 'cron.defaultStoreKey'").fetchone()
        out["defaultStoreKey"] = json.loads(row[0]) if row else None
    con.close()
except Exception as e:
    out["error"] = str(e)
print(json.dumps(out, sort_keys=True))
PY
}

# snapshot <live state dir> <copy dir>: SQLite online backup (a consistent read of a
# live WAL database, no lock held on writers) for each *.sqlite, plain copies for the
# rest. Skips regenerable or historical trees, earlier backups of the databases, and
# lock files: the per-database *-lock.sqlite files hold the live gateway's locks, and a
# copy of them makes doctor refuse with "An agent database is in use".
snapshot() {
  python3 - "$1" "$2" <<'PY'
import os, pathlib, shutil, sqlite3, sys
src, dst = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
skip_top = {"backups", "tmp", "runtime-plugins", "media", "logs", "cache", "quarantine", "browser", "locks"}
for root, dirs, files in os.walk(src):
    rel = pathlib.Path(root).relative_to(src)
    if not rel.parts:
        dirs[:] = [d for d in dirs if d not in skip_top]
    (dst / rel).mkdir(parents=True, exist_ok=True)
    for name in files:
        s, d = pathlib.Path(root) / name, dst / rel / name
        if s.is_symlink() or name.endswith((".sqlite-wal", ".sqlite-shm")) \
                or ".bak" in name or ".clobbered." in name or "pre-startup-migration" in name \
                or name.endswith(("-lock.sqlite", ".lock", ".pid", ".sock")):
            continue
        if name.endswith(".sqlite"):
            live = sqlite3.connect(f"file:{s}?mode=ro", uri=True, timeout=7)
            copy = sqlite3.connect(d)
            live.backup(copy)
            # The copy has no running owner: drop the live gateway's ownership rows
            # (state_leases, agent_database_leases), or doctor refuses with "An agent
            # database is in use" because the holder process is alive.
            for (table,) in copy.execute("select name from sqlite_master where type='table' and name like '%lease%'").fetchall():
                copy.execute(f'delete from "{table}"')
            copy.commit()
            copy.close(); live.close()
        else:
            shutil.copy2(s, d)
PY
}

for inst in "$@"; do
  I="$Q/$inst"
  if [ -e "$I" ]; then mv "$I" "$I.prev-$(date +%H%M%S)"; fi
  mkdir -p "$I/home"
  # shellcheck disable=SC2059
  live=$(printf "$state_pattern" "$inst")
  [ -f "$live/$config_name" ] || { echo "FAIL $inst: no $config_name in $live (OPENCLAW_UPGRADE_STATE_DIR_PATTERN)"; continue; }
  # A full disk once took every gateway down mid-upgrade: refuse to start a copy that
  # could push it there. On ZFS, deleted files only free space once snapshots go.
  # Workspaces the config names outside the state dir are copied too (below).
  outside=()
  while IFS= read -r ws; do
    case "$ws" in "$live" | "$live"/*) continue ;; esac
    [ -d "$ws" ] && outside+=("$ws")
  done < <(jq -r '[.. | objects | .workspace? | strings] | unique | .[]' "$live/$config_name")
  ws_mb=0
  if [ "${#outside[@]}" -gt 0 ]; then
    ws_mb=$(du -smc --exclude=.git --exclude=node_modules --exclude=media "${outside[@]}" | tail -1 | cut -f1)
  fi
  need=$(( ($(du -sm --exclude=backups --exclude=media --exclude=runtime-plugins --exclude=tmp "$live" | cut -f1) + ws_mb) * 2 + 20480 ))
  free=$(df -m --output=avail "$Q" | tail -1 | tr -d ' ')
  if [ "$free" -lt "$need" ]; then
    echo "FAIL $inst: ${free} MB free under $Q, want ${need} MB (twice the state plus 20 GB)"; continue
  fi
  if [ "${QUAL_ARCHIVE:-0}" = 1 ]; then
    echo "== $inst: verified backup archive (installed binary)"
    mkdir -p "$I/archive"
    OPENCLAW_NIX_MODE=1 OPENCLAW_STATE_DIR="$live" OPENCLAW_CONFIG_PATH="$live/$config_name" \
      "$GW" backup create --no-include-workspace --verify --output "$I/archive" > "$I/backup.log" 2>&1
  fi
  echo "== $inst: snapshot of the live state"
  ST="$I/state/$(basename "$live")"
  snapshot "$live" "$ST" > "$I/snapshot.log" 2>&1 || { echo "FAIL $inst: snapshot failed (see $I/snapshot.log)"; continue; }
  census "$ST" > "$I/census-before.json"
  # Point the copied config at the copy, never at the live state dir.
  # Escaped for the rewrite below: the dot in .openclaw-<name> is not a wildcard.
  live_re=$(sed 's|[].[*^$\\#]|\\&|g' <<<"$live")
  sed "s#${live_re}\\b#$ST#g" "$ST/$config_name" > "$I/doctor-config.json"
  chmod 0600 "$I/doctor-config.json"
  # Runtime plugins, as the real activation's doctor sees them. prepare-config runs the
  # doctor on the previous start's render before it stages the new release's plugin
  # set, and that render's plugins.load.paths name the set the previous start staged
  # under <state>/runtime-plugins/<set id> (pruning keeps it: it is the newest). The
  # snapshot skips runtime-plugins/, so copy each set the config names from the live
  # state (cp -a, as prepare-config stages them). Without them 2026.11.5's doctor finds
  # no configured plugin package and records every plugin's data/settings upgrade as
  # unfinished, which the live upgrade would not.
  if [ "${QUAL_RUNTIME_PLUGINS:-1}" != 0 ]; then
    plugin_sets=0 plugin_missing=()
    while IFS= read -r plugin_path; do
      case "$plugin_path" in "$ST/runtime-plugins/"?*/?*) ;; *) continue ;; esac
      set_id=${plugin_path#"$ST/runtime-plugins/"}; set_id=${set_id%%/*}
      if [ ! -e "$ST/runtime-plugins/$set_id" ] && [ -d "$live/runtime-plugins/$set_id" ]; then
        install -d -m 0700 "$ST/runtime-plugins"
        cp -a --no-preserve=ownership -- "$live/runtime-plugins/$set_id" "$ST/runtime-plugins/$set_id"
        plugin_sets=$((plugin_sets + 1))
      fi
      [ -d "$plugin_path" ] || plugin_missing+=("$plugin_path")
    done < <(jq -r '.plugins.load.paths[]? // empty' "$I/doctor-config.json")
    [ "$plugin_sets" -eq 0 ] || echo "   copied $plugin_sets runtime-plugin set(s) from the live state"
    if [ "${#plugin_missing[@]}" -gt 0 ]; then
      printf '   missing: %s\n' "${plugin_missing[@]}" | head -5
      echo "FAIL $inst: ${#plugin_missing[@]} configured runtime-plugin path(s) are not in the live state either (QUAL_RUNTIME_PLUGINS=0 runs without them)"
      chmod -R u+w "$I/state" 2>/dev/null || true
      continue
    fi
  fi
  # Workspaces outside the state dir are agent files under a read-only home: doctor
  # writes there (2026.11.5 renames HEARTBEAT.md to claim it, then removes it), and the
  # sandbox fails that with EROFS. Copy each, as prepare-config does on a real start,
  # and point the config at the copy with the same walk.
  printf '{}' > "$I/workspace-map.json"
  ws_n=0
  for ws in "${outside[@]}"; do
    ws_n=$((ws_n + 1))
    ws_copy="$I/workspaces/$ws_n"
    install -d -m 0700 "$ws_copy"
    tar -C "$ws" --exclude=./.git --exclude=./node_modules --exclude=./media -cf - . | tar -C "$ws_copy" -xf -
    jq --arg from "$ws" --arg to "$ws_copy" '. + {($from): $to}' "$I/workspace-map.json" > "$I/workspace-map.json.tmp"
    mv "$I/workspace-map.json.tmp" "$I/workspace-map.json"
  done
  jq --slurpfile m "$I/workspace-map.json" \
    'walk(if type == "object" and (.workspace | type) == "string" and $m[0][.workspace] != null then .workspace = $m[0][.workspace] else . end)' \
    "$I/doctor-config.json" > "$I/doctor-config.json.tmp"
  mv "$I/doctor-config.json.tmp" "$I/doctor-config.json"; chmod 0600 "$I/doctor-config.json"
  [ "$ws_n" -eq 0 ] || echo "   copied $ws_n workspace(s) from outside the state dir"
  cron_census "$ST" > "$I/cron-before.json"

  if [ -n "${QUAL_PRE_DOCTOR:-}" ]; then
    echo "== $inst: QUAL_PRE_DOCTOR $QUAL_PRE_DOCTOR"
    if ! "$QUAL_PRE_DOCTOR" "$inst" "$I" "$ST" > "$I/pre-doctor.log" 2>&1; then
      echo "FAIL $inst: QUAL_PRE_DOCTOR failed (see $I/pre-doctor.log)"; continue
    fi
  fi
  cp "$I/doctor-config.json" "$I/doctor-config.before.json"
  # What the activation deploys into the workspaces, for the second pass: doctor
  # archives and removes the HEARTBEAT.md files it imports, and Nix puts them back.
  mapfile -t copies < <(jq -r '[.. | objects | .workspace? | strings] | unique | .[]' "$I/doctor-config.json"; \
    find "$ST" -mindepth 1 -maxdepth 1 -type d -name 'workspace*')
  : > "$I/heartbeat-files.tsv"
  for ws in "${copies[@]}"; do
    # Only copies: a workspace the config still names outside $Q is never written.
    case "$ws" in "$Q"/*) ;; *) continue ;; esac
    [ -f "$ws/HEARTBEAT.md" ] || continue
    grep -qxF "$ws" <(cut -f1 "$I/heartbeat-files.tsv") && continue
    saved="$I/heartbeat-files/$(wc -l < "$I/heartbeat-files.tsv").md"
    install -D -m 0600 "$ws/HEARTBEAT.md" "$saved"
    printf '%s\t%s\n' "$ws" "$saved" >> "$I/heartbeat-files.tsv"
  done

  # doctor_pass <log>: the candidate's doctor --fix on the copy; sets rc and secs.
  doctor_pass() {
    local start
    rc=0
    start=$(date +%s)
    systemd-run --user --pipe --wait --quiet --collect -p ProtectHome=read-only -p "ReadWritePaths=$Q" \
      -p MemoryMax=6G -E OPENCLAW_NIX_MODE=0 -E "OPENCLAW_STATE_DIR=$ST" -E "OPENCLAW_CONFIG_PATH=$I/doctor-config.json" \
      -E HOME="$I/home" \
      timeout "$doctor_limit" "$CAND" doctor --fix --non-interactive > "$1" 2>&1 || rc=$?
    secs=$(( $(date +%s) - start ))
    # Exit 1 whose only errors are plugin dependencies missing from the copy is the
    # harness (backups skip runtime-plugin node_modules), not a migration failure.
    if [ "$rc" -eq 1 ] && grep -q "Doctor finished with plugin load errors" "$1" \
      && ! grep -E '^\[error\]' "$1" | grep -qv 'Plugin dependency .* is missing'; then
      echo "   doctor rc=1: plugin dependencies missing from the copy only (harness); treated as 0"
      rc=0
    fi
    echo "   doctor rc=$rc in ${secs} s (limit ${doctor_limit} s)"
  }

  echo "== $inst: candidate doctor --fix on the copy"
  doctor_pass "$I/doctor.log"
  secs1=$secs
  census "$ST" > "$I/census-after.json"
  cron_census "$ST" > "$I/cron-after.json"

  rc2=0 secs2=0
  printf '{}' > "$I/cron-after2.json"
  if [ "${QUAL_SECOND_PASS:-1}" != 0 ] && [ "$rc" -eq 0 ]; then
    echo "== $inst: second doctor pass, as the next upgrade runs it"
    restored=0
    while IFS=$'\t' read -r ws saved; do
      [ -f "$ws/HEARTBEAT.md" ] && continue
      install -m 0600 "$saved" "$ws/HEARTBEAT.md"
      restored=$((restored + 1))
    done < "$I/heartbeat-files.tsv"
    echo "   restored $restored HEARTBEAT.md file(s) into the workspace copies"
    cp "$I/doctor-config.json" "$I/doctor-config.pass1.json"
    first_rc=$rc
    doctor_pass "$I/doctor2.log"
    rc2=$rc secs2=$secs rc=$first_rc
    cron_census "$ST" > "$I/cron-after2.json"
  fi

  echo "== $inst: candidate opens the migrated copy"
  arc=0
  systemd-run --user --pipe --wait --quiet --collect -p ProtectHome=read-only -p "ReadWritePaths=$Q" \
    -p MemoryMax=6G -E OPENCLAW_NIX_MODE=1 -E "OPENCLAW_STATE_DIR=$ST" -E "OPENCLAW_CONFIG_PATH=$I/doctor-config.json" \
    -E HOME="$I/home" \
    timeout 300 "$CAND" agents list --json > "$I/admission.log" 2>&1 || arc=$?
  echo "   admission rc=$arc"

  python3 - "$I" "$inst" "$rc" "$arc" "$secs1" "$rc2" "$secs2" "$doctor_limit" "${QUAL_SECOND_PASS:-1}" "$ST" <<'PY'
import json, os, re, sqlite3, sys
I, inst = sys.argv[1], sys.argv[2]
rc, arc, secs1, rc2, secs2, limit = map(int, sys.argv[3:9])
second = sys.argv[9] != "0" and rc == 0
ST = sys.argv[10]
b = json.load(open(f"{I}/census-before.json")); a = json.load(open(f"{I}/census-after.json"))
schema = {k: (b[k].get("user_version"), a.get(k, {}).get("user_version")) for k in b}
changed = {k: v for k, v in schema.items() if v[0] != v[1]}
# Records must never shrink; derived caches and work queues may (9.9's doctor drops
# stale cached systemPromptReport snapshots and drains validation queues).
derived_tables = ("snapshot", "pending", "cache", "queue")
# Doctor removes a database whose only rows are metadata or search-index shadow rows
# (2026.10.5 repairs agent databases a bug registered as "(multiple)*.sqlite"), and
# drops tables a release retired once the log says so. Neither is a lost record.
metadata = re.compile(r"^(schema_meta|session_key_contract|memory_index_state)$|fts\w*_(config|data|idx|docsize)$")
retired_tables = {t: "Retired the Skill Workshop proposal tables" for t in (  # 2026.10.5
    "skill_workshop_proposal_events", "skill_workshop_proposal_rollbacks",
    "skill_workshop_collection_reviews", "skill_workshop_proposals")}
log = open(f"{I}/doctor.log", errors="replace").read()
lost, trimmed, removed, retired = {}, {}, {}, {}
for k in b:
    if k not in a and "error" not in b[k] and all(not n or metadata.search(t) for t, n in b[k]["rows"].items()):
        removed[k] = sum(b[k]["rows"].values()); continue
    for t, n in b[k].get("rows", {}).items():
        m = a.get(k, {}).get("rows", {}).get(t)
        if m is None and k in a and retired_tables.get(t, "\0") in log:
            retired[f"{k}:{t}"] = n
        elif m is None or m < n:
            (trimmed if any(d in t.lower() for d in derived_tables) else lost)[f"{k}:{t}"] = (n, m)
errors = {k: v["error"] for k, v in a.items() if "error" in v}
total_b = sum(sum(v.get("rows", {}).values()) for v in b.values())
total_a = sum(sum(v.get("rows", {}).values()) for v in a.values())

# Cron: 2026.11.5's doctor converts every heartbeat row in place (same id, schedule and
# anchor, payload agentTurn, no declarationKey) and completes one automation-default
# receipt per agent; a failed conversion leaves heartbeat rows or pending receipts.
cb, ca = json.load(open(f"{I}/cron-before.json")), json.load(open(f"{I}/cron-after.json"))
c2 = json.load(open(f"{I}/cron-after2.json")) if second else {}
cron, warn = [], []
for label, c in (("after", ca), ("second pass", c2)) if second else (("after", ca),):
    if c.get("error"): cron.append(f"{label}: cron census failed: {c['error']}")
    left = [j for j, r in c.get("heartbeats", {}).items() if r["kind"] == "heartbeat"]
    if left: cron.append(f"{label}: {len(left)} heartbeat payload row(s) remain ({', '.join(left[:4])})")
    pending = {p: n for p, n in c.get("receipts", {}).items() if p != "complete"}
    if pending: cron.append(f"{label}: automation-default receipts not complete: {pending}")
for j, r in cb.get("heartbeats", {}).items():
    m = ca.get("heartbeats", {}).get(j)
    if m is None: cron.append(f"heartbeat row {j} ({r['name']}) is gone")
    elif (m["everyMs"], m["anchorMs"]) != (r["everyMs"], r["anchorMs"]):
        cron.append(f"heartbeat row {j} ({r['name']}): schedule {r['everyMs']}@{r['anchorMs']} -> {m['everyMs']}@{m['anchorMs']}")
if second:
    keep = ("enabled", "kind", "schedule", "payload", "delivery")
    for j, r in ca.get("heartbeats", {}).items():
        m = c2.get("heartbeats", {}).get(j)
        if m is None or any(m[k] != r[k] for k in keep):
            cron.append(f"second pass changed heartbeat-derived row {j} ({r['name']})")
    for j in set(c2.get("heartbeats", {})) - set(ca.get("heartbeats", {})):
        cron.append(f"second pass created {j} ({c2['heartbeats'][j]['name']})")
# Doctor's own refusals and partial migrations, in either pass. Doctor wraps its notes
# in boxes, so match against the text with the box drawing and line breaks folded away.
def flat(text): return " ".join(re.sub(r"[\u2500-\u257f\u25c6\u25c7]", " ", text).split())
refusals = ("Default cron partition selection is unresolved",
            "Legacy heartbeat state must become ordinary editable automations",
            "is running; stop the Gateway", "belongs to unconfigured agent",
            "Multiple legacy monitors", "was not finalized",
            "Rerun doctor to retry safely")
# "<what> was not migrated" is a refusal, except an automation's inference account:
# 2026.11.5 keeps an ambient-credential route and asks to adopt a stored account
# (a warning; the job still converts).
not_migrated = re.compile(r"(?<!inference account) was not migrated")
logs = {"doctor.log": flat(log)}
if second and os.path.exists(f"{I}/doctor2.log"):
    logs["doctor2.log"] = flat(open(f"{I}/doctor2.log", errors="replace").read())
for name, text in logs.items():
    for r in refusals:
        if r in text: cron.append(f"{name}: {r!r}")
    if not_migrated.search(text): cron.append(f"{name}: 'was not migrated'")
    for m in re.finditer(r"Automation \S+ \(([0-9a-f-]{36})\): inference account was not migrated", text):
        warn.append(f"{name}: automation {m.group(1)} keeps an ambient credential (adopt a stored account)")
# The retirement note only appears when the config Doctor read still had heartbeat keys
# (an instance with heartbeat rows but no heartbeat config converts them silently).
cfg_had_heartbeat = '"heartbeat"' in open(f"{I}/doctor-config.before.json", errors="replace").read() \
    if os.path.exists(f"{I}/doctor-config.before.json") else None
if any(r["kind"] == "heartbeat" for r in cb.get("heartbeats", {}).values()) and cfg_had_heartbeat is not False \
        and "Retired heartbeat configuration after ordinary automation data was verified." not in logs["doctor.log"]:
    cron.append("doctor.log: no 'Retired heartbeat configuration after ordinary automation data was verified.'")
slow = [f"pass {n}: {s} s" for n, s in ((1, secs1), (2, secs2)) if s >= limit]
# Plugin data/settings upgrades the doctor left unfinished (2026.11.5+ ledger). With the
# runtime plugins in the copy, the live upgrade's doctor should leave none.
plugin_pending = {}
try:
    con = sqlite3.connect(f"file:{ST}/state/openclaw.sqlite?mode=ro", uri=True)
    if con.execute("select 1 from sqlite_master where type='table' and name='migration_runs'").fetchone():
        for run_id, status, report in con.execute(
                "select id, status, report_json from migration_runs where id like 'deferred-plugin-migration:%' "
                "and status in ('pending', 'deferred') order by id"):
            r = json.loads(report or "{}")
            plugin_pending[run_id.split(":", 1)[1]] = {
                "status": status, "requiresStateMigration": bool(r.get("requiresStateMigration")),
                "reason": r.get("reason")}
    con.close()
except Exception as e:
    plugin_pending["(ledger)"] = {"status": "unreadable", "reason": str(e)}

ok = rc == 0 and arc == 0 and not lost and not errors and not cron and not slow and not plugin_pending \
    and (not second or rc2 == 0)
print(f"{'PASS' if ok else 'FAIL'} {inst}: doctor rc={rc} ({secs1} s) "
      + (f"second pass rc={rc2} ({secs2} s) " if second else "")
      + f"admission rc={arc} dbs={len(b)} "
      f"schema-changes={len(changed)} rows {total_b}->{total_a} lost={len(lost)} errors={len(errors)}")
def kinds(c): return " ".join(f"{k}|{e}|{n}" for k, e, n in c.get("kinds", [])) or "none"
print(f"     cron jobs (kind|enabled|count) before: {kinds(cb)}; after: {kinds(ca)}"
      + (f"; second pass: {kinds(c2)}" if second else ""))
if cb.get("heartbeats") or ca.get("heartbeats"):
    print(f"     heartbeat rows {len(cb.get('heartbeats', {}))} -> {len(ca.get('heartbeats', {}))}; "
          f"receipts {ca.get('receipts') or {}}; cron.defaultStoreKey {ca.get('defaultStoreKey')}")
for line in sorted({l for l in log.splitlines() if "Heartbeat model changed" in l})[:8]:
    print(f"     note: {line.strip()}")
for s in slow: print(f"     SLOW doctor {s} (limit {limit} s)")
for c in cron[:12]: print(f"     CRON {c}")
for p, v in list(plugin_pending.items())[:12]:
    held = " (gateway holds it: requiresStateMigration)" if v.get("requiresStateMigration") else ""
    print(f"     PLUGIN {p}: data/settings upgrade {v['status']}{held}: {v.get('reason')}")
for w in warn[:8]: print(f"     warning: {w}")
for k, v in list(changed.items())[:8]: print(f"     schema {k}: {v[0]} -> {v[1]}")
for k, v in list(lost.items())[:8]: print(f"     LOST {k}: {v[0]} -> {v[1]}")
for k, v in list(trimmed.items())[:8]: print(f"     trimmed (derived) {k}: {v[0]} -> {v[1]}")
for k, v in list(removed.items())[:8]: print(f"     removed (no user rows) {k}: {v} metadata rows")
for k, v in list(retired.items())[:8]: print(f"     retired by the release {k}: {v} rows")
for k, v in list(errors.items())[:5]: print(f"     ERROR {k}: {v}")
json.dump({"inst": inst, "ok": ok, "schema_changes": changed, "lost": lost, "trimmed": trimmed,
           "removed": removed, "retired": retired, "errors": errors, "cron": cron,
           "plugin_pending": plugin_pending,
           "doctor_seconds": [secs1] + ([secs2] if second else []), "second_pass_rc": rc2 if second else None,
           "rows_before": total_b, "rows_after": total_a}, open(f"{I}/result.json", "w"), indent=1)
PY
  # Copied plugin sets keep the store's read-only modes; rm needs them writable.
  chmod -R u+w "$I/state/$(basename "$live")/runtime-plugins" 2>/dev/null || true
  [ "${QUAL_KEEP:-0}" = 1 ] || rm -rf "${I:?}/state" "${I:?}/home" "${I:?}/workspaces"
done
