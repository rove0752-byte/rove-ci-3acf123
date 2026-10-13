#!/bin/zsh
# Isolated, resource-limited A3-local runner. Local image only (never pulls). --network none.
# usage: runner.sh <evidence-dir> [wall-clock-seconds]   env: A3_PAGES
set -u
SELF=${0:A:h}; source $SELF/registry.sh; a3_init
OUT=$1; WALL=${2:-120}
WT=${SELF:h:h}; NM=$(readlink "$WT/node_modules" || print "$WT/node_modules")
IMG=rove-browser-pilot:local
docker image inspect $IMG >/dev/null 2>&1 || { echo "image $IMG not present locally; refusing to pull"; exit 4; }
mkdir -p -m 700 "$OUT" && chmod 700 "$OUT"
NAME=rove-a3-$(date +%Y%m%d%H%M%S)-$$
NONCE=$(a3_nonce)
a3_log "start name=$NAME wall=${WALL}s out=$OUT"
# Foreground --rm run in the background: logs stream to the evidence dir, so nothing is lost when the container is removed.
docker run --rm --pull never --name $NAME --label rove.a3=1 --label rove.a3.nonce=$NONCE \
  --network none --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 \
  --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges --user "$(id -u):$(id -g)" \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e HOME=/tmp -e A3_PAGES="${A3_PAGES:-simple,links,jsonld,table,nav}" -e A3_KILL_FILE=/evidence/run/KILL \
  -v "$WT":/app:ro -v "$NM":"$NM":ro -v "$OUT":/evidence \
  $IMG node --experimental-strip-types /app/harness/a3-local/run.ts /evidence/run > "$OUT/container.log" 2>&1 &
DP=$!
a3_register_container $NAME $NAME $NONCE || a3_log "register-failed name=$NAME"
docker inspect $NAME --format '{{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}} {{json .HostConfig.PidsLimit}} {{json .HostConfig.NetworkMode}} {{json .HostConfig.AutoRemove}} {{json .HostConfig.ReadonlyRootfs}}' > "$OUT/container.inspect" 2>/dev/null
# Wall clock enforced from outside; the log line is written BEFORE the kill so it survives.
( trap 'kill $SL 2>/dev/null; exit 0' TERM; sleep $WALL & SL=$!; wait $SL; if docker inspect $NAME >/dev/null 2>&1; then a3_log "wall-clock name=$NAME after=${WALL}s"; print -r -- "$(a3_now) wall-clock kill after ${WALL}s" >> "$OUT/runner.log"; docker kill $NAME >/dev/null 2>&1; fi ) &
WD=$!
wait $DP; CODE=$?
kill $WD 2>/dev/null; wait $WD 2>/dev/null
print -r -- "$(a3_now) exit $CODE" >> "$OUT/runner.log"
a3_log "end name=$NAME exit=$CODE"
rm -f "$A3_REGISTRY/$NAME"
exit $CODE
