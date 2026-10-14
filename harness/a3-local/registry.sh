# Shared helpers (sourced). Registry of runs this tooling started; kill.sh acts only on entries here.
: ${A3_REGISTRY:=$HOME/.rove-a3/registry}
: ${A3_KILL_LOG:=$HOME/.rove-a3/kill.log}
a3_init() { umask 077; mkdir -p -m 700 "$A3_REGISTRY" "${A3_KILL_LOG:h}"; }
a3_now() { perl -MPOSIX=strftime -MTime::HiRes=time -e '$t=time; printf "%s.%03d", strftime("%Y-%m-%dT%H:%M:%S%z", localtime($t)), ($t-int($t))*1000'; }
# Append before acting so the record survives if the actor is killed next.
a3_log() { a3_init; print -r -- "$(a3_now) $*" >> "$A3_KILL_LOG"; }
a3_nonce() { od -An -N16 -tx1 /dev/urandom | tr -d ' \n'; }
# Register a started container by full ID + creation time + the per-run nonce label it was started with.
a3_register_container() { # <registry-name> <container-name> <nonce>
  local i info; for i in {1..50}; do info=$(docker inspect -f '{{.Id}} {{.Created}}' "$2" 2>/dev/null) && break; sleep 0.1; done
  [ -n "$info" ] || return 1
  print -r -- "type=docker name=$2 id=${info%% *} created=${info#* } nonce=$3" > "$A3_REGISTRY/$1"
}
# Protected supervisors (review t26 N2): pid + lstart. kill.sh refuses any target whose pid/pgid or group members
# include a live protected process, regardless of ancestry (covers double-fork+setsid, nohup, disown, cron/launchd callers).
: ${A3_PROTECTED:=$HOME/.rove-a3/protected}
a3_lstart() { ps -o lstart= -p $1 2>/dev/null | sed 's/^ *//;s/ *$//'; }
a3_protect() { # <pid>   (removed again by a3_unprotect; stale entries are ignored because lstart must match)
  umask 077; mkdir -p -m 700 "$A3_PROTECTED"
  print -r -- "pid=$1 lstart=$(a3_lstart $1);" > "$A3_PROTECTED/$1"
}
a3_unprotect() { rm -f "$A3_PROTECTED/$1"; }
