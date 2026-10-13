#!/bin/zsh
# External kill switch. Works even if the agent or harness is hung.
# usage: kill.sh            -> docker kill every container labelled rove.a3=1
#        kill.sh --pgid PID -> SIGTERM then SIGKILL the host process group of PID (host-mode runs)
set -u
start=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
if [ "${1:-}" = "--pgid" ]; then
  PG=$(ps -o pgid= -p $2 | tr -d ' ')
  [ -n "$PG" ] || { echo "no such process"; exit 1; }
  kill -TERM -- -$PG 2>/dev/null; sleep 2; kill -KILL -- -$PG 2>/dev/null
else
  IDS=$(docker ps -q --filter label=rove.a3=1)
  [ -n "$IDS" ] && docker kill $IDS >/dev/null
fi
end=$(perl -MTime::HiRes=time -e 'printf "%.0f", time*1000')
echo "kill-switch done in $((end-start)) ms"
