#!/bin/zsh
# Start a host-mode target in its OWN process group (setpgid, not a new session) and register it.
# usage: spawn.sh <name> <logfile> -- <cmd...>   prints the pid
set -u
SELF=${0:A:h}; source $SELF/registry.sh; a3_init
NAME=$1; LOG=$2; shift 3
[[ "$NAME" =~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' ]] || { echo "bad name"; exit 2; }
perl -e 'setpgrp(0,0) or die "setpgrp: $!"; exec @ARGV or die "exec: $!"' "$@" > "$LOG" 2>&1 &
PID=$!
sleep 0.2
PG=$(ps -o pgid= -p $PID | tr -d ' ')
print -r -- "type=pgid pid=$PID pgid=$PG lstart=$(ps -o lstart= -p $PID | sed "s/^ *//;s/ *$//");" > "$A3_REGISTRY/$NAME"
a3_log "spawn name=$NAME pid=$PID pgid=$PG"
print $PID
