#!/bin/zsh
# Stage A isolated runner (development only, local fixtures only; D-25-3). Never pulls images.
# usage: run.sh <evidence-dir> <wall-seconds> <url...>
set -u
SELF=${0:A:h}; WT=${SELF:h:h}; source $WT/harness/a3-local/registry.sh; a3_init
OUT=$1; WALL=$2; shift 2; URLS="$*"
NM=$(readlink "$WT/node_modules" || print "$WT/node_modules")
for img in rove-browser-pilot:local node:24-bookworm-slim; do docker image inspect $img >/dev/null 2>&1 || { echo "STOP: $img not present; not pulling"; exit 4; }; done
mkdir -p -m 700 "$OUT"; chmod 700 "$OUT"; : > "$OUT/requests.jsonl"; : > "$OUT/dns.jsonl"; chmod 600 "$OUT"/*.jsonl
ensure_net() { docker network inspect $1 >/dev/null 2>&1 || docker network create --internal --label rove.a3=1 --subnet $2 $1 >/dev/null; }
ensure_net rove-a3-up 10.89.1.0/24; ensure_net rove-a3-in 10.89.2.0/24
ID=$(date +%Y%m%d%H%M%S)-$$; F=rove-a3-${ID}1; P=rove-a3-${ID}2; B=rove-a3-${ID}3
cleanup() { for n in $B $P $F; do docker kill $n >/dev/null 2>&1; done; for n in $F $P $B; do rm -f "$A3_REGISTRY/$n"; done; }
trap cleanup INT TERM
for n in $F $P $B; do print -r -- "type=docker container=$n" > "$A3_REGISTRY/$n"; done
print -r -- "run $ID $(date '+%F %T %Z')" > "$OUT/supervisor.log"; chmod 600 "$OUT/supervisor.log"
slog() { print -r -- "$(a3_now) $*" >> "$OUT/supervisor.log"; a3_log "stage-a $ID $*"; }
COMMON=(--rm --pull never --label rove.a3=1 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,size=64m --user "$(id -u):$(id -g)")
docker run -d $COMMON --name $F --network rove-a3-up --ip 10.89.1.10 --cpus 0.5 --memory 128m --pids-limit 64 \
  -v $SELF/fixture.mjs:/fixture.mjs:ro node:24-bookworm-slim node /fixture.mjs >/dev/null || { slog "fixture failed"; cleanup; exit 5; }
docker run -d $COMMON --name $P --network rove-a3-up --cpus 0.5 --memory 256m --pids-limit 64 -e OUT=/evidence \
  -v $WT:/app:ro -v $SELF/policy.json:/cfg/policy.json:ro -v $OUT:/evidence node:24-bookworm-slim node --experimental-strip-types /app/harness/stage-a-runner/proxy.ts >/dev/null || { slog "proxy failed"; cleanup; exit 5; }
docker network connect --alias proxy rove-a3-in $P
sleep 1
docker run -d $COMMON --name $B --network rove-a3-in --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --shm-size 256m \
  -e HOME=/tmp -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e URLS="$URLS" -e PROBE="${PROBE:-}" \
  -v $SELF:/runner:ro -v $NM:/node_modules:ro -v $OUT:/evidence \
  rove-browser-pilot:local sh -c "${CMD:-node /runner/browse.mjs}" >/dev/null || { slog "browser failed"; cleanup; exit 5; }
docker inspect $B --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.AutoRemove}} {{.HostConfig.ReadonlyRootfs}} {{json .NetworkSettings.Networks}}' > "$OUT/browser.inspect" 2>/dev/null
slog "started fixture=$F proxy=$P browser=$B wall=${WALL}s urls=$URLS"
peak=0; t0=$SECONDS; result=completed
docker logs -f $B > "$OUT/browser.log" 2>&1 &
docker logs -f $P > "$OUT/proxy.log" 2>&1 &
while :; do
  if [ ! -f "$A3_REGISTRY/$B" ]; then result="external kill (kill.sh)"; slog "external kill observed"; break; fi
  docker inspect $B >/dev/null 2>&1 || break
  m=$(docker exec $B cat /sys/fs/cgroup/memory.peak 2>/dev/null) && [ -n "$m" ] && (( m > peak )) && peak=$m
  if [ -f "$OUT/VIOLATION" ]; then result="auto-terminated: $(<"$OUT/VIOLATION")"; slog "violation -> kill"; break; fi
  if ! docker inspect $P >/dev/null 2>&1; then result="auto-terminated: proxy exited"; slog "proxy gone -> kill"; break; fi
  if (( SECONDS - t0 >= WALL )); then result="wall-clock kill after ${WALL}s"; slog "wall-clock -> kill"; break; fi
  sleep 0.5
done
[ -f "$OUT/VIOLATION" ] && [[ $result == completed ]] && result="auto-terminated: $(<"$OUT/VIOLATION")"
for n in $B $P $F; do docker kill $n >/dev/null 2>&1; done
sleep 1; wait 2>/dev/null
left=$(docker ps -aq --filter name=rove-a3-$ID | wc -l | tr -d ' ')
slog "result=$result peak_memory_bytes=$peak containers_left=$left"
print -r -- "{\"result\": $(print -r -- $result | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().strip()))'), \"peak_memory_bytes\": $peak, \"containers_left\": $left}" > "$OUT/summary.json"
for n in $F $P $B; do rm -f "$A3_REGISTRY/$n"; done
(cd "$OUT" && shasum -a 256 $(ls | grep -v SHA256SUMS) > SHA256SUMS)
[[ $result == completed ]] && exit 0 || exit 9
