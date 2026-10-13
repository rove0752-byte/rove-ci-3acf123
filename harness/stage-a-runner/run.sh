#!/bin/zsh
# Stage A isolated runner (development only, local fixtures only; D-25-3). Never pulls images.
# usage: run.sh <new-evidence-dir> <wall-seconds> <url...>
# The evidence dir must not exist yet (or be empty): stale VIOLATION/browse files can never be read (review H4).
# Browser container: --network none; its only path out is a unix socket to the proxy (review M4).
# Test hooks CMD/PROBE are honoured only with STAGE_A_TEST=1, and refused otherwise (review M2).
set -u
SELF=${0:A:h}; WT=${SELF:h:h}; source $WT/harness/a3-local/registry.sh; a3_init
OUT=$1; WALL=$2; shift 2; URLS="$*"
NM=$(readlink "$WT/node_modules" || print "$WT/node_modules")
if [ "${STAGE_A_TEST:-0}" != 1 ] && [ -n "${CMD:-}${PROBE:-}" ]; then echo "refused: CMD/PROBE are test-only (set STAGE_A_TEST=1)"; a3_log "stage-a refuse reason=test-hook-in-production"; exit 7; fi
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ]; then echo "refused: evidence dir $OUT is not empty"; exit 6; fi
for img in rove-browser-pilot:local node:24-bookworm-slim; do docker image inspect $img >/dev/null 2>&1 || { echo "STOP: $img not present; not pulling"; exit 4; }; done
umask 077; mkdir -p -m 700 "$OUT"; chmod 700 "$OUT"; : > "$OUT/requests.jsonl"; : > "$OUT/dns.jsonl"; : > "$OUT/decisions.jsonl"
ID=$(date +%Y%m%d%H%M%S)-$$; F=rove-a3-${ID}1; P=rove-a3-${ID}2; B=rove-a3-${ID}3; NONCE=$(a3_nonce); VOL=rove-a3-sock-$ID; NET=rove-a3-up
START=$(date +%s)
print -r -- "run $ID $(date '+%F %T %Z') start_epoch=$START nonce=${NONCE:0:8}…" > "$OUT/supervisor.log"
slog() { print -r -- "$(a3_now) $*" >> "$OUT/supervisor.log"; a3_log "stage-a $ID $*"; }
cleanup() {
  for n in $B $P $F; do docker kill $n >/dev/null 2>&1; done
  for i in {1..30}; do [ -z "$(docker ps -aq --filter label=rove.a3.nonce=$NONCE)" ] && break; sleep 0.2; done
  for n in $F $P $B; do rm -f "$A3_REGISTRY/$n"; done
  docker volume rm $VOL >/dev/null 2>&1
  # label-scoped network removal when unused (review L4); rove-a3-in is the legacy pre-t26 network
  for n in $NET rove-a3-in; do
    [ "$(docker network inspect -f '{{index .Labels "rove.a3"}} {{len .Containers}}' $n 2>/dev/null)" = "1 0" ] && docker network rm $n >/dev/null 2>&1
  done
}
trap 'cleanup; exit 130' INT TERM
docker network inspect $NET >/dev/null 2>&1 || docker network create --internal --label rove.a3=1 --subnet 10.89.1.0/24 $NET >/dev/null
docker volume create --label rove.a3=1 --label rove.a3.nonce=$NONCE --driver local --opt type=tmpfs --opt device=tmpfs --opt o=size=1m,uid=$(id -u),gid=$(id -g),mode=0700 $VOL >/dev/null
COMMON=(--rm --pull never --label rove.a3=1 --label rove.a3.nonce=$NONCE --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,size=64m --user "$(id -u):$(id -g)")
start() { local reg=$1; shift; docker run -d $COMMON --name $reg "$@" >/dev/null && a3_register_container $reg $reg $NONCE; }
start $F --network $NET --ip 10.89.1.10 --cpus 0.5 --memory 128m --pids-limit 64 \
  -v $SELF/fixture.mjs:/fixture.mjs:ro node:24-bookworm-slim node /fixture.mjs || { slog "fixture failed"; cleanup; exit 5; }
start $P --network $NET --cpus 0.5 --memory 256m --pids-limit 64 -e OUT=/evidence -e TOPLEVEL="$URLS" \
  -v $WT:/app:ro -v $SELF/policy.json:/cfg/policy.json:ro -v $OUT:/evidence -v $VOL:/sock \
  node:24-bookworm-slim node --experimental-strip-types /app/harness/stage-a-runner/proxy.ts || { slog "proxy failed"; cleanup; exit 5; }
for i in {1..50}; do grep -q listening <(docker logs $P 2>&1) && break; sleep 0.1; done
JOB="node /runner/browse.mjs"
if [ "${STAGE_A_TEST:-0}" = 1 ] && [ -n "${CMD:-}" ]; then JOB=$CMD; slog "TEST MODE: CMD hook in use"; fi
start $B --network none --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --shm-size 256m \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e URLS="$URLS" -e PROBE="${PROBE:-}" \
  -v $SELF:/runner:ro -v $NM:/node_modules:ro -v $OUT:/evidence -v $VOL:/sock \
  rove-browser-pilot:local sh -c "$JOB" || { slog "browser failed"; cleanup; exit 5; }
docker inspect $B --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.AutoRemove}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.NetworkMode}}' > "$OUT/browser.inspect" 2>/dev/null
slog "started fixture=$F proxy=$P browser=$B wall=${WALL}s urls=$URLS"
peak=0; t0=$SECONDS; result=completed
docker logs -f $B > "$OUT/browser.log" 2>&1 &
docker logs -f $P > "$OUT/proxy.log" 2>&1 &
while :; do
  if [ ! -f "$A3_REGISTRY/$B" -o ! -f "$A3_REGISTRY/$P" -o ! -f "$A3_REGISTRY/$F" ]; then result="external kill (kill.sh)"; slog "external kill observed"; break; fi
  docker inspect $B >/dev/null 2>&1 || break
  m=$(docker exec $B cat /sys/fs/cgroup/memory.peak 2>/dev/null) && [ -n "$m" ] && (( m > peak )) && peak=$m
  if [ -f "$OUT/VIOLATION" ]; then result="auto-terminated: $(<"$OUT/VIOLATION")"; slog "violation -> kill"; break; fi
  if ! docker inspect $P >/dev/null 2>&1; then result="auto-terminated: proxy exited"; slog "proxy gone -> kill"; break; fi
  if (( SECONDS - t0 >= WALL )); then result="wall-clock kill after ${WALL}s"; slog "wall-clock -> kill"; break; fi
  sleep 0.5
done
sleep 0.3
[[ $result == completed ]] && [ ! -f "$A3_REGISTRY/$B" -o ! -f "$A3_REGISTRY/$P" -o ! -f "$A3_REGISTRY/$F" ] && { result="external kill (kill.sh)"; slog "external kill observed"; }
[ -f "$OUT/VIOLATION" ] && [[ $result == completed ]] && result="auto-terminated: $(<"$OUT/VIOLATION")"
cleanup
wait 2>/dev/null
if [[ $result == completed ]]; then
  if python3 -c 'import json,sys; sys.exit(0 if any("error" in r or (r.get("status") or 0) >= 500 for r in json.load(open(sys.argv[1]))) else 1)' "$OUT/browse.json" 2>/dev/null; then result=completed-with-errors
  elif python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["aTotal"] > 0 else 1)' "$OUT/policy-summary.json" 2>/dev/null; then result=completed-with-blocks; fi
fi
left=$(docker ps -aq --filter label=rove.a3.nonce=$NONCE | wc -l | tr -d ' ')
slog "result=$result peak_memory_bytes=$peak containers_left=$left"
python3 - "$OUT" "$result" $peak $left $START <<'PY'
import json, sys, os
out, result, peak, left, start = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
try: pol = json.load(open(os.path.join(out, 'policy-summary.json')))
except Exception: pol = {}
s = {"result": result, "peak_memory_bytes": peak, "containers_left": left, "start_epoch": start, "blocks": pol.get("blocks", {}), "a_class_total": pol.get("aTotal", 0)}
fd = os.open(os.path.join(out, 'summary.json'), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600); os.write(fd, json.dumps(s).encode()); os.close(fd)
PY
(cd "$OUT" && shasum -a 256 $(ls | grep -v SHA256SUMS) > SHA256SUMS)
[[ $result == completed* ]] && exit 0 || exit 9
