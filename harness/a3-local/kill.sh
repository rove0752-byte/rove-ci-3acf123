#!/bin/zsh
# External kill switch. Acts ONLY on runs recorded in the registry by runner.sh/spawn.sh.
# usage: kill.sh                 -> stop every registered run
#        kill.sh <name>          -> stop one registered run
# Refuses: pgid of itself or its parent, PID/pgid 1, session leaders, anything not registered.
set -u
SELF=${0:A:h}; source $SELF/registry.sh; a3_init
MYPG=$(ps -o pgid= -p $$ | tr -d ' '); PARENTPG=$(ps -o pgid= -p $PPID | tr -d ' ')
rc=0
stop_one() {
  local name=$1 f="$A3_REGISTRY/$1"
  [ -f "$f" ] || { a3_log "refuse name=$name reason=not-registered"; echo "refused: $name not registered"; rc=3; return; }
  local line=$(<"$f"); local type=${${line#type=}%% *}
  if [ "$type" = docker ]; then
    local cname=${${line#*container=}%% *}
    a3_log "kill name=$name container=$cname signal=KILL"
    docker kill "$cname" >/dev/null 2>&1; docker rm "$cname" >/dev/null 2>&1   # --rm also removes; this covers a missed --rm
    a3_log "killed name=$name container=$cname"
  else
    local pid=${${line#*pid=}%% *} pg=${${line#*pgid=}%% *}
    if [ "$pid" -le 1 -o "$pg" -le 1 ]; then a3_log "refuse name=$name pid=$pid pgid=$pg reason=pid1"; echo "refused: $name (pid1)"; rc=4; return; fi
    if ! ps -p $pid >/dev/null 2>&1; then a3_log "gone name=$name pid=$pid"; rm -f "$f"; return; fi
    local cur=$(ps -o pgid= -p $pid | tr -d ' ')
    local reason=""
    [ "$cur" != "$pg" ] && reason="pgid-changed"
    [ "$pg" = "$MYPG" ] && reason="own-pgid"
    [ "$pg" = "$PARENTPG" ] && reason="parent-pgid"
    [ "$pid" = 1 -o "$pg" = 1 -o "$pg" = 0 ] && reason="pid1"
    [ "$pg" != "$pid" ] && reason="${reason:-not-group-leader}"
    [[ "$(ps -o stat= -p $pid)" == *s* ]] && reason="session-leader"   # ps STAT 's' = session leader
    if [ -n "$reason" ]; then a3_log "refuse name=$name pid=$pid pgid=$pg reason=$reason"; echo "refused: $name ($reason)"; rc=4; return; fi
    a3_log "kill name=$name pgid=$pg signal=TERM"
    kill -TERM -- -$pg 2>/dev/null
    for i in {1..20}; do kill -0 -- -$pg 2>/dev/null || break; sleep 0.1; done
    if kill -0 -- -$pg 2>/dev/null; then a3_log "kill name=$name pgid=$pg signal=KILL"; kill -KILL -- -$pg 2>/dev/null; sleep 0.2; fi
    kill -0 -- -$pg 2>/dev/null && { a3_log "SURVIVORS name=$name pgid=$pg"; rc=5; } || a3_log "killed name=$name pgid=$pg"
  fi
  rm -f "$f"
}
if [ $# -ge 1 ]; then stop_one $1; else for f in "$A3_REGISTRY"/*(N); do stop_one ${f:t}; done; fi
exit $rc
