#!/usr/bin/env bash
# Qualify an OpenClaw candidate against copies of live state (generalized from the
# 2026.9.8 qualification, 2026-10-03). Never touches live state with the candidate.
#
#   qualify-candidate.sh <candidate-bin/openclaw> <instance>...
#
# Per instance: snapshot the live state (SQLite online backup of every *.sqlite, plain
# copies of the rest, caches and old backups skipped) -> SQLite schema and row census ->
# candidate `doctor --fix` on the copy (home read-only, only $QUAL_DIR writable) -> census
# again -> candidate opens the migrated copy -> the working copy and scratch home are
# deleted.
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
#   OPENCLAW_UPGRADE_INSTALLED_BIN      installed binary, for QUAL_ARCHIVE=1
# Env: QUAL_DIR       output root (default <backup root>/qual-<candidate>-<date>)
#      QUAL_KEEP=1    keep the migrated working copy for inspection
#      QUAL_ARCHIVE=1 also write a verified `backup create` archive (slow; needs
#                     INSTALLED_BIN or OPENCLAW_UPGRADE_INSTALLED_BIN)
set -euo pipefail
here=$(dirname "$(readlink -f "$0")")
# shellcheck source=/dev/null
[ ! -f "$here/host.env" ] || . "$here/host.env"
state_pattern=${OPENCLAW_UPGRADE_STATE_DIR_PATTERN:-$HOME/.openclaw-%s}
config_name=${OPENCLAW_UPGRADE_CONFIG_NAME:-openclaw.json}
backup_root=${OPENCLAW_UPGRADE_BACKUP_ROOT:-$HOME/openclaw-backups}

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
# A fenced secondary binary (rescue's) refuses to run against the default state, so
# probe the version with a scratch state; never let the probe end the script silently.
probe=$(mktemp -d)
cand_version=$(OPENCLAW_STATE_DIR="$probe" OPENCLAW_CONFIG_PATH="$probe/openclaw.json" "$CAND" --version 2>/dev/null \
  | head -1 | tr -c 'A-Za-z0-9.\n-' '_' || true)
rmdir "$probe" 2>/dev/null || true
Q=${QUAL_DIR:-$backup_root/qual-${cand_version:-candidate}-$(date +%Y%m%d)}
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
  need=$(( $(du -sm --exclude=backups --exclude=media --exclude=runtime-plugins --exclude=tmp "$live" | cut -f1) * 2 + 20480 ))
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
  chmod 0600 "$I/doctor-config.json"; cp "$I/doctor-config.json" "$I/doctor-config.before.json"

  echo "== $inst: candidate doctor --fix on the copy"
  rc=0
  systemd-run --user --pipe --wait --quiet --collect -p ProtectHome=read-only -p "ReadWritePaths=$Q" \
    -p MemoryMax=6G -E OPENCLAW_NIX_MODE=0 -E "OPENCLAW_STATE_DIR=$ST" -E "OPENCLAW_CONFIG_PATH=$I/doctor-config.json" \
    -E HOME="$I/home" \
    timeout 900 "$CAND" doctor --fix --non-interactive > "$I/doctor.log" 2>&1 || rc=$?
  # Exit 1 whose only errors are plugin dependencies missing from the copy is the
  # harness (backups skip runtime-plugin node_modules), not a migration failure.
  if [ "$rc" -eq 1 ] && grep -q "Doctor finished with plugin load errors" "$I/doctor.log" \
    && ! grep -E '^\[error\]' "$I/doctor.log" | grep -qv 'Plugin dependency .* is missing'; then
    echo "   doctor rc=1: plugin dependencies missing from the copy only (harness); treated as 0"
    rc=0
  fi
  echo "   doctor rc=$rc"
  census "$ST" > "$I/census-after.json"

  echo "== $inst: candidate opens the migrated copy"
  arc=0
  systemd-run --user --pipe --wait --quiet --collect -p ProtectHome=read-only -p "ReadWritePaths=$Q" \
    -p MemoryMax=6G -E OPENCLAW_NIX_MODE=1 -E "OPENCLAW_STATE_DIR=$ST" -E "OPENCLAW_CONFIG_PATH=$I/doctor-config.json" \
    -E HOME="$I/home" \
    timeout 300 "$CAND" agents list --json > "$I/admission.log" 2>&1 || arc=$?
  echo "   admission rc=$arc"

  python3 - "$I" "$inst" "$rc" "$arc" <<'PY'
import json, sys
I, inst, rc, arc = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
b = json.load(open(f"{I}/census-before.json")); a = json.load(open(f"{I}/census-after.json"))
schema = {k: (b[k].get("user_version"), a.get(k, {}).get("user_version")) for k in b}
changed = {k: v for k, v in schema.items() if v[0] != v[1]}
# Records must never shrink; derived caches and work queues may (9.9's doctor drops
# stale cached systemPromptReport snapshots and drains validation queues).
derived_tables = ("snapshot", "pending", "cache", "queue")
lost, trimmed = {}, {}
for k in b:
    for t, n in b[k].get("rows", {}).items():
        m = a.get(k, {}).get("rows", {}).get(t)
        if m is None or m < n:
            (trimmed if any(d in t.lower() for d in derived_tables) else lost)[f"{k}:{t}"] = (n, m)
errors = {k: v["error"] for k, v in a.items() if "error" in v}
total_b = sum(sum(v.get("rows", {}).values()) for v in b.values())
total_a = sum(sum(v.get("rows", {}).values()) for v in a.values())
ok = rc == 0 and arc == 0 and not lost and not errors
print(f"{'PASS' if ok else 'FAIL'} {inst}: doctor rc={rc} admission rc={arc} dbs={len(b)} "
      f"schema-changes={len(changed)} rows {total_b}->{total_a} lost={len(lost)} errors={len(errors)}")
for k, v in list(changed.items())[:8]: print(f"     schema {k}: {v[0]} -> {v[1]}")
for k, v in list(lost.items())[:8]: print(f"     LOST {k}: {v[0]} -> {v[1]}")
for k, v in list(trimmed.items())[:8]: print(f"     trimmed (derived) {k}: {v[0]} -> {v[1]}")
for k, v in list(errors.items())[:5]: print(f"     ERROR {k}: {v}")
json.dump({"inst": inst, "ok": ok, "schema_changes": changed, "lost": lost, "trimmed": trimmed, "errors": errors,
           "rows_before": total_b, "rows_after": total_a}, open(f"{I}/result.json", "w"), indent=1)
PY
  [ "${QUAL_KEEP:-0}" = 1 ] || rm -rf "$I/state" "$I/home"
done
