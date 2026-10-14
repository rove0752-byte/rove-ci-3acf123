#!/bin/zsh
# Stage A isolated runner (development only, local fixtures only; D-25-3). Never pulls images. No Docker networks:
#  - proxy: --network none; fixture shares the proxy's network namespace (--network container:proxy) on 127.0.0.1:8081,
#    so there is no bridge and no gateway anywhere (review t26 proxy-gateway item);
#  - browser: --network none; reaches the proxy only via a unix socket on a per-run tmpfs volume (M4).
# Evidence layout (N1): $OUT/proxy (proxy only, hash-chained journal), $OUT/browser (browser scratch, the browser's
# only writable mount), $OUT/* (supervisor). The browser sees $OUT read-only.
# usage: run.sh <new-evidence-dir> <wall-seconds> <url...>
set -u
SELF=${0:A:h}; WT=${SELF:h:h}; source $WT/harness/a3-local/registry.sh; a3_init
OUT=$1; WALL=$2; shift 2; URLS="$*"
NM=$(readlink "$WT/node_modules" || print "$WT/node_modules")
TEST=${STAGE_A_TEST:-0}
if [ "$TEST" != 1 ] && [ -n "${CMD:-}${PROBE:-}${PROXY_PROBE:-}" ]; then echo "refused: CMD/PROBE are test-only (set STAGE_A_TEST=1)"; a3_log "stage-a refuse reason=test-hook-in-production"; exit 7; fi
POLICY=${STAGE_A_POLICY:-$SELF/policy.json}
POLICY_SHA=$(shasum -a 256 "$POLICY" | cut -d' ' -f1); PINNED=$(<"$SELF/policy.sha256")
POLICY_BLOB=$(git -C "$WT" hash-object "$POLICY" 2>/dev/null)
POLICY_REL=harness/stage-a-runner/policy.json
HEAD_BLOB=$(git -C "$WT" rev-parse "HEAD:$POLICY_REL" 2>/dev/null); HEAD_PIN=$(git -C "$WT" show "HEAD:harness/stage-a-runner/policy.sha256" 2>/dev/null)
HEAD_COMMIT=$(git -C "$WT" rev-parse HEAD 2>/dev/null)
POLICY_HEAD_OK=0; [ -n "$HEAD_BLOB" ] && [ "$POLICY_BLOB" = "$HEAD_BLOB" ] && [ "$HEAD_PIN" = "$PINNED" ] && POLICY_HEAD_OK=1
if [ "$POLICY_SHA" != "$PINNED" ] && [ "$TEST" != 1 ]; then echo "refused: policy sha256 $POLICY_SHA does not match pinned $PINNED"; a3_log "stage-a refuse reason=policy-hash-mismatch"; exit 8; fi
if [ "$POLICY_HEAD_OK" != 1 ] && [ "$TEST" != 1 ]; then echo "refused: policy.json/policy.sha256 differ from committed HEAD ($HEAD_COMMIT)"; a3_log "stage-a refuse reason=policy-not-committed"; exit 8; fi
# R4-2/R5: production runs only an APPROVED commit from a WHOLE-tree-clean checkout (R5-1: everything except
# node_modules, untracked files count), with the allowlist at its fixed default path (R5-2: STAGE_A_APPROVED_COMMITS is
# honoured only in test mode) and never inside any git repo/worktree (R5-3). See check-approval.py.
DIRTY=$(git -C "$WT" status --porcelain --untracked-files=all -- . ':(exclude)node_modules' 2>&1)
TREE_CLEAN=0; [ -z "$DIRTY" ] && [ -n "$HEAD_COMMIT" ] && TREE_CLEAN=1
OVERRIDE=""; [ "$TEST" = 1 ] && OVERRIDE=${STAGE_A_APPROVED_COMMITS:-}
APPROVAL=$(python3 "$SELF/check-approval.py" "${HEAD_COMMIT:-none}" "$WT" "$OVERRIDE")
AP=("${(@f)APPROVAL}"); COMMIT_OK=${AP[1]:-0}; APPROVED_SHA=${AP[2]:--}; APPROVAL_WHY=${AP[3]:-check-failed}; APPROVED=${AP[4]:-?}
if [ "$TEST" != 1 ]; then
  [ "$TREE_CLEAN" = 1 ] || { echo "refused: working tree not clean (whole tree except node_modules; untracked counts) or no HEAD"; a3_log "stage-a refuse reason=tree-dirty"; exit 8; }
  [ "$COMMIT_OK" = 1 ] || { echo "refused: HEAD $HEAD_COMMIT is not an approved commit ($APPROVAL_WHY; allowlist $APPROVED)"; a3_log "stage-a refuse reason=commit-not-approved why=$APPROVAL_WHY head=$HEAD_COMMIT"; exit 8; }
fi
if [ "$TEST" = 1 ] && python3 -c 'import json,sys; sys.exit(0 if any(not h.endswith(".test") for h in json.load(open(sys.argv[1]))["allow"]) else 1)' "$POLICY"; then
  echo "refused: test mode with non-.test hosts in the allowlist"; exit 7; fi
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "refused: evidence dir $OUT is not empty"; exit 6; fi
for img in rove-browser-pilot:local node:24-bookworm-slim; do docker image inspect $img >/dev/null 2>&1 || { echo "STOP: $img not present; not pulling"; exit 4; }; done
umask 077; mkdir -p -m 700 "$OUT" "$OUT/proxy" "$OUT/browser"; chmod 700 "$OUT" "$OUT/proxy" "$OUT/browser"
# R5-4: containers never mount the live worktree. Production extracts `git archive HEAD` (the approved, checked commit)
# into a private read-only snapshot after the checks; test mode copies the tracked + untracked (non-ignored) working
# files (so uncommitted test edits still run) unless STAGE_A_TEST_SNAPSHOT=git-archive. node_modules stays a live
# read-only mount (outside git); its .package-lock.json sha256 is recorded.
SNAP=$(mktemp -d "${TMPDIR:-/tmp}/rove-a3-snap-$$.XXXXXX") || { echo "STOP: snapshot dir"; exit 5; }
if [ "$TEST" != 1 ] || [ "${STAGE_A_TEST_SNAPSHOT:-}" = git-archive ]; then
  git -C "$WT" archive --format=tar HEAD | tar -x -C "$SNAP" && SNAPKIND="git-archive:$HEAD_COMMIT"
else
  (cd "$WT" && git ls-files -z -co --exclude-standard -- . ':(exclude)node_modules' | tar -c --null -T - -f -) | tar -x -C "$SNAP" && SNAPKIND="worktree-copy"
fi
[ -n "${SNAPKIND:-}" ] && [ -f "$SNAP/harness/stage-a-runner/run.sh" ] || { echo "STOP: snapshot failed"; chmod -R u+w "$SNAP"; rm -rf "$SNAP"; exit 5; }
RWT=$SNAP; RSELF=$SNAP/harness/stage-a-runner
if [ "$TEST" != 1 ]; then RPOLICY=$RSELF/policy.json
  [ "$(shasum -a 256 "$RPOLICY" | cut -d' ' -f1)" = "$PINNED" ] || { echo "refused: snapshot policy differs from pin"; chmod -R u+w "$SNAP"; rm -rf "$SNAP"; exit 8; }
else RPOLICY=$POLICY; fi
chmod -R a-w "$SNAP"
rmsnap() { [ -n "${SNAP:-}" ] && [ -d "$SNAP" ] && { chmod -R u+w "$SNAP"; rm -rf "$SNAP"; }; }   # our own private snapshot only
trap rmsnap EXIT
NM_LOCK_SHA=$( [ -f "$NM/.package-lock.json" ] && shasum -a 256 "$NM/.package-lock.json" | cut -d' ' -f1 || print none)
ID=$(date +%Y%m%d%H%M%S)-$$; F=rove-a3-${ID}1; P=rove-a3-${ID}2; B=rove-a3-${ID}3; NONCE=$(a3_nonce); VOL=rove-a3-sock-$ID; SVOL=rove-a3-scratch-$ID
START=$(date +%s)
a3_protect $$
SUP="$$-$(a3_lstart $$ | tr -cd '0-9A-Za-z')"
# Startup sweep (R3-6): remove rove.a3 containers/volumes whose supervisor (pid + start time label) is no longer alive.
for kindq in "ps -aq" "volume ls -q"; do
  for res in $(docker ${=kindq} --filter label=rove.a3=1 2>/dev/null); do
    if [ "$kindq" = "ps -aq" ]; then sup=$(docker inspect -f '{{index .Config.Labels "rove.a3.sup"}}' $res 2>/dev/null); else sup=$(docker volume inspect -f '{{index .Labels "rove.a3.sup"}}' $res 2>/dev/null); fi
    [ -z "$sup" ] && continue
    # R4-3: only sweep resources that are unmistakably ours: rove-a3- name, 32-hex nonce label, well-formed sup label.
    if [ "$kindq" = "ps -aq" ]; then rname=$(docker inspect -f '{{.Name}}' $res 2>/dev/null); rname=${rname#/}; rnonce=$(docker inspect -f '{{index .Config.Labels "rove.a3.nonce"}}' $res 2>/dev/null)
    else rname=$res; rnonce=$(docker volume inspect -f '{{index .Labels "rove.a3.nonce"}}' $res 2>/dev/null); fi
    if [[ $rname != rove-a3-* || ! $rnonce =~ '^[0-9a-f]{32}$' || ! $sup =~ '^[0-9]+-[0-9A-Za-z]+$' ]]; then a3_log "stage-a sweep skip-unrecognised ${kindq%% *} $res name=$rname"; continue; fi
    spid=${sup%%-*}; slst=${sup#*-}
    [ "$(a3_lstart $spid | tr -cd '0-9A-Za-z')" = "$slst" ] && continue   # supervisor still alive
    if [ "$kindq" = "ps -aq" ]; then docker kill $res >/dev/null 2>&1; docker rm -f $res >/dev/null 2>&1; else docker volume rm $res >/dev/null 2>&1; fi
    a3_log "stage-a sweep stale ${kindq%% *} $res sup=$sup"
  done
done
print -r -- "run $ID $(date '+%F %T %Z') start_epoch=$START nonce=${NONCE:0:8}… test_mode=$TEST policy_sha256=$POLICY_SHA" > "$OUT/supervisor.log"
slog() { print -r -- "$(a3_now) $*" >> "$OUT/supervisor.log"; a3_log "stage-a $ID $*"; }
dcmd() { print -r -- "docker ${(q)@}" | sed "s/$NONCE/<nonce>/g" >> "$OUT/docker-commands.txt"; docker "$@"; }
cleanup() {
  for n in $B $F $P $H; do docker kill $n >/dev/null 2>&1; done
  for i in {1..30}; do [ -z "$(docker ps -aq --filter label=rove.a3.nonce=$NONCE)" ] && break; sleep 0.2; done
  for n in $F $P $B $H; do rm -f "$A3_REGISTRY/$n"; done
  docker volume rm $VOL $SVOL >/dev/null 2>&1
  for n in rove-a3-up rove-a3-in; do   # legacy networks from earlier versions, label-scoped and only when unused
    [ "$(docker network inspect -f '{{index .Labels "rove.a3"}} {{len .Containers}}' $n 2>/dev/null)" = "1 0" ] && docker network rm $n >/dev/null 2>&1
  done
  a3_unprotect $$
}
trap 'cleanup; exit 130' INT TERM HUP
dcmd volume create --label rove.a3=1 --label rove.a3.nonce=$NONCE --label rove.a3.sup=$SUP --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m,uid=$(id -u),gid=$(id -g),mode=0700 $VOL >/dev/null
# Browser scratch: size-capped tmpfs (R3-3), never a host bind mount.
dcmd volume create --label rove.a3=1 --label rove.a3.nonce=$NONCE --label rove.a3.sup=$SUP --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=64m,uid=$(id -u),gid=$(id -g),mode=0700 $SVOL >/dev/null
H=rove-a3-${ID}4
COMMON=(--rm --pull never --label rove.a3=1 --label rove.a3.nonce=$NONCE --label rove.a3.sup=$SUP --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,size=64m --user "$(id -u):$(id -g)")
start() { local reg=$1; shift; dcmd run -d $COMMON --name $reg "$@" >/dev/null && a3_register_container $reg $reg $NONCE; }
# Scratch holder/copier (trusted): keeps the tmpfs scratch mounted after the browser exits, then copies out.
start $H --network none --cpus 0.5 --memory 256m --pids-limit 32 -v $SVOL:/s:ro -v $OUT/browser:/out -v $RSELF/copyout.mjs:/copyout.mjs:ro \
  node:24-bookworm-slim sleep 86400 || { slog "holder failed"; cleanup; exit 5; }
start $P --network none --cpus 0.5 --memory 256m --pids-limit 64 -e OUT=/evidence -e TOPLEVEL="$URLS" \
  -v $RWT:/app:ro -v $RPOLICY:/cfg/policy.json:ro -v $OUT/proxy:/evidence -v $VOL:/sock \
  node:24-bookworm-slim node --experimental-strip-types /app/harness/stage-a-runner/proxy.ts || { slog "proxy failed"; cleanup; exit 5; }
start $F --network container:$P --cpus 0.5 --memory 128m --pids-limit 64 \
  -v $RSELF/fixture.mjs:/fixture.mjs:ro node:24-bookworm-slim node /fixture.mjs || { slog "fixture failed"; cleanup; exit 5; }
for i in {1..50}; do grep -q listening <(docker logs $P 2>&1) && grep -q listening <(docker logs $F 2>&1) && break; sleep 0.1; done
JOB="node /runner/browse.mjs"
if [ "$TEST" = 1 ] && [ -n "${CMD:-}" ]; then JOB=$CMD; slog "TEST MODE: CMD hook in use"; fi
start $B --network none --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --shm-size 256m \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e URLS="$URLS" -e PROBE="${PROBE:-}" \
  -v $RSELF:/runner:ro -v $NM:/node_modules:ro -v $OUT:/evidence:ro -v $SVOL:/scratch -v $VOL:/sock \
  rove-browser-pilot:local sh -c "umask 077; $JOB" || { slog "browser failed"; cleanup; exit 5; }
for n in $B $P $F; do docker inspect $n --format "$n {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.AutoRemove}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}} {{json .HostConfig.CapDrop}} {{.HostConfig.Privileged}}" 2>/dev/null; done > "$OUT/containers.inspect"
grep "^$B " "$OUT/containers.inspect" | cut -d' ' -f2-7 > "$OUT/browser.inspect"
if [ "$TEST" = 1 ] && [ -n "${PROXY_PROBE:-}" ]; then docker exec $P node /app/harness/stage-a-runner/tests/isolation-probe.mjs /evidence/proxy-probe.json; slog "TEST MODE: proxy isolation probe"; fi
slog "started fixture=$F proxy=$P browser=$B wall=${WALL}s urls=$URLS"
peak=0; t0=$SECONDS; result=completed
docker logs -f $B > "$OUT/browser.log" 2>&1 &
docker logs -f $P > "$OUT/proxy.log" 2>&1 &
V=$OUT/proxy/VIOLATION
while :; do
  if [ ! -f "$A3_REGISTRY/$B" -o ! -f "$A3_REGISTRY/$P" -o ! -f "$A3_REGISTRY/$F" ]; then result="external kill (kill.sh)"; slog "external kill observed"; break; fi
  docker inspect $B >/dev/null 2>&1 || break
  m=$(docker exec $B cat /sys/fs/cgroup/memory.peak 2>/dev/null) && [ -n "$m" ] && (( m > peak )) && peak=$m
  if [ -f "$V" ]; then result="auto-terminated: $(<"$V")"; slog "violation -> kill"; break; fi
  if ! docker inspect $P >/dev/null 2>&1; then result="auto-terminated: proxy exited"; slog "proxy gone -> kill"; break; fi
  if (( SECONDS - t0 >= WALL )); then result="wall-clock kill after ${WALL}s"; slog "wall-clock -> kill"; break; fi
  sleep 0.5
done
sleep 0.3
[[ $result == completed ]] && [ ! -f "$A3_REGISTRY/$B" -o ! -f "$A3_REGISTRY/$P" -o ! -f "$A3_REGISTRY/$F" ] && { result="external kill (kill.sh)"; slog "external kill observed"; }
[ -f "$V" ] && [[ $result == completed ]] && result="auto-terminated: $(<"$V")"
KEEPB=0; [ "$TEST" = 1 ] && [ -n "${STAGE_A_TEST_KEEP_BROWSER:-}" ] && KEEPB=1   # test-only: simulate a browser that survives kill
for n in $B $F $P; do [ $KEEPB = 1 ] && [ $n = $B ] && continue; docker kill $n >/dev/null 2>&1; done
for i in {1..30}; do docker inspect $B >/dev/null 2>&1 || break; sleep 0.2; done
: > "$OUT/scratch-copy.json"
if docker inspect $B >/dev/null 2>&1; then
  # R4-4: never copy while the browser could still be writing to scratch.
  print -r -- '{"error":"browser-still-present"}' > "$OUT/scratch-copy.json"; slog "browser still present after kill -> copy-out aborted"
else
# Copy browser scratch out (R3-1/R3-2/R3-3): trusted copier container, regular files only, caps, 30 s timeout.
docker exec $H node /copyout.mjs > "$OUT/scratch-copy.json" 2>/dev/null &
CP=$!
for i in {1..60}; do kill -0 $CP 2>/dev/null || break; sleep 0.5; done
if kill -0 $CP 2>/dev/null; then kill $CP 2>/dev/null; print -r -- '{"error":"copy-timeout"}' > "$OUT/scratch-copy.json"; slog "scratch copy timed out"; fi
wait $CP 2>/dev/null
fi
cleanup
wait 2>/dev/null
docker volume rm $SVOL >/dev/null 2>&1
left=$(docker ps -aq --filter label=rove.a3.nonce=$NONCE | wc -l | tr -d ' ')
export SELF OUT
summary() { # <integrity: pending|true|false> <detail>
SELF=$RSELF python3 - "$OUT" "$result" $peak $left $START "$TEST" "$POLICY_SHA" "$PINNED" "${POLICY_BLOB:-}" "$1" "$2" "$POLICY_HEAD_OK" "${HEAD_COMMIT:-}" "$COMMIT_OK" "$APPROVED" "$APPROVED_SHA" "$TREE_CLEAN" "$APPROVAL_WHY" "$SNAPKIND" "$NM_LOCK_SHA" <<'PY'
import json, sys, os, subprocess
out, result, peak, left, start, test, psha, pinned, blob, integ, detail, headok, commit = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5]), sys.argv[6] == '1', sys.argv[7], sys.argv[8], sys.argv[9], sys.argv[10], sys.argv[11], sys.argv[12] == '1', sys.argv[13]
pd = os.path.join(out, 'proxy')
r = subprocess.run([sys.executable, os.path.join(os.environ['SELF'], 'verify-evidence.py'), '--journal', out], capture_output=True, text=True, timeout=90)
jok = r.returncode == 0; jwhy = '' if jok else r.stdout.strip()
try: pol = json.load(open(os.path.join(pd, 'policy-summary.json')))
except Exception: pol = {}
try: copy = json.load(open(os.path.join(out, 'scratch-copy.json')))
except Exception: copy = {"error": "copy-report-missing"}
refused = copy.get('refused', [])
if not jok: result = f'evidence-integrity-failure ({jwhy})'
elif copy.get('error'): result = f'auto-terminated: scratch {copy["error"]}'
elif refused: result = 'auto-terminated: scratch-violation ' + ','.join(sorted({x["reason"] for x in refused}))
elif result == 'completed':
    try:
        p = os.path.join(out, 'browser', 'browse.json')
        browse = json.load(open(p)) if os.path.isfile(p) and not os.path.islink(p) else []
    except Exception: browse = []
    if any('error' in r or (r.get('status') or 0) >= 500 for r in browse): result = 'completed-with-errors'
    elif pol.get('aTotal', 0) > 0: result = 'completed-with-blocks'
if integ == 'false' and not result.startswith('evidence-integrity-failure'): result = f'evidence-integrity-failure ({detail})'
result = result[:-5] if result.endswith('-TEST') else result
if test: result += '-TEST'
s = {"result": result, "test_mode": test, "evidence_integrity": {"pending": None, "true": True, "false": False}[integ], "integrity_detail": detail,
     "integrity_checked_after_seal": integ != 'pending', "journal_ok": jok, "scratch_refused": refused, "scratch_copied": len(copy.get('copied', [])),
     "policy_sha256": psha, "policy_pinned_sha256": pinned, "policy_pinned_ok": psha == pinned, "policy_git_blob": blob, "policy_matches_head": headok, "head_commit": commit,
     "commit_approved": sys.argv[14] == '1', "approval_reason": sys.argv[18], "approved_commits_file": sys.argv[15], "approved_commits_sha256": sys.argv[16], "tree_clean": sys.argv[17] == '1', "run_snapshot": sys.argv[19], "node_modules_lock_sha256": sys.argv[20],
     "peak_memory_bytes": peak, "containers_left": left, "start_epoch": start, "blocks": pol.get("blocks", {}), "a_class_total": pol.get("aTotal", 0)}
p = os.path.join(out, 'summary.json')
if os.path.lexists(p): os.chmod(p, 0o600); os.unlink(p)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600); os.write(fd, json.dumps(s).encode()); os.close(fd)
print(result)
PY
}
seal() {
  (cd "$OUT" && find . -type f ! -name SHA256SUMS ! -name MANIFEST.sealed -print0 | sort -z | xargs -0 shasum -a 256 > SHA256SUMS)
  python3 $RSELF/verify-evidence.py --seal "$OUT" $NONCE
}
result=$(summary pending "")
slog "provisional result=$result (before integrity verification) peak_memory_bytes=$peak containers_left=$left"
chmod -R go-rwx "$OUT"
print -r -- $NONCE > "$OUT/supervisor.nonce"; chmod 400 "$OUT/supervisor.nonce"
if [ "$TEST" = 1 ] && [ -n "${STAGE_A_TEST_BREAK_SEAL:-}" ]; then mkfifo "$OUT/seal-breaker"; fi   # test-only: sealing must fail
# Seal, then compute evidence_integrity FROM THE VERIFIER (R3-3), then seal again over the final summary and re-verify.
SEALOUT=$(seal); SEALRC=$?
if [ $SEALRC -ne 0 ]; then INTEG=false; DETAIL="seal-failed: $SEALOUT"
else V1=$(python3 $RSELF/verify-evidence.py "$OUT"); [ "$V1" = intact ] && { INTEG=true; DETAIL=""; } || { INTEG=false; DETAIL="$V1"; }; fi
result=$(summary $INTEG "$DETAIL")
slog "final result=$result evidence_integrity=$INTEG (post-seal verification)"   # R4-1: authoritative line, sealed by the reseal below
if [ $SEALRC -eq 0 ]; then chmod 600 "$OUT/MANIFEST.sealed"; seal >/dev/null || { INTEG=false; result="evidence-integrity-failure (reseal)"; }; fi
V2=$(python3 $RSELF/verify-evidence.py "$OUT" 2>&1)
echo "evidence: $V2 (integrity=$INTEG)"
[ "$INTEG" = true ] && [ "$V2" = intact ] || exit 10
[[ $result == completed* ]] && exit 0 || exit 9
