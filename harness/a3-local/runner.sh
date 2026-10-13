#!/bin/zsh
# Isolated, resource-limited A3-local runner. Local image only (never pulls). No network (loopback only inside).
# usage: runner.sh <evidence-dir> [wall-clock-seconds]   env: A3_PAGES
set -u
OUT=$1; WALL=${2:-120}
WT=${0:A:h:h:h}; NM=$(readlink "$WT/node_modules")
IMG=rove-browser-pilot:local
docker image inspect $IMG >/dev/null 2>&1 || { echo "image $IMG not present locally; refusing to pull"; exit 4; }
mkdir -p "$OUT" && chmod 777 "$OUT"
NAME=rove-a3-$(date +%Y%m%d%H%M%S)
docker run -d --pull never --name $NAME --label rove.a3=1 \
  --network none --cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 \
  --read-only --tmpfs /tmp:rw,size=256m --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 \
  -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright -e HOME=/tmp -e A3_PAGES="${A3_PAGES:-simple,links,jsonld,table,nav}" -e A3_KILL_FILE=/evidence/run/KILL \
  -v "$WT":/app:ro -v "$NM":"$NM":ro -v "$OUT":/evidence \
  $IMG node --experimental-strip-types /app/harness/a3-local/run.ts /evidence/run > "$OUT/container.id" || exit 5
echo "$NAME" > "$OUT/container.name"
# Wall-clock limit enforced from outside the container.
( sleep $WALL; docker kill $NAME >/dev/null 2>&1 && echo "wall-clock kill after ${WALL}s" >> "$OUT/runner.log" ) &
WD=$!
CODE=$(docker wait $NAME); kill $WD 2>/dev/null
docker logs $NAME > "$OUT/container.log" 2>&1
docker inspect $NAME --format '{{json .State}} {{json .HostConfig.NanoCpus}} {{json .HostConfig.Memory}} {{json .HostConfig.PidsLimit}} {{json .HostConfig.NetworkMode}}' > "$OUT/container.inspect"
echo "exit $CODE" >> "$OUT/runner.log"
exit $CODE
