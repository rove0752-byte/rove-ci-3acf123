#!/bin/zsh
# External kill switch. Acts ONLY on runs recorded in the registry by runner.sh / spawn.sh / stage-a run.sh.
# usage: kill.sh            -> stop every registered run
#        kill.sh <name>     -> stop one registered run
# Process-group targets are refused when the pgid is: PID/pgid <=1; the pgid or pid of ANY ancestor of this
# script (walk to PID 1, so the supervisor and its callers can never be hit); a session leader; not a group
# leader; or the recorded start time does not match (PID reuse). Identity is re-verified immediately before
# every signal. If the leader has exited, each surviving member must have started at/after the leader's
# recorded start, otherwise the run is refused (orphan-group-unverifiable).
# Containers are verified by registry-recorded full ID + creation time + per-run random nonce label.
# Supervisors register themselves in $A3_PROTECTED (pid + lstart); those are refused even when kill.sh is not a
# descendant (double-fork + setsid, nohup, disown, cron, launchd). Without that registration, kill.sh only protects
# its live process ancestry.
# RESIDUAL RISK (documented): macOS has no pidfd, so a PID can in theory be recycled between the last check
# and kill(2) (window of a few ms). The registry is trusted local state: any process running as this user,
# or any user with Docker access, can forge entries or create look-alike containers; this tool protects
# against mistakes and stale state, not against a hostile same-user or docker-group process.
set -u
SELF=${0:A:h}; source $SELF/registry.sh; a3_init
typeset -A ANC          # pids and pgids of every ancestor (incl. self)
p=$$
while [ -n "$p" ] && [ "$p" -gt 0 ]; do
  ANC[$p]=1; g=$(ps -o pgid= -p $p 2>/dev/null | tr -d ' '); [ -n "$g" ] && ANC[$g]=1
  [ "$p" = 1 ] && break
  p=$(ps -o ppid= -p $p 2>/dev/null | tr -d ' ')
done
# Live protected supervisors: their pid and pgid are refused whatever our ancestry is (N2).
typeset -A PROT
for pf in "$A3_PROTECTED"/*(N); do
  pl=$(<"$pf"); pp=${${pl#pid=}%% *}; pls=${${pl#*lstart=}%%;*}
  [[ "$pp" =~ '^[0-9]+$' ]] || continue
  [ "$(ps -o lstart= -p $pp 2>/dev/null | sed 's/^ *//;s/ *$//')" = "$pls" ] || continue
  PROT[$pp]=1; pg2=$(ps -o pgid= -p $pp 2>/dev/null | tr -d ' '); [ -n "$pg2" ] && PROT[$pg2]=1
done
epoch() { local s="${(j: :)${(z)1}}"; date -j -f "%a %b %d %T %Y" "$s" +%s 2>/dev/null || date -d "$s" +%s 2>/dev/null; }
lst() { ps -o lstart= -p $1 2>/dev/null | sed 's/^ *//;s/ *$//'; }
members() { pgrep -g $1 2>/dev/null; }
rc=0
refuse() { a3_log "refuse name=$1 $2"; echo "refused: $1 (${2##*reason=})"; rc=$3; }

stop_docker() {
  local name=$1 f=$2 line=$3
  local id=${${line#*id=}%% *} created=${${line#*created=}%% *} nonce=${${line#*nonce=}%% *}
  if [[ "$line" != *" id="* || "$line" != *" created="* || "$line" != *" nonce="* || ! "$id" =~ '^[0-9a-f]{64}$' || ! "$nonce" =~ '^[0-9a-f]{16,64}$' ]]; then
    refuse $name "reason=malformed-entry" 4; return; fi
  verify() { [ "$(docker inspect -f '{{.Id}} {{.Created}} {{index .Config.Labels "rove.a3"}} {{index .Config.Labels "rove.a3.nonce"}}' "$id" 2>/dev/null)" = "$id $created 1 $nonce" ]; }
  if ! docker inspect "$id" >/dev/null 2>&1; then a3_log "gone name=$name container=${id:0:12}"; rm -f "$f"; return; fi
  verify || { refuse $name "container=${id:0:12} reason=container-not-ours" 4; return; }
  a3_log "kill name=$name container=${id:0:12} signal=KILL"
  verify && docker kill "$id" >/dev/null 2>&1; docker rm "$id" >/dev/null 2>&1
  a3_log "killed name=$name container=${id:0:12}"
  rm -f "$f"
}

stop_pgid() {
  local name=$1 f=$2 line=$3
  local pid=${${line#*pid=}%% *} pg=${${line#*pgid=}%% *} started=${${line#*lstart=}%%;*}
  if [[ ! "$pid" =~ '^[0-9]+$' || ! "$pg" =~ '^[0-9]+$' || "$line" != *lstart=*\;* ]]; then refuse $name "reason=malformed-entry" 4; return; fi
  if [ "$pid" -le 1 -o "$pg" -le 1 ]; then refuse $name "pid=$pid pgid=$pg reason=pid1" 4; return; fi
  if (( ${+ANC[$pg]} || ${+ANC[$pid]} )); then refuse $name "pid=$pid pgid=$pg reason=ancestor" 4; return; fi
  if (( ${+PROT[$pg]} || ${+PROT[$pid]} )); then refuse $name "pid=$pid pgid=$pg reason=protected-supervisor" 4; return; fi
  [ "$pg" != "$pid" ] && { refuse $name "pid=$pid pgid=$pg reason=not-group-leader" 4; return; }
  local t0=$(epoch "$started"); [ -n "$t0" ] || { refuse $name "reason=malformed-entry" 4; return; }
  # A member is ours if it is still in pg, is not an ancestor, and started at/after the leader's recorded start.
  member_ok() { local m=$1; (( ! ${+PROT[$m]} )) && [ "$(ps -o pgid= -p $m 2>/dev/null | tr -d ' ')" = "$pg" ] && (( ! ${+ANC[$m]} )) && local e=$(epoch "$(lst $m)") && [ -n "$e" ] && (( e >= t0 )); }
  leader_ok() { [ "$(lst $pid)" = "$started" ] && [ "$(ps -o pgid= -p $pid | tr -d ' ')" = "$pg" ] && [[ "$(ps -o stat= -p $pid)" != *s* ]]; }
  local snap=($(members $pg))
  if [ ${#snap} -eq 0 ]; then a3_log "gone name=$name pgid=$pg"; rm -f "$f"; return; fi
  if ps -p $pid >/dev/null 2>&1; then
    [ "$(lst $pid)" != "$started" ] && { refuse $name "pid=$pid pgid=$pg reason=start-time-mismatch" 4; return; }
    [[ "$(ps -o stat= -p $pid)" == *s* ]] && { refuse $name "pid=$pid pgid=$pg reason=session-leader" 4; return; }
  fi
  for m in $snap; do (( ${+PROT[$m]} )) && { refuse $name "pgid=$pg member=$m reason=protected-supervisor" 4; return; }; done
  for m in $snap; do member_ok $m || { refuse $name "pgid=$pg member=$m reason=orphan-group-unverifiable" 4; return; }; done
  a3_log "kill name=$name pgid=$pg members=${(j:,:)snap} leader=$(ps -p $pid >/dev/null 2>&1 && echo alive || echo exited) signal=TERM"
  if ps -p $pid >/dev/null 2>&1; then leader_ok && kill -TERM -- -$pg 2>/dev/null
  else for m in $snap; do member_ok $m && kill -TERM $m 2>/dev/null; done; fi
  for i in {1..20}; do [ -z "$(members $pg)" ] && break; sleep 0.1; done
  local left=($(members $pg))
  if [ ${#left} -gt 0 ]; then
    a3_log "kill name=$name pgid=$pg members=${(j:,:)left} signal=KILL"
    for m in $left; do member_ok $m && kill -KILL $m 2>/dev/null; done   # per-member, each re-verified just before the signal
    sleep 0.2
  fi
  left=($(members $pg))
  if [ ${#left} -gt 0 ]; then a3_log "SURVIVORS name=$name pgid=$pg members=${(j:,:)left}"; rc=5; else a3_log "killed name=$name pgid=$pg"; fi
  rm -f "$f"
}

stop_one() {
  local name=$1 f="$A3_REGISTRY/$1"
  if [[ ! "$name" =~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' ]]; then a3_log "refuse reason=bad-name"; echo "refused: bad name"; rc=3; return; fi
  [ -f "$f" ] || { refuse $name "reason=not-registered" 3; return; }
  local line=$(<"$f")
  case "${${line#type=}%% *}" in
    docker) stop_docker $name $f "$line" ;;
    pgid) stop_pgid $name $f "$line" ;;
    *) refuse $name "reason=malformed-entry" 4 ;;
  esac
}
if [ $# -ge 1 ]; then stop_one $1; else for f in "$A3_REGISTRY"/*(N); do stop_one ${f:t}; done; fi
exit $rc
